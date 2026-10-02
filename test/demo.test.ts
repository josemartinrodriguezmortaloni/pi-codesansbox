import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHarness, type Harness, imagesOf, js, py, textOf } from "./harness.ts";

const PNG_SIGNATURE = "89504e470d0a1a0a";
const isPng = (data: string): boolean => Buffer.from(data, "base64").subarray(0, 8).toString("hex") === PNG_SIGNATURE;

const CSV = ["month,region,revenue", "Jan,north,120", "Jan,south,80", "Feb,north,150", "Feb,south,95", "Mar,north,170", "Mar,south,130"].join("\n");

describe("reference demo", () => {
	let h: Harness;
	before(async () => {
		h = await createHarness();
		writeFileSync(join(h.cwd, "sales.csv"), CSV);
	});
	after(async () => {
		await h.dispose();
	});

	it("loads a CSV in Python with tool.read, charts it from JS, and the chart reaches the model", async () => {
		const [load, chart] = await h.run([
			py(`import csv, io, json
rows = list(csv.DictReader(io.StringIO(tool.read(path="sales.csv"))))
totals = {}
for row in rows:
    totals[row["month"]] = totals.get(row["month"], 0) + int(row["revenue"])
tool.write(path="totals.json", content=json.dumps(totals))
totals`),
			js(`const totals = JSON.parse(await tool.read({ path: "totals.json" }));
const entries = Object.entries(totals);
const max = Math.max(...entries.map(([, v]) => v));
const bars = entries.map(([month, v], i) => {
  const h = (v / max) * 200;
  return \`<rect x="\${40 + i * 90}" y="\${230 - h}" width="60" height="\${h}" fill="#4c78a8"/><text x="\${70 + i * 90}" y="250" text-anchor="middle" font-size="14">\${month}</text>\`;
}).join("");
await display.svg(\`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="260">\${bars}</svg>\`);
entries.length`),
		]);
		assert.equal(textOf(load), "{'Jan': 200, 'Feb': 245, 'Mar': 300}");
		assert.equal(textOf(chart), "3");
		const [image] = imagesOf(chart);
		assert.equal(image?.mimeType, "image/png");
		assert.ok(isPng(image.data));
		const lastContext = h.contexts.at(-1)!;
		const delivered = lastContext.messages.filter((message) => message.role === "toolResult").at(-1)!;
		assert.ok(imagesOf(delivered as any).some((block) => block.data === image.data), "chart image is in the model context");
	});

	it("shows matplotlib output like the reference TUI capture", async () => {
		const [cell] = await h.run([
			py(`import matplotlib.pyplot as plt, warnings
fig, (left, right) = plt.subplots(1, 2, figsize=(12, 7))
left.plot([1, 2, 3], [3, 1, 2]); right.bar(["a", "b"], [2, 5])
print("plotted 2 axes")
warnings.warn("The figure layout has changed to tight", UserWarning)
plt.show()
fig`),
		]);
		const text = textOf(cell);
		assert.match(text, /plotted 2 axes/);
		assert.match(text, /UserWarning: The figure layout has changed to tight/);
		assert.match(text, /<Figure size 1200x700 with 2 Axes>/);
		const images = imagesOf(cell);
		assert.equal(images.length, 1);
		assert.ok(isPng(images[0].data));
	});

	it("flushes figures that were never shown when the cell ends", async () => {
		const [cell] = await h.run([py("import matplotlib.pyplot as plt\nplt.plot([1, 2])\nNone")]);
		assert.equal(imagesOf(cell).length, 1);
		assert.match(textOf(cell), /displayed 1 image/);
	});
});
