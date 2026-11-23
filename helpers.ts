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

/** True when text is raw internal agent notification XML (<task-notification> or <progress-warning>). */
export function isInternalNotificationText(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed.startsWith("<task-notification>") ||
		trimmed.startsWith("<progress-warning>")
	);
}

/** pi auto-discovers every *.ts in an extensions dir; no-op factory. */
/** As much of a pi transcript component as `keepsInResponseOnly` reads. */
export interface TranscriptChild {
	constructor: { name: string };
	lastMessage?: { content?: unknown };
	text?: unknown;
}

/**
 * Whether response-only mode with responseSource "transcript" draws a child
 * of pi's transcript: everything but tool calls (the Tool Usage panel owns
 * those), internal task-notification/progress-warning user messages, and
 * assistant messages with no text, which would draw only a thinking label or
 * nothing.
 */
export function keepsInResponseOnly(child: TranscriptChild): boolean {
	const kind = child?.constructor?.name;
	if (kind === "ToolExecutionComponent") return false;
	if (kind === "UserMessageComponent") {
		const text = (child as any).text;
		if (typeof text === "string" && isInternalNotificationText(text))
			return false;
		return true;
	}
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

/** Global override for tool card expansion in the Tools panel. */
export type ToolExpandGlobal = "all" | "none" | null;

/**
 * Whether a tool card in the Tools panel should render expanded.
 * Precedence: per-tool override > zoomed tools panel > global override >
 * default (active/running tools and errors stay expanded; clean completed
 * tools auto-collapse).
 */
export function isToolExpanded(
	entry: { id: string; active: boolean; isError: boolean },
	overrides: ReadonlyMap<string, boolean>,
	globalOverride: ToolExpandGlobal,
	zoomedTools = false,
): boolean {
	if (overrides.has(entry.id)) return overrides.get(entry.id)!;
	if (zoomedTools) return true;
	if (globalOverride === "all") return true;
	if (globalOverride === "none") return false;
	return entry.active || entry.isError;
}

export type ThinkingTokenKind =
	| "plain"
	| "heading"
	| "code"
	| "path"
	| "tool"
	| "error"
	| "caution"
	| "verify"
	| "plan"
	| "hypothesis";

export interface ThinkingToken {
	kind: ThinkingTokenKind;
	text: string;
}

export type ThinkingPalette = Record<ThinkingTokenKind, (text: string) => string>;

const THINKING_TOOL_NAMES = new Set<string>([
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"Agent",
	"codemode",
	"ask_user",
	"SendMessage",
	"TaskOutput",
	"TaskStop",
]);

const THINKING_PATH_EXT =
	"ts|tsx|js|jsx|mjs|cjs|json|md|py|rb|go|rs|sh|yml|yaml|toml|css|html|sql|txt|jsonl";

/**
 * Single-pass left-to-right tokenizer regex for thinking lines.
 * Capture groups correspond to priority order:
 *  1: heading (**...**)
 *  2: code (`...`)
 *  3: URL passthrough (kept plain so URL substrings never match path/keywords)
 *  4: path (explicit ~/ ./ ../ /dir/file, known extensions, or multi-segment/trailing-slash paths)
 *  5: error
 *  6: caution
 *  7: verify
 *  8: plan
 *  9: hypothesis
 * 10: tool (exact-case checked against THINKING_TOOL_NAMES)
 */
const THINKING_TOKEN_RE = new RegExp(
	[
		`(\\*\\*[^*\\n]+\\*\\*)`,
		`(\`[^\`\\n]+\`)`,
		`(https?:\\/\\/[^\\s)>"'\\]]+)`,
		`((?<![:/\\.\\w-])(?:(?:~\\/|\\.\\.?\\/)[\\w.@-]+(?:\\/[\\w.@-]+)*\\/?|\\/[\\w.@-]+(?:\\/[\\w.@-]+)+\\/?|\\/[\\w.@-]+\\.(?:${THINKING_PATH_EXT})\\b|(?:[\\w.@-]+\\/)*[\\w.@-]+\\.(?:${THINKING_PATH_EXT})\\b|[\\w.@-]+(?:\\/[\\w.@-]+){2,}\\/?(?![\\w./-])|[\\w.@-]+(?:\\/[\\w.@-]+)*\\/(?![\\w./-])))`,
		`(\\b(?:bug|bugs|error|errors|fail|fails|failed|failure|broken|crash|exception|wrong|invalid)\\b)`,
		`(\\b(?:wait|actually|however|instead|careful|risk|blocker|caveat|warning|problem|issue|backtrack|missed|conflict|stuck)\\b)`,
		`(\\b(?:verify|verified|verifying|confirm|confirmed|check|checked|checking|test|tests|testing|passed|passing|validate|validated|proven|evidence)\\b)`,
		`(\\b(?:plan|planning|approach|strategy|decide|decided|decision|next|goal|step|steps|implement|refactor|design)\\b)`,
		`(\\b(?:maybe|might|probably|possibly|assuming|assumption|hypothesis|unclear|unknown|wonder|suspect|likely)\\b)`,
		`(\\b(?:bash|read|edit|write|grep|find|ls|Agent|codemode|ask_user|SendMessage|TaskOutput|TaskStop)\\b)`,
	].join("|"),
	"gi",
);

/**
 * Tokenize a single line of Thinking text into non-overlapping semantic spans.
 * Pre-styled lines containing ANSI CSI escapes (`\x1b[`) are returned untouched
 * as a single `"plain"` token. Concatenating all token `.text` values is
 * guaranteed to equal `line`.
 */
export function tokenizeThinkingLine(line: string): ThinkingToken[] {
	if (line.includes("\x1b[")) return [{ kind: "plain", text: line }];
	const tokens: ThinkingToken[] = [];
	const push = (kind: ThinkingTokenKind, text: string) => {
		if (!text) return;
		const prev = tokens[tokens.length - 1];
		if (kind === "plain" && prev?.kind === "plain") {
			prev.text += text;
		} else {
			tokens.push({ kind, text });
		}
	};
	let lastIndex = 0;
	THINKING_TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = THINKING_TOKEN_RE.exec(line)) !== null) {
		if (m.index > lastIndex) {
			push("plain", line.slice(lastIndex, m.index));
		}
		const text = m[0];
		let kind: ThinkingTokenKind = "plain";
		if (m[1] !== undefined) kind = "heading";
		else if (m[2] !== undefined) kind = "code";
		else if (m[3] !== undefined) kind = "plain";
		else if (m[4] !== undefined) kind = "path";
		else if (m[5] !== undefined) kind = "error";
		else if (m[6] !== undefined) kind = "caution";
		else if (m[7] !== undefined) kind = "verify";
		else if (m[8] !== undefined) kind = "plan";
		else if (m[9] !== undefined) kind = "hypothesis";
		else if (m[10] !== undefined) {
			kind = THINKING_TOOL_NAMES.has(text) ? "tool" : "plain";
		}
		push(kind, text);
		lastIndex = m.index + text.length;
	}
	if (lastIndex < line.length) {
		push("plain", line.slice(lastIndex));
	}
	return tokens;
}

