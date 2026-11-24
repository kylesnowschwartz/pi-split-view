/**
 * The file tree pane: a framed right column drawn as one pi-tui component.
 * It owns the chrome (rounded frame, header, footer, scroll thumb) and the
 * mouse hit-testing; everything it shows comes from a PaneModel.
 */

import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { PaneTheme } from "./rows.ts";
import { thumbOf } from "./viewport.ts";

/** What the pane draws for one frame. */
export interface PaneBody {
	/** Styled rows, at most `room` of them, each at most `width` columns. */
	lines: string[];
	/** Index of the first drawn row among all tree rows, and the row total. */
	from: number;
	total: number;
	/** Running and recent rows outside the drawn window. */
	above: number;
	below: number;
}

export interface PaneModel {
	theme(): PaneTheme | null;
	/** Display width of a styled string, and a styled string cut to a display width. */
	widthOf(text: string): number;
	truncate(text: string, width: number): string;
	/** Rows the pane fills: the terminal height. */
	height(): number;
	/** Styled header label (after "Files"); "" when there is none. */
	header(width: number): string;
	/** Styled footer label naming the selected file; "" when none is selected. */
	footer(width: number): string;
	body(width: number, room: number): PaneBody;
	/** A click on the drawn row `index` (0 = first drawn row). */
	clickRow(index: number): void;
	clickFooter(): void;
	wheel(delta: number): void;
	/** The user dragged the left edge; `width` is the requested pane width. */
	resize(width: number): void;
}

/** Rows the frame takes: the top and bottom border. */
export const FRAME_ROWS = 2;

export class TreePane implements Component {
	private drag: { x: number; start: number; moved: boolean } | null = null;
	private suppressClick = false;

	private readonly model: PaneModel;

	constructor(model: PaneModel) {
		this.model = model;
	}

	private padTo(line: string, width: number): string {
		const m = this.model;
		const clipped = m.widthOf(line) > width ? m.truncate(line, width) : line;
		return clipped + " ".repeat(Math.max(0, width - m.widthOf(clipped)));
	}

	render(width: number): string[] {
		const th = this.model.theme();
		const height = Math.max(0, this.model.height());
		if (!th || width < 4 || height < 3) return Array.from({ length: height }, () => "");
		const inner = width - 2;
		const room = height - FRAME_ROWS;
		const body = this.model.body(inner, room);
		const border = (s: string) => th.fg("border", s);

		const counts =
			(body.above > 0 ? `↑${body.above}` : "") +
			(body.above > 0 && body.below > 0 ? " " : "") +
			(body.below > 0 ? `↓${body.below}` : "");
		const right = counts ? th.fg("warning", ` ${counts} `) + border("─") : "";
		const labelRoom = Math.max(0, inner - this.model.widthOf(right));
		const title = th.fg("accent", " Files") + this.model.header(Math.max(0, labelRoom - 7)) + " ";
		const label = this.model.truncate(title, labelRoom);
		const top =
			border("╭") +
			label +
			border("─".repeat(Math.max(0, labelRoom - this.model.widthOf(label)))) +
			right +
			border("╮");

		const thumb = thumbOf(room, body.from, body.total);
		const out = [top];
		for (let i = 0; i < room; i++) {
			const isThumb = thumb !== null && i >= thumb.top && i < thumb.top + thumb.size;
			out.push(
				border("│") +
					this.padTo(body.lines[i] ?? "", inner) +
					(isThumb ? th.fg("muted", "┃") : border("│")),
			);
		}

		const foot = this.model.truncate(this.model.footer(inner), inner);
		out.push(
			border("╰") +
				foot +
				border("─".repeat(Math.max(0, inner - this.model.widthOf(foot)))) +
				border("╯"),
		);
		return out;
	}

	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.drag) {
			if (ev.type === "release") {
				this.suppressClick = this.drag.moved;
				this.drag = null;
				return { handled: true };
			}
			if (ev.type === "drag") {
				const dx = this.drag.x - ev.screenX;
				if (!this.drag.moved && dx === 0) return { handled: true };
				this.drag.moved = true;
				this.model.resize(this.drag.start + dx);
				return { handled: true };
			}
		}
		if (ev.type === "wheel") {
			this.model.wheel(ev.wheelDelta ?? 0);
			return { handled: true };
		}
		if (ev.button !== "left") return undefined;
		if (ev.type === "press") {
			this.suppressClick = false;
			if (ev.x === 0) this.drag = { x: ev.screenX, start: ev.width, moved: false };
			return { capture: true };
		}
		if (ev.type === "click") {
			if (this.suppressClick) {
				this.suppressClick = false;
				return { handled: true };
			}
			if (ev.x <= 0 || ev.x >= ev.width - 1) return { handled: true };
			if (ev.y === ev.height - 1) this.model.clickFooter();
			else if (ev.y >= 1) this.model.clickRow(ev.y - 1);
			return { handled: true };
		}
		return undefined;
	}

	cancelDrag(): void {
		this.drag = null;
	}

	invalidate(): void {}
	dispose(): void {}
}
