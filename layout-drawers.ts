import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type ScrollView,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { computeDrawerHeights, drawerBarLayout } from "./helpers.ts";
import {
	type LayoutContext,
	type LayoutStrategy,
	MeasurementSafeVStack,
	type PanelCtl,
	type PanelId,
	stackEntry,
} from "./layout-types.ts";

export type DrawerId = "thinking" | "tools";

export interface DrawerState {
	open: boolean;
	manualPin: boolean;
	height: number;
}

interface DrawerDragState {
	id: DrawerId;
	y: number;
	start: number;
	moved: boolean;
}

const DEFAULT_THINKING_HEIGHT = 10;
const DEFAULT_TOOLS_HEIGHT = 14;
const MIN_DRAWER_HEIGHT = 5;
const MAX_DRAWER_HEIGHT = 30;
const MIN_MESSAGES_ROWS = 6;
const MIN_TERM_ROWS_FOR_DRAWERS = 12;

function hitSpan(x: number, span: { start: number; end: number } | null): boolean {
	return span !== null && x >= span.start && x < span.end;
}

/**
 * 1-row drawer header & collapsed bar.
 * - Collapsed: `╭▸ Tool Usage (2 done · bash) ──[◀] Turn 3/8 [▶]─[All]─[↗][▸]╮`
 *   Wheel events pass through to primary Messages; clicking anywhere outside
 *   [↗] / pager buttons expands the drawer.
 * - Expanded: `╭▾ Tool Usage (2 done · bash) ─────────────────────────[↗][▾]╮`
 *   Clicking [▾] collapses, [↗] zooms, pressing the remaining `─` drags height.
 */
class DrawerHeader implements Component {
	constructor(
		private readonly id: DrawerId,
		private readonly title: string,
		private readonly color: "accent" | "muted",
		private readonly theme: Theme,
		private readonly ctx: LayoutContext,
		private readonly getState: () => DrawerState,
		private readonly getScroll: () => ScrollView | undefined,
		private readonly onToggle: () => void,
		private readonly onBeginDrag: (ev: TuiMouseEvent) => TuiMouseEventResult,
		private readonly onDragEvent: (ev: TuiMouseEvent) => TuiMouseEventResult | undefined,
		private readonly hasDrag: () => boolean,
		private readonly consumeSuppressedClick: () => boolean,
	) {}

	private computeLayout(width: number) {
		const st = this.getState();
		const pager =
			!st.open && this.id === "tools" ? this.ctx.pagerState?.() : undefined;
		const showPager = Boolean(pager && pager.currentTurn > 0);
		const glyph = st.open ? "▾" : "▸";
		return {
			st,
			pager,
			bar: drawerBarLayout(width, {
				showPager,
				pagerLabel: pager?.label,
				pagerToggleText: pager ? (pager.isAll ? "[Sync]" : "[All]") : undefined,
				leftToggleCols: visibleWidth(`${glyph} ${this.title}`),
			}),
		};
	}

