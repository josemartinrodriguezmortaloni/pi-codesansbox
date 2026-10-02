import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createHarness, js, PACKAGE_ROOT, processAlive, py, textOf } from "./harness.ts";

async function waitUntilGone(pids: number[], ms = 5000): Promise<number[]> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline && pids.some(processAlive)) await sleep(100);
	return pids.filter(processAlive);
}

const details = (result: { details?: unknown }) => result.details as { status: string; stateLost: boolean };

describe("cell timeouts and interrupts", () => {
	it("interrupts on timeout and keeps state in both kernels", async () => {
		const h = await createHarness();
		try {
			const results = await h.run([
				py("kept = 'py-state'"),
				py("import time\nwhile True:\n    time.sleep(0.05)", { timeout: 1 }),
				py("while True:\n    pass", { timeout: 1 }),
				py("kept"),
				js("const kept = 'js-state'"),
				js("while (true) {}", { timeout: 1 }),
				js("await new Promise(() => {})", { timeout: 1 }),
				js("kept"),
			]);
			const [, pySleep, pyBusy, pyAfter, , jsBusy, jsPending, jsAfter] = results;
			for (const cell of [pySleep, pyBusy, jsBusy, jsPending]) {
				assert.deepEqual(details(cell), { ...details(cell), status: "timeout", stateLost: false });
				assert.match(textOf(cell), /\[kernel state kept\]/);
			}
			assert.equal(textOf(pyAfter), "'py-state'");
			assert.equal(textOf(jsAfter), "'js-state'");
		} finally {
			await h.dispose();
		}
	});

	it("restarts a JS kernel that ignores SIGINT and says the state is gone", async () => {
		const h = await createHarness();
		try {
			const [, stuck, after] = await h.run([
				js("var lost = 1"),
				js("await new Promise((r) => setTimeout(r, 10)); while (true) {}", { timeout: 1 }),
				js("typeof lost"),
			]);
			assert.equal(details(stuck).stateLost, true);
			assert.match(textOf(stuck), /variables from earlier cells are gone/);
			assert.equal(textOf(after), "'undefined'");
		} finally {
			await h.dispose();
		}
	});

	it("interrupts the running cell when the agent run is aborted", async () => {
		const h = await createHarness();
		try {
			const running = h.run([py("import time\ntime.sleep(60)")]);
			await sleep(1500);
			await h.runtime.session.abort();
			const [cell] = await running;
			assert.equal(details(cell).status, "cancelled");
			assert.equal(details(cell).stateLost, false);
		} finally {
			await h.dispose();
		}
	});
});

describe("process cleanup", () => {
	it("leaves no kernel or child processes after the session shuts down", async () => {
		const h = await createHarness();
		const [pyCell, jsCell] = await h.run([
			py("import os, subprocess\nchild = subprocess.Popen(['sleep', '300'])\nprint(os.getpid(), child.pid)"),
			js("process.pid"),
		]);
		const pids = [...textOf(pyCell).split(" ").map(Number), Number(textOf(jsCell))];
		assert.equal(pids.length, 3);
		assert.deepEqual(pids.filter(processAlive), pids);
		await h.dispose();
		assert.deepEqual(await waitUntilGone(pids), []);
	});

	it("kernels exit when the Pi process dies without a shutdown", async () => {
		const host = spawn(process.execPath, [join(PACKAGE_ROOT, "test", "fixtures", "crashing-host.ts")], { stdio: ["ignore", "pipe", "inherit"] });
		let output = "";
		host.stdout.on("data", (chunk) => (output += chunk));
		while (!output.includes("\n")) await sleep(100);
		const pids = output.trim().split(" ").map(Number);
		assert.equal(pids.length, 2);
		host.kill("SIGKILL");
		assert.deepEqual(await waitUntilGone(pids, 8000), []);
	});
});
