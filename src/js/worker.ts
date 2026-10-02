/**
 * Persistent JavaScript kernel. Runs under Bun as a child of the Pi (Node.js) process and talks to it
 * over the Node IPC channel (`serialization: "json"`).
 *
 * Design adapted from oh-my-pi's `eval` tool (packages/coding-agent/src/eval/js/, MIT License, see
 * NOTICE). Difference: cells run through `vm.runInThisContext({ breakOnSigint })`, so SIGINT stops
 * synchronous code without discarding the global state.
 *
 * Host -> kernel: {type:"init", bridgeUrl, bridgeToken} (first) | {type:"run", id, code} | {type:"exit"}
 * Kernel -> host: the frame vocabulary of python/runner.py (ready, stream, display, done).
 */
import { inspect } from "node:util";
import vm from "node:vm";
import { IMPORT_HELPER, rewriteCell } from "./rewrite.ts";

type Frame = Record<string, unknown> & { type: string };
type Outcome = { status: "ok" | "error" | "cancelled"; error?: string };
type RunRequest = { type: "run"; id: string; code: string };

const state: { id: string | null; cancel: ((error: Error) => void) | null } = { id: null, cancel: null };
/** Set by the `init` message; kept out of the environment so /proc/<pid>/environ does not leak the token. */
const bridge = { url: "", token: "" };
const send = (frame: Frame): void => {
	process.send?.(frame);
};

// ---------------------------------------------------------------- output

function format(values: unknown[]): string {
	return values.map((value) => (typeof value === "string" ? value : inspect(value, { depth: 4 }))).join(" ");
}

function stream(name: "stdout" | "stderr") {
	return (...values: unknown[]): void => send({ type: "stream", id: state.id, name, text: `${format(values)}\n` });
}

function patchConsole(): void {
	const out = stream("stdout");
	const err = stream("stderr");
	Object.assign(console, { log: out, info: out, debug: out, warn: err, error: err, trace: err });
	process.stdout.write = ((chunk: unknown) => rawWrite("stdout", chunk)) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => rawWrite("stderr", chunk)) as typeof process.stderr.write;
}

function rawWrite(name: string, chunk: unknown): boolean {
	send({ type: "stream", id: state.id, name, text: String(chunk) });
	return true;
}

function toBase64(data: Uint8Array | string): string {
	return typeof data === "string" ? data : Buffer.from(data).toString("base64");
}

/** Shows a value like `repr` in Python; `{ type: "image", data, mimeType }` objects become images. */
function display(value: unknown): void {
	const image = value as { type?: string; data?: string };
	if (image?.type === "image" && image.data) return void send({ type: "display", id: state.id, png: image.data });
	send({ type: "display", id: state.id, text: inspect(value, { depth: 4 }) });
}

/** Shows PNG bytes (or base64) as an image. */
display.png = (data: Uint8Array | string): void => {
	send({ type: "display", id: state.id, png: toBase64(data) });
};

/** Rasterizes an SVG document to PNG with resvg and shows it. Returns the PNG bytes. */
display.svg = async (svg: string, options: { width?: number } = {}): Promise<Uint8Array> => {
	const { Resvg } = await import("@resvg/resvg-js");
	const fitTo = options.width ? { mode: "width" as const, value: options.width } : { mode: "original" as const };
	const png = new Resvg(svg, { fitTo, background: "white" }).render().asPng();
	display.png(png);
	return png;
};

// ---------------------------------------------------------------- tool bridge

class ToolError extends Error {
	override name = "ToolError";
}

