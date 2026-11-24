import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { TreeController } from "../filetree/controller.ts";
import { type PaneModel, TreePane } from "../filetree/pane.ts";
import type { PaneTheme } from "../filetree/rows.ts";
import { MAX_TREE_WIDTH, MIN_TREE_WIDTH, paneWidthFor } from "../filetree/viewport.ts";
import { fakeIo, type World } from "./filetree-world.ts";

const theme: PaneTheme = {
	fg: (_role, text) => text,
	bg: (_role, text) => text,
	bold: (text) => text,
	strikethrough: (text) => text,
};

const COLS = 160;
const HEIGHT = 12;

/** A pane over a real controller: 30 files, 10 rows of room. */
async function make() {
	const w: World = { dirs: { "/r": Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, "0")}.ts`, "file"] as [string, "file"]) } };
	const tree = new TreeController(fakeIo(w), { changed: () => {}, visible: () => true });
	await tree.start("/r");
	const state = { width: 36, footerClicks: 0 };
	const model: PaneModel = {
		theme: () => theme,
		widthOf: (s) => Array.from(s).length,
		truncate: (s, width) => Array.from(s).slice(0, width).join(""),
		height: () => HEIGHT,
		header: () => " r",
		footer: () => (tree.selected ? ` ${tree.selected} ` : ""),
		body: (_width, room) => {
			const win = tree.window(room);
			return { lines: win.rows.map((r) => r.node.name), from: win.from, total: win.total, above: win.above, below: win.below };
		},
		clickRow: (index) => tree.clickRow(index),
		clickFooter: () => {
			state.footerClicks++;
			tree.select("");
		},
		wheel: (delta) => tree.wheel(delta),
		resize: (width) => {
			state.width = paneWidthFor(width, COLS);
		},
	};
	const pane = new TreePane(model);
	const ev = (type: TuiMouseEvent["type"], x: number, y: number, over: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
		type,
		button: type === "wheel" ? "none" : "left",
		x,
		y,
		// The pane's left border sits at this terminal column.
		screenX: COLS - state.width + x,
		screenY: y,
		width: state.width,
		height: HEIGHT,
		shift: false,
		alt: false,
		ctrl: false,
		...over,
	});
	const click = (x: number, y: number) => {
		pane.handleMouse(ev("press", x, y));
		pane.handleMouse(ev("release", x, y));
		return pane.handleMouse(ev("click", x, y));
	};
	return { tree, pane, state, ev, click };
}

test("the pane draws a frame of the model's height around the rows", async () => {
	const { pane } = await make();
	const lines = pane.render(36);
	assert.equal(lines.length, HEIGHT);
	assert.match(lines[0]!, /^╭ Files r ─+╮$/);
	assert.match(lines[1]!, /^│f00\.ts +[│┃]$/);
	assert.match(lines[HEIGHT - 1]!, /^╰─+╯$/);
	for (const line of lines) assert.equal(Array.from(line).length, 36);
});

test("a click on a row selects that row, also after a scroll offset", async () => {
	const { tree, pane, click, ev } = await make();
	pane.render(36);
	click(5, 1);
	assert.equal(tree.selected, "/r/f00.ts");
	click(5, 4);
	assert.equal(tree.selected, "/r/f03.ts");
	pane.handleMouse(ev("wheel", 5, 3, { wheelDelta: 7 }));
	pane.render(36);
	assert.equal(tree.from, 7);
	click(5, 1);
	assert.equal(tree.selected, "/r/f07.ts");
	click(5, 10);
	assert.equal(tree.selected, "/r/f16.ts");
	click(5, 10);
	assert.equal(tree.selected, "", "a click on the selected row clears it");
});

test("clicks on the frame and the header select nothing", async () => {
	const { tree, pane, click, state } = await make();
	pane.render(36);
	for (const [x, y] of [
		[5, 0], // header
		[0, 0], // top-left corner
		[0, 3], // left border
		[35, 3], // right border
		[35, 0], // top-right corner
		[5, HEIGHT - 1], // bottom border with nothing selected
	] as const) {
		const res = click(x, y);
		assert.equal(tree.selected, "", `(${x}, ${y})`);
		assert.equal(res?.handled, true);
	}
	assert.equal(state.width, 36, "a press and release on the left border without a move keeps the width");
});

test("a click below the last row selects nothing", async () => {
	const w: World = { dirs: { "/r": [["only.ts", "file"]] } };
	const tree = new TreeController(fakeIo(w), { changed: () => {}, visible: () => true });
	await tree.start("/r");
	const { pane, ev } = await make();
	// Swap in the short tree: one row, then empty room.
	const model = (pane as unknown as { model: PaneModel }).model;
	model.body = (_w, room) => {
		const win = tree.window(room);
		return { lines: win.rows.map((r) => r.node.name), from: win.from, total: win.total, above: 0, below: 0 };
	};
	model.clickRow = (index) => tree.clickRow(index);
	pane.render(36);
	for (const y of [2, 5, 10]) {
		pane.handleMouse(ev("press", 5, y));
		pane.handleMouse(ev("click", 5, y));
		assert.equal(tree.selected, "", `row ${y}`);
	}
	pane.handleMouse(ev("press", 5, 1));
	pane.handleMouse(ev("click", 5, 1));
	assert.equal(tree.selected, "/r/only.ts");
});

test("a click on the bottom border clears the selection", async () => {
	const { tree, pane, click, state } = await make();
	pane.render(36);
	click(5, 2);
	assert.equal(tree.selected, "/r/f01.ts");
	assert.match(pane.render(36)[HEIGHT - 1]!, /^╰ \/r\/f01\.ts ─+╯$/);
	click(5, HEIGHT - 1);
	assert.equal(tree.selected, "");
	assert.equal(state.footerClicks, 1);
});

test("a drag of the left edge changes the width and clamps at both limits", async () => {
	const { tree, pane, state, ev } = await make();
	pane.render(36);
	const edge = COLS - 36;
	const drag = (toScreenX: number) => pane.handleMouse(ev("drag", 0, 5, { screenX: toScreenX }));

	assert.equal(pane.handleMouse(ev("press", 0, 5))?.capture, true);
	drag(edge - 10);
	assert.equal(state.width, 46, "ten columns to the left: ten columns wider");
	drag(edge + 4);
	assert.equal(state.width, 32);
	drag(0);
	assert.equal(state.width, MAX_TREE_WIDTH);
	drag(COLS - 2);
	assert.equal(state.width, MIN_TREE_WIDTH);
	drag(edge - 4);
	assert.equal(state.width, 40);
	pane.handleMouse(ev("release", 0, 5, { screenX: edge - 4 }));
	// The click that ends a drag does nothing, and later moves do not resize.
	pane.handleMouse(ev("click", 0, 5));
	drag(edge - 30);
	assert.equal(state.width, 40);
	assert.equal(tree.selected, "");
});

test("a drag that starts off the left edge does not resize", async () => {
	const { pane, state, ev } = await make();
	pane.render(36);
	pane.handleMouse(ev("press", 5, 5));
	pane.handleMouse(ev("drag", 5, 5, { screenX: 20 }));
	assert.equal(state.width, 36);
});

test("pane width for a drag: within the limits and never squeezing the stack", () => {
	assert.equal(paneWidthFor(50, 160), 50);
	assert.equal(paneWidthFor(500, 160), MAX_TREE_WIDTH);
	assert.equal(paneWidthFor(1, 160), MIN_TREE_WIDTH);
	assert.equal(paneWidthFor(60, 110), 34);
	assert.equal(paneWidthFor(60, 90), MIN_TREE_WIDTH);
});
