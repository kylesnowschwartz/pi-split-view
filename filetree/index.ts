/**
 * filetree — the file tree sidebar of the split view. This module is the
 * folder's one public entry: split-view.ts builds a FileTree, wraps its layout
 * in it and feeds it session and tool events.
 *
 * The tree logic (tree model, path helpers, prune list, git status parsing,
 * listing, icons) is adapted from data-goblin/claude-code-filetree (MIT,
 * Copyright (c) 2026 Kurt Buhler); see the LICENSE file in this folder.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, truncateToWidth, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { toolHudBadge } from "../helpers.ts";
import { TreeController } from "./controller.ts";
import { BRANCH_ICON } from "./icons.ts";
import { nodeIo, type TreeIo } from "./io.ts";
import { type PaneBody, type PaneModel, TreePane } from "./pane.ts";
import { basename, relative } from "./paths.ts";
import { type Badge, type PaneTheme, renderRow, type RowContext, shimmer, TONE_TOOL } from "./rows.ts";

/** Saved state of the pane: shown or hidden, and its width in columns. */
export interface TreeConfig {
	open: boolean;
	width: number;
}

/** Pane state as read from disk: only well-typed fields are present. */
export type TreeConfigInput = Partial<TreeConfig>;

export interface FileTreeHost {
	/** World access; Node's fs, child_process and timers when absent. */
	io?: TreeIo;
	requestRender(): void;
	terminalSize(): { cols: number; rows: number };
	theme(): PaneTheme | null;
}

export const DEFAULT_TREE_WIDTH = 36;
export const MIN_TREE_WIDTH = 24;
export const MAX_TREE_WIDTH = 80;
/** Columns the stack left of the pane keeps; the pane shrinks, then hides,
 * before the stack gets narrower than this. */
export const MIN_STACK_COLS = 76;

/** Narrowest terminal that shows the pane. */
export const MIN_TREE_COLS = MIN_STACK_COLS + MIN_TREE_WIDTH;

/** Clamp a requested pane width to the limits. */
export function clampTreeWidth(width: number): number {
	return Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, Math.round(width)));
}

/** Whether a terminal of `cols` columns has room for the pane. */
export function treeFits(cols: number): boolean {
	return cols >= MIN_TREE_COLS;
}

/** The stack and the pane side by side. Its render() is a sentinel: the
 * layout engine reads the layout node, never the rendered lines. */
class TreeSplit extends HStack {
	override render(_width: number): string[] {
		return [""];
	}
	setPaneWidth(pane: Component, width: number): void {
		const entry = this.entries.find((e) => e.component === pane);
		if (entry) entry.basis = width;
	}
	/** Reserve the stack's minimum width only while the pane is drawn, so the
	 * pane shrinks before the stack does and a narrow terminal still fits. */
	reserveStack(stack: Component, on: boolean): void {
		const entry = this.entries.find((e) => e.component === stack);
		if (entry) entry.minSize = on ? MIN_STACK_COLS : 0;
	}
}

/** One-entry stack around the left side, so the HStack's height measurement
 * of it costs O(1) instead of a full render of the transcript. */
class StackColumn extends VStack {
	override render(_width: number): string[] {
		return [""];
	}
}

export class FileTree {
	private open = true;
	private width = DEFAULT_TREE_WIDTH;
	private split: TreeSplit | null = null;
	private readonly pane: TreePane;
	private readonly tree: TreeController;

	constructor(private readonly host: FileTreeHost) {
		this.tree = new TreeController(host.io ?? nodeIo(), {
			changed: () => {
				if (this.isVisible()) this.host.requestRender();
			},
			visible: () => this.isVisible(),
		});
		const model: PaneModel = {
			theme: () => this.host.theme(),
			height: () => this.host.terminalSize().rows,
			header: () => this.header(),
			footer: (width) => this.footer(width),
			body: (width, room) => this.body(width, room),
			clickRow: (index) => {
				this.tree.clickRow(index);
			},
			clickFooter: () => this.tree.select(""),
			wheel: (delta) => this.tree.wheel(delta),
			resize: (width) => this.setWidth(width),
		};
		this.pane = new TreePane(model);
	}

	/** Build the tree for a session's working directory. */
	start(cwd: string): void {
		void this.tree.start(cwd).catch(() => undefined);
	}

	/** Drop the tree and stop its timers. */
	stop(): void {
		this.tree.stop();
	}

	/** A tool call started (tool_execution_start). */
	toolStart(id: string, tool: string, args: unknown): void {
		this.tree.toolStart(id, tool, args);
	}

	/** A tool call ended (tool_execution_end), in success or failure. */
	toolEnd(id: string, isError: boolean, result: unknown): void {
		this.tree.toolEnd(id, isError, result);
	}

	/** A prompt is about to run. */
	promptStart(): void {
		this.tree.promptStart();
	}

	/** The selected file's path below the tree root; "" when none is selected. */
	selectedPath(): string {
		const t = this.tree;
		return t.selected ? relative(t.root, t.selected) : "";
	}

