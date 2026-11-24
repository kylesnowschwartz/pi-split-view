import assert from "node:assert/strict";
import { test } from "node:test";
import { foldFor, offscreen, scrollFor } from "../filetree/fold.ts";
import { type FileNode, visibleRows } from "../filetree/model.ts";
import { CLOSE_INTERVAL_MS, HOLD_MS } from "../filetree/timing.ts";

/** A tree of `dirs` top-level folders (d0, d1, …), each with `files` files
 * and one sub-folder `sub` holding `files` files. Everything is listed. */
function tree(dirs: number, files: number): FileNode[] {
	const nodes: FileNode[] = [];
	const add = (id: string, kind: "dir" | "file") =>
		nodes.push({ id, parent: id.slice(0, id.lastIndexOf("/")), name: id.slice(id.lastIndexOf("/") + 1), kind, hidden: false, loaded: kind === "dir" });
	for (let d = 0; d < dirs; d++) {
		add(`/r/d${d}`, "dir");
		add(`/r/d${d}/sub`, "dir");
		for (let f = 0; f < files; f++) add(`/r/d${d}/sub/s${f}.ts`, "file");
		for (let f = 0; f < files; f++) add(`/r/d${d}/f${f}.ts`, "file");
	}
	return nodes;
}

const NODES = tree(4, 6);
const rowsOf = (expanded: ReadonlySet<string>) => visibleRows(NODES, "/r", expanded).map((r) => r.node.id);
const T0 = 100_000;

function fold(over: { expanded?: string[]; pinned: string[]; room?: number; now?: number; lastCloseAt?: number }) {
	return foldFor({
		expanded: new Set(over.expanded ?? []),
		pinned: over.pinned,
		root: "/r",
		room: over.room ?? 10,
		now: over.now ?? T0,
		lastCloseAt: over.lastCloseAt ?? Number.NEGATIVE_INFINITY,
		rowsOf,
	});
}
const open = (r: { expanded: Set<string> }) => [...r.expanded].sort();

test("fold: the folders above a pinned row open at once, even right after a close pass", () => {
	const r = fold({ pinned: ["/r/d2/sub/s3.ts"], lastCloseAt: T0 });
	assert.deepEqual(open(r), ["/r/d2", "/r/d2/sub"]);
	assert.deepEqual(r.closed, []);
	assert.equal(r.retryAt, null);
});

test("fold: nothing closes while the pinned rows fit, and folders opened by hand stay", () => {
	const r = fold({ expanded: ["/r/d0", "/r/d3"], pinned: ["/r/d1/f0.ts", "/r/d1/f4.ts"], room: 10 });
	assert.deepEqual(open(r), ["/r/d0", "/r/d1", "/r/d3"]);
	assert.deepEqual(r.closed, []);
});

test("fold: no pinned row means no change at all (a folder never closes by itself)", () => {
	const r = fold({ expanded: ["/r/d0", "/r/d0/sub", "/r/d1", "/r/d2", "/r/d3"], pinned: [], room: 3 });
	assert.deepEqual(open(r), ["/r/d0", "/r/d0/sub", "/r/d1", "/r/d2", "/r/d3"]);
	assert.deepEqual(r.closed, []);
	assert.equal(r.retryAt, null);
});

test("fold: when the pinned rows do not fit, the open folders between them with no pinned row below close", () => {
	// d0 and d3 hold the pinned rows; d1 and d2 (opened by hand) sit between them.
	const r = fold({
		expanded: ["/r/d0", "/r/d1", "/r/d1/sub", "/r/d2", "/r/d3"],
		pinned: ["/r/d0/f5.ts", "/r/d3/f0.ts"],
		room: 10,
	});
	assert.deepEqual(r.closed.sort(), ["/r/d1", "/r/d1/sub", "/r/d2"]);
	assert.deepEqual(open(r), ["/r/d0", "/r/d3"]);
	const rows = rowsOf(r.expanded);
	assert.ok(rows.indexOf("/r/d3/f0.ts") - rows.indexOf("/r/d0/f5.ts") + 1 <= 10);
});

test("fold (rule 2): a folder above a running or held row never closes, whatever the room", () => {
	// Three held rows in three far-apart folders, and a new running row: no
	// window of 5 rows holds them, and every open folder is above one of them.
	const pinned = ["/r/d0/sub/s0.ts", "/r/d1/sub/s0.ts", "/r/d2/sub/s0.ts", "/r/d3/sub/s5.ts"];
	const before = fold({ pinned: pinned.slice(0, 3), room: 5 });
	const r = fold({ expanded: [...before.expanded], pinned, room: 5, now: T0 + HOLD_MS - 1 });
	assert.deepEqual(open(r), ["/r/d0", "/r/d0/sub", "/r/d1", "/r/d1/sub", "/r/d2", "/r/d2/sub", "/r/d3", "/r/d3/sub"]);
	assert.deepEqual(r.closed, []);
	assert.equal(r.retryAt, null);
});

