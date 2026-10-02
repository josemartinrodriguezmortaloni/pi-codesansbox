import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, type Harness, imagesOf, js, py, textOf } from "./harness.ts";

describe("eval tool", () => {
	let h: Harness;
	before(async () => {
		h = await createHarness();
	});
	after(async () => {
		await h.dispose();
	});

	it("is loaded from the package and declared to the model", () => {
		const session = h.runtime.session;
		assert.ok(session.getActiveToolNames().includes("eval"));
		const tool = session.getAllTools().find((candidate) => candidate.name === "eval");
		assert.equal(tool?.exposure, "model-only");
		const language = (tool?.parameters as any).properties.language;
		assert.deepEqual(language.anyOf.map((option: { const: string }) => option.const), ["py", "js"]);
	});

	it("keeps Python variables between cells", async () => {
		const [first, second] = await h.run([py("x = 41\nprint('defined')"), py("x + 1")]);
		assert.equal(textOf(first), "defined");
		assert.equal(textOf(second), "42");
	});

	it("keeps JavaScript bindings between cells", async () => {
		const [first, second, third] = await h.run([
			js("const x = 41; let y = 1; class Box { constructor(v) { this.v = v } }; function inc(n) { return n + y }"),
			js("const z = await Promise.resolve(inc(x)); new Box(z).v"),
			js("const x = 'redeclared'; [x, z]"),
		]);
		assert.equal(first.isError, false, textOf(first));
		assert.equal(textOf(second), "42");
		assert.equal(textOf(third), "[ 'redeclared', 42 ]");
	});

	it("turns static imports and exports into persistent bindings", async () => {
		writeFileSync(join(h.cwd, "helper.mjs"), "export const double = (n) => n * 2;\n");
		const [, second] = await h.run([
			js('import { join as joinPath } from "node:path"; import { double } from "./helper.mjs"; export const base = 21;'),
			js('[joinPath("a", "b"), double(base)]'),
		]);
		assert.equal(textOf(second), "[ 'a/b', 42 ]");
	});

	it("shows images returned by nested tool calls", async () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		writeFileSync(join(h.cwd, "pixel.png"), Buffer.from(png, "base64"));
		const [fromPy, fromJs] = await h.run([py('tool.read(path="pixel.png") and None'), js('void await tool.read({ path: "pixel.png" })')]);
		assert.equal(imagesOf(fromPy).length, 1, textOf(fromPy));
		assert.equal(imagesOf(fromJs).length, 1, textOf(fromJs));
	});

	it("reports Python errors with the cell traceback and keeps the kernel", async () => {
		const [failed, after] = await h.run([py("def boom():\n    raise ValueError('bad')\nboom()"), py("x")]);
		assert.equal(failed.isError, true);
		assert.match(textOf(failed), /File "<cell-\d+>", line 2, in boom/);
		assert.match(textOf(failed), /ValueError: bad/);
		assert.doesNotMatch(textOf(failed), /runner\.py/);
		assert.equal(textOf(after), "41");
	});
});