async function bridgeRequest(path: string, body?: unknown): Promise<any> {
	const response = await fetch(`${bridge.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return response.json();
}

type CallReply = { ok: boolean; value?: unknown; error?: string; images?: Array<{ data: string }> };

async function callTool(name: string, args: unknown): Promise<unknown> {
	const reply: CallReply = await bridgeRequest("/v1/tools/call", { name, args });
	if (!reply.ok) throw new ToolError(String(reply.error));
	showImages(reply);
	return reply.value;
}

/** Images in a nested tool result (for example `read` of a PNG) become cell images. */
function showImages(reply: CallReply): void {
	for (const image of reply.images || []) display.png(image.data);
}

async function listTools(): Promise<Array<{ name: string; description: string }>> {
	return (await bridgeRequest("/v1/tools")).tools ?? [];
}

/** `await tool.read({ path })` calls the agent tool of that name. `then` stays undefined so `tool` is not a thenable. */
const tool = new Proxy({} as Record<string, (args?: unknown) => Promise<unknown>>, {
	get: (_target, name) => (typeof name === "string" && name !== "then" ? (args?: unknown) => callTool(name, args) : undefined),
});

/** Resolves relative and bare specifiers against the working directory, like a file in it. */
async function importFromCwd(specifier: string): Promise<unknown> {
	return import(Bun.resolveSync(specifier, process.cwd()));
}

Object.assign(globalThis, { tool, listTools, ToolError, display, [IMPORT_HELPER]: importFromCwd });

// ---------------------------------------------------------------- execution

function interruption(): Promise<never> {
	return new Promise((_resolve, reject) => {
		state.cancel = reject;
	});
}

async function evaluate(request: RunRequest): Promise<unknown> {
	const { script, isAsync } = rewriteCell(request.code);
	const value = vm.runInThisContext(script, { filename: `cell-${request.id}.js`, breakOnSigint: true });
	return isAsync ? Promise.race([value, interruption()]) : value;
}

function isInterrupt(error: unknown): boolean {
	const code = (error as { code?: string })?.code;
	return code === "ERR_SCRIPT_EXECUTION_INTERRUPTED" || error instanceof InterruptError;
}

class InterruptError extends Error {}

function failure(error: unknown): Outcome {
	if (isInterrupt(error)) return { status: "cancelled", error: "Interrupted" };
	send({ type: "stream", id: state.id, name: "stderr", text: `${stackOf(error)}\n` });
	return { status: "error", error: summaryOf(error) };
}

function stackOf(error: unknown): string {
	return error instanceof Error ? error.stack || String(error) : inspect(error);
}

function summaryOf(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function run(request: RunRequest): Promise<void> {
	state.id = request.id;
	let outcome: Outcome;
	try {
		const value = await evaluate(request);
		if (value !== undefined) display(value);
		outcome = { status: "ok" };
	} catch (error) {
		outcome = failure(error);
	}
	send({ type: "done", id: request.id, ...outcome });
	state.id = null;
	state.cancel = null;
}

const queue: RunRequest[] = [];
let draining = false;

async function drain(): Promise<void> {
	if (draining) return;
	draining = true;
	for (let request = queue.shift(); request; request = queue.shift()) await run(request);
	draining = false;
}

type InitRequest = { type: "init"; bridgeUrl: string; bridgeToken: string };

const HANDLERS: Record<string, (message: any) => void> = {
	init: (message: InitRequest) => {
		Object.assign(bridge, { url: message.bridgeUrl, token: message.bridgeToken });
		send({ type: "ready", pid: process.pid });
	},
	run: (message: RunRequest) => {
		queue.push(message);
		void drain();
	},
	exit: () => process.exit(0),
};

function onMessage(message: { type: string }): void {
	HANDLERS[message.type]?.(message);
}

function watchParent(): void {
	const parent = process.ppid;
	setInterval(() => process.ppid !== parent && process.exit(0), 1000).unref();
}

patchConsole();
watchParent();
process.on("SIGINT", () => state.cancel?.(new InterruptError("Interrupted")));
process.on("message", onMessage);
process.on("disconnect", () => process.exit(0));
process.on("unhandledRejection", (reason) => send({ type: "stream", id: state.id, name: "stderr", text: `Unhandled rejection: ${format([reason])}\n` }));