test("fold (rule 2): a folder whose rows left the hold stays open until room is needed, then may close", () => {
	const opened = ["/r/d0", "/r/d1", "/r/d1/sub", "/r/d2"];
	// The hold on d1 has ended; nothing is pinned: it stays open.
	assert.deepEqual(open(fold({ expanded: opened, pinned: [], room: 5 })), [...opened].sort());
	// One pinned row: it fits alone, so d1 still stays.
	assert.deepEqual(open(fold({ expanded: opened, pinned: ["/r/d0/f0.ts"], room: 5 })), [...opened].sort());
	// New activity on both sides of it needs the room: now it closes.
	const r = fold({ expanded: opened, pinned: ["/r/d0/f5.ts", "/r/d2/f0.ts"], room: 5 });
	assert.deepEqual(r.closed.sort(), ["/r/d1", "/r/d1/sub"]);
});

test("fold: open folders outside the span of the pinned rows are left alone", () => {
	const r = fold({
		expanded: ["/r/d0", "/r/d0/sub", "/r/d1", "/r/d2", "/r/d3", "/r/d3/sub"],
		pinned: ["/r/d1/f5.ts", "/r/d2/sub/s5.ts"],
		room: 4,
	});
	assert.ok(r.expanded.has("/r/d0") && r.expanded.has("/r/d0/sub") && r.expanded.has("/r/d3/sub"));
});

test("fold (rule 3): at most one close pass per interval; a paced pass says when to try again", () => {
	const input = {
		expanded: ["/r/d0", "/r/d1", "/r/d2", "/r/d3"],
		pinned: ["/r/d0/f5.ts", "/r/d3/f0.ts"],
		room: 10,
	};
	const early = fold({ ...input, now: T0 + CLOSE_INTERVAL_MS - 1, lastCloseAt: T0 });
	assert.deepEqual(early.closed, []);
	assert.deepEqual(open(early), ["/r/d0", "/r/d1", "/r/d2", "/r/d3"]);
	assert.equal(early.retryAt, T0 + CLOSE_INTERVAL_MS);
	const due = fold({ ...input, now: T0 + CLOSE_INTERVAL_MS, lastCloseAt: T0 });
	assert.deepEqual(due.closed.sort(), ["/r/d1", "/r/d2"]);
	assert.equal(due.retryAt, null);
});

test("fold (rule 3): opening for new activity is not paced", () => {
	const r = fold({
		expanded: ["/r/d0", "/r/d1", "/r/d2"],
		pinned: ["/r/d0/f5.ts", "/r/d3/sub/s0.ts"],
		room: 10,
		now: T0 + 1,
		lastCloseAt: T0,
	});
	assert.ok(r.expanded.has("/r/d3") && r.expanded.has("/r/d3/sub"));
	assert.deepEqual(r.closed, []);
	assert.equal(r.retryAt, T0 + CLOSE_INTERVAL_MS);
});

test("fold (rule 4): when nothing may close, the folders stay and no retry is asked for", () => {
	const r = fold({ expanded: [], pinned: ["/r/d0/sub/s0.ts", "/r/d0/f5.ts"], room: 3 });
	assert.deepEqual(open(r), ["/r/d0", "/r/d0/sub"]);
	assert.deepEqual(r.closed, []);
	assert.equal(r.retryAt, null);
});

test("scroll (rule 3): a target that is on screen never moves the window", () => {
	for (const target of [10, 15, 19]) {
		assert.equal(scrollFor({ from: 10, room: 10, total: 100, target, running: [target], held: [] }), 10);
	}
	// Other marked rows off screen do not move it either.
	assert.equal(scrollFor({ from: 10, room: 10, total: 100, target: 12, running: [12, 40], held: [2, 90] }), 10);
});

test("scroll: no marked row keeps the window, clamped to the rows there are", () => {
	assert.equal(scrollFor({ from: 7, room: 10, total: 100, target: -1, running: [], held: [] }), 7);
	assert.equal(scrollFor({ from: 95, room: 10, total: 30, target: -1, running: [], held: [] }), 20);
	assert.equal(scrollFor({ from: 5, room: 10, total: 4, target: -1, running: [], held: [] }), 0);
});

test("scroll: an off-screen target is brought in with the least movement", () => {
	assert.equal(scrollFor({ from: 0, room: 10, total: 100, target: 30, running: [30], held: [] }), 21);
	assert.equal(scrollFor({ from: 50, room: 10, total: 100, target: 30, running: [30], held: [] }), 30);
	assert.equal(scrollFor({ from: 0, room: 10, total: 100, target: 99, running: [99], held: [] }), 90);
});

test("scroll: the window that holds the target keeps the most running rows, then the most held rows", () => {
	// Target 30; running rows at 24 and 36 cannot both join it; 36 and 38 can.
	assert.equal(scrollFor({ from: 0, room: 10, total: 100, target: 30, running: [30, 24, 36, 38], held: [] }), 29);
	// With running equal, the window that also shows held rows wins.
	assert.equal(scrollFor({ from: 0, room: 10, total: 100, target: 30, running: [30], held: [37, 39] }), 30);
});

test("scroll (rule 4): when the marked rows cannot all fit, the newest running row is on screen and the rest are counted", () => {
	const running = [5, 60];
	const held = [20, 95];
	const from = scrollFor({ from: 0, room: 10, total: 100, target: 60, running, held });
	assert.ok(60 >= from && 60 < from + 10);
	assert.deepEqual(offscreen(from, 10, [...running, ...held]), { above: 2, below: 1 });
});

test("offscreen: rows in the window are not counted", () => {
	assert.deepEqual(offscreen(10, 10, [9, 10, 19, 20]), { above: 1, below: 1 });
	assert.deepEqual(offscreen(0, 10, []), { above: 0, below: 0 });
});
