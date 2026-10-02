/**
 * The `eval` tool: runs one cell in the persistent Python or JavaScript kernel.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { CellOutput } from "./cell-output.ts";
import type { CellStatus } from "./kernel/slot.ts";
import { renderCall, renderResult } from "./render.ts";
import type { EvalRuntime } from "./runtime.ts";

export const EVAL_TOOL_NAME = "eval";
const DEFAULT_TIMEOUT_SECONDS = 120;
const UPDATE_INTERVAL_MS = 150;

export const evalSchema = Type.Object({
	language: Type.Union([Type.Literal("py"), Type.Literal("js")], {
		description: '"py" runs in the persistent Python kernel, "js" in the persistent Bun (JavaScript) kernel.',
	}),
	code: Type.String({ description: "Cell source. The value of a trailing expression is displayed." }),
	title: Type.Optional(Type.String({ description: "Short label shown in the UI." })),
	timeout: Type.Optional(
		Type.Number({ description: `Seconds before the cell is interrupted. Default ${DEFAULT_TIMEOUT_SECONDS}; 0 disables it.`, minimum: 0 }),
	),
	reset: Type.Optional(Type.Boolean({ description: "Restart this language's kernel before running, discarding its state." })),
});

export type EvalParams = Static<typeof evalSchema>;

export interface EvalDetails {
	language: EvalParams["language"];
	status: CellStatus;
	durationMs: number;
	images: number;
	stateLost: boolean;
	fullOutputPath?: string;
}

const DESCRIPTION = `Run a code cell in a persistent kernel, like a notebook.
- language "py": Python. language "js": JavaScript in Bun. Each language has one kernel per session; variables, imports, and functions defined in a cell stay available in later cells of the same language. The two kernels do not share memory: pass data through files or tool calls.
- stdout, stderr, warnings, and the value of a trailing expression are returned. Images are returned as image content.
- Every agent tool is callable from both kernels through \`tool.<name>\`:
  - Python (synchronous): \`text = tool.read(path="data.csv")\`, or \`tool["name"]({...})\`. Failures raise \`ToolError\`. \`list_tools()\` lists the callable tools.
  - JavaScript (async): \`const text = await tool.read({ path: "data.csv" })\`. Failures reject with \`ToolError\`. \`await listTools()\` lists the callable tools.
  - A tool returns its text output, or its structured content when it declares an output schema. Tool calls are real and have side effects.
- Python images: matplotlib figures appear on \`plt.show()\`, as a trailing expression, or automatically when the cell ends. \`display(obj)\` shows any object; \`display_png(bytes)\` shows raw PNG data.
- JavaScript images: \`await display.svg(svgString)\` rasterizes an SVG chart to PNG; \`display.png(bytes)\` shows PNG data; \`display(value)\` shows any value. Top-level await and static imports (resolved from the working directory) work.
- A cell that exceeds its timeout or is aborted gets an interrupt (KeyboardInterrupt in Python); the kernel keeps its state. A kernel that ignores the interrupt is restarted and loses its state; the result says so.`;

type Runtime = (ctx: ExtensionToolContext) => EvalRuntime;

export function createEvalTool(getRuntime: Runtime): ToolDefinition<typeof evalSchema, EvalDetails | undefined> {
	return {
		name: EVAL_TOOL_NAME,
		label: "eval",
		description: DESCRIPTION,
		promptSnippet: "Run Python or JavaScript cells in persistent kernels that can call the other tools",
		promptGuidelines: [
			"Use eval for data processing, computation, and charts; call other tools from inside cells with tool.<name>(...) instead of copying their output by hand.",
		],
		parameters: evalSchema,
		// Cells must not start other cells.
		exposure: "model-only",
		// Cells of one kernel share mutable state.
		executionMode: "sequential",
		execute: (_id, params, signal, onUpdate, ctx) => runCell(getRuntime(ctx), params, signal, onUpdate, ctx),
		renderCall,
		renderResult,
	};
}

type Update = ((result: AgentToolResult<EvalDetails | undefined>) => void) | undefined;

async function runCell(
	runtime: EvalRuntime,
	params: EvalParams,
	signal: AbortSignal | undefined,
	onUpdate: Update,
	ctx: ExtensionToolContext,
): Promise<AgentToolResult<EvalDetails | undefined>> {
	const started = Date.now();
	const output = new CellOutput();
	const publish = throttledPreview(output, onUpdate);
	const outcome = await runtime.run({
		language: params.language,
		code: params.code,
		timeoutMs: (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
		reset: params.reset === true,
		signal,
		ctx,
		onOutput: (frame) => {
			output.add(frame);
			publish();
		},
	});
	const { content, fullOutputPath } = output.content(outcome);
	const details: EvalDetails = {
		language: params.language,
		status: outcome.status,
		durationMs: Date.now() - started,
		images: output.imageCount,
		stateLost: outcome.stateLost,
		fullOutputPath,
	};
	return { content, details, ...(outcome.status === "ok" ? {} : { isError: true }) };
}

function throttledPreview(output: CellOutput, onUpdate: Update): () => void {
	let last = 0;
	return () => {
		const now = Date.now();
		if (!onUpdate || now - last < UPDATE_INTERVAL_MS) return;
		last = now;
		onUpdate({ content: [{ type: "text", text: output.preview() }], details: undefined });
	};
}