/** Apply `palette` functions to each semantic token of `line` and join. */
export function styleThinkingLine(line: string, palette: ThinkingPalette): string {
	return tokenizeThinkingLine(line)
		.map((token) => palette[token.kind](token.text))
		.join("");
}

// ─── turn pagination helpers ─────────────────────────────────────────────────

export interface TurnSpan {
	turn: number;
	startRow: number;
	endRow: number;
}

/**
 * Return sorted ascending unique `turn` values whose `[startRow, endRow)`
 * overlaps the viewport `[scrollTop, scrollTop + Math.max(1, viewportHeight))`.
 * If `spans` is empty, returns `[]`. If nothing overlaps, returns the first
 * turn when `scrollTop < spans[0].startRow`, else the last turn.
 */
/**
 * Align rendered turn spans against totalTurns across compaction boundaries:
 * - If `spans.length < totalTurns` (post-compaction tail rendered), right-align to `totalTurns`.
 * - If `spans.length > totalTurns` (pre-compaction messages still in chatContainer while
 *   reconstruct tracks active context entries), keep the trailing `totalTurns` spans numbered 1..totalTurns.
 */
export function alignTurnSpans(
	spans: readonly TurnSpan[],
	totalTurns: number,
): TurnSpan[] {
	if (spans.length === 0 || totalTurns <= 0) return [];
	if (spans.length > totalTurns) {
		const tail = spans.slice(spans.length - totalTurns);
		return tail.map((s, idx) => ({
			turn: idx + 1,
			startRow: s.startRow,
			endRow: s.endRow,
		}));
	}
	if (spans.length === totalTurns) {
		return spans.map((s) => ({ ...s }));
	}
	const offset = totalTurns - spans.length;
	return spans.map((s) => ({
		turn: s.turn + offset,
		startRow: s.startRow,
		endRow: s.endRow,
	}));
}

