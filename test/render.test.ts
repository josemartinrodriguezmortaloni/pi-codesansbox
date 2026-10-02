import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderCall, renderResult } from "../src/render.ts";

// highlightCode and keyHint read Pi's global theme; the renderer's own colors come from `theme`.
initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const strip = (lines: string[]): string => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");
const context = (expanded: boolean, isError = false) => ({ expanded, isError, lastComponent: undefined }) as any;

describe("TUI rendering", () => {
	it("shows the language, title, and highlighted code of a cell", () => {
		const component = renderCall({ language: "py", code: "x = 1\nprint(x)", title: "load data" }, theme, context(false));
		const text = strip(component.render(80));
		assert.match(text, /eval py load data/);
		assert.match(text, /x = 1\nprint\(x\)/);
	});

	it("shows the text output and collapses long output", () => {
		const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const result = { content: [{ type: "text" as const, text: output }], details: undefined };
		const collapsed = strip(renderResult(result, { expanded: false, isPartial: false }, theme, context(false)).render(80));
		assert.match(collapsed, /line 19\n.*20 more lines/);
		const expanded = strip(renderResult(result, { expanded: true, isPartial: false }, theme, context(true)).render(80));
		assert.match(expanded, /line 39/);
	});
});
