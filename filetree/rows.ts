/** One tree row as a styled line. */

import type { GitLetter, GitState } from "./git.ts";
import { fileIcon } from "./icons.ts";
import type { Row } from "./model.ts";
import { dirname, underAny } from "./paths.ts";

/** Theme roles the file tree draws with. pi's Theme satisfies this shape. */
export type PaneRole =
	| "accent"
	| "border"
	| "dim"
	| "error"
	| "muted"
	| "success"
	| "text"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "warning";

export interface PaneTheme {
	fg(role: PaneRole, text: string): string;
	bg(role: "selectedBg", text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
	appearance?: string;
}

/** What a tool call did to a row: read or search, write, or a change a bash
 * command made (confirmed by git). */
export type MarkKind = "read" | "write" | "bash";

/** The live state of a row. */
export type RowMark = {
	/** running: a call that names the row is in progress. recent: the call
	 * ended and the row is inside its hold time. */
	state: "running" | "recent";
	kind: MarkKind;
	/** The tool of the call; it picks the icon and color of a running row. */
	tool: string;
	/** The call failed. */
	error: boolean;
};

/** A tool's badge: its 1-cell icon and the ANSI code of its color. */
export type Badge = { icon: string; ansiColor: string };

/** The tool whose badge color is the steady tone of each kind. */
export const TONE_TOOL: Record<MarkKind, string> = { read: "read", write: "edit", bash: "bash" };

export interface RowContext {
	theme: PaneTheme;
	root: string;
	git: GitState;
	ignored: Set<string>;
	untracked: Set<string>;
	selected: string;
	width: number;
	/** Animation frame counter. */
	tick: number;
	mark(id: string): RowMark | undefined;
	badge(tool: string): Badge;
	/** Display width of a string, and a string cut to a display width. */
	widthOf(text: string): number;
	truncate(text: string, width: number): string;
}

/** Ends a foreground color and leaves the background and weight in place. */
const RESET = "\x1b[39m";

const GIT_ROLE: Record<GitLetter, PaneRole> = {
	U: "error",
	D: "error",
	M: "warning",
	T: "warning",
	A: "success",
	"?": "success",
	R: "accent",
	C: "accent",
};

/** Width of the bright band that travels over a running row's name. */
const BAND = 3;

/** `name` in the tool's color with a bright band at the frame's position. */
export function shimmer(name: string, color: string, tick: number, theme: PaneTheme): string {
	const chars = Array.from(name);
	const period = chars.length + BAND + 4;
	const head = ((tick % period) + period) % period;
	let out = "";
	let run = "";
	let runBright = false;
	const flush = () => {
		if (!run) return;
		out += runBright ? theme.bold(theme.fg("text", run)) : `${color}${run}${RESET}`;
		run = "";
	};
	chars.forEach((ch, i) => {
		const bright = i <= head && i > head - BAND;
		if (bright !== runBright) {
			flush();
			runBright = bright;
		}
		run += ch;
	});
	flush();
	return out;
}

/** The row at `ctx.width` columns: indent, caret, icon and name on the left;
 * line changes and the git letter on the right. */
export function renderRow(r: Row, ctx: RowContext): string {
	const th = ctx.theme;
	const n = r.node;
	const indent = "  ".repeat(r.depth);
	if (r.note) return ctx.truncate(`${indent}  ${th.fg("dim", r.note)}`, ctx.width);

	const own = ctx.git.git[n.id];
	const status = own ?? (underAny(dirname(n.id), ctx.untracked, ctx.root) ? "?" : undefined);
	// A folder is colored by its folder letter, open or closed; it shows the
	// letter and its line totals only while closed.
	const letter = n.kind === "dir" ? (ctx.git.folderStatus[n.id] ?? status) : status;
	const isIgnored = !letter && underAny(n.id, ctx.ignored, ctx.root);
	const gitRole = letter ? GIT_ROLE[letter] : undefined;
	const shut = n.kind !== "dir" || !r.open;
	const mark = ctx.mark(n.id);
	const selected = n.id === ctx.selected;

	const loc = shut ? ctx.git.diff[n.id] : undefined;
	let right = "";
	if (loc && loc.added > 0) right += th.fg("toolDiffAdded", ` +${loc.added}`);
	if (loc && loc.removed > 0) right += th.fg("toolDiffRemoved", ` -${loc.removed}`);
	right += shut && letter && gitRole ? ` ${th.bold(th.fg(gitRole, letter))}` : "  ";

	const failed = mark?.state === "recent" && mark.error;
	const caret =
		n.kind === "dir"
			? `${th.fg("muted", r.open ? "▾" : "▸")} `
			: failed
				? `${th.fg("error", "✗")} `
				: "  ";
	const glyph = fileIcon(n, r.open, n.kind === "dir" && n.id === ctx.git.top);
	const fixed = ctx.widthOf(indent) + 2 + 2;
	const room = Math.max(1, ctx.width - fixed - ctx.widthOf(right));
	const name = ctx.widthOf(n.name) > room ? ctx.truncate(n.name, room) : n.name;

	let icon: string;
	let label: string;
	if (mark?.state === "running") {
		const badge = ctx.badge(mark.tool);
		icon = `${badge.ansiColor}${badge.icon}${RESET}`;
		label = shimmer(name, badge.ansiColor, ctx.tick, th);
	} else if (mark) {
		const tone = mark.error ? undefined : ctx.badge(TONE_TOOL[mark.kind]).ansiColor;
		const paint = (s: string) => (tone ? `${tone}${s}${RESET}` : th.fg("error", s));
		icon = paint(glyph);
		label = paint(name);
	} else {
		const quiet = isIgnored ? "dim" : n.hidden ? "muted" : undefined;
		icon = th.fg(quiet ?? gitRole ?? (n.kind === "dir" ? "accent" : "muted"), glyph);
		const role = quiet ?? gitRole ?? "text";
		label = th.fg(role, name);
	}
	if (selected) label = th.bold(label);

	const left = `${indent}${caret}${icon} ${label}`;
	const gap = " ".repeat(Math.max(0, ctx.width - ctx.widthOf(left) - ctx.widthOf(right)));
	const line = `${left}${gap}${right}`;
	return selected ? th.bg("selectedBg", line) : line;
}