	render(width: number): string[] {
		const th = this.theme;
		const { st, pager, bar } = this.computeLayout(width);
		const summary = this.ctx.panelSummary?.(this.id) ?? {
			text: "",
			streaming: false,
			errorCount: 0,
		};
		const glyph = st.open ? "▾" : "▸";
		const dot = summary.streaming ? th.fg("warning", " ●") : "";
		const summaryText = summary.text
			? th.fg("muted", ` (${summary.text})`)
			: "";
		const rawLeft =
			th.fg(this.color, `${glyph} ${this.title}`) +
			summaryText +
			dot +
			" ";
		const left = truncateToWidth(rawLeft, bar.labelRoom);
		const leftW = visibleWidth(left);
		const fillCols = Math.max(0, bar.labelRoom - leftW);
		const fill = th.fg("border", "─".repeat(fillCols));

		let pagerStr = "";
		if (bar.pager && pager) {
			const prevBtn = th.fg(pager.canPrev ? "accent" : "dim", "[◀]");
			const nextBtn = th.fg(pager.canNext ? "accent" : "dim", "[▶]");
			const labelStr = th.fg(
				pager.pinned ? "warning" : "muted",
				` ${bar.pager.label} `,
			);
			const toggleBtn = th.fg(
				pager.isAll ? "accent" : "muted",
				bar.pager.toggleText,
			);
			pagerStr =
				prevBtn +
				labelStr +
				nextBtn +
				th.fg("border", "─") +
				toggleBtn +
				th.fg("border", "─");
		}

		const buttons = bar.showButtons
			? th.fg("muted", "[↗]") + th.fg("muted", `[${glyph}]`)
			: "";

		return [
			th.fg("border", "╭") +
				left +
				fill +
				pagerStr +
				buttons +
				th.fg("border", "╮"),
		];
	}

	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.hasDrag() && (ev.type === "drag" || ev.type === "release")) {
			return this.onDragEvent(ev);
		}
		const st = this.getState();
		if (ev.type === "wheel") {
			// Pass wheel through on collapsed 1-row bars so there is no dead zone.
			if (!st.open) return undefined;
			this.getScroll()?.scrollBy(ev.wheelDelta ?? 0);
			return { handled: true };
		}
		if (ev.button !== "left" || ev.y !== 0) return undefined;

		const { bar } = this.computeLayout(ev.width);
		const isZoom = hitSpan(ev.x, bar.zoom);
		const isToggle = hitSpan(ev.x, bar.toggle) || hitSpan(ev.x, bar.leftToggle);
		const isPrev = bar.pager ? hitSpan(ev.x, bar.pager.prev) : false;
		const isNext = bar.pager ? hitSpan(ev.x, bar.pager.next) : false;
		const isPagerToggle = bar.pager ? hitSpan(ev.x, bar.pager.toggle) : false;
		const isControl = isZoom || isPrev || isNext || isPagerToggle;

		if (ev.type === "press") {
			if (isControl || isToggle || !st.open) return { capture: true };
			// Expanded top border outside [↗]/pager: press-and-drag >= 1 row resizes height;
			// releasing with 0 movement falls through to click and toggles collapse.
			return this.onBeginDrag(ev);
		}
		if (ev.type === "click") {
			if (this.consumeSuppressedClick()) return { handled: true };
			if (isZoom) {
				this.ctx.toggleZoom?.(this.id);
				return { handled: true };
			}
			if (isPrev) {
				this.ctx.stepTurn?.(-1);
				return { handled: true };
			}
			if (isNext) {
				this.ctx.stepTurn?.(1);
				return { handled: true };
			}
			if (isPagerToggle) {
				this.ctx.toggleToolsScopeAll?.();
				return { handled: true };
			}
			this.onToggle();
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {}
	dispose(): void {}
}

/**
 * Single-column collapsible drawers layout strategy.
 * Full-width Messages on top, Pi's full-width prompt editor dock below it, and
 * collapsible Thinking + Tool Usage drawers at the bottom of the screen.
 *
 * Each drawer is a real MeasurementSafeVStack ([LAYOUT_NODE] provider) with
 * permanent entries [DrawerHeader, ScrollView(visible: () => open), BorderBottom(visible: () => open)]
 * so pi-tui natively manages scrolling, scrollbars, and scroll preservation
 * across collapse/expand without tree rebuilds.
 */
export class DrawersLayoutStrategy implements LayoutStrategy {
	readonly id = "drawers" as const;

	private drawers: Record<DrawerId, DrawerState> = {
		thinking: { open: false, manualPin: false, height: DEFAULT_THINKING_HEIGHT },
		tools: { open: false, manualPin: false, height: DEFAULT_TOOLS_HEIGHT },
	};

	private geo: {
		rootStack?: VStack;
		thinkingDrawer?: Component;
		toolsDrawer?: Component;
		thinkingScroll?: ScrollView;
		toolsScroll?: ScrollView;
	} = {};

	/** Cached ScrollViews survive zoom round-trips so drawer scroll positions persist. */
	private cachedScrolls: Partial<
		Record<DrawerId, { scroll: ScrollView; bottom: Component; reattach: () => void }>
	> = {};

	private lastCtx: LayoutContext | null = null;
	private drag: DrawerDragState | null = null;
	private suppressNextClick = false;
	private enabled = true;

	constructor(
		private readonly getTerminalSize: () => { cols: number; rows: number },
		private readonly requestRender: () => void,
	) {}

	setEnabled(on: boolean): void {
		this.enabled = on;
	}

	getDrawerState(id: DrawerId): DrawerState {
		return this.drawers[id];
	}

	toggleDrawer(id: DrawerId): void {
		const st = this.drawers[id];
		st.open = !st.open;
		st.manualPin = true;
		const { cols, rows } = this.getTerminalSize();
		this.applyGeometry(cols, rows);
	}

	setDrawerOpen(id: DrawerId, open: boolean, manual = true): void {
		const st = this.drawers[id];
		st.open = open;
		if (manual) st.manualPin = true;
		const { cols, rows } = this.getTerminalSize();
		this.applyGeometry(cols, rows);
	}

	resetGeometry(): void {
		this.geo = {};
	}

	clearScrollCache(): void {
		this.cachedScrolls = {};
	}

	cancelDrag(): void {
		this.drag = null;
	}

