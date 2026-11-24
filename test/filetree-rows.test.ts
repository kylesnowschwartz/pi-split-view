import assert from "node:assert/strict";
import { test } from "node:test";
import { type GitState, NO_GIT } from "../filetree/git.ts";
import type { Row } from "../filetree/model.ts";
import { type PaneTheme, renderRow, type RowContext, type RowMark, shadeAt, shimmer } from "../filetree/rows.ts";

/** A theme that tags each styled span, so a test reads the roles used. */
const theme: PaneTheme = {
	fg: (role, text) => `<${role}>${text}</>`,
	bg: (role, text) => `[${role}]${text}`,
	bold: (text) => `*${text}*`,
	strikethrough: (text) => text,
};
const plain = (s: string) =>
	s.replace(/<[a-zA-Z]+>|<\/>|\*|\[selectedBg\]|\x1b\[[0-9;]*m/g, "");

const row = (id: string, kind: "file" | "dir", depth = 0, open = false): Row => ({
	node: { id, parent: id.slice(0, id.lastIndexOf("/")), name: id.slice(id.lastIndexOf("/") + 1), kind, hidden: false, loaded: false },
	depth,
	open,
});

function ctx(over: Partial<RowContext> = {}, git: Partial<GitState> = {}, marks: Record<string, RowMark> = {}): RowContext {
	return {
		theme,
		root: "/r",
		git: { ...NO_GIT, ...git },
		ignored: new Set(),
		untracked: new Set(),
		selected: "",
		width: 30,
		tick: 0,
		mark: (id) => marks[id],
		badge: (tool) => ({ icon: `{${tool}}`, ansiColor: `\x1b[38;5;${tool.length}m` }),
		widthOf: (s) => Array.from(plain(s)).length,
		truncate: (s, w) => (Array.from(s).length > w ? `${Array.from(s).slice(0, w - 1).join("")}…` : s),
		...over,
	};
}

test("a row fills the width exactly: name on the left, line changes and the git letter on the right", () => {
	const line = renderRow(row("/r/src/a.ts", "file", 1), ctx({}, { git: { "/r/src/a.ts": "M" }, diff: { "/r/src/a.ts": { added: 12, removed: 3 } } }));
	assert.equal(Array.from(plain(line)).length, 30);
	assert.match(plain(line), /^ {4}. a\.ts +\+12 -3 M$/);
	assert.match(line, /<warning>a\.ts<\/>/);
	assert.match(line, /<toolDiffAdded> \+12<\/><toolDiffRemoved> -3<\/>/);
});

test("a long name is cut to the room left of the right column", () => {
	const line = renderRow(row("/r/a-very-long-file-name-that-does-not-fit.ts", "file"), ctx({ width: 20 }, { git: { "/r/a-very-long-file-name-that-does-not-fit.ts": "?" } }));
	assert.equal(Array.from(plain(line)).length, 20);
	assert.match(plain(line), /… \?$/);
});

test("a folder shows its letter and totals only while closed", () => {
	const git = { folderStatus: { "/r/src": "M" as const }, git: { "/r/src": "M" as const }, diff: { "/r/src": { added: 5, removed: 0 } } };
	assert.match(plain(renderRow(row("/r/src", "dir"), ctx({}, git))), /^▸ . src +\+5 M$/);
	const open = renderRow(row("/r/src", "dir", 0, true), ctx({}, git));
	assert.match(plain(open), /^▾ . src +$/);
	assert.match(open, /<warning>src<\/>/);
});

test("a file below an untracked folder reads as untracked, and an ignored file is dim", () => {
	const untracked = renderRow(row("/r/new/a.ts", "file", 1), ctx({ untracked: new Set(["/r/new"]) }));
	assert.match(untracked, /<success>a\.ts<\/>/);
	assert.match(plain(untracked), / \?$/);
	assert.match(renderRow(row("/r/dist/x.js", "file", 1), ctx({ ignored: new Set(["/r/dist"]) })), /<dim>x\.js<\/>/);
});

test("the selected row is bold on the selection background", () => {
	const line = renderRow(row("/r/a.ts", "file"), ctx({ selected: "/r/a.ts" }));
	assert.match(line, /^\[selectedBg\]/);
	assert.match(line, /\*<text>a\.ts<\/>\*/);
});

const C = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};
const mark = (over: Partial<RowMark>): RowMark => ({ state: "recent", kind: "read", tool: "read", error: false, shimmer: false, ...over });

