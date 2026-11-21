/**
 * helpers.ts — pure, side-effect-free helpers for split-view.ts (unit-tested
 * in test/helpers.test.ts). No pi imports at runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import * as path from "node:path";

/** True if c is a UTF-16 high (lead) surrogate. */
export function isHighSurrogate(c: number): boolean {
	return c >= 0xd800 && c <= 0xdbff;
}

/** True if c is a UTF-16 low (trail) surrogate. */
export function isLowSurrogate(c: number): boolean {
	return c >= 0xdc00 && c <= 0xdfff;
}

/** Collapse whitespace and cut to `max` UTF-16 units with an ellipsis,
 * never ending mid surrogate pair. */
export function truncateInline(s: string, max = 40): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let end = max - 1;
	if (end >= 1 && isHighSurrogate(flat.charCodeAt(end - 1))) end--;
	return flat.slice(0, end) + "…";
}

/** SV-16: storage cap for one tool's text (args JSON or result output). */
export const MAX_TOOL_TEXT_CHARS = 32 * 1024;

/** SV-16: keep the NEWEST suffix within the cap, prefixed by a truncation
 * marker; the cut is code-point aligned. Text within the cap is unchanged. */
export function capToolText(s: string, cap = MAX_TOOL_TEXT_CHARS): string {
	if (s.length <= cap) return s;
	const marker = `[truncated: newest ${cap} of ${s.length} chars]\n`;
	const budget = cap - marker.length;
	let end = s.length;
	let units = 0;
	while (end > 0 && units < budget) {
		const w = end >= 2 && isHighSurrogate(s.charCodeAt(end - 2)) ? 2 : 1;
		if (units + w > budget) break;
		units += w;
		end -= w;
	}
	return marker + s.slice(end);
}

/** Band split minimums (cols) below which the tools ratio clamps. */
export const MIN_THINK_COLS = 24;
export const MIN_TOOLS_COLS = 20;

/** Tools panel width (cols) for a band of `total` cols at `pct` percent,
 * with minimum clamps; falls back to the raw ratio when both minimums
 * cannot hold. */
export function bandToolsColsFor(total: number, pct: number): number {
	const raw = Math.round((total * pct) / 100);
	let toolsW = raw;
	let thinkW = total - toolsW;
	if (toolsW < MIN_TOOLS_COLS) {
		toolsW = MIN_TOOLS_COLS;
		thinkW = total - toolsW;
	}
	if (thinkW < MIN_THINK_COLS) {
		thinkW = MIN_THINK_COLS;
		toolsW = total - thinkW;
	}
	if (toolsW < MIN_TOOLS_COLS) toolsW = raw;
	return toolsW;
}

export const MIN_DOCK_COLS = 24;
/** Columns the transcript side keeps when the files dock is resized. */
export const DOCK_LEFT_RESERVE = 50;

/** Files dock width: auto = 25% clamped to 34–48 cols; a manual width is
 * clamped to [MIN_DOCK_COLS, cols - DOCK_LEFT_RESERVE]. */
export function dockColsFor(cols: number, manual: number | null = null): number {
	if (manual === null) return Math.max(34, Math.min(48, Math.floor(cols * 0.25)));
	const max = Math.max(MIN_DOCK_COLS, cols - DOCK_LEFT_RESERVE);
	return Math.max(MIN_DOCK_COLS, Math.min(max, Math.trunc(manual)));
}

/** Compact duration: 0.4s · 2.3s · 42s · 3m05s · 1h02m. `live` drops the
 * sub-second digit so a running counter ticks once per second. */
