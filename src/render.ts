/**
 * TUI rendering of `eval` calls: the cell code with syntax highlighting, then its text output.
 * Image blocks of the result are drawn inline by Pi's ToolExecutionComponent, not here.
 */
import { highlightCode, keyHint, type Theme, type ToolDefinition, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { EvalDetails, EvalParams } from "./eval-tool.ts";

/** Pi passes this context to renderers but does not export its type. */
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const CODE_PREVIEW_LINES = 12;
const OUTPUT_PREVIEW_LINES = 20;
const HIGHLIGHT_LANGUAGE = { py: "python", js: "javascript" } as const;

function previewLines(lines: string[], limit: number, expanded: boolean, theme: Theme): string {
	if (expanded || lines.length <= limit) return lines.join("\n");
	const hint = `${theme.fg("muted", `... (${lines.length - limit} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	return [...lines.slice(0, limit), hint].join("\n");
}

function container(context: ToolRenderContext): Container {
	const component = (context.lastComponent as Container | undefined) ?? new Container();
	component.clear();
	return component;
}

export function renderCall(args: EvalParams, theme: Theme, context: ToolRenderContext): Container {
	const component = container(context);
	const label = args.title ? ` ${theme.fg("muted", args.title)}` : "";
	component.addChild(new Text(`${theme.fg("toolTitle", theme.bold(`eval ${args.language ?? ""}`))}${label}`, 0, 0));
	const code = (args.code ?? "").replace(/\t/g, "    ").trimEnd();
	const lines = highlightCode(code, HIGHLIGHT_LANGUAGE[args.language] ?? "text");
	component.addChild(new Text(previewLines(lines, CODE_PREVIEW_LINES, context.expanded, theme), 0, 0));
	return component;
}

export function renderResult(
	result: AgentToolResult<EvalDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Container {
	const component = container(context);
	const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const color = context.isError ? "error" : "toolOutput";
	const lines = text.replace(/\t/g, "    ").split("\n").map((line) => theme.fg(color, line));
	component.addChild(new Spacer(1));
	component.addChild(new Text(previewLines(lines, OUTPUT_PREVIEW_LINES, options.expanded, theme), 0, 0));
	return component;
}
