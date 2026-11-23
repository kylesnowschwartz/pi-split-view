import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	HStack,
	Spacer,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@earendil-works/pi-tui";
import type { SlotPanel } from "./ui-panels-config.ts";
import {
	type GridStateAdapter,
	type LayoutContext,
	type LayoutStrategy,
	MIN_ROWS_BELOW_BAND,
	MIN_TERM_WIDTH,
	MeasurementSafeVStack,
	type PanelCtl,
	type PanelId,
	stackEntry,
} from "./layout-types.ts";

type GridDragKind = "height" | "tools" | "dock";

interface GridDragState {
	kind: GridDragKind;
	x: number;
	y: number;
	start: number;
}

/** Top border of the transcript region under the band; drags the band height. */
class BandSeparator implements Component {
	constructor(
		private theme: Theme,
		private onPress: (ev: TuiMouseEvent) => TuiMouseEventResult,
		private onDrag: (ev: TuiMouseEvent) => TuiMouseEventResult | undefined,
		private hasDrag: () => boolean,
	) {}
	render(w: number): string[] {
		const th = this.theme;
		return [
			th.fg("border", "╭") +
				th.fg("border", "─".repeat(Math.max(0, w - 2))) +
				th.fg("border", "╮"),
		];
	}
	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.hasDrag() && (ev.type === "drag" || ev.type === "release")) {
			return this.onDrag(ev);
		}
		if (ev.type === "press" && ev.button === "left") {
			return this.onPress(ev);
		}
		return undefined;
	}
	invalidate(): void {}
	dispose(): void {}
}

/**
 * 4-slot grid layout strategy (topLeft, topRight, main, dock + dockSide).
 * Owns its own geometry references and drag state so split-view.ts stays
 * layout-agnostic.
 */
export class GridLayoutStrategy implements LayoutStrategy {
	readonly id = "grid" as const;

	private geo: {
		bandStack?: VStack;
		band?: Component;
		panelStack?: HStack;
		leftBandPanel?: Component;
		rightBandPanel?: Component;
		dockStack?: HStack;
		dockPanel?: Component;
	} = {};

	private drag: GridDragState | null = null;

	constructor(private readonly state: GridStateAdapter) {}

	resetGeometry(): void {
		this.geo = {};
	}

	cancelDrag(): void {
		this.drag = null;
	}

	hasActiveDrag(): boolean {
		return this.drag !== null;
	}

	/** Band width available next to a visible dock. */
	bandBase(cols: number): number {
		const slots = this.state.getSlots();
		const dockVisible = slots.dock !== null && cols >= MIN_TERM_WIDTH;
		return cols - (dockVisible ? this.state.dockColsFor(cols) : 0);
	}

	private beginDrag(kind: GridDragKind, ev: TuiMouseEvent): TuiMouseEventResult {
		const { cols } = this.state.getTerminalSize();
		const start =
			kind === "height"
				? this.state.getBandHeight()
				: kind === "dock"
					? this.state.dockColsFor(cols)
					: this.state.bandToolsColsFor(this.bandBase(cols));
		this.drag = { kind, x: ev.screenX, y: ev.screenY, start };
		return { capture: true };
	}

	handleDragEvent(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		const d = this.drag;
		if (!d) return undefined;
		if (ev.type === "release") {
			this.drag = null;
			return { handled: true };
		}
		if (ev.type !== "drag") return { handled: true };
		const { cols, rows } = this.state.getTerminalSize();
		if (d.kind === "height") {
			const max = Math.max(6, Math.min(40, rows - 1 - MIN_ROWS_BELOW_BAND));
			this.state.setBandHeight(
				Math.max(6, Math.min(max, d.start + (ev.screenY - d.y))),
			);
		} else if (d.kind === "tools") {
			const base = Math.max(1, this.bandBase(cols));
			const w = d.start - (ev.screenX - d.x);
			this.state.setToolsWidthPct(
				Math.max(20, Math.min(80, Math.round((w * 100) / base))),
			);
		} else {
			const dockSide = this.state.getDockSide();
			const delta = dockSide === "left" ? ev.screenX - d.x : -(ev.screenX - d.x);
			this.state.setFilesWidth(this.state.dockColsForManual(cols, d.start + delta));
		}
		this.applyGeometry(cols, rows);
		return { handled: true };
	}

