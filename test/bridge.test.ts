import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Call, createHarness, type Harness, js, py, textOf } from "./harness.ts";

const SAMPLE = "id,name\n1,ä unicode ✓\n2,\"quoted, comma\"\n\ttabbed line\n";

describe("tool bridge", () => {
	let h: Harness;
	before(async () => {
		h = await createHarness();
		writeFileSync(join(h.cwd, "sample.csv"), SAMPLE);
	});
	after(async () => {
		await h.dispose();
	});

	it("tool.read returns the same text as Pi's read tool, from Python and JS", async () => {
		const readCall: Call = { name: "read", args: { path: "sample.csv" } };
		const [direct, fromPy, fromJs] = await h.run([
			readCall,
			py('print(tool.read(path="sample.csv"), end="")'),
			js('void process.stdout.write(await tool.read({ path: "sample.csv" }))'),
		]);
		assert.equal(direct.isError, false);
		assert.equal(textOf(fromPy), textOf(direct).trimEnd());
		assert.equal(textOf(fromJs), textOf(direct).trimEnd());
	});

	it("discovers the session's tools at run time in both kernels", async () => {
		const [fromPy, fromJs] = await h.run([
			py("sorted(t['name'] for t in list_tools())"),
			js("(await listTools()).map((t) => t.name).sort().join(',')"),
		]);
		for (const name of ["bash", "edit", "read", "write"]) {
			assert.match(textOf(fromPy), new RegExp(`'${name}'`));
			assert.match(textOf(fromJs), new RegExp(name));
		}
		assert.doesNotMatch(textOf(fromJs), /eval/);
	});

	it("reports failed nested calls as ToolError", async () => {
		const [fromPy, fromJs] = await h.run([
			py('try:\n    tool.read(path="missing.txt")\nexcept ToolError as e:\n    print("ToolError", "missing.txt" in str(e))'),
			js('try { await tool.read({ path: "missing.txt" }) } catch (e) { console.log(e.name, String(e.message).includes("missing.txt")) }'),
		]);
		assert.equal(textOf(fromPy), "ToolError True");
		assert.equal(textOf(fromJs), "ToolError true");
	});

	it("rejects bridge calls without the session token", async () => {
		const [cell] = await h.run([
			py(`import json, os, urllib.request, urllib.error
import sys
bridge = sys.modules["__pi_kernel__"]._BRIDGE
url = bridge["url"]
def status(headers):
    req = urllib.request.Request(url + "/v1/tools/call", data=json.dumps({"name": "read", "args": {"path": "sample.csv"}}).encode(), headers=headers, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
print(url.startswith("http://127.0.0.1:"), status({}), status({"Authorization": "Bearer wrong"}), status({"Authorization": "Bearer " + bridge["token"]}), bridge["token"] in open(f"/proc/{os.getpid()}/environ").read())`),
		]);
		assert.equal(textOf(cell), "True 401 401 200 False");
	});
});
