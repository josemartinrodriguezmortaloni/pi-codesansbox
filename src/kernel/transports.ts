/**
 * Spawns the two kernel kinds. Each returns a transport that delivers the shared frame vocabulary.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Frame, KernelTransport } from "./kernel.ts";

export type Language = "py" | "js";

export interface KernelEnvironment {
	cwd: string;
	bridgeUrl: string;
	bridgeToken: string;
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON_DIR = join(PACKAGE_ROOT, "python");
const JS_WORKER = join(PACKAGE_ROOT, "src", "js", "worker.ts");

/** First protocol message: the bridge address and token, kept out of the kernel environment. */
function initMessage(environment: KernelEnvironment): object {
	return { type: "init", bridgeUrl: environment.bridgeUrl, bridgeToken: environment.bridgeToken };
}

/** Python runner: NDJSON requests on stdin, frames on the original stdout, raw fd output on stderr. */
function spawnPython(environment: KernelEnvironment): KernelTransport {
	const child = spawn(process.env.PI_EVAL_PYTHON ?? "python3", ["-u", join(PYTHON_DIR, "runner.py")], {
		cwd: environment.cwd,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			PYTHONPATH: [PYTHON_DIR, process.env.PYTHONPATH].filter(Boolean).join(":"),
			MPLBACKEND: "module://pi_inline_backend",
		},
	});
	const lines = createInterface({ input: child.stdout! });
	child.stdin!.write(`${JSON.stringify(initMessage(environment))}\n`);
	return {
		child,
		outputPipes: [{ name: "stderr", pipe: child.stderr! }],
		send: (message) => child.stdin!.write(`${JSON.stringify(message)}\n`),
		onFrame: (listener) => lines.on("line", (line) => listener(JSON.parse(line) as Frame)),
	};
}

/** Bun worker: Node IPC channel for requests and frames, stdout/stderr pipes for raw fd output. */
function spawnJs(environment: KernelEnvironment): KernelTransport {
	const child = spawn(process.env.PI_EVAL_BUN ?? "bun", [JS_WORKER], {
		cwd: environment.cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		serialization: "json",
	});
	child.send(initMessage(environment));
	return {
		child,
		outputPipes: [
			{ name: "stdout", pipe: child.stdout! },
			{ name: "stderr", pipe: child.stderr! },
		],
		send: (message) => child.send(message),
		onFrame: (listener) => child.on("message", (frame) => listener(frame as Frame)),
	};
}

export const TRANSPORTS: Record<Language, (environment: KernelEnvironment) => KernelTransport> = {
	py: spawnPython,
	js: spawnJs,
};
