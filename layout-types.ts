import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type ScrollView,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@earendil-works/pi-tui";
import type { DockSide, LayoutSlots, SlotName, SlotPanel } from "./ui-panels-config.ts";

/** Built-in layout strategy identifiers. */
export type LayoutMode = "grid" | "drawers";

/** Panel identifiers supported by layout strategies. */
export type PanelId = "thinking" | "tools" | "files" | "messages";

/**
 * Neutral mouse & sizing wiring of one panel.
 * Panel chrome calls `onEdgePress` / `onDragEvent` without knowing which
 * layout strategy is active or what drag semantics it uses.
 */
export interface PanelCtl {
	id: PanelId;
	/** Body ScrollView — wheel over the frame scrolls it (B3). */
	scroll?: ScrollView;
	/** Optional initial minRows estimate before viewportHeight is known. */
	minRows?: () => number;
	/** Edge-drag start hook owned by the active LayoutStrategy. */
	onEdgePress?: (
		edge: "left" | "bottom" | "top",
		ev: TuiMouseEvent,
	) => TuiMouseEventResult | undefined;
	/** Active drag continuation / release hook owned by the active LayoutStrategy. */
	onDragEvent?: (ev: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

/** Summary snapshot for compact panel chrome (such as collapsed drawer bars). */
export interface PanelSummary {
	text: string;
	streaming: boolean;
	errorCount: number;
}

/** Narrow context passed from split-view.ts into LayoutStrategy.compose(). */
export interface LayoutContext {
	theme: Theme;
	base: Component | null;
	inner: Component;
	editorDock: Component | null;
	hasFullscreenLayout: boolean;
	trimResponse: boolean;
	cols: number;
	rows: number;
	buildSlotPanel(
		id: Exclude<SlotPanel, null>,
		slot: SlotName,
		ctl: PanelCtl,
	): Component;
	buildBodyScroll?(
		id: "thinking" | "tools",
		ctl: PanelCtl,
	): { scroll: ScrollView; bottom: Component };
	panelSummary?(id: "thinking" | "tools"): PanelSummary;
	toggleZoom?(id: PanelId): void;
	pagerState?(): {
		currentTurn: number;
		label: string;
		canPrev: boolean;
		canNext: boolean;
		isAll: boolean;
		pinned: boolean;
		liveShown: boolean;
		liveOn: boolean;
	};
	stepTurn?(delta: -1 | 1): void;
	toggleToolsScopeAll?(): void;
	toggleToolsLive?(): void;
	isMessagesFollowingEnd?(): boolean;
	getMessagesViewportHeight?(): number;
	isTurnPinned?(): boolean;
	requestRender(): void;
}

/**
 * Pluggable layout strategy seam.
 * Each layout owns its own geometry refs, drag state, visibility rules, and
 * opaque persisted config so experimental layouts can be added or deleted
 * cleanly without untangling split-view.ts.
 */
export interface LayoutStrategy {
	readonly id: LayoutMode;
	compose(ctx: LayoutContext): Component;
	applyGeometry(cols: number, rows: number): void;
	panelVisible(id: PanelId, hasFullscreenLayout: boolean): boolean;
	wantsLayer(): boolean;
	hasActiveDrag(): boolean;
	handleDragEvent(ev: TuiMouseEvent): TuiMouseEventResult | undefined;
	cancelDrag(): void;
	resetGeometry(): void;
	onTurnStart?(): void;
	onThinkingStart?(): void;
	onToolStart?(isError?: boolean): void;
	onReconstruct?(): void;
	serialize?(): Record<string, unknown>;
	hydrate?(raw: unknown): void;
}

/**
 * VStack whose component-level render() is an O(1) sentinel.
 * The pi-tui layout engine checks LAYOUT_NODE before plain render, so real
 * layout and painting are untouched while discarded intrinsic-height
 * measurement passes in HStack cost O(1).
 */
export class MeasurementSafeVStack extends VStack {
	override render(_width: number): string[] {
		return [""];
	}
}

/** Find a stack entry by component identity for in-place geometry mutation. */
export function stackEntry(stack: unknown, component: Component | undefined): any {
	if (!component) return undefined;
	const entries = (stack as { entries?: any[] } | undefined)?.entries;
	return entries?.find((e) => e.component === component);
}

/** Grid state accessor injected into GridLayoutStrategy so split-view.ts owns
 * the shared slot/dimension variables without circular imports. */
export interface GridStateAdapter {
	getSlots(): LayoutSlots;
	getDockSide(): DockSide;
	getBandHeight(): number;
	setBandHeight(h: number): void;
	getToolsWidthPct(): number;
	setToolsWidthPct(pct: number): void;
	getFilesWidth(): number | null;
	setFilesWidth(w: number | null): void;
	getFlags(): { thinkingOn: boolean; toolsOn: boolean; filesOn: boolean; trimResponse: boolean };
	getTerminalSize(): { cols: number; rows: number };
	dockColsFor(cols: number): number;
	dockColsForManual(cols: number, wanted: number): number;
	bandToolsColsFor(bandCols: number): number;
	requestRender(): void;
	onUseBaseTranscript?(): void;
}

export const MIN_TERM_WIDTH = 90;
export const MIN_ROWS_BELOW_BAND = 12;

export default function (_pi: ExtensionAPI) {}
