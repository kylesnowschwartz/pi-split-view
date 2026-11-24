import assert from "node:assert/strict";
import { test } from "node:test";
import { type GitState, NO_GIT } from "../filetree/git.ts";
import type { Row } from "../filetree/model.ts";
import { type PaneTheme, renderRow, type RowContext, type RowMark, shimmer } from "../filetree/rows.ts";

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

test("a running row carries the tool's icon and color, and its band moves with the frame", () => {
	const marks = { "/r/a.ts": { state: "running", kind: "write", tool: "edit", error: false } as RowMark };
	const a = renderRow(row("/r/a.ts", "file"), ctx({ tick: 1 }, {}, marks));
	const b = renderRow(row("/r/a.ts", "file"), ctx({ tick: 3 }, {}, marks));
	assert.match(a, /\x1b\[38;5;4m\{edit\}/);
	assert.notEqual(a, b);
	assert.equal(plain(a), plain(b));
});

test("a recent row holds the tone of its kind; a failed one is in the error role with a cross", () => {
	const ok = renderRow(row("/r/a.ts", "file"), ctx({}, { git: { "/r/a.ts": "M" } }, { "/r/a.ts": { state: "recent", kind: "read", tool: "grep", error: false } }));
	assert.match(ok, /\x1b\[38;5;4ma\.ts/);
	assert.doesNotMatch(ok, /<warning>a\.ts/);
	const bash = renderRow(row("/r/a.ts", "file"), ctx({}, {}, { "/r/a.ts": { state: "recent", kind: "bash", tool: "bash", error: false } }));
	assert.match(bash, /\x1b\[38;5;4ma\.ts/);
	const failed = renderRow(row("/r/a.ts", "file"), ctx({}, {}, { "/r/a.ts": { state: "recent", kind: "read", tool: "read", error: true } }));
	assert.match(failed, /<error>✗<\/>/);
	assert.match(failed, /<error>a\.ts<\/>/);
});

test("shimmer: the band enters at the first character and leaves after the last", () => {
	const th: PaneTheme = { ...theme, bold: (t) => `B(${t})`, fg: (_r, t) => t };
	const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
	assert.equal(strip(shimmer("abcdef", "", 0, th)), "B(a)bcdef");
	assert.equal(strip(shimmer("abcdef", "", 3, th)), "aB(bcd)ef");
	assert.equal(strip(shimmer("abcdef", "", 7, th)), "abcdeB(f)");
	assert.equal(strip(shimmer("abcdef", "", 9, th)), "abcdef");
});