export function visibleTurnsInViewport(
	spans: readonly TurnSpan[],
	scrollTop: number,
	viewportHeight: number,
): number[] {
	if (spans.length === 0) return [];
	const vpEnd = scrollTop + Math.max(1, viewportHeight);
	const seen = new Set<number>();
	for (const span of spans) {
		if (span.endRow > scrollTop && span.startRow < vpEnd) {
			seen.add(span.turn);
		}
	}
	if (seen.size > 0) {
		return [...seen].sort((a, b) => a - b);
	}
	return scrollTop < spans[0]!.startRow
		? [spans[0]!.turn]
		: [spans[spans.length - 1]!.turn];
}

export type ToolsScope = "visible" | "turn" | "all";

/**
 * Resolve which 1-indexed turn(s) should be displayed in the Tool Usage and
 * Thinking panels, or `null` to show all turns.
 */
export function selectActiveTurns(opts: {
	scope: ToolsScope;
	totalTurns: number;
	pinnedTurn: number | null;
	visibleTurns: readonly number[];
}): number[] | null {
	const { scope, totalTurns, pinnedTurn, visibleTurns } = opts;
	if (scope === "all" && pinnedTurn === null) return null;
	if (totalTurns <= 0) return [];
	if (pinnedTurn !== null) {
		const clamped = Math.max(1, Math.min(totalTurns, Math.trunc(pinnedTurn)));
		return [clamped];
	}
	if (scope === "visible" && visibleTurns.length > 0) {
		const seen = new Set<number>();
		for (const t of visibleTurns) {
			const n = Math.trunc(t);
			if (n >= 1 && n <= totalTurns) seen.add(n);
		}
		if (seen.size > 0) {
			return [...seen].sort((a, b) => a - b);
		}
	}
	return [totalTurns];
}

export interface PagerButtonRange {
	start: number;
	end: number;
}

export interface ToolsPagerLayout {
	prev: PagerButtonRange;
	next: PagerButtonRange;
	toggle: PagerButtonRange & { text: "[All]" | "[Sync]" };
	label: string;
	fillCols: number;
}

/**
 * Compute exact column coordinates for the tools panel bottom-frame turn pager:
 * `╰─[◀] <label> [▶]─[All]──…──[▶]─╯` (or `…──╯` without the live button).
 * Shared by both rendering and mouse hit-testing.
 */
export function toolsPagerButtons(
	width: number,
	label: string,
	scope: ToolsScope,
	hasLiveButton: boolean,
): ToolsPagerLayout | null {
	if (width < 30) return null;
	const toggleText: "[All]" | "[Sync]" = scope === "all" ? "[Sync]" : "[All]";
	const rightReserved = hasLiveButton ? 5 : 1; // "[▶]─╯" or "╯"
	const minFill = hasLiveButton ? 1 : 0;
	// Fixed prefix/controls: "╰─" (2) + "[◀]" (3) + " " (1) + " " (1) + "[▶]" (3) + "─" (1) + toggleText
	const fixedCols = 11 + toggleText.length;
	const maxLabelLen = width - rightReserved - minFill - fixedCols;
	if (maxLabelLen < 3) return null;
	const displayLabel =
		label.length > maxLabelLen ? label.slice(0, maxLabelLen) : label;

	const prev: PagerButtonRange = { start: 2, end: 5 };
	const nextStart = 5 + displayLabel.length + 2;
	const next: PagerButtonRange = { start: nextStart, end: nextStart + 3 };
	const toggleStart = next.end + 1;
	const toggle = {
		start: toggleStart,
		end: toggleStart + toggleText.length,
		text: toggleText,
	};
	const fillCols = width - rightReserved - toggle.end;
	return { prev, next, toggle, label: displayLabel, fillCols };
}

