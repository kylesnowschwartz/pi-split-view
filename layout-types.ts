import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type ScrollView,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@earendil-works/pi-tui";

/** Framed panel identifiers (the two drawers, also zoomable). */
export type PanelId = "thinking" | "tools";

/**
 * Mouse & sizing wiring of one panel. Panel chrome calls `onDragEvent`
 * without knowing the drawer drag semantics.
 */
export interface PanelCtl {
	id: PanelId;
	/** Body ScrollView — wheel over the frame scrolls it (B3). */
	scroll?: ScrollView;
	/** Optional initial minRows estimate before viewportHeight is known. */
	minRows?: () => number;
	/** Active drag continuation / release hook owned by the drawers layout. */
	onDragEvent?: (ev: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

/** Summary snapshot for compact panel chrome (such as collapsed drawer bars). */
export interface PanelSummary {
	text: string;
	streaming: boolean;
	errorCount: number;
}

/** Narrow context passed from split-view.ts into DrawersLayout.compose(). */
export interface LayoutContext {
	theme: Theme;
	editorDock: Component | null;
	cols: number;
	rows: number;
	/** The Messages region (pi's transcript or the response-only view). */
	buildMessages(): Component;
	buildBodyScroll(
		id: PanelId,
		ctl: PanelCtl,
	): { scroll: ScrollView; bottom: Component; reattach: () => void };
	panelSummary(id: PanelId): PanelSummary;
	toggleZoom(id: PanelId): void;
	pagerState(): {
		currentTurn: number;
		label: string;
		canPrev: boolean;
		canNext: boolean;
		isAll: boolean;
		pinned: boolean;
	};
	stepTurn(delta: -1 | 1): void;
	toggleToolsScopeAll(): void;
	isMessagesFollowingEnd(): boolean;
	getMessagesViewportHeight(): number;
	isTurnPinned(): boolean;
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

export default function (_pi: ExtensionAPI) {}