test("a running row carries the tool's icon, a bar in its tone, and a bold name whose band moves with the frame", () => {
	const marks = { "/r/a.ts": mark({ state: "running", kind: "write", tool: "edit", shimmer: true }) };
	const a = renderRow(row("/r/a.ts", "file"), ctx({ tick: 4 }, {}, marks));
	const b = renderRow(row("/r/a.ts", "file"), ctx({ tick: 5 }, {}, marks));
	assert.match(a, /\x1b\[38;5;4m\{edit\}/);
	assert.ok(a.includes(`*${C("#fb923c")}▌`));
	assert.ok(a.includes(C("#ffedd5")), "the band's peak shade is on the name");
	assert.notEqual(a, b);
	assert.equal(plain(a), plain(b));
});

test("a recent row is bold in the tone of its kind over its git color: read purple, write orange, bash green", () => {
	const of = (m: RowMark) => renderRow(row("/r/a.ts", "file"), ctx({}, { git: { "/r/a.ts": "M" } }, { "/r/a.ts": m }));
	const read = of(mark({ tool: "grep" }));
	assert.ok(read.includes(`*${C("#c084fc")}a.ts`));
	assert.doesNotMatch(read, /<warning>a\.ts/);
	assert.ok(of(mark({ kind: "write", tool: "edit" })).includes(`*${C("#fb923c")}a.ts`));
	assert.ok(of(mark({ kind: "bash", tool: "bash" })).includes(`*${C("#4ade80")}a.ts`));
});

test("a recent row shimmers while its mark says so, then holds one shade", () => {
	const of = (m: RowMark, tick: number) => renderRow(row("/r/a.ts", "file"), ctx({ tick }, {}, { "/r/a.ts": m }));
	assert.notEqual(of(mark({ shimmer: true }), 3), of(mark({ shimmer: true }), 5));
	assert.equal(of(mark({}), 3), of(mark({}), 5));
});

test("a failed row is red with a cross; a marked folder has its caret in the tone", () => {
	const failed = renderRow(row("/r/a.ts", "file"), ctx({}, {}, { "/r/a.ts": mark({ error: true }) }));
	assert.ok(failed.includes(`*${C("#f87171")}✗`));
	assert.ok(failed.includes(`*${C("#f87171")}a.ts`));
	const dir = renderRow(row("/r/src", "dir", 0, true), ctx({}, {}, { "/r/src": mark({ tool: "grep" }) }));
	assert.ok(dir.includes(`*${C("#c084fc")}▾`));
});

test("a light theme uses the darker shades", () => {
	const line = renderRow(row("/r/a.ts", "file"), ctx({ theme: { ...theme, appearance: "light" } }, {}, { "/r/a.ts": mark({}) }));
	assert.ok(line.includes(C("#7e22ce")));
});

test("shimmer: the band enters before the first character and leaves after the last", () => {
	const shades = ["0", "1", "2", "3"].map((d) => `#00000${d}`);
	const levels = (tick: number) =>
		[...shimmer("abcdef", shades, tick).matchAll(/38;2;0;0;(\d)m([a-f]+)/g)].map((m) => m[1]!.repeat(m[2]!.length)).join("");
	assert.equal(levels(0), "000000");
	assert.equal(levels(2), "210000");
	assert.equal(levels(4), "123210");
	assert.equal(levels(6), "000123");
	assert.equal(levels(9), "000000");
	assert.equal(shadeAt(2, 2), 3);
	assert.equal(shadeAt(0, 4), 0);
});