export interface DrawerHeightInput {
	open: boolean;
	height: number;
}

export interface DrawerHeightResult {
	thinking: number;
	tools: number;
}

/**
 * Clamp expanded drawer heights so Messages always keeps at least `minMessages`
 * rows and the editor keeps at least `editorReserve` rows.
 */
export function computeDrawerHeights(
	rows: number,
	thinking: DrawerHeightInput,
	tools: DrawerHeightInput,
	minMessages = 6,
	editorReserve = 6,
	minOpenHeight = 5,
): DrawerHeightResult {
	const tReq = thinking.open
		? Math.max(minOpenHeight, Math.min(30, thinking.height))
		: 1;
	const uReq = tools.open
		? Math.max(minOpenHeight, Math.min(30, tools.height))
		: 1;
	const budget = Math.max(2, rows - minMessages - editorReserve);
	if (tReq + uReq <= budget) {
		return { thinking: tReq, tools: uReq };
	}
	if (thinking.open && tools.open) {
		const minBoth = minOpenHeight * 2;
		if (budget <= minBoth) {
			const half = Math.max(1, Math.floor(budget / 2));
			return { thinking: half, tools: Math.max(1, budget - half) };
		}
		const ratio = tReq / (tReq + uReq);
		const tH = Math.max(
			minOpenHeight,
			Math.min(budget - minOpenHeight, Math.round(budget * ratio)),
		);
		return { thinking: tH, tools: Math.max(minOpenHeight, budget - tH) };
	}
	if (thinking.open) {
		return { thinking: Math.max(1, Math.min(tReq, budget - 1)), tools: 1 };
	}
	if (tools.open) {
		return { thinking: 1, tools: Math.max(1, Math.min(uReq, budget - 1)) };
	}
	return { thinking: 1, tools: 1 };
}

export interface DrawerBarSpan {
	start: number;
	end: number;
}

export interface DrawerBarLayout {
	showButtons: boolean;
	leftToggle: DrawerBarSpan | null;
	zoom: DrawerBarSpan | null;
	toggle: DrawerBarSpan | null;
	pager: {
		prev: DrawerBarSpan;
		next: DrawerBarSpan;
		toggle: DrawerBarSpan;
		label: string;
		toggleText: string;
	} | null;
	/** Columns available for the left title + summary text (between ╭ and fill). */
	labelRoom: number;
	/** Column where the pager starts (or null if no pager). */
	pagerStart: number | null;
}

/**
 * Pure column geometry for a 1-row DrawerHeader (shared by render and mouse
 * hit-testing so click targets always match painted cells).
 * Layout: `╭<label>─…─[◀] <pagerLabel> [▶]─[All]─[↗][▸]╮`
 */
