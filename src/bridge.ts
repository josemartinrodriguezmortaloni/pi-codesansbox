/**
 * Loopback HTTP bridge through which kernel code calls the agent's tools.
 *
 * Listens on 127.0.0.1 only, on a random port, and requires `Authorization: Bearer <token>` with a
 * per-session 256-bit token on every request. Calls are dispatched through the context of the
 * running `eval` call (`ctx.executeTool`), so validation, `tool_call`/`tool_result` hooks, and
 * permission checks apply as for model-issued calls. Outside a running cell the bridge refuses calls.
 *
 * Routes: GET /v1/tools → { tools: [{ name, description }] }
 *         POST /v1/tools/call { name, args } → { ok: true, value, images } | { ok: false, error }
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentTool, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

type Reply = { status: number; body: object };
type ImageBlock = { type: "image"; data: string; mimeType: string };

/** The context of the `eval` call whose cell is running. */
export interface BridgeBinding {
	ctx: ExtensionToolContext;
	signal: AbortSignal | undefined;
}

export class ToolBridge {
	readonly token = randomBytes(32).toString("hex");
	private readonly server: Server = createServer((request, response) => void this.handle(request, response));
	private binding: BridgeBinding | undefined;
	private listening: Promise<string> | undefined;

	/** Starts listening once; resolves with the base URL. */
	start(): Promise<string> {
		this.listening ??= new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}`));
		});
		return this.listening;
	}

	/** Routes calls to `binding` until the returned function runs. */
	bind(binding: BridgeBinding): () => void {
		this.binding = binding;
		return () => {
			if (this.binding === binding) this.binding = undefined;
		};
	}

	close(): Promise<void> {
		this.server.closeAllConnections();
		return new Promise((resolve) => this.server.close(() => resolve()));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const reply = await this.reply(request).catch((error: Error) => fail(500, error.message));
		response.writeHead(reply.status, { "content-type": "application/json" });
		response.end(JSON.stringify(reply.body));
	}

	private readonly routes: Record<string, (request: IncomingMessage) => Promise<Reply> | Reply> = {
		"GET /v1/tools": () => this.listTools(),
		"POST /v1/tools/call": async (request) => this.callTool(parseCall(await readJson(request))),
	};

	private async reply(request: IncomingMessage): Promise<Reply> {
		if (!this.authorized(request.headers.authorization)) return fail(401, "missing or invalid bridge token");
		const route = `${request.method} ${request.url}`;
		const handler = this.routes[route];
		return handler ? handler(request) : fail(404, `unknown route ${route}`);
	}

	/** Constant-time comparison; hashing equalizes the lengths. */
	private authorized(header: string | undefined): boolean {
		return timingSafeEqual(sha256(`Bearer ${this.token}`), sha256(String(header)));
	}

	private listTools(): Reply {
		const tools = this.binding?.ctx.tools ?? [];
		return { status: 200, body: { tools: tools.map(({ name, description }) => ({ name, description })) } };
	}

	private async callTool(call: ToolCall): Promise<Reply> {
		const binding = this.binding;
		if (!binding) return fail(409, "no eval cell is running; tool calls are accepted only during a cell");
		const tool = findTool(binding.ctx.tools, call.name);
		if (!tool) return fail(404, unknownToolMessage(call.name, binding.ctx.tools));
		const outcome = await binding.ctx.executeTool(tool.name, call.args, { signal: binding.signal });
		return toReply(tool, outcome);
	}
}

type ToolCall = { name: string; args: unknown };

function parseCall(body: { name?: unknown; args?: unknown }): ToolCall {
	return { name: String(body.name), args: body.args ?? {} };
}

function findTool(tools: readonly AgentTool[], name: string): AgentTool | undefined {
	return tools.find((candidate) => candidate.name === name);
}

function sha256(text: string): Buffer {
	return createHash("sha256").update(text).digest();
}

function fail(status: number, error: string): Reply {
	return { status, body: { ok: false, error } };
}

function unknownToolMessage(name: unknown, tools: readonly AgentTool[]): string {
	return `unknown tool ${JSON.stringify(name)}; callable tools: ${tools.map((tool) => tool.name).join(", ")}`;
}

/**
 * Same value rule as Pi's codemode: a tool with `outputSchema` yields its `structuredContent`;
 * any other tool yields its text. Failures without structured content become errors.
 */
function toReply(tool: AgentTool, outcome: AgentToolCallOutcome): Reply {
	const { result } = outcome;
	if (outcome.isError && !hasStructured(tool, result)) return fail(200, failureText(tool, result));
	return { status: 200, body: { ok: true, value: valueOf(tool, result), images: imagesIn(result) } };
}

type ToolResult = AgentToolCallOutcome["result"];

function hasStructured(tool: AgentTool, result: ToolResult): boolean {
	return tool.outputSchema !== undefined && result.structuredContent !== undefined;
}

function valueOf(tool: AgentTool, result: ToolResult): unknown {
	return hasStructured(tool, result) ? result.structuredContent : textOf(result.content);
}

function failureText(tool: AgentTool, result: ToolResult): string {
	return textOf(result.content) || `tool "${tool.name}" failed`;
}

function imagesIn(result: ToolResult): ImageBlock[] {
	return result.content.filter((block): block is ImageBlock => block.type === "image");
}

function textOf(content: AgentToolCallOutcome["result"]["content"]): string {
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

async function readJson(request: IncomingMessage): Promise<{ name?: unknown; args?: unknown }> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