	/**
	 * The note for the model about the selection, when it differs from the
	 * last note given: the selected file, or that the selection was cleared.
	 * null when the model already knows. The caller sends the note with the
	 * next prompt.
	 */
	selectionNote(): string | null {
		return this.tree.selectionNote();
	}

	/** Forget what the model was told, so the next prompt carries the
	 * selection again (the conversation the note was in is gone or compacted). */
	forgetSelectionNote(): void {
		this.tree.forgetSelectionNote();
	}

	/** The selected file in the bottom border; the path keeps its end when it is too long. */
	private footer(width: number): string {
		const th = this.host.theme();
		const path = this.selectedPath();
		if (!th || !path) return "";
		const room = width - 5;
		if (room < 4) return "";
		const chars = Array.from(path);
		let shown = path;
		if (visibleWidth(path) > room) {
			let tail = chars.slice(-(room - 1));
			while (tail.length > 1 && visibleWidth(tail.join("")) > room - 1) tail = tail.slice(1);
			shown = `…${tail.join("")}`;
		}
		return `${th.fg("border", "─")} ${th.fg("accent", `● ${shown}`)} `;
	}

	private badge(tool: string): Badge {
		return toolHudBadge(tool, this.host.theme()?.appearance === "light");
	}

	/** The root's name and branch. A call on the root itself (a search of the
	 * whole tree) shows here, as it would on a row. */
	private header(): string {
		const th = this.host.theme();
		const t = this.tree;
		if (!th || !t.root) return "";
		const name = basename(t.root) || "/";
		const mark = t.marks().get(t.root);
		let label = th.fg("muted", name);
		if (mark?.state === "running") {
			const badge = this.badge(mark.tool);
			label = `${badge.ansiColor}${badge.icon}\x1b[39m ${shimmer(name, badge.ansiColor, t.tick, th)}`;
		} else if (mark) {
			label = mark.error
				? th.fg("error", name)
				: `${this.badge(TONE_TOOL[mark.kind]).ansiColor}${name}\x1b[39m`;
		}
		const branch = t.git.branch ? th.fg("dim", `  ${BRANCH_ICON} ${t.git.branch.head}`) : "";
		return ` ${label}${branch}`;
	}

	private body(width: number, room: number): PaneBody {
		const th = this.host.theme();
		const t = this.tree;
		const win = t.window(room);
		if (!th) return { lines: [], from: win.from, total: win.total, above: 0, below: 0 };
		const marks = t.marks();
		const ctx: RowContext = {
			theme: th,
			root: t.root,
			git: t.git,
			ignored: t.ignored,
			untracked: t.untracked,
			selected: t.selected,
			width,
			tick: t.tick,
			mark: (id) => marks.get(id),
			badge: (tool) => this.badge(tool),
			widthOf: visibleWidth,
			truncate: (text, w) => truncateToWidth(text, w, "…"),
		};
		return {
			lines: win.rows.map((r) => renderRow(r, ctx)),
			from: win.from,
			total: win.total,
			above: win.above,
			below: win.below,
		};
	}

	/** Whether the pane is switched on (it still hides on a narrow terminal). */
	isOpen(): boolean {
		return this.open;
	}

	setOpen(open: boolean): void {
		this.open = open;
		this.pane.cancelDrag();
		this.host.requestRender();
	}

	/** Whether the pane is drawn right now. */
	isVisible(): boolean {
		return this.open && this.split !== null && treeFits(this.host.terminalSize().cols);
	}

	private setWidth(width: number): void {
		const cols = this.host.terminalSize().cols;
		this.width = Math.min(clampTreeWidth(width), Math.max(MIN_TREE_WIDTH, cols - MIN_STACK_COLS));
		this.split?.setPaneWidth(this.pane, this.width);
		this.host.requestRender();
	}

	/** Put the pane to the right of `left` (the Messages / editor / drawers stack). */
	wrap(left: Component): Component {
		this.pane.cancelDrag();
		const stack = new StackColumn([
			{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 0 },
		]);
		const split: TreeSplit = new TreeSplit([
			{ component: stack, basis: 0, grow: 1, shrink: 0, minSize: 0 },
			{
				component: this.pane,
				basis: this.width,
				grow: 0,
				shrink: 1,
				minSize: MIN_TREE_WIDTH,
				visible: (v) => {
					const shown = this.open && treeFits(v.width);
					split.reserveStack(stack, shown);
					return shown;
				},
			},
		]);
		this.split = split;
		return split;
	}

	/** The layout was removed: the pane is no longer on screen. */
	unwrap(): void {
		this.pane.cancelDrag();
		this.split = null;
	}

	serialize(): TreeConfig {
		return { open: this.open, width: this.width };
	}

	hydrate(saved: TreeConfigInput): void {
		this.open = saved.open ?? true;
		this.width = clampTreeWidth(saved.width ?? DEFAULT_TREE_WIDTH);
	}
}

/** pi loads a folder's index.ts as an extension when the folder sits directly
 * in an extensions directory, and needs a default factory there. */
export default function (_pi: ExtensionAPI) {}
