/**
 * Turns the frames of one cell into the tool result the model receives: one text block with
 * stdout, stderr, and display text in arrival order, followed by one image block per figure.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import type { DisplayFrame, OutputFrame } from "./kernel/kernel.ts";
import type { CellOutcome } from "./kernel/slot.ts";

/** What the model receives for one cell, plus where the untruncated text went. */
export interface ModelContent {
	content: Array<TextContent | ImageContent>;
	fullOutputPath: string | undefined;
}

export class CellOutput {
	private text = "";
	private readonly images: ImageContent[] = [];

	add(frame: OutputFrame): void {
		if (frame.type === "stream") return this.append(frame.text);
		this.addDisplay(frame);
	}

	get imageCount(): number {
		return this.images.length;
	}

	/** Text shown while the cell is still running. */
	preview(): string {
		return this.text;
	}

	/** Model-facing content: truncated text (full text spilled to a file) and the images. */
	content(outcome: CellOutcome): ModelContent {
		const { text, fullOutputPath } = truncateForModel(this.text);
		const notes = [truncationNote(fullOutputPath), ...outcomeNotes(outcome), this.emptyNote(outcome)];
		const joined = [text, ...notes].filter(Boolean).join("\n");
		return { content: [{ type: "text", text: joined }, ...this.images], fullOutputPath };
	}

	/** A display frame carries a text representation, a PNG, or both (a figure and its repr). */
	private addDisplay(frame: DisplayFrame): void {
		if (frame.text !== undefined) this.append(`${frame.text}\n`);
		if (frame.png) this.images.push({ type: "image", data: frame.png, mimeType: "image/png" });
	}

	private append(text: string): void {
		this.text += text;
	}

	/** A successful cell without text says so, so the model does not wait for output. */
	private emptyNote(outcome: CellOutcome): string {
		if (this.text.trim() || outcome.status !== "ok") return "";
		return describeImagesOnly(this.images.length);
	}
}

function describeImagesOnly(count: number): string {
	return count ? `(displayed ${count} image(s); no text output)` : "(no output)";
}

/** Keeps the tail of long output for the model and spills the full text to a file. */
function truncateForModel(text: string): { text: string; fullOutputPath: string | undefined } {
	const truncation = truncateTail(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const fullOutputPath = truncation.truncated ? spill(text) : undefined;
	return { text: truncation.content.trimEnd(), fullOutputPath };
}

function spill(text: string): string {
	const path = join(mkdtempSync(join(tmpdir(), "pi-eval-")), "output.txt");
	writeFileSync(path, text);
	return path;
}

function truncationNote(path: string | undefined): string {
	return path ? `[output truncated; full output: ${path}]` : "";
}

const STATUS_NOTES: Record<string, (outcome: CellOutcome) => string> = {
	ok: () => "",
	error: (outcome) => (outcome.error ? `[cell failed: ${outcome.error}]` : "[cell failed]"),
	cancelled: () => "[cell interrupted]",
	timeout: () => "[cell timed out and was interrupted]",
	killed: (outcome) => `[kernel died: ${outcome.error ?? "unknown reason"}]`,
};

const STOPPED = new Set(["cancelled", "timeout"]);

function stateNote(outcome: CellOutcome): string {
	if (outcome.stateLost) return "[kernel restarted: variables from earlier cells are gone]";
	return STOPPED.has(outcome.status) ? "[kernel state kept]" : "";
}

function outcomeNotes(outcome: CellOutcome): string[] {
	return [STATUS_NOTES[outcome.status](outcome), stateNote(outcome)];
}