export function formatDuration(ms: number, live = false): string {
	const t = Math.max(0, ms);
	if (t < 10_000 && !live) return `${(Math.floor(t / 100) / 10).toFixed(1)}s`;
	const s = Math.floor(t / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Append a streamed delta to a newline-free tail, moving completed lines
 * into `lines` (mutated). Lines are split BEFORE the tail is capped, so a
 * large delta never loses complete lines. When the tail exceeds `maxTail` it
 * drops its older half (code-point aligned) in one step instead of sliding by
 * a few chars per delta — a sliding cut would re-flow every wrapped row of
 * the visible paragraph on each flush. Returns the new tail.
 */
export function appendStreamTail(
	lines: string[],
	tail: string,
	delta: string,
	maxTail: number,
): string {
	let t = tail + delta;
	let nl = t.indexOf("\n");
	while (nl !== -1) {
		const seg = t.slice(0, nl);
		lines.push(seg.endsWith("\r") ? seg.slice(0, -1) : seg);
		t = t.slice(nl + 1);
		nl = t.indexOf("\n");
	}
	if (t.length > maxTail) {
		let start = t.length - Math.floor(maxTail / 2);
		if (isLowSurrogate(t.charCodeAt(start))) start++;
		t = t.slice(start);
	}
	return t;
}

/** Cap one display line to its newest `max` UTF-16 units ("… " prefix). */
export function capDisplayLine(line: string, max: number): string {
	if (line.length <= max) return line;
	let start = line.length - (max - 2);
	if (isLowSurrogate(line.charCodeAt(start))) start++;
	return "… " + line.slice(start);
}

/** One inline-image block of a tool result (base64 data + MIME type). */
export interface ImageBlock {
	data: string;
	mimeType: string;
}

/** The LAST image block of a tool result's content, if any. Content is
 * either a plain string or an array of blocks; only well-formed image blocks
 * (string `data` + `mimeType`) count. Keeping the last one matches how pi's
 * transcript renders results (one image per `read`; rare multi-image results
 * keep the most recent). */
export function lastImageBlock(content: unknown): ImageBlock | undefined {
	if (!Array.isArray(content)) return undefined;
	for (let i = content.length - 1; i >= 0; i--) {
		const c = content[i] as any;
		if (
			c?.type === "image" &&
			typeof c.data === "string" &&
			typeof c.mimeType === "string"
		)
			return { data: c.data, mimeType: c.mimeType };
	}
	return undefined;
}

/** The first `cap` lines of an already-trimmed output list, plus how many
 * lines were hidden (for the "+N more" marker). `cap <= 0` shows nothing. */
export function outputPreview(
	lines: string[],
	cap: number,
): { shown: string[]; hidden: number } {
	if (cap <= 0 || lines.length === 0) return { shown: [], hidden: lines.length };
	const shown = lines.slice(0, cap);
	return { shown, hidden: lines.length - shown.length };
}

/** Head+tail preview: the first `head` lines, a hidden count, and the last
 * `tail` lines, so a running command's fresh tail stays visible while the
 * start of the output is not lost. When everything fits, `head` is the whole
 * list and `tail` is empty (no line is duplicated). `total` is the real line
 * count when `lines` is only a stored window of a longer output (defaults to
 * `lines.length`), so `hidden` counts what is really not shown. The caller
 * renders the "+N more" marker between `head` and `tail`. */
export function headTailPreview(
	lines: string[],
	head: number,
	tail: number,
	total = lines.length,
): { head: string[]; hidden: number; tail: string[] } {
	total = Math.max(total, lines.length);
	if (lines.length <= head + tail)
		return { head: lines.slice(), hidden: total - lines.length, tail: [] };
	return {
		head: lines.slice(0, head),
		hidden: total - head - tail,
		tail: lines.slice(lines.length - tail),
	};
}

/** True if `s` was cut by capToolText (it starts with the truncation marker),
 * i.e. its first line is the marker, not the output's real first line. */
export function isCappedToolText(s: string): boolean {
	return s.startsWith("[truncated: newest ");
}

/** Live-output view of a streaming tool: the last `max` lines of its raw
 * output, shaped for a terminal-like panel. Unlike the trimmed previews it
 * keeps indentation and blank lines; it drops escape sequences and control
 * characters (a raw stream can carry colours or cursor moves that would
 * corrupt the frame), keeps only what follows the last carriage return of a
 * line (progress bars redraw with \r), expands tabs to 8-column stops and
 * drops trailing blank lines. `hidden` counts the earlier lines left out. */
export function liveTailLines(text: string, max: number): { lines: string[]; hidden: number } {
	const all = text.split("\n");
	while (all.length > 0 && all[all.length - 1].trim() === "") all.pop();
	const start = Math.max(0, all.length - Math.max(0, max));
	const lines = all.slice(start).map((raw) => {
		const seg = raw
			// CSI (colours, cursor moves) and OSC (titles, hyperlinks) sequences.
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			.split("\r")
			.filter((p) => p !== "")
			.pop() ?? "";
		let out = "";
		for (const ch of seg.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")) {
			if (ch === "\t") out += " ".repeat(8 - (out.length % 8));
			else out += ch;
		}
		return out.trimEnd();
	});
	return { lines, hidden: start };
}

/** SV-27: the reasoning of the current turn. `turns` is the conversation in
 * order; the result is every thought that follows the last user message, so a
 * resumed or branch-switched session reconstructs the same slice the "turn"
 * scope keeps live. With no user message yet, the whole sequence is one turn. */
export function thoughtsSinceLastUser(
	turns: ReadonlyArray<{ isUser: boolean; thoughts: readonly string[] }>,
): string[] {
	let start = 0;
	for (let i = turns.length - 1; i >= 0; i--) {
		if (turns[i]?.isUser) {
			start = i + 1;
			break;
		}
	}
	const out: string[] = [];
	for (let i = start; i < turns.length; i++) {
		for (const thought of turns[i]?.thoughts ?? []) out.push(thought);
	}
	return out;
}

/** pi auto-discovers every *.ts in an extensions dir; no-op factory. */
/** As much of a pi transcript component as `keepsInResponseOnly` reads. */
export interface TranscriptChild {
	constructor: { name: string };
	lastMessage?: { content?: unknown };
}

/**
 * Whether response-only mode with responseSource "transcript" draws a child
 * of pi's transcript: everything but tool calls (the Tool Usage panel owns
 * those) and assistant messages with no text, which would draw only a
 * thinking label or nothing.
 */
export function keepsInResponseOnly(child: TranscriptChild): boolean {
	const kind = child?.constructor?.name;
	if (kind === "ToolExecutionComponent") return false;
	if (kind !== "AssistantMessageComponent") return true;
	const content = child.lastMessage?.content;
	if (!Array.isArray(content)) return true;
	return content.some(
		(part: any) =>
			part?.type === "text" && typeof part.text === "string" && part.text.trim(),
	);
}

/** Most values one shell variable can stand for in bashPathCandidates. */
const MAX_VARIABLE_VALUES = 64;

/** Strip the quotes and punctuation a shell word carries around a path. */
function bareWord(raw: string): string {
	return raw.replace(/^[("'`]+/, "").replace(/[)"'`;:,]+$/, "");
}

/** A leading `~` or `~/` becomes the home directory. */
function expandHome(word: string, home: string): string {
	if (word === "~") return home;
	return word.startsWith("~/") ? path.join(home, word.slice(2)) : word;
}

/** Every reading of `word` once its `$name` and `${name}` references are
 * replaced by the known values. Empty when a reference is unknown. */
function expandVariables(word: string, variables: Map<string, string[]>): string[] {
	let readings = [word];
	const reference = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/;
	for (;;) {
		const match = reference.exec(readings[0]!);
		if (!match) return readings;
		const values = variables.get(match[1] ?? match[2]!);
		if (!values) return [];
		readings = readings.flatMap((reading) =>
			values.map((value) => reading.replace(match[0], () => value)),
		);
		if (readings.length > MAX_VARIABLE_VALUES) return [];
	}
}

/**
 * Absolute paths that the words of a bash command may name. The caller keeps
 * the ones that are files.
 *
 * Words resolve against the directory the command is in at that point: `cwd`,
 * then the target of each `cd`. A leading `~` is the home directory. A
 * `name=value` assignment and the word list of a `for name in …` loop give
 * `$name` its values, so `cat $f.md` in a loop names one file per loop word.
 * Words with globs, redirects, or a variable of unknown value are skipped.
 */
export function bashPathCandidates(command: string, cwd: string, home: string): string[] {
	const out: string[] = [];
	const variables = new Map<string, string[]>();
	const literal = (word: string) => !/[|&><`$*?]/.test(word);
	let dir = cwd;
	for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
		const words = segment.split(/\s+/).map(bareWord).filter(Boolean);
		while (["do", "then", "else", "{", "("].includes(words[0] ?? "")) words.shift();
		if (words[0] === "cd") {
			const targets = words[1] ? expandVariables(words[1], variables) : [home];
			if (targets.length === 1 && literal(targets[0]!) && targets[0] !== "-")
				dir = path.resolve(dir, expandHome(targets[0]!, home));
			continue;
		}
		if (words[0] === "for" && words[2] === "in") {
			const values = words.slice(3).flatMap((word) => expandVariables(word, variables));
			if (values.length > 0 && values.length <= MAX_VARIABLE_VALUES && values.every(literal))
				variables.set(words[1]!, values);
			else variables.delete(words[1]!);
			continue;
		}
		for (const word of words) {
			const assignment = /^([A-Za-z_]\w*)=(.*)$/.exec(word);
			if (assignment) {
				const values = expandVariables(bareWord(assignment[2]!), variables);
				if (values.length > 0 && values.every(literal)) variables.set(assignment[1]!, values);
				else variables.delete(assignment[1]!);
				continue;
			}
			if (word.startsWith("-")) continue;
			for (const reading of expandVariables(word, variables)) {
				if (!literal(reading)) continue;
				out.push(path.resolve(dir, expandHome(reading, home)));
			}
		}
	}
	return out;
}

/**
 * Row budget for the Files panel (list + optional Last Edit diff subpanel).
 * The diff section is shown only when both enabled (`showDiff`) and an edit
 * diff actually exists (`hasEditDiff`); otherwise all rows go to the file list.
 */
export function filesPanelRowBudget(
	height: number,
	showDiff: boolean,
	hasEditDiff: boolean,
): { showDiffSection: boolean; listRows: number; diffRows: number } {
	const showDiffSection = showDiff && hasEditDiff;
	if (!showDiffSection) {
		return {
			showDiffSection: false,
			listRows: Math.max(1, height - 4),
			diffRows: 0,
		};
	}
	const half = Math.max(6, Math.floor(height / 2));
	const listRows = Math.max(2, half - 4);
	const diffRows = Math.max(0, height - listRows - 6);
	return { showDiffSection: true, listRows, diffRows };
}

function shortenHomePath(p: string): string {
	const home = homedir();
	if (!home) return p;
	if (p === home) return "~";
	const prefix = home.endsWith(path.sep) ? home : home + path.sep;
	if (p.startsWith(prefix)) return "~/" + p.slice(prefix.length);
	return p;
}

/**
 * Concise single-line summary of a tool call's arguments for tool headers.
 * Parses JSON when possible and extracts tool-specific key fields (`path`,
 * `command`, `pattern`, `description`/`tasks`, or primitive `key=val` pairs),
 * falling back to `truncateInline(rawArgs, maxChars)` on non-JSON.
 */
export function formatToolArgSummary(
	toolName: string,
	rawArgs: string,
	maxChars = 60,
): string {
	if (!rawArgs || !rawArgs.trim()) return "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawArgs);
	} catch {
		return truncateInline(rawArgs, maxChars);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return truncateInline(rawArgs, maxChars);
	}
	const obj = parsed as Record<string, unknown>;
	const lower = toolName.toLowerCase();

	if (lower === "read" || lower === "write" || lower === "edit") {
		const p = typeof obj.path === "string" ? obj.path.trim() : "";
		if (p) {
			let summary = shortenHomePath(p);
			if (lower === "read") {
				const hasOffset = typeof obj.offset === "number" && Number.isFinite(obj.offset);
				const hasLimit = typeof obj.limit === "number" && Number.isFinite(obj.limit);
				if (hasOffset && hasLimit) {
					const offset = obj.offset as number;
					const limit = obj.limit as number;
					summary += limit > 0 ? `:${offset}-${offset + limit - 1}` : `:${offset} (limit ${limit})`;
				} else if (hasOffset) {
					summary += `:${obj.offset}`;
				} else if (hasLimit) {
					summary += ` (limit ${obj.limit})`;
				}
			}
			return truncateInline(summary, maxChars);
		}
	} else if (lower === "bash") {
		const cmd = typeof obj.command === "string" ? obj.command.trim() : "";
		if (cmd) return truncateInline(cmd, maxChars);
	} else if (lower === "grep" || lower === "find" || lower === "ls") {
		const pattern = typeof obj.pattern === "string" ? obj.pattern.trim() : "";
		const p = typeof obj.path === "string" ? obj.path.trim() : "";
		if (pattern && p) return truncateInline(`${pattern} ${shortenHomePath(p)}`, maxChars);
		if (pattern) return truncateInline(pattern, maxChars);
		if (p) return truncateInline(shortenHomePath(p), maxChars);
	} else if (lower === "agent") {
		const desc = typeof obj.description === "string" ? obj.description.trim() : "";
		if (desc) return truncateInline(desc, maxChars);
		if (Array.isArray(obj.tasks)) {
			const n = obj.tasks.length;
			return truncateInline(`${n} ${n === 1 ? "task" : "tasks"}`, maxChars);
		}
	}

	const keys = Object.keys(obj);
	if (keys.length === 0) return "";
	const parts: string[] = [];
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			const s = typeof v === "string" ? truncateInline(v, 24) : String(v);
			parts.push(`${k}=${s}`);
			if (parts.length >= 4) break;
		}
	}
	if (parts.length > 0) return truncateInline(parts.join(" "), maxChars);
	return truncateInline(rawArgs, maxChars);
}

const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function isBlankAnsiLine(line: string): boolean {
	if (line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) return false;
	return line.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "").trim() === "";
}

/** Trim blank or ANSI-only-whitespace lines from the start and end of `lines`. */
export function stripLeadingTrailingBlankLines(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length && isBlankAnsiLine(lines[start]!)) start++;
	let end = lines.length - 1;
	while (end >= start && isBlankAnsiLine(lines[end]!)) end--;
	return start > end ? [] : lines.slice(start, end + 1);
}

export default function (_pi: ExtensionAPI) {
	/* shared helper module, not a real extension */
}
