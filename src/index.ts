/**
 * pi-eval-kernels: persistent Python and Bun cells that call back into the agent's tools.
 *
 * Registers the `eval` tool. Kernels and the loopback bridge start on the first cell, not in the
 * factory, and stop on `session_shutdown`.
 */
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createEvalTool } from "./eval-tool.ts";
import { EvalRuntime } from "./runtime.ts";

export default function evalKernels(pi: ExtensionAPI): void {
	let runtime: EvalRuntime | undefined;
	const getRuntime = (ctx: ExtensionToolContext): EvalRuntime => {
		runtime ??= new EvalRuntime(ctx.cwd);
		return runtime;
	};
	pi.registerTool(createEvalTool(getRuntime));
	pi.on("session_shutdown", async () => {
		const current = runtime;
		runtime = undefined;
		await current?.dispose();
	});
}