	private makeCtl(
		id: PanelId,
		inBand: boolean,
		resizeLeft: "tools" | "dock" | false,
	): PanelCtl {
		return {
			id,
			minRows: () =>
				inBand
					? Math.max(1, this.state.getBandHeight() - 2)
					: Math.max(
							1,
							this.state.getTerminalSize().rows - this.state.getBandHeight() - 2,
						),
			onEdgePress: (edge, ev) => {
				if (edge === "left" && resizeLeft) return this.beginDrag(resizeLeft, ev);
				if (edge === "bottom" && inBand) return this.beginDrag("height", ev);
				return undefined;
			},
			onDragEvent: (ev) => this.handleDragEvent(ev),
		};
	}

	panelVisible(id: PanelId, hasFullscreenLayout: boolean): boolean {
		const slots = this.state.getSlots();
		let slot: string | null = null;
		if (slots.topLeft === id) slot = "topLeft";
		else if (slots.topRight === id) slot = "topRight";
		else if (slots.main === id) slot = "main";
		else if (slots.dock === id) slot = "dock";
		if (!slot) return false;
		if (slot === "dock") return hasFullscreenLayout;
		return true;
	}

	wantsLayer(): boolean {
		const slots = this.state.getSlots();
		const hasNonBare =
			slots.topLeft !== null ||
			slots.topRight !== null ||
			slots.dock !== null ||
			slots.main !== "messages";
		const f = this.state.getFlags();
		return hasNonBare || f.thinkingOn || f.toolsOn || f.filesOn || f.trimResponse;
	}

	applyGeometry(cols: number, _rows: number): void {
		const slots = this.state.getSlots();
		const dockEntry = stackEntry(this.geo.dockStack, this.geo.dockPanel);
		if (dockEntry) {
			const w =
				slots.dock === "messages"
					? Math.min(this.state.dockColsFor(cols), Math.max(24, cols - 20))
					: this.state.dockColsFor(cols);
			dockEntry.basis = w;
			dockEntry.minSize = w;
		}
		const bandHeight = this.state.getBandHeight();
		const bandEntry = stackEntry(this.geo.bandStack, this.geo.band);
		if (bandEntry) {
			bandEntry.basis = bandHeight;
			bandEntry.minSize = Math.min(6, bandHeight);
		}
		const left = stackEntry(this.geo.panelStack, this.geo.leftBandPanel);
		const right = stackEntry(this.geo.panelStack, this.geo.rightBandPanel);
		if (left && right) {
			const base = this.bandBase(cols);
			const rightW = this.state.bandToolsColsFor(base);
			left.basis = base - rightW;
			right.basis = rightW;
		}
		this.state.requestRender();
	}

	private buildBand(ctx: LayoutContext, inner: Component): Component {
		const slots = this.state.getSlots();
		const dockSide = this.state.getDockSide();
		const bandSlots: { slot: "topLeft" | "topRight"; id: Exclude<SlotPanel, null> }[] = [];
		if (slots.topLeft !== null) bandSlots.push({ slot: "topLeft", id: slots.topLeft });
		if (slots.topRight !== null) bandSlots.push({ slot: "topRight", id: slots.topRight });
		if (bandSlots.length === 0) return inner;

		const hasDock = slots.dock !== null && ctx.hasFullscreenLayout;
		const splitBand = bandSlots.length === 2;
		const panels = bandSlots.map(({ slot, id }) => {
			const resizeLeft: "tools" | "dock" | false =
				splitBand && slot === "topRight"
					? "tools"
					: dockSide === "left" && hasDock && slot === "topLeft"
						? "dock"
						: false;
			return ctx.buildSlotPanel(id, slot, this.makeCtl(id, true, resizeLeft));
		});
		const band = splitBand
			? new HStack(
					panels.map((component) => ({
						component,
						basis: 1,
						grow: 0,
						shrink: 1,
						minSize: 1,
					})),
				)
			: panels[0]!;
		if (splitBand) {
			this.geo.panelStack = band as HStack;
			this.geo.leftBandPanel = panels[0];
			this.geo.rightBandPanel = panels[1];
		}
		const fits = (v: { height: number }) =>
			v.height - this.state.getBandHeight() - 1 >= MIN_ROWS_BELOW_BAND;
		const bandHeight = this.state.getBandHeight();
		const bandEntries: any[] = [
			{
				component: band,
				basis: bandHeight,
				grow: 0,
				shrink: 1,
				minSize: Math.min(6, bandHeight),
				visible: fits,
			},
		];
		if (slots.main === "messages") {
			bandEntries.push({
				component: new BandSeparator(
					ctx.theme,
					(ev) => this.beginDrag("height", ev),
					(ev) => this.handleDragEvent(ev),
					() => this.hasActiveDrag(),
				),
				basis: 1,
				grow: 0,
				shrink: 0,
				visible: fits,
			});
		}
		bandEntries.push({ component: inner, basis: 0, grow: 1, shrink: 1, minSize: 1 });
		const stack = new VStack(bandEntries);
		this.geo.bandStack = stack;
		this.geo.band = band;
		return stack;
	}