export function drawerBarLayout(
	width: number,
	opts: {
		showPager: boolean;
		pagerLabel?: string;
		pagerToggleText?: string;
		minLabelCols?: number;
		leftToggleCols?: number;
	},
): DrawerBarLayout {
	const contentWidth = Math.max(1, width - 2);
	const showButtons = contentWidth >= 16;
	const zoom: DrawerBarSpan | null = showButtons
		? { start: width - 7, end: width - 4 }
		: null;
	const toggle: DrawerBarSpan | null = showButtons
		? { start: width - 4, end: width - 1 }
		: null;
	const buttonsWidth = showButtons ? 6 : 0;

	let pager: DrawerBarLayout["pager"] = null;
	let pagerStart: number | null = null;
	let pagerWidth = 0;

	if (opts.showPager && opts.pagerLabel && opts.pagerToggleText) {
		const labelText = ` ${opts.pagerLabel} `;
		const toggleText = opts.pagerToggleText;
		// `[◀]`(3) + labelText + `[▶]`(3) + `─`(1) + toggleText + `─`(1)
		const needed = 3 + labelText.length + 3 + 1 + toggleText.length + 1;
		const minLabel = opts.minLabelCols ?? 18;
		if (contentWidth - buttonsWidth - needed >= minLabel) {
			pagerWidth = needed;
			const start = width - 1 - buttonsWidth - needed;
			pagerStart = start;
			const prev: DrawerBarSpan = { start, end: start + 3 };
			const nextStart = prev.end + labelText.length;
			const next: DrawerBarSpan = { start: nextStart, end: nextStart + 3 };
			const toggleStart = next.end + 1;
			const pToggle: DrawerBarSpan = {
				start: toggleStart,
				end: toggleStart + toggleText.length,
			};
			pager = {
				prev,
				next,
				toggle: pToggle,
				label: opts.pagerLabel,
				toggleText,
			};
		}
	}

	const labelRoom = Math.max(1, contentWidth - buttonsWidth - pagerWidth);
	const leftCols = Math.max(0, Math.min(labelRoom, opts.leftToggleCols ?? 0));
	const leftToggle: DrawerBarSpan | null =
		leftCols > 0 ? { start: 1, end: 1 + leftCols } : null;
	return { showButtons, leftToggle, zoom, toggle, pager, labelRoom, pagerStart };
}

export interface ToolHudBadge {
	/** 1-cell Nerd Font icon (matching tail-claude-mux waterfall glyphs). */
	icon: string;
	/** 24-bit ANSI foreground escape for Catppuccin Mocha (dark) or Latte (light). */
	ansiColor: string;
	/** True when the tool name should still be printed after the icon (custom/MCP tools). */
	showName: boolean;
}

const COMPACT_ICON_TOOLS = new Set([
	"bash",
	"run",
	"shell",
	"read",
	"grep",
	"find",
	"ls",
	"glob",
	"edit",
	"write",
	"notebookedit",
	"agent",
	"task",
]);

/**
 * Map a tool name to its 1-cell Nerd Font HUD badge and Catppuccin color
 * (reusing tail-claude-mux's waterfall glyph + palette vocabulary).
 */
export function toolHudBadge(name: string, light = false): ToolHudBadge {
	const lower = name.trim().toLowerCase();
	// Catppuccin Mocha (dark) vs Latte (light) 24-bit foreground codes.
	const blue = light ? "\x1b[38;2;30;102;245m" : "\x1b[38;2;137;180;250m";
	const peach = light ? "\x1b[38;2;254;100;11m" : "\x1b[38;2;250;179;135m";
	const green = light ? "\x1b[38;2;64;160;43m" : "\x1b[38;2;166;227;161m";
	const teal = light ? "\x1b[38;2;23;146;153m" : "\x1b[38;2;148;226;213m";
	const mauve = light ? "\x1b[38;2;136;57;239m" : "\x1b[38;2;203;166;247m";

	const showName = !COMPACT_ICON_TOOLS.has(lower);

	if (
		lower === "read" ||
		lower === "grep" ||
		lower === "find" ||
		lower === "ls" ||
		lower === "glob" ||
		lower === "search"
	) {
		return { icon: "\uE28B", ansiColor: blue, showName }; // nf-fae-book_open_o
	}
	if (lower === "edit" || lower === "write" || lower === "notebookedit") {
		return { icon: "\uEE75", ansiColor: peach, showName }; // nf-fa-pen_nib
	}
	if (lower === "bash" || lower === "run" || lower === "shell") {
		return { icon: "\u{F0BE0}", ansiColor: green, showName }; // nf-md-wrench_outline
	}
	if (
		lower === "agent" ||
		lower === "task" ||
		lower === "sendmessage" ||
		lower === "listpeers" ||
		lower === "taskoutput" ||
		lower === "taskstop" ||
		lower === "skill"
	) {
		return { icon: "\u{F167A}", ansiColor: mauve, showName }; // nf-md-robot_outline
	}
	return { icon: "\u{F059F}", ansiColor: teal, showName }; // nf-md-web
}

export default function (_pi: ExtensionAPI) {
	/* shared helper module, not a real extension */
}
