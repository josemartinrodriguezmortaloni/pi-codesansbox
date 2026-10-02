/**
 * Owns the lifetime of one language's kernel: lazy start, cell deadlines, interrupt escalation,
 * restart, and shutdown.
 */
import { type DoneFrame, delay, Kernel, type OutputFrame } from "./kernel.ts";
import { type KernelEnvironment, type Language, TRANSPORTS } from "./transports.ts";

/** How long an interrupted cell may take to report `cancelled` before its kernel is killed. */
export const INTERRUPT_GRACE_MS = 3_000;

export type CellStatus = "ok" | "error" | "cancelled" | "timeout" | "killed";

export interface CellOutcome {
	status: CellStatus;
	error?: string;
	/** The kernel restarted, so variables from earlier cells are gone. */
	stateLost: boolean;
}

export interface CellRequest {
	code: string;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	onOutput: (frame: OutputFrame) => void;
}

type Stop = "timeout" | "cancelled";

export class KernelSlot {
	private kernel: Kernel | undefined;
	private starting: Promise<Kernel> | undefined;

	readonly language: Language;
	private readonly environment: () => Promise<KernelEnvironment>;

	constructor(language: Language, environment: () => Promise<KernelEnvironment>) {
		this.language = language;
		this.environment = environment;
	}

	async run(request: CellRequest): Promise<CellOutcome> {
		const kernel = await this.ensure();
		const done = kernel.run(request.code, request.onOutput);
		const stop = await Promise.race([done.then(() => undefined), stopSignal(request)]);
		if (!stop) return this.fromDone(await done);
		return this.interrupt(kernel, done, stop);
	}

	async reset(): Promise<void> {
		const kernel = this.kernel;
		this.kernel = undefined;
		this.starting = undefined;
		await kernel?.dispose();
	}

	dispose(): Promise<void> {
		return this.reset();
	}

	private fromDone(done: DoneFrame): CellOutcome {
		const stateLost = !this.kernel?.alive;
		if (stateLost) this.kernel = undefined;
		return { status: stateLost ? "killed" : done.status, error: done.error, stateLost };
	}

	/** SIGINT first; if the kernel does not answer in the grace period, kill it and start over. */
	private async interrupt(kernel: Kernel, done: Promise<DoneFrame>, stop: Stop): Promise<CellOutcome> {
		kernel.interrupt();
		const answered = await Promise.race([done.then(() => true), delay(INTERRUPT_GRACE_MS).then(() => false)]);
		if (answered) return { status: stop, stateLost: false };
		await this.reset();
		return { status: stop, stateLost: true, error: "kernel did not respond to SIGINT and was restarted" };
	}

	private ensure(): Promise<Kernel> {
		if (this.kernel?.alive) return Promise.resolve(this.kernel);
		this.starting ??= this.start();
		return this.starting;
	}

	private async start(): Promise<Kernel> {
		const kernel = new Kernel(TRANSPORTS[this.language](await this.environment()));
		try {
			await kernel.ready;
			this.kernel = kernel;
			return kernel;
		} catch (error) {
			await kernel.dispose();
			throw new Error(`${this.language} kernel failed to start: ${(error as Error).message}`);
		} finally {
			this.starting = undefined;
		}
	}
}

/** Resolves when the cell must stop: its deadline passes or the tool call is aborted. */
function stopSignal(request: CellRequest): Promise<Stop> {
	const timeout = request.timeoutMs > 0 ? delay(request.timeoutMs).then(() => "timeout" as const) : new Promise<never>(() => {});
	return Promise.race([timeout, abortPromise(request.signal)]);
}

function abortPromise(signal: AbortSignal | undefined): Promise<Stop> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve("cancelled");
		signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
	});
}