	private buildDock(
		ctx: LayoutContext,
		inner: Component,
		dockId: Exclude<SlotPanel, null>,
		editorInDock: Component | null,
	): Component {
		const dockSide = this.state.getDockSide();
		const panelCols = editorInDock
			? Math.min(this.state.dockColsFor(ctx.cols), Math.max(24, ctx.cols - 20))
			: this.state.dockColsFor(ctx.cols);
		const panel = ctx.buildSlotPanel(
			dockId,
			"dock",
			this.makeCtl(dockId, false, dockSide === "right" ? "dock" : false),
		);
		const dockContainer: Component = editorInDock
			? new MeasurementSafeVStack([
					{ component: panel, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: editorInDock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
				])
			: panel;
		const mainSide = new MeasurementSafeVStack([
			{ component: inner, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		]);
		const dockEntry = {
			component: dockContainer,
			basis: panelCols,
			grow: 0,
			shrink: 0,
			minSize: panelCols,
			...(editorInDock
				? {}
				: { visible: (v: { width: number }) => v.width >= MIN_TERM_WIDTH }),
		};
		const mainEntry = {
			component: mainSide,
			basis: 0,
			grow: 1,
			shrink: 1,
			minSize: 1,
		};
		const stack = new HStack(
			dockSide === "left" ? [dockEntry, mainEntry] : [mainEntry, dockEntry],
		);
		this.geo.dockStack = stack;
		this.geo.dockPanel = dockContainer;
		return stack;
	}

	compose(ctx: LayoutContext): Component {
		this.resetGeometry();
		const slots = this.state.getSlots();
		const dockSide = this.state.getDockSide();
		const hasDock = slots.dock !== null && ctx.hasFullscreenLayout;
		const editorInDock = Boolean(
			ctx.base && ctx.editorDock && hasDock && slots.dock === "messages",
		);

		let root: Component;
		if (ctx.base && ctx.editorDock) {
			if (!editorInDock && slots.main === "messages" && !ctx.trimResponse) {
				this.state.onUseBaseTranscript?.();
				root = ctx.inner;
			} else if (slots.main !== null) {
				const mainComp = ctx.buildSlotPanel(
					slots.main,
					"main",
					this.makeCtl(slots.main, false, dockSide === "left" && hasDock ? "dock" : false),
				);
				root = editorInDock
					? mainComp
					: new VStack([
							{ component: mainComp, basis: 0, grow: 1, shrink: 1, minSize: 1 },
							{ component: ctx.editorDock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
						]);
			} else {
				root = editorInDock
					? new Spacer(1)
					: new VStack([
							{ component: new Spacer(1), basis: 0, grow: 1, shrink: 1, minSize: 1 },
							{ component: ctx.editorDock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
						]);
			}
		} else {
			root = ctx.inner;
		}

		const wantBand = slots.topLeft !== null || slots.topRight !== null;
		if (wantBand) root = this.buildBand(ctx, root);
		if (hasDock && slots.dock !== null) {
			root = this.buildDock(ctx, root, slots.dock, editorInDock ? ctx.editorDock : null);
		}
		this.applyGeometry(ctx.cols, ctx.rows);
		return root;
	}
}

export default function (_pi: ExtensionAPI) {}
