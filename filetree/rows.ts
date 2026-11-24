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
	/** The row's name moves: the call runs, or it ended a moment ago. */
	shimmer: boolean;
};

/** A tool's badge: its 1-cell icon and the ANSI code of its color. */
export type Badge = { icon: string; ansiColor: string };

/** The color family of a marked row. */
export type Tone = "purple" | "orange" | "green" | "red";

/** Four shades per tone, from the base color to the peak of the shimmer
 * band. `bright` reads on a dark background, `dim` on a light one. */
const TONES: Record<Tone, { bright: string[]; dim: string[] }> = {
	purple: { bright: ["#a855f7", "#c084fc", "#d8b4fe", "#f3e8ff"], dim: ["#6b21a8", "#7e22ce", "#9333ea", "#c084fc"] },
	orange: { bright: ["#f97316", "#fb923c", "#fdba74", "#ffedd5"], dim: ["#9a3412", "#c2410c", "#ea580c", "#fb923c"] },
	green: { bright: ["#22c55e", "#4ade80", "#86efac", "#dcfce7"], dim: ["#166534", "#15803d", "#16a34a", "#4ade80"] },
	red: { bright: ["#ef4444", "#f87171", "#fca5a5", "#fee2e2"], dim: ["#991b1b", "#b91c1c", "#dc2626", "#f87171"] },
};

/** Reads and searches are purple, writes orange, changes a bash command made
 * green, and a failed call red. */
export function toneOf(mark: Pick<RowMark, "kind" | "error">): Tone {
	if (mark.error) return "red";
	return mark.kind === "read" ? "purple" : mark.kind === "write" ? "orange" : "green";
}

/** The four shades of a tone for the theme's background. */
export function shadesOf(tone: Tone, theme: PaneTheme): string[] {
	return theme.appearance === "light" ? TONES[tone].dim : TONES[tone].bright;
}

/** The ANSI foreground code of a "#rrggbb" color. */
function fgCode(hex: string): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/** `text` in one shade, with the foreground color ended after it. */
export function inShade(hex: string, text: string): string {
	return `${fgCode(hex)}${text}${RESET}`;
}

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

/** Columns the band travels before the first character and after the last. */
const BAND_LEAD = 4;

/** The shade index of character `i` when the band's peak is at `peak`: the
 * peak is the lightest shade, and each column away from it is one shade
 * closer to the base. */
export function shadeAt(i: number, peak: number): number {
	const d = Math.abs(i - peak);
	return d < 1 ? 3 : d < 2 ? 2 : d < 3 ? 1 : 0;
}

/** `name` in a tone's base shade with a lighter band at the frame's
 * position. The band enters before the first character and leaves after the
 * last. */
export function shimmer(name: string, shades: string[], tick: number): string {
	const chars = Array.from(name);
	const period = chars.length + 2 * BAND_LEAD;
	const peak = (((tick * 1.5) % period) + period) % period - BAND_LEAD;
	let out = "";
	let run = "";
	let runShade = -1;
	chars.forEach((ch, i) => {
		const shade = shadeAt(i, peak);
		if (shade !== runShade && run) {
			out += inShade(shades[runShade] ?? "", run);
			run = "";
		}
		runShade = shade;
		run += ch;
	});
	if (run) out += inShade(shades[runShade] ?? "", run);
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

	// A marked row has a bar in its tone in the caret column (a cross when
	// the call failed); a marked folder has its caret in the tone.
	const shades = mark ? shadesOf(toneOf(mark), th) : undefined;
	const solid = shades?.[1] ?? "";
	const failed = mark?.state === "recent" && mark.error;
	const caretGlyph = n.kind === "dir" ? (r.open ? "▾" : "▸") : failed ? "✗" : mark ? "▌" : " ";
	const caret = `${mark ? th.bold(inShade(solid, caretGlyph)) : th.fg("muted", caretGlyph)} `;
	const glyph = fileIcon(n, r.open, n.kind === "dir" && n.id === ctx.git.top);
	const fixed = ctx.widthOf(indent) + 2 + 2;
	const room = Math.max(1, ctx.width - fixed - ctx.widthOf(right));
	const name = ctx.widthOf(n.name) > room ? ctx.truncate(n.name, room) : n.name;

	let icon: string;
	let label: string;
	if (mark && shades) {
		// A running row has its tool's icon; the name is bold in the tone and
		// shimmers while the mark says so.
		if (mark.state === "running") {
			const badge = ctx.badge(mark.tool);
			icon = `${badge.ansiColor}${badge.icon}${RESET}`;
		} else icon = inShade(solid, glyph);
		label = th.bold(mark.shimmer ? shimmer(name, shades, ctx.tick) : inShade(solid, name));
	} else {
		const quiet = isIgnored ? "dim" : n.hidden ? "muted" : undefined;
		icon = th.fg(quiet ?? gitRole ?? (n.kind === "dir" ? "accent" : "muted"), glyph);
		const role = quiet ?? gitRole ?? "text";
		label = th.fg(role, name);
	}
	if (selected && !mark) label = th.bold(label);

	const left = `${indent}${caret}${icon} ${label}`;
	const gap = " ".repeat(Math.max(0, ctx.width - ctx.widthOf(left) - ctx.widthOf(right)));
	const line = `${left}${gap}${right}`;
	return selected ? th.bg("selectedBg", line) : line;
}