	hasActiveDrag(): boolean {
		return this.drag !== null;
	}

	panelVisible(id: PanelId, _hasFullscreenLayout: boolean): boolean {
		if (!this.enabled) return false;
		return id === "thinking" || id === "tools" || id === "messages";
	}

	wantsLayer(): boolean {
		return this.enabled;
	}

	onReconstruct(): void {
		this.drawers.thinking.manualPin = false;
		this.drawers.thinking.open = false;
		this.drawers.tools.manualPin = false;
		this.drawers.tools.open = false;
		const { cols, rows } = this.getTerminalSize();
		this.applyGeometry(cols, rows);
	}

	private shouldSuppressAutoOpen(): boolean {
		if (!this.lastCtx) return false;
		if (this.lastCtx.isTurnPinned?.()) return true;
		if (this.lastCtx.isMessagesFollowingEnd && !this.lastCtx.isMessagesFollowingEnd()) {
			return true;
		}
		return false;
	}

	onThinkingStart(): void {
		const st = this.drawers.thinking;
		if (st.open || st.manualPin || this.shouldSuppressAutoOpen()) return;
		st.open = true;
		const { cols, rows } = this.getTerminalSize();
		this.applyGeometry(cols, rows);
	}

	onToolStart(_isError?: boolean): void {
		const st = this.drawers.tools;
		if (st.open || st.manualPin || this.shouldSuppressAutoOpen()) return;
		st.open = true;
		const { cols, rows } = this.getTerminalSize();
		this.applyGeometry(cols, rows);
	}

	private beginDrag(id: DrawerId, ev: TuiMouseEvent): TuiMouseEventResult {
		const scroll =
			id === "thinking" ? this.geo.thinkingScroll : this.geo.toolsScroll;
		const effectiveH =
			scroll && scroll.viewportHeight > 0
				? scroll.viewportHeight + 2
				: this.drawers[id].height;
		this.suppressNextClick = false;
		this.drag = { id, y: ev.screenY, start: effectiveH, moved: false };
		return { capture: true };
	}

	handleDragEvent(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		const d = this.drag;
		if (!d) return undefined;
		if (ev.type === "release") {
			this.suppressNextClick = d.moved;
			this.drag = null;
			return { handled: true };
		}
		if (ev.type !== "drag") return { handled: true };
		if (!d.moved && Math.abs(ev.screenY - d.y) < 1) {
			return { handled: true };
		}
		d.moved = true;
		const { cols, rows } = this.getTerminalSize();
		const msgVp = this.lastCtx?.getMessagesViewportHeight?.() ?? 0;
		const dynamicMax =
			msgVp > 0
				? Math.max(MIN_DRAWER_HEIGHT, d.start + msgVp - MIN_MESSAGES_ROWS)
				: MAX_DRAWER_HEIGHT;
		const maxH = Math.min(MAX_DRAWER_HEIGHT, dynamicMax);
		// Dragging the top border upward (smaller screenY) increases height.
		const nextH = Math.max(
			MIN_DRAWER_HEIGHT,
			Math.min(maxH, d.start - (ev.screenY - d.y)),
		);
		this.drawers[d.id].height = nextH;
		this.drawers[d.id].manualPin = true;
		this.applyGeometry(cols, rows);
		return { handled: true };
	}

	applyGeometry(_cols: number, rows: number): void {
		const heights = computeDrawerHeights(
			rows,
			this.drawers.thinking,
			this.drawers.tools,
			MIN_MESSAGES_ROWS,
			6,
			MIN_DRAWER_HEIGHT,
		);
		const tEntry = stackEntry(this.geo.rootStack, this.geo.thinkingDrawer);
		if (tEntry) {
			const open = this.drawers.thinking.open;
			tEntry.basis = open ? heights.thinking : 1;
			tEntry.shrink = open ? 1 : 0;
			tEntry.minSize = open ? Math.min(MIN_DRAWER_HEIGHT, heights.thinking) : 1;
		}
		const uEntry = stackEntry(this.geo.rootStack, this.geo.toolsDrawer);
		if (uEntry) {
			const open = this.drawers.tools.open;
			uEntry.basis = open ? heights.tools : 1;
			uEntry.shrink = open ? 1 : 0;
			uEntry.minSize = open ? Math.min(MIN_DRAWER_HEIGHT, heights.tools) : 1;
		}
		this.requestRender();
	}

