import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { PACKAGE_ROOT, processAlive } from "./harness.ts";

const PI = process.env.PI_BIN ?? "pi";

describe("pi CLI", () => {
	it("loads the package, runs both kernels, and leaves no processes after exit", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-eval-cli-"));
		const cwd = join(root, "work");
		mkdirSync(cwd);
		writeFileSync(join(cwd, "note.txt"), "hello from note");
		try {
			const run = spawnSync(
				PI,
				["--offline", "-ne", "-e", PACKAGE_ROOT, "-e", join(PACKAGE_ROOT, "test", "fixtures", "faux-cli-provider.ts"),
					"--provider", "faux-eval", "--model", "faux-1", "--mode", "json", "go"],
				{ cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") } },
			);
			assert.equal(run.status, 0, run.stderr);
			const ends = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
				.filter((event) => event.type === "tool_execution_end" && event.toolName === "eval");
			assert.equal(ends.length, 2, run.stdout.slice(0, 2000));
			const texts = ends.map((event) => event.result.content[0].text as string);
			for (const text of texts) assert.match(text, /^\d+ hello from note$/);
			const pids = texts.map((text) => Number(text.split(" ")[0]));
			await sleep(500);
			assert.deepEqual(pids.filter(processAlive), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
