/**
 * Session-scoped state of the extension: one bridge and one kernel slot per language.
 * Created on the first cell, disposed on `session_shutdown`.
 */
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { ToolBridge } from "./bridge.ts";
import type { OutputFrame } from "./kernel/kernel.ts";
import { type CellOutcome, KernelSlot } from "./kernel/slot.ts";
import type { KernelEnvironment, Language } from "./kernel/transports.ts";

export interface CellRun {
	language: Language;
	code: string;
	timeoutMs: number;
	reset: boolean;
	signal: AbortSignal | undefined;
	ctx: ExtensionToolContext;
	onOutput: (frame: OutputFrame) => void;
}

export class EvalRuntime {
	readonly bridge = new ToolBridge();
	private readonly slots: Record<Language, KernelSlot>;

	constructor(cwd: string) {
		const environment = async (): Promise<KernelEnvironment> => ({
			cwd,
			bridgeUrl: await this.bridge.start(),
			bridgeToken: this.bridge.token,
		});
		this.slots = { py: new KernelSlot("py", environment), js: new KernelSlot("js", environment) };
	}

	async run(cell: CellRun): Promise<CellOutcome> {
		const slot = this.slots[cell.language];
		if (cell.reset) await slot.reset();
		const unbind = this.bridge.bind({ ctx: cell.ctx, signal: cell.signal });
		try {
			return await slot.run(cell);
		} finally {
			unbind();
		}
	}

	async dispose(): Promise<void> {
		await Promise.all(Object.values(this.slots).map((slot) => slot.dispose()));
		await this.bridge.close();
	}
}