	private buildDrawer(
		id: DrawerId,
		title: string,
		color: "accent" | "muted",
		ctx: LayoutContext,
	): { drawer: Component; scroll?: ScrollView } {
		const ctl: PanelCtl = {
			id,
			minRows: () => Math.max(1, this.drawers[id].height - 2),
			onDragEvent: (ev) => this.handleDragEvent(ev),
		};
		let pair = this.cachedScrolls[id];
		if (!pair && ctx.buildBodyScroll) {
			pair = ctx.buildBodyScroll(id, ctl);
			this.cachedScrolls[id] = pair;
		} else if (pair) {
			ctl.scroll = pair.scroll;
			pair.reattach();
		}
		const header = new DrawerHeader(
			id,
			title,
			color,
			ctx.theme,
			ctx,
			() => this.drawers[id],
			() => pair?.scroll,
			() => this.toggleDrawer(id),
			(ev) => this.beginDrag(id, ev),
			(ev) => this.handleDragEvent(ev),
			() => this.hasActiveDrag(),
			() => {
				if (!this.suppressNextClick) return false;
				this.suppressNextClick = false;
				return true;
			},
		);
		const entries: any[] = [
			{ component: header, basis: 1, grow: 0, shrink: 0, minSize: 1 },
		];
		if (pair) {
			entries.push(
				{
					component: pair.scroll,
					basis: 0,
					grow: 1,
					shrink: 1,
					minSize: 0,
					visible: () => this.drawers[id].open,
				},
				{
					component: pair.bottom,
					basis: 1,
					grow: 0,
					shrink: 0,
					minSize: 1,
					visible: () => this.drawers[id].open,
				},
			);
		}
		return {
			drawer: new MeasurementSafeVStack(entries),
			scroll: pair?.scroll,
		};
	}

	compose(ctx: LayoutContext): Component {
		this.resetGeometry();
		this.lastCtx = ctx;
		const msgCtl: PanelCtl = { id: "messages" };
		const msgComp = ctx.buildSlotPanel("messages", "main", msgCtl);
		const thinkBuilt = this.buildDrawer("thinking", "Thinking", "accent", ctx);
		const toolsBuilt = this.buildDrawer("tools", "Tool Usage", "muted", ctx);

		const fits = (v: { height: number }) => v.height >= MIN_TERM_ROWS_FOR_DRAWERS;
		const drawerEntries: any[] = [
			{
				component: thinkBuilt.drawer,
				basis: this.drawers.thinking.open ? this.drawers.thinking.height : 1,
				grow: 0,
				shrink: this.drawers.thinking.open ? 1 : 0,
				minSize: this.drawers.thinking.open ? MIN_DRAWER_HEIGHT : 1,
				visible: fits,
			},
			{
				component: toolsBuilt.drawer,
				basis: this.drawers.tools.open ? this.drawers.tools.height : 1,
				grow: 0,
				shrink: this.drawers.tools.open ? 1 : 0,
				minSize: this.drawers.tools.open ? MIN_DRAWER_HEIGHT : 1,
				visible: fits,
			},
		];
		const editorEntry = ctx.editorDock
			? {
					component: ctx.editorDock,
					basis: "auto",
					grow: 0,
					shrink: 0,
					minSize: 1,
				}
			: null;

		const entries: any[] = [
			{
				component: msgComp,
				basis: 0,
				grow: 1,
				shrink: 0,
				minSize: MIN_MESSAGES_ROWS,
			},
		];
		if (editorEntry) entries.push(editorEntry);
		entries.push(...drawerEntries);

		const stack = new VStack(entries);
		this.geo.rootStack = stack;
		this.geo.thinkingDrawer = thinkBuilt.drawer;
		this.geo.toolsDrawer = toolsBuilt.drawer;
		this.geo.thinkingScroll = thinkBuilt.scroll;
		this.geo.toolsScroll = toolsBuilt.scroll;
		this.applyGeometry(ctx.cols, ctx.rows);
		return stack;
	}

	serialize(): Record<string, unknown> {
		return {
			thinking: {
				open: this.drawers.thinking.open,
				height: this.drawers.thinking.height,
			},
			tools: {
				open: this.drawers.tools.open,
				height: this.drawers.tools.height,
			},
		};
	}

	hydrate(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		const obj = raw as Record<string, unknown>;
		for (const id of ["thinking", "tools"] as const) {
			const item = obj[id];
			if (!item || typeof item !== "object") continue;
			const rec = item as Record<string, unknown>;
			if (typeof rec.open === "boolean") {
				this.drawers[id].open = rec.open;
			}
			if (
				typeof rec.height === "number" &&
				Number.isFinite(rec.height)
			) {
				this.drawers[id].height = Math.max(
					MIN_DRAWER_HEIGHT,
					Math.min(MAX_DRAWER_HEIGHT, Math.round(rec.height)),
				);
			}
			this.drawers[id].manualPin = false;
		}
	}
}

export default function (_pi: ExtensionAPI) {}
