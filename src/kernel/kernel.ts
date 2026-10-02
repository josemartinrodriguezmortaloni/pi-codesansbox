/**
 * One kernel process (Python runner or Bun worker) and the frames it sends.
 *
 * Kernels run in their own process group (`detached: true`) so that dispose can signal every
 * process user code started. Both transports deliver the same frame vocabulary.
 */
import type { ChildProcess } from "node:child_process";

export type StreamFrame = { type: "stream"; id: string | null; name: "stdout" | "stderr"; text: string };
export type DisplayFrame = { type: "display"; id: string | null; text?: string; png?: string };
export type DoneFrame = { type: "done"; id: string; status: "ok" | "error" | "cancelled"; error?: string };
export type ReadyFrame = { type: "ready"; pid: number };
export type Frame = StreamFrame | DisplayFrame | DoneFrame | ReadyFrame;
export type OutputFrame = StreamFrame | DisplayFrame;

/** How the host talks to one kind of kernel process. */
export interface KernelTransport {
	child: ChildProcess;
	/** Pipes that carry raw fd output (child processes, native code) rather than protocol frames. */
	outputPipes: Array<{ name: "stdout" | "stderr"; pipe: NodeJS.ReadableStream }>;
	send(message: object): void;
	/** Registers the receiver of protocol frames. */
	onFrame(listener: (frame: Frame) => void): void;
}

const STARTUP_TIMEOUT_MS = 20_000;
const EXIT_GRACE_MS = 1_000;

/** Kills every live kernel process group when Pi exits without a session shutdown. */
const liveGroups = new Set<number>();
process.once("exit", () => {
	for (const pid of liveGroups) killGroup(pid, "SIGKILL");
});

function killGroup(pid: number, signal: NodeJS.Signals): void {
	if (pid <= 0) return;
	try {
		process.kill(-pid, signal);
	} catch {
		// The group is already gone.
	}
}

interface ActiveCell {
	id: string;
	onOutput: (frame: OutputFrame) => void;
	finish: (frame: DoneFrame) => void;
}

export class Kernel {
	private active: ActiveCell | undefined;
	private nextId = 1;
	private exited = false;
	readonly ready: Promise<void>;
	private readonly transport: KernelTransport;

	constructor(transport: KernelTransport) {
		this.transport = transport;
		const child = transport.child;
		this.ready = this.waitForReady();
		this.ready.catch(() => {});
		child.once("error", (error) => this.onExit(`kernel failed: ${error.message}`));
		child.once("exit", (code, signal) => this.onExit(`kernel exited (${signal ?? `code ${code}`})`));
		if (child.pid) liveGroups.add(child.pid);
		for (const { name, pipe } of transport.outputPipes) this.forwardPipe(name, pipe);
	}

	get pid(): number {
		return this.transport.child.pid ?? 0;
	}

	get alive(): boolean {
		return !this.exited;
	}

	/** Runs one cell. Resolves with the `done` frame; never rejects. */
	run(code: string, onOutput: (frame: OutputFrame) => void): Promise<DoneFrame> {
		const id = String(this.nextId++);
		return new Promise((resolve) => {
			this.active = { id, onOutput, finish: resolve };
			this.transport.send({ type: "run", id, code });
		});
	}

	/** Raises KeyboardInterrupt (Python) or interrupts the script (Bun) in the running cell. */
	interrupt(): void {
		killGroup(this.pid, "SIGINT");
	}

	async dispose(): Promise<void> {
		if (this.exited) return;
		const exit = new Promise((resolve) => this.transport.child.once("exit", resolve));
		this.trySend({ type: "exit" });
		await Promise.race([exit, delay(EXIT_GRACE_MS)]);
		killGroup(this.pid, "SIGTERM");
		await Promise.race([exit, delay(EXIT_GRACE_MS)]);
		killGroup(this.pid, "SIGKILL");
		liveGroups.delete(this.pid);
	}

	private waitForReady(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("kernel did not start in time")), STARTUP_TIMEOUT_MS);
			this.transport.child.once("error", (error) => reject(error));
			this.transport.child.once("exit", () => reject(new Error("kernel exited during startup")));
			this.transport.onFrame((frame) => {
				if (frame.type === "ready") {
					clearTimeout(timer);
					resolve();
				}
				this.route(frame);
			});
		});
	}

	private route(frame: Frame): void {
		const cell = this.active;
		if (!cell || frame.type === "ready") return;
		if (frame.type !== "done") return cell.onOutput(frame);
		if (frame.id === cell.id) this.complete(frame);
	}

	private complete(frame: DoneFrame): void {
		const cell = this.active;
		this.active = undefined;
		cell?.finish(frame);
	}

	/** Bytes written straight to fd 1/2 (child processes, native code) belong to the running cell. */
	private forwardPipe(name: "stdout" | "stderr", pipe: NodeJS.ReadableStream): void {
		pipe.setEncoding("utf8");
		pipe.on("data", (text: string) => this.active?.onOutput({ type: "stream", id: null, name, text }));
	}

	private onExit(reason: string): void {
		this.exited = true;
		liveGroups.delete(this.pid);
		const cell = this.active;
		if (cell) this.complete({ type: "done", id: cell.id, status: "error", error: reason });
	}

	private trySend(message: object): void {
		try {
			this.transport.send(message);
		} catch {
			// Channel already closed.
		}
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
