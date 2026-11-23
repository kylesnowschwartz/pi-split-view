/**
 * split-view.ts — unified panel TUI extension
 *
 * One extension owns the whole "split the main window" surface:
 *   - thinking panel  (top-left band)
 *   - tools panel     (top-right band)
 *   - files panel     (right dock side column, with an edit-diff subpanel)
 *
 * Layout (fullscreen, composed in ONE layer owned by layout-manager):
 *
 *   band on?  files on?
 *   ─────────────────────────────────────
 *   both  → HStack(VStack(band, transcript), filesDock)
 *   band  → VStack(band, transcript)
 *   files → HStack(transcript, filesDock)
 *   none  → transcript (no layer)
 *
 * With trimResponse on, "transcript" above is replaced by the response doc
 * ScrollView + the base root's reused editor dock (works standalone, without
 * band or files).
 *
 * Regular (non-fullscreen) mode: the files panel falls back to a non-capturing
 * overlay; the band needs the layout engine and only works in fullscreen.
 *
 * Commands:
 *   /split              full toggle pair: OFF = all panels off (bare pi
 *                       layout), ON = the panel flags saved as startup defaults
 *   /split-thinking     toggle the thinking panel within the band
 *   /split-tools        toggle the tools panel within the band
 *   /files              toggle the files panel (dock in fullscreen, overlay otherwise)
 *   /split-tools-view   toggle tool panel compact ↔ full detail
 *   /split-trim-response toggle panel C: pi transcript ↔ response-only view
 *   /split-height <n>   set the top band height in rows (6–40)
 *   /split-save       persist current layout as startup defaults for NEW
 *                     windows (toggles are session-local by default, so
 *                     concurrent pi windows don't clobber each other)
 *
 * Panels use the measurement-safe architecture: no separate border-column
 * flanks; the ScrollView's always-on scrollbar (track styled as border) IS the right frame
 * edge, and MeasurementSafeVStack subclasses make the engine's discarded
 * intrinsic-height measurement passes O(1) instead of eagerly rendering whole
 * subtrees (panels + transcript) every keystroke frame. The Tool Usage body
 * renders a newest-first visual-row window (MAX_BODY_ROWS); the Thinking body
 * renders its whole buffer up to MAX_UNWINDOWED_ROWS, so a panel scrolled away
 * from the end keeps its position while reasoning streams in (SV-27). Full
 * history stays in the transcript either way.
 *
 * Panel C trim mode (trimResponse): the transcript region of pi's base root is
 * swapped for an extension-owned ScrollView over a document of user / assistant
 * messages (reused from branch + streamed live via pi's own message
 * components), so rendering matches the native transcript minus tool calls,
 * thinking blocks and extension custom entries. pi's startup header and
 * loaded-resources listing stay mounted above those messages (SV-26). The
 * editor dock
 * (pending/status/editor/footer) is reused verbatim, so input is untouched.
 *
 * Response-only is native-parity BY DESIGN (SV-09/SV-10/SV-18, USER DECISION
 * 2026-10-07, decisions/E-policy.md): it shows TEXT content only — pi's own
 * transcript renders user messages as text and drops non-text blocks, so
 * image-only user turns render nothing there either; it keeps FULL scrollback
 * (unbounded — pi's own transcript is unbounded and offers no virtualization
 * primitive, so this matches the platform's cost model, a constant factor
 * only); and it preserves the NUMERIC scroll offset across branch switches —
 * the ScrollView clamps the old offset into the new content, exactly like
 * the native transcript on the same /tree switch. Toggling trim itself does
 * not move the response doc's scroll position.
 *
 * Single-TUI-context assumption (SV-20): this extension and layout-manager.ts
 * assume ONE interactive TUI context per process. Module state (tuiRef, panel
 * flags, buffers) and the shared layout manager (one tuiRef / baseRoot / layer
 * map on globalThis) are singletons. pi does not guarantee this upstream, and
 * simultaneous TUI contexts in one process are unverified and unsupported.
 *
 * Performance: pi's renderCache is fresh every frame, so panels cache their
 * wrapped/styled output on a (version, width) key; unchanged frames are O(1).
 * requestRender() is gated on any panel being active.
 *
 * Mouse (fullscreen): header [↗]/[×] buttons zoom / hide a panel; drag the
 * band bottom border (height), the tools panel's left edge (split) and the
 * files dock's left edge (width). Drags mutate the composed stack entries in
 * place (applyGeometry) so panel scroll positions survive.
 *
 * Shortcuts (ctrl+o/ctrl+t) are dropped: reserved built-ins, un-registrable.
 */

import {
	generateDiffString,
	getLanguageFromPath,
	highlightCode,
	renderDiff,
	AssistantMessageComponent,
	UserMessageComponent,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	HStack,
	Image,
	ScrollView,
	Spacer,
	VStack,
	getCapabilities,
	getImageDimensions,
	imageFallback,
	type Component,
	type OverlayHandle,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	wrapTextWithAnsi,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	loadUiPanelsConfig,
	saveUiPanelsConfig,
	normalizeConfig,
	assignSlot,
	LAYOUT_PRESETS,
	type LayoutSlots,
	type PresetName,
	type SlotName,
	type SlotPanel,
	type DockSide,
	type ToolMode as ToolModeCfg,
	type ThinkingScope,
	type ThinkingHudMode,
	type ResponseSource,
} from "./ui-panels-config.ts";
import {
	ThinkingAiRefiner,
	analyzeThinkingLineLocal,
	applyAiSpansOverLine,
	renderThinkingSpans,
	type ThinkingHudPalette,
} from "./thinking-hud.ts";
import {
	initToolHighlighter,
	highlightBashCommand,
	highlightCliOutputLine,
	highlightCodeTreeSitter,
	isLightTheme,
} from "./tool-highlighter.ts";
import {
	getBaseRoot,
	initLayoutManager,
	setLayoutLayer,
	isLayoutLayerActive,
	selfHealLayout,
} from "./layout-manager.ts";
import {
	type LayoutContext,
	type LayoutMode,
	type LayoutStrategy,
	MeasurementSafeVStack,
	type PanelCtl,
	type PanelId,
} from "./layout-types.ts";
import { GridLayoutStrategy } from "./layout-grid.ts";
import { DrawersLayoutStrategy } from "./layout-drawers.ts";
import {
	alignTurnSpans,
	appendStreamTail,
	bashPathCandidates,
	bandToolsColsFor as bandToolsColsForPct,
	capDisplayLine,
	capToolText,
	dockColsFor as dockColsForManual,
	filesPanelRowBudget,
	formatDuration,
	formatToolArgSummary,
	headTailPreview,
	isCappedToolText,
	isInternalNotificationText,
	isToolExpanded,
	keepsInResponseOnly,
	lastImageBlock,
	liveTailLines,
	outputPreview,
	selectActiveTurns,
	stripLeadingTrailingBlankLines,
	toolsPagerButtons,
	truncateInline,
	thoughtsSinceLastUser,
	visibleTurnsInViewport,
	type ImageBlock,
	type ToolExpandGlobal,
	type ToolsScope,
	type TurnSpan,
} from "./helpers.ts";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const WIDGET_KEY = "split-view";
const MAX_TOOLS = 60;
// Display window (logical lines) for the thinking panel. The full transcript
// keeps everything; the band is a recent-history view. Must stay small: the
// per-flush render cost is dominated by wrapping the visible window.
const MAX_LINES = 400;
// A newline-free streaming tail grows char by char and re-wraps on every
// flush. Bounded by dropping its older HALF on overflow (appendStreamTail),
// so the visible paragraph re-flows once per ~8K chars, not on every flush.
const MAX_TAIL_CHARS = 16000;
const MAX_FILES = 500;
const MAX_WIDGET_NAMES = 3;
const MIN_TERM_WIDTH = 90;
const MAX_TOOL_OUTPUT_LINES = 80;
/** Max lines rendered in an expanded rich bash/read/write card when not zoomed. */
const MAX_EXPANDED_RICH_LINES = 40;
/** Lines of an edit's unified diff kept per tool entry (zoomed tools view). */
const MAX_TOOL_DIFF_LINES = 150;
// OracleSpec body window: hard cap on FINAL VISUAL rows rendered by band
// panels (logical lines can wrap into many). Wrapped rows are memoized per
// line, so only changed lines (the streaming tail) re-wrap on a flush.
const MAX_BODY_ROWS = 400;
// SV-27: the thinking panel renders its whole buffer instead of a sliding
// window, so ITS visual-row bound has to come from here — MAX_LINES counts
// LOGICAL lines, and one of them can wrap into hundreds of rows. 4x the normal
// window leaves every realistic turn completely stable while still capping a
// pathological buffer (beyond it the body falls back to the newest rows).
const MAX_UNWINDOWED_ROWS = MAX_BODY_ROWS * 4;
// Hard cap on raw chars per logical line (giant-line guard). ≥ MAX_TAIL_CHARS
// so the streaming tail is never cut by a sliding (re-flowing) window.
const MAX_LINE_CHARS = MAX_TAIL_CHARS;
/** Rows the transcript + editor need below the band; shorter terminals hide
 * the band (B2) instead of squeezing the transcript. */
const MIN_ROWS_BELOW_BAND = 12;

/** Legend shown at the bottom of the files list. */
const LEGEND = "r read · w write · s seen(bash) · a subagent";

// ─── module-lifetime state ───────────────────────────────────────────────────

let tuiRef: any;
let widgetSet = false;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
/** SV-14: the saved startup composition is still unapplied. Armed in
 * session_start before reconstruct(); consumed by the widget factory (the
 * first point where the fullscreen root is available, BEFORE the first
 * paint) or by the deferred startup timer as a fallback. */
let startupPending = false;

// Overlay registry for the regular-mode files panel (survives /reload).
const REG_KEY = Symbol.for("pi.explored-files");
interface Registry {
	gen: number;
	active?: OverlayHandle | null;
	activeGen?: number;
	/** The overlay's component, stored so the extension — the valid lifecycle
	 * owner — can dispose it on close/shutdown (Option C: no ctx.ui.custom()
	 * promise exists to dispose it for us). decisions/D-overlay-lifecycle.md */
	panel?: FilesPanel | null;
}
const G = globalThis as Record<symbol, Registry>;
const REG: Registry = G[REG_KEY] ?? { gen: 0 };
G[REG_KEY] = REG;
const MY_GEN = ++REG.gen;

/** Terminal height, captured by the overlay's visible callback each render. */
let termHeight = 0;

// Panel enable flags (kept in sync with config; thinking/tools default true).
let thinkingOn = true;
/** SV-27: "turn" = the thinking panel carries the current turn only (the
 * buffer is cleared on each new user message); "session" = accumulate every
 * turn (default, the pre-SV-27 behaviour). Session-local;
 * /split-thinking-scope, persisted by /split-save. */
let thinkingScope: ThinkingScope = "session";
/** Two-tier semantic HUD mode for the Thinking panel ("ai" | "local" | "off").
 * Session-local; /split-thinking-hud, persisted by /split-save. */
let thinkingHudMode: ThinkingHudMode = "ai";
/** Latest ExtensionContext for async Tier 2 fast-AI thinking refinement. */
let lastCtx: ExtensionContext | null = null;
/** Tier 2 async fast-AI paragraph refiner (bounded LRU + concurrency cap). */
const aiRefiner = new ThinkingAiRefiner();

function enqueueThinkingAiLine(line: string): void {
	if (thinkingHudMode !== "ai" || !lastCtx) return;
	aiRefiner.enqueue(line, lastCtx, () => {
		thinking.version++;
		thinkingBody?.invalidate();
		if (anyPanelActive()) requestRender();
	});
}

function enqueueRecentThinkingLines(maxLines = 8): void {
	if (thinkingHudMode !== "ai" || !lastCtx) return;
	const recent: string[] = [];
	for (let bi = thinking.blocks.length - 1; bi >= 0 && recent.length < maxLines; bi--) {
		const block = thinking.blocks[bi]!;
		for (let li = block.lines.length - 1; li >= 0 && recent.length < maxLines; li--) {
			const line = block.lines[li]!;
			if (line.trim().length >= 45) recent.push(line);
		}
	}
	for (let i = recent.length - 1; i >= 0; i--) {
		enqueueThinkingAiLine(recent[i]!);
	}
}
let toolsOn = true;
let filesOn = false;
/** Which side of the terminal the dock column sits on ("left" | "right"). */
let dockSide: DockSide = "right";
/** Files panel edit-diff subpanel (session-local; /split-diff, persisted by
 * /split-save). Off keeps the file list but drops the bottom diff section. */
let showDiff = true;
/** Response-only divider between successive assistant messages: "rule" (dim
 * dashed line) or "space" (plain blank line). Session-local; /split-divider,
 * persisted by /split-save. */
let answerDividerMode: "rule" | "space" = "rule";
/** What response-only mode draws: "messages" = the response doc this
 * extension builds; "transcript" = pi's own transcript minus tool calls.
 * Session-local; /split-response-source, persisted by /split-save. */
let responseSource: ResponseSource = "messages";
let toolMode: ToolModeCfg = "compact";
/** Tool panel turn scope: "visible" (auto-sync with Messages viewport),
 * "turn" (latest turn only), or "all" (all turns). Persisted by /split-save. */
let toolsScope: ToolsScope = "visible";
/** 1-indexed user turn counter for the current branch. */
let currentTurn = 0;
/** Manually pinned turn via [◀]/[▶] or /split-turn <N>, or null for auto/all. */
let pinnedTurn: number | null = null;
/** Short (~32-char) preview of each user prompt, keyed by 1-indexed turn. */
const turnPreviews = new Map<number, string>();
/** Row spans of each turn in the Messages ScrollView, recorded on render. */
let messageTurnSpans: TurnSpan[] = [];
/** Mounted Messages ScrollView (trimmed or native), captured on compose. */
let messagesScrollRef: ScrollView | null = null;
/** Last observed visible-turns key ("1,2"), guarding against redundant renders. */
let lastVisibleTurnsKey = "";
/** Suppress clearing pinnedTurn on the render immediately following a
 * programmatic scrollTo(span.startRow) triggered by pager/command navigation. */
let suppressNextPinClear = false;
/** Live-output focus of the tools panel (bottom-frame [▶] /
 * /split-tools-live): the id of the PINNED tool whose raw output stream the
 * panel shows, or null. Pinned once chosen — a newer streaming tool never
 * retargets it, and it stays on after the tool ends (the user may still be
 * reading); only the user exits it, or the entry disappearing (eviction,
 * session rebuild) clears it. Session-local. */
let liveToolId: string | null = null;
/** The tools panel's body ScrollView (band or zoomed; set on compose), so
 * entering / leaving live mode can jump to the end of the swapped content
 * instead of keeping a scroll offset that points into unrelated rows. */
let toolsScroll: ScrollView | null = null;
/** The thinking panel's RecentBody (band or zoomed; set on compose), so
 * toggling /split-thinking-hud can invalidate its per-line wrap memo immediately. */
let thinkingBody: RecentBody | null = null;
/** Panel C: response-only view instead of pi's transcript (persisted). */
let trimResponse = false;
/** Top band height in rows (6–40, persisted; /split-height). */
let bandHeight = 14;
/** F: tools panel's share of the band width in percent (20–60, default 35,
 * persisted as toolsWidthPct; session-local, only /split-save writes it). */
let toolsWidthPct = 35;
/** Files dock width in cols set by dragging its edge (null = auto 25%,
 * 34–48). Session-local; persisted by /split-save as filesWidth. */
let filesWidth: number | null = null;
/** Named layout slot assignments (topLeft, topRight, main, dock). */
let layoutSlots: LayoutSlots = {
	topLeft: null,
	topRight: null,
	main: "messages",
	dock: null,
};
/** Panel expanded to the whole area above the editor (header ↗ button).
 * Transient: never persisted. */
// PanelId is imported from ./layout-types.ts.
let zoomed: PanelId | null = null;

const SLOT_NAMES: readonly SlotName[] = ["topLeft", "topRight", "main", "dock"];

function slotOf(panel: Exclude<SlotPanel, null>): SlotName | null {
	for (const s of SLOT_NAMES) {
		if (layoutSlots[s] === panel) return s;
	}
	return null;
}

function syncFlagsFromSlots(): void {
	thinkingOn = slotOf("thinking") !== null;
	toolsOn = slotOf("tools") !== null;
	filesOn = slotOf("files") !== null;
}

function hasNonBareSlots(): boolean {
	return (
		layoutSlots.topLeft !== null ||
		layoutSlots.topRight !== null ||
		layoutSlots.main !== "messages" ||
		layoutSlots.dock !== null
	);
}

const bandToolsColsFor = (total: number) => bandToolsColsForPct(total, toolsWidthPct);
const dockColsFor = (cols: number) => dockColsForManual(cols, filesWidth);

/** SV-08: fingerprint of the live theme's panel-relevant colors, captured
 * when the composition was built. pi replaces the global theme object on a
 * theme change (extensions receive no event), and components/caches capture
 * ANSI at build time — so the widget render compares this fingerprint and
 * recomposes theme-dependent components on a change ONLY. */
let composedThemeFp: string | null = null;

function themeFingerprint(theme: Theme): string {
	return [
		theme.fg("border", "x"),
		theme.fg("accent", "x"),
		theme.fg("muted", "x"),
		theme.fg("thinkingText", "x"),
		theme.fg("toolOutput", "x"),
		theme.fg("success", "x"),
		theme.fg("error", "x"),
		theme.fg("warning", "x"),
		theme.fg("dim", "x"),
		theme.fg("text", "x"),
	].join("|");
}

// ─── thinking buffer ─────────────────────────────────────────────────────────

interface ThinkingBlock {
	lines: string[];
	tail: string;
	complete: boolean;
	turn: number;
}

/**
 * Coalesce streaming appends: each token bumps `version`, which invalidates the
 * panel's (version, width) render cache → full re-wrap of all lines per frame.
 * During a stream we bump at most every THINK_RAF_MS instead, so keystroke
 * frames don't queue behind 5000-line re-wraps. Complete blocks + end() are
 * unaffected (they bump synchronously).
 */
const THINK_RAF_MS = 50;
let thinkFlushTimer: ReturnType<typeof setTimeout> | null = null;
let thinkDirty = false;

function flushThinking(): void {
	thinkFlushTimer = null;
	if (!thinkDirty) return;
	thinkDirty = false;
	thinking.version++;
	requestRender();
}

function cancelPendingThinkFlush(): void {
	thinkDirty = false;
	if (thinkFlushTimer) {
		clearTimeout(thinkFlushTimer);
		thinkFlushTimer = null;
	}
}

/**
 * Tools-side twin of the thinking flush: tool_execution_update can fire many
 * times per second while a command streams output; each bump would re-wrap
 * the tools window + repaint. Coalesce to ≤1 version bump per TOOLS_FLUSH_MS.
 * start/end stay synchronous (entry appears / finalizes immediately).
 */
const TOOLS_FLUSH_MS = 100;
let toolsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let toolsDirty = false;

function flushTools(): void {
	toolsFlushTimer = null;
	if (!toolsDirty) return;
	toolsDirty = false;
	toolsVersionCounter++;
	requestRender();
}

function cancelPendingToolsFlush(): void {
	toolsDirty = false;
	if (toolsFlushTimer) {
		clearTimeout(toolsFlushTimer);
		toolsFlushTimer = null;
	}
}

function markToolsDirty(): void {
	toolsDirty = true;
	if (!toolsFlushTimer) toolsFlushTimer = setTimeout(flushTools, TOOLS_FLUSH_MS);
}

const thinking = {
	blocks: [] as ThinkingBlock[],
	current: null as ThinkingBlock | null,
	streaming: false,
	version: 0,
	start() {
		if (this.current && (this.current.lines.length || this.current.tail)) {
			this.current.complete = true;
			this.blocks.push(this.current);
		}
		this.current = { lines: [], tail: "", complete: false, turn: Math.max(1, currentTurn) };
		this.streaming = true;
		this.version++;
	},
	append(delta: string) {
		if (!this.current)
			this.current = { lines: [], tail: "", complete: false, turn: Math.max(1, currentTurn) };
		// Split complete lines first, then cap the tail (half-drop on overflow).
		const before = this.current.lines.length;
		this.current.tail = appendStreamTail(
			this.current.lines,
			this.current.tail,
			delta,
			MAX_TAIL_CHARS,
		);
		if (this.current.lines.length !== before) {
			for (let i = before; i < this.current.lines.length; i++) {
				enqueueThinkingAiLine(this.current.lines[i]!);
			}
			this.trim();
		}
		thinkDirty = true;
		if (!thinkFlushTimer)
			thinkFlushTimer = setTimeout(flushThinking, THINK_RAF_MS);
	},
	end(text: string) {
		cancelPendingThinkFlush();
		if (this.current) {
			if (text) {
				// Authoritative final content: replace the accumulated buffer.
				this.current.lines = text.split(/\r?\n/);
				this.current.tail = "";
			} else if (this.current.tail) {
				// SV-21: an empty/omitted end payload must not wipe streamed
				// text — finalize the accumulated tail into the current block.
				this.current.lines.push(this.current.tail);
				this.current.tail = "";
			}
			this.current.complete = true;
			const completedLines = this.current.lines;
			this.blocks.push(this.current);
			this.current = null;
			this.trim();
			// Enqueue the last few completed lines for Tier 2 AI refinement
			// (cached/in-flight lines are deduplicated by ThinkingAiRefiner).
			for (let i = Math.max(0, completedLines.length - 6); i < completedLines.length; i++) {
				enqueueThinkingAiLine(completedLines[i]!);
			}
		}
		this.streaming = false;
		this.version++;
	},
	trim() {
		// Hard-bound the whole display buffer (oldest lines first, splicing
		// partially into the front/current block so a giant block trims instead
		// of vanishing). The old version only evicted whole completed blocks, so
		// an oversized current block or reconstruct() output could blow past
		// MAX_LINES.
		let excess = this.countLines() - MAX_LINES;
		while (excess > 0) {
			const b = this.blocks[0];
			if (!b) {
				if (this.current) {
					const cut = Math.min(excess, this.current.lines.length);
					this.current.lines.splice(0, cut);
					excess -= cut;
				}
				break;
			}
			if (b.lines.length <= excess) {
				this.blocks.shift();
				excess -= b.lines.length;
			} else {
				b.lines.splice(0, excess);
				excess = 0;
			}
		}
	},
	countLines() {
		let total = 0;
		for (const b of this.blocks) total += b.lines.length;
		if (this.current) total += this.current.lines.length;
		return total;
	},
	/** SV-27: `keepStreaming` preserves the live-stream indicator when the buffer
	 * is cleared mid-turn (/split-thinking-scope turn while reasoning is still in
	 * flight); the next thinking_delta rebuilds `current`. */
	reset(keepStreaming = false) {
		cancelPendingThinkFlush();
		const wasStreaming = this.streaming;
		this.blocks = [];
		this.current = null;
		this.streaming = keepStreaming && wasStreaming;
		this.version++;
	},
};

function thinkingLines(theme: Theme, width: number): string[] {
	const out: string[] = [];
	const sep = theme.fg("dim", "─".repeat(Math.max(8, Math.min(60, width - 3))));
	const activeTurns = thinkingScope === "session" ? activeTurnSelection() : null;
	for (const b of thinking.blocks) {
		if (activeTurns !== null && !activeTurns.includes(b.turn)) continue;
		if (out.length) out.push("");
		out.push(sep);
		for (const l of b.lines) out.push(l);
	}
	if (
		thinking.current &&
		(activeTurns === null || activeTurns.includes(thinking.current.turn))
	) {
		if (out.length) out.push("");
		for (const l of thinking.current.lines) out.push(l);
		if (thinking.current.tail) out.push(thinking.current.tail);
	}
	return out;
}

// ─── response doc (panel C trim mode) ───────────────────────────────

/**
 * Panel C's document: user + assistant messages only, rendered with pi's own
 * transcript components. Built from the branch (session start / tree) and
 * streamed live (message_start/update/end). Assistant content is filtered to
 * drop thinking blocks (panel A owns those) — tool calls never render here
 * (panel B owns those), so an assistant message with no text is skipped.
 */
const responseDoc = new Container();
let streamingResponseComponent: AssistantMessageComponent | null = null;

/** Live theme proxy captured from ctx.ui.theme / the widget factory; it
 * resolves the current global theme on every access, so answer dividers never
 * go stale after a theme change (the doc is rebuilt on change anyway). */
let docTheme: Theme | null = null;

/** One dim rule separating consecutive assistant messages in the response-only
 *  doc. Dashed (and dim) so it reads fainter than the panel borders. */
class AnswerDivider implements Component {
	render(width: number): string[] {
		const rule = "┄".repeat(Math.max(0, width));
		return [docTheme ? docTheme.fg("dim", rule) : rule];
	}
	invalidate(): void {}
	dispose(): void {}
}

/** Role of the last message actually added to the response doc. */
let lastResponseRole: "user" | "assistant" | null = null;

/**
 * Begin a response-doc entry: always a blank spacer between turns, plus the
 * divider ONLY between two successive assistant messages (never around a user
 * message). `answerDivider` = "space" drops the rule, leaving plain
 * blank-line spacing.
 */
function beginResponseEntry(role: "user" | "assistant"): void {
	if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
	if (
		role === "assistant" &&
		lastResponseRole === "assistant" &&
		answerDividerMode === "rule"
	)
		responseDoc.addChild(new AnswerDivider());
	lastResponseRole = role;
}

function messageText(msg: any): string {
	const c = msg?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c))
		return c
			.filter((p: any) => p?.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text)
			.join("");
	return "";
}

/** Content with thinking blocks and tool calls stripped (panel C is response-only). */
function responseContent(msg: any): any[] {
	return (Array.isArray(msg?.content) ? msg.content : []).filter(
		(c: any) => c?.type !== "thinking" && c?.type !== "toolCall",
	);
}

/** Append a message to the response doc (user or assistant). */
function addResponseMessage(msg: any): void {
	try {
		if (msg.role === "user") {
			const text = messageText(msg);
			if (!text.trim() || isInternalNotificationText(text)) return;
			beginResponseEntry("user");
			responseDoc.addChild(new UserMessageComponent(text, getMarkdownTheme()));
			return;
		}
		if (msg.role === "assistant") {
			const content = responseContent(msg);
			const hasText = content.some(
				(c: any) =>
					c?.type === "text" && typeof c.text === "string" && c.text.trim(),
			);
			// Keep empty-text messages whose stopReason shows an error marker.
			if (!hasText && msg.stopReason !== "error" && msg.stopReason !== "aborted")
				return;
			beginResponseEntry("assistant");
			// toolCalls are stripped too so the component's error/abort markers
			// render (it suppresses them when toolCalls exist — in the full
			// transcript the tool components show errors instead).
			responseDoc.addChild(
				new AssistantMessageComponent(
					{ ...msg, content },
					true,
					getMarkdownTheme(),
					"Thinking…",
					1,
					[],
				),
			);
		}
	} catch {
		/* theme not ready yet — skipped; rebuilt on next reconstruct */
	}
}

/** Rebuild the whole response doc from the current branch. */
function rebuildResponseDoc(ctx: ExtensionContext): void {
	responseDoc.clear();
	streamingResponseComponent = null;
	lastResponseRole = null;
	const branch = ctx.sessionManager.getBranch();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = (entry as any).message;
		if (msg) addResponseMessage(msg);
	}
}

/** Live-stream an assistant message into the doc (lazy: created on first visible text). */
function responseMessageUpdate(msg: any): void {
	if (msg?.role !== "assistant") return;
	const stripped = { ...msg, content: responseContent(msg) };
	const hasVisible = stripped.content.some(
		(c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim(),
	);
	if (!streamingResponseComponent) {
		// Pure tool-call / thinking rounds never create a component — no stray
		// spacers accumulate in the doc.
		if (!hasVisible) return;
		try {
			beginResponseEntry("assistant");
			streamingResponseComponent = new AssistantMessageComponent(
				undefined as any,
				true,
				getMarkdownTheme(),
				"Thinking…",
				1,
				[],
			);
			responseDoc.addChild(streamingResponseComponent);
		} catch {
			/* theme not ready */
			return;
		}
	}
	try {
		streamingResponseComponent.updateContent(stripped, true);
	} catch {
		/* ignore */
	}
}

function responseMessageEnd(msg: any): void {
	if (msg?.role !== "assistant") return;
	if (streamingResponseComponent) {
		try {
			streamingResponseComponent.updateContent(
				{ ...msg, content: responseContent(msg) },
				false,
			);
		} catch {
			/* ignore */
		}
		streamingResponseComponent = null;
	} else {
		// No component was streamed (no update fired, or thinking/tool-only
		// round): finalize from the full message — addResponseMessage itself
		// skips empty text and keeps error/abort markers.
		addResponseMessage(msg);
	}
}

// ─── tool buffer ─────────────────────────────────────────────────────────────

let toolsVersionCounter = 0;

interface ToolEntry {
	id: string;
	name: string;
	args: string;
	output: string;
	active: boolean;
	isError: boolean;
	/** 1-indexed user turn that triggered this tool call. */
	turn: number;
	subagent?: boolean;
	agent?: string;
	/** Last image block of the result (e.g. `read` on an image file), so the
	 * panel can render it inline like pi's transcript does. */
	image?: ImageBlock;
	/** Raw unified diff of an `edit` result (details.diff), shown in the
	 * zoomed tools view; capped to MAX_TOOL_DIFF_LINES. */
	diff?: string;
	/** Wall-clock start/end (ms) of LIVE calls; absent for resumed history. */
	startedAt?: number;
	endedAt?: number;
	/** The tool reported at least one partial result (tool_execution_update),
	 * i.e. it streams output via onUpdate while running. */
	streaming?: boolean;
	/** The true first output line, captured the first time output was seen —
	 * `output` itself keeps only the last MAX_TOOL_OUTPUT_LINES, so without
	 * this the band's head+tail preview could not show the real first line.
	 * null = unknown (the first text seen was already capped). */
	firstLine?: string | null;
	/** Non-blank lines in the last output text (the stored window is only the
	 * last MAX_TOOL_OUTPUT_LINES of them), for an honest "+N more" count. */
	outputLines?: number;
	/** Raw latest output text (capped like every tool text) of a streaming
	 * tool, for the live-output view — the stream itself, not the trimmed
	 * 20-line window. Kept while the tool runs and, after it ends, only for
	 * the pinned live tool; dropped otherwise. */
	liveText?: string;
}
const toolsBy = new Map<string, ToolEntry>();
const toolOrder: string[] = [];
/** Per-tool manual expand/collapse overrides (cleared on session reset). */
const toolExpandOverrides = new Map<string, boolean>();
/** Global expand override for tool cards (null = auto: running & errors). */
let toolExpandGlobal: ToolExpandGlobal = null;

/** Running tools that stream partial output, oldest → newest. */
function streamingActiveIds(): string[] {
	return toolOrder.filter((id) => {
		const e = toolsBy.get(id);
		return !!e?.active && !!e.streaming;
	});
}

/** The pinned live tool, if its entry still exists. */
function liveEntry(): ToolEntry | undefined {
	return liveToolId ? toolsBy.get(liveToolId) : undefined;
}

/** Bottom-frame live button: [▶] while some tool streams, [◼] while live
 * mode is on (so there is always a way out, even after the stream ended).
 * ONE predicate for both painting and hit-testing. */
function liveButtonVisible(): boolean {
	return liveToolId !== null || streamingActiveIds().length > 0;
}

/** Pin (or with null, leave) the live-output view. A finished tool that is
 * no longer pinned drops its raw stream text. */
function setLiveTool(id: string | null): void {
	const prev = liveEntry();
	if (prev && prev.id !== id && !prev.active) delete prev.liveText;
	liveToolId = id;
	toolsVersionCounter++;
	toolsScroll?.scrollToEnd();
	requestRender();
}

/** B1: 1 Hz ticker that refreshes running-tool elapsed counters; runs only
 * while a timed tool is active and stops itself afterwards. */
let toolTicker: ReturnType<typeof setInterval> | null = null;
function stopToolTicker(): void {
	if (toolTicker) {
		clearInterval(toolTicker);
		toolTicker = null;
	}
}
function ensureToolTicker(): void {
	if (toolTicker) return;
	toolTicker = setInterval(() => {
		let running = false;
		for (const e of toolsBy.values())
			if (e.active && e.startedAt !== undefined) running = true;
		if (!running) return stopToolTicker();
		toolsVersionCounter++;
		if (toolsOn) requestRender();
	}, 1000);
	toolTicker.unref?.();
}

function resultText(r: any): string {
	let text: string;
	if (typeof r === "string") text = r;
	else {
		const content = r?.content;
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("");
		} else text = "";
	}
	// SV-16: bound the stored text before the caller splits/keeps lines.
	return capToolText(text);
}

function argsJson(args: any): string {
	try {
		// SV-16: bound the stored args JSON (newest suffix + marker).
		return capToolText(JSON.stringify(args ?? {}));
	} catch {
		return "";
	}
}

function setToolOutput(e: ToolEntry, text: string): void {
	// SV-16: cap BEFORE splitting so the split never sees unbounded text.
	const capped = capToolText(text);
	const lines = capped.split(/\r?\n/);
	e.output =
		e.name.toLowerCase() === "read"
			? lines.slice(0, MAX_TOOL_OUTPUT_LINES).join("\n")
			: lines.slice(-MAX_TOOL_OUTPUT_LINES).join("\n");
	let nonBlank = 0;
	for (const l of lines) if (l.trim()) nonBlank++;
	e.outputLines = nonBlank;
	// Capture the true first line only once: output accumulates from the start,
	// so the first write still holds the beginning (later writes are tails) —
	// unless that first write was already capped: then its first line is the
	// truncation marker and the real one is unknown.
	if (e.firstLine === undefined && nonBlank > 0) {
		e.firstLine = isCappedToolText(capped)
			? null
			: lines.find((l) => l.trim().length > 0)!.trim();
	}
}

/** SV-17: ingest one tool call through the SAME path for live events and
 * branch reconstruction (resume / session_tree), so the bounded buffer,
 * the newest-first display and the MAX_TOOLS eviction (oldest shifted out)
 * behave identically for resumed and live entries. */
function ingestToolCall(id: string, name: string, args: any, startedAt?: number): void {
	toolOrder.push(id);
	toolsBy.set(id, {
		id,
		name,
		args: argsJson(args),
		output: "",
		active: true,
		isError: false,
		turn: Math.max(1, currentTurn),
		startedAt,
	});
	if (startedAt !== undefined) ensureToolTicker();
	toolsVersionCounter++;
	if (toolOrder.length > MAX_TOOLS) {
		const evict = toolOrder.shift()!;
		toolsBy.delete(evict);
		toolExpandOverrides.delete(evict);
		if (evict === liveToolId) liveToolId = null;
	}
}

/** SV-17: ingest one tool result, correlated to its call by id (live event
 * or resumed branch entry). A result whose call is not in the bounded buffer
 * (evicted or unknown) is ignored. */
function ingestToolResult(id: string, result: any, isError: boolean, endedAt?: number): void {
	const e = toolsBy.get(id);
	if (!e) return;
	if (endedAt !== undefined && e.startedAt !== undefined) e.endedAt = endedAt;
	const text = resultText(result);
	if (text) setToolOutput(e, text);
	// Keep the last image block so the tools panel can render it inline on
	// terminals with image support (pi's transcript does the same via pi-tui's
	// Image component; resultText drops non-text blocks).
	const img = lastImageBlock(result?.content);
	if (img) e.image = img;
	const diff = result?.details?.diff;
	if (typeof diff === "string" && diff) {
		const lines = capToolText(diff).split(/\r?\n/);
		e.diff = lines.slice(0, MAX_TOOL_DIFF_LINES).join("\n");
		if (lines.length > MAX_TOOL_DIFF_LINES)
			e.diff += `\n… +${lines.length - MAX_TOOL_DIFF_LINES} more diff lines`;
	}
	e.active = false;
	e.isError = isError;
	cancelPendingToolsFlush();
	toolsVersionCounter++;
}

/** One row-source item of a band panel body: a styled text line, or an
 * inline image block. Image items render RAW via pi-tui's Image component
 * (never wrapped, capped or padded) — the same line structure pi's own
 * transcript feeds its ScrollView, which the TUI engine handles (image-aware
 * scrollbar, scroll cropping, placement cleanup on full repaints). */
type BodyItem = string | { image: ImageBlock; maxRows?: number };

/** Band (non-zoomed) tools panel: inline images are thumbnails capped at
 * this many rows so they don't crowd the small panel. Zoomed: pi's default. */
const BAND_IMAGE_ROWS = 6;

/** Live view: at most this many of the newest raw output lines (below
 * MAX_BODY_ROWS, so wrapped long lines usually still fit the body window). */
const LIVE_MAX_LINES = 300;

/** One tool's summary row: status mark, name, badge, duration, args. */
function toolHeaderRow(th: Theme, e: ToolEntry, textWidth: number): string {
	const mark = e.active
		? th.fg("warning", "●")
		: e.isError
			? th.fg("error", "✗")
			: th.fg("success", "✓");
	const name = e.active
		? th.fg("accent", e.name)
		: e.isError
			? th.fg("error", e.name)
			: th.fg("success", e.name);
	const badge = e.subagent ? th.fg("muted", `[${e.agent ?? "sub"}]`) : "";
	// B1: duration (done) or live elapsed counter (running, from 1s on).
	let dur = "";
	if (e.startedAt !== undefined) {
		if (e.endedAt !== undefined)
			dur = th.fg("dim", ` ${formatDuration(e.endedAt - e.startedAt)}`);
		else if (e.active && Date.now() - e.startedAt >= 1000)
			dur = th.fg("warning", ` ${formatDuration(Date.now() - e.startedAt, true)}`);
	}
	const prefix = `${mark} ${name}${badge}${dur}`;
	const room = textWidth - visibleWidth(prefix) - 1;
	const args =
		e.args && room >= 8
			? th.fg("muted", ` ${truncateInline(e.args, room)}`)
			: "";
	return prefix + args;
}

/** Live-output view (bottom-frame [▶] / /split-tools-live): the pinned
 * tool's raw output stream — indentation and blank lines kept, long lines
 * wrapped by the body — instead of the trimmed 20-line preview. Shown
 * regardless of zoom / compact mode. */
function liveToolItems(th: Theme, e: ToolEntry, textWidth: number): BodyItem[] {
	const out: BodyItem[] = [];
	const state = e.active ? "running" : e.isError ? "failed" : "finished";
	let status = ` ▶ live output · ${state}`;
	const newer = streamingActiveIds().filter((id) => id !== e.id);
	if (newer.length > 0) {
		const n = toolsBy.get(newer[newer.length - 1])?.name ?? "tool";
		status += ` · newer: ${n}${newer.length > 1 ? ` +${newer.length - 1}` : ""} running (/split-tools-live)`;
	}
	out.push(th.fg("dim", truncateInline(status, textWidth)));
	out.push(toolHeaderRow(th, e, textWidth));
	const { lines, hidden } = liveTailLines(e.liveText ?? e.output ?? "", LIVE_MAX_LINES);
	if (hidden > 0) out.push(th.fg("dim", `  … ${hidden} earlier lines`));
	if (lines.length === 0 && e.active) out.push(th.fg("dim", "  …"));
	for (const l of lines) out.push(l ? th.fg("toolOutput", `  ${l}`) : "");
	return out;
}

function toolItems(theme: Theme, width: number): BodyItem[] {
	const th = theme;
	// Text budget inside the frame: 1 col inset + ≥2 trailing pad cols
	// (the transient scrollbar paints over the pad, never the frame).
	const textWidth = Math.max(8, width - 3);
	const live = liveEntry();
	if (live) return liveToolItems(th, live, textWidth);
	const out: BodyItem[] = [];
	// Zooming the tools panel expands it over the whole area above the editor,
	// so it always renders full detail regardless of the compact/full toggle.
	const zoomedTools = zoomed === "tools";
	const full = toolMode === "full" || zoomedTools;
	for (const id of toolOrder) {
		const e = toolsBy.get(id);
		if (!e) continue;
		out.push(toolHeaderRow(th, e, textWidth));
		if (!full) {
			if (out.length > 1) out.splice(out.length - 1, 0, "");
			continue;
		}
		const content = (e.output || "")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (content.length === 0) {
			if (e.active) out.push(th.fg("dim", "  · …"));
		} else if (zoomedTools) {
			// Zoomed: the whole stored output (≤ MAX_TOOL_OUTPUT_LINES).
			const { shown, hidden } = outputPreview(content, MAX_TOOL_OUTPUT_LINES);
			for (const l of shown)
				out.push(th.fg("toolOutput", `  · ${truncateInline(l, textWidth - 4)}`));
			if (hidden > 0) out.push(th.fg("dim", `  · +${hidden} more`));
		} else {
			// Band full detail: head+tail preview — the output's true first line
			// (e.firstLine, kept from when output was first seen), "+N more",
			// last 2 lines — so a running tool's fresh tail stays visible (pi's
			// own transcript previews with keep:"end" for the same reason).
			const { head, hidden, tail } = headTailPreview(content, 1, 2, e.outputLines);
			if (hidden > 0 && e.firstLine) head[0] = e.firstLine;
			const row = (l: string, dim = false) =>
				out.push(th.fg(dim ? "dim" : "toolOutput", `  · ${truncateInline(l, textWidth - 4)}`));
			for (const l of head) row(l);
			if (hidden > 0) row(`+${hidden} more`, true);
			for (const l of tail) row(l);
		}
		// Zoomed: an edit's diff, rendered like pi's transcript (renderDiff
		// colours +/- lines); long lines wrap in the body.
		if (zoomedTools && e.diff) {
			out.push("");
			for (const l of renderDiff(e.diff).split(/\r?\n/)) out.push(`    ${l}`);
		}
		// Inline image result (e.g. read on an image file), like pi's
		// transcript: a separator row, then the image as a raw item. Without
		// image support it's a one-line text fallback styled as an output row.
		if (e.image) {
			if (getCapabilities().images) out.push("");
			out.push({
				image: e.image,
				maxRows: zoomedTools ? undefined : BAND_IMAGE_ROWS,
			});
		}
	}
	return out;
}

const toolsVersion = () => toolsVersionCounter;

// ─── files buffer ────────────────────────────────────────────────────────────

interface FileEntry {
	path: string;
	ops: string;
	count: number;
}
const files = new Map<string, FileEntry>();
let filesVersion = 0;

function pathsFrom(
	toolName: string,
	input: any,
): { abs: string; op: string }[] {
	const out: { abs: string; op: string }[] = [];
	if (toolName === "bash") {
		const cmd = typeof input?.command === "string" ? input.command : "";
		for (const abs of bashPathCandidates(cmd, process.cwd(), homedir())) {
			try {
				if (existsSync(abs) && statSync(abs).isFile()) out.push({ abs, op: "s" });
			} catch {
				/* skip */
			}
		}
		return out;
	}
	const add = (v: unknown, op: string, unconditional: boolean) => {
		if (typeof v !== "string" || !v) return;
		try {
			const abs = path.resolve(v);
			if (!unconditional && (!existsSync(abs) || !statSync(abs).isFile())) return;
			out.push({ abs, op });
		} catch {
			/* skip */
		}
	};
	if (toolName === "read") {
		add(input?.path, "r", true);
		return out;
	}
	if (toolName === "write" || toolName === "edit") {
		add(input?.path, "w", true);
		return out;
	}
	for (const key of ["path", "filePath", "file_path", "imagePath"])
		add(input?.[key], "r", false);
	for (const key of ["paths", "files", "filePaths"]) {
		if (Array.isArray(input?.[key]))
			for (const v of input[key]) add(v, "r", false);
	}
	return out;
}

function record(toolName: string, input: any): void {
	const seen = new Set<string>();
	for (const { abs, op } of pathsFrom(toolName, input)) {
		if (seen.has(abs)) continue;
		seen.add(abs);
		const prev = files.get(abs);
		if (prev) {
			files.delete(abs);
			prev.count++;
			if (!prev.ops.includes(op)) prev.ops += op;
			files.set(abs, prev);
		} else {
			if (files.size >= MAX_FILES)
				files.delete(files.keys().next().value as string);
			files.set(abs, { path: abs, ops: op, count: 1 });
		}
	}
	filesVersion++;
}

function bumpFilesVersion(): void {
	filesVersion++;
}

const recentEntries = (): FileEntry[] => [...files.values()].reverse();

function displayPath(abs: string): string {
	const rel = path.relative(process.cwd(), abs);
	if (rel && !rel.startsWith("..")) return rel;
	const home = homedir();
	if (abs.startsWith(home + path.sep)) return `~${abs.slice(home.length)}`;
	return abs;
}

function widgetLines(theme: Theme, width: number): string[] {
	const entries = recentEntries();
	if (entries.length === 0) return [];
	const names = entries
		.slice(0, MAX_WIDGET_NAMES)
		.map((e) => path.basename(e.path));
	const rest = entries.length - names.length;
	let text = `📂 ${entries.length}`;
	if (names.length) text += `  ${names.join(" · ")}`;
	if (rest > 0) text += `  +${rest}`;
	return [truncateToWidth(theme.fg("dim", text), width)];
}

// ─── edit-diff buffer ────────────────────────────────────────────────────────

/**
 * Raw (unrendered) diff state for the files panel's bottom subpanel.
 * We store raw text (not ANSI) so it survives theme changes; `renderDiff` is
 * applied at draw time. A monotonic token guards against out-of-order async
 * diff computations overwriting a newer edit with a stale older one.
 */
const editDiff = {
	path: "" as string,
	diff: "" as string,
	version: 0,
	token: 0,
};
let pendingDiffToken = 0;
/** SV-23: edit preview/result correlation. Every edit tool_call gets a
 * monotonically increasing generation and owns the preview; a tool_result
 * applies its authoritative diff only when its toolCallId maps to the current
 * generation, so an older, slower edit can never overwrite a newer preview. */
let editGeneration = 0;
const editGenByCallId = new Map<string, number>();

function setEditDiff(p: string, diff: string): void {
	editDiff.path = p;
	editDiff.diff = diff;
	editDiff.version++;
}

function clearEditDiff(): void {
	editDiff.path = "";
	editDiff.diff = "";
	editDiff.version++;
}

// ─── shared helpers ──────────────────────────────────────────────────────────

function requestRender(): void {
	try {
		tuiRef?.requestRender?.();
	} catch {
		/* ignore */
	}
}

const anyPanelActive = () =>
	isLayoutLayerActive("ui") || isLayoutLayerActive("files") || !!REG.active;
// SV-01 (revised): /split is a full toggle pair over every panel flag
// (thinking/tools/files/trim), so its "on" state is the flag disjunction.
// The old bandActive() derived state from the band alone, which made a
// files-only or trim-only layout report "off" for a not-bare view and left
// those panels running after a /split off. Layout-layer checks remain in use
// only for layout ownership (anyPanelActive/filesActive).
const panelsActive = () =>
	layoutMode === "drawers"
		? drawersStrategy.wantsLayer()
		: hasNonBareSlots() || trimResponse;
const filesActive = () => isLayoutLayerActive("files") || !!REG.active;

// ─── mouse: drag-resize, header buttons, wheel routing ───────────────────────

/** Active layout mode and strategy registry. */
let layoutMode: LayoutMode = "grid";

/** Terminal dimensions the current geometry was computed for (resize hook). */
let composedTermCols = -1;
let composedTermRows = -1;

/** Late-bound UI access for mouse actions (set by the widget factory). */
let themeGetter: (() => Theme) | null = null;
let notifyFn: ((msg: string, level: "info" | "warning") => void) | null = null;

/** Grid strategy instance; owns grid geo, drag state, and band/dock composition. */
const gridStrategy = new GridLayoutStrategy({
	getSlots: () => layoutSlots,
	getDockSide: () => dockSide,
	getBandHeight: () => bandHeight,
	setBandHeight: (h) => {
		bandHeight = h;
	},
	getToolsWidthPct: () => toolsWidthPct,
	setToolsWidthPct: (pct) => {
		toolsWidthPct = pct;
	},
	getFilesWidth: () => filesWidth,
	setFilesWidth: (w) => {
		filesWidth = w;
	},
	getFlags: () => ({ thinkingOn, toolsOn, filesOn, trimResponse }),
	getTerminalSize: () => ({
		cols: tuiRef?.terminal?.columns ?? 120,
		rows: tuiRef?.terminal?.rows ?? 40,
	}),
	dockColsFor: (cols) => dockColsFor(cols),
	dockColsForManual: (cols, wanted) => dockColsForManual(cols, wanted),
	bandToolsColsFor: (bandCols) => bandToolsColsFor(bandCols),
	requestRender: () => requestRender(),
	onUseBaseTranscript: () => {
		const base = getBaseRoot();
		const baseTranscript = base ? baseTranscriptOf(base) : null;
		if (baseTranscript instanceof ScrollView) messagesScrollRef = baseTranscript;
	},
});

const drawersStrategy = new DrawersLayoutStrategy(
	() => ({
		cols: tuiRef?.terminal?.columns ?? 120,
		rows: tuiRef?.terminal?.rows ?? 40,
	}),
	() => requestRender(),
);

const strategies: Record<LayoutMode, LayoutStrategy> = {
	grid: gridStrategy,
	drawers: drawersStrategy,
};

function activeStrategy(): LayoutStrategy {
	return strategies[layoutMode] ?? gridStrategy;
}

/** Band width available next to a visible dock (used by FilesPanel main-slot sizing). */
function bandBase(cols: number): number {
	return gridStrategy.bandBase(cols);
}

/** Re-apply layout geometry in place on resize or state mutation. */
function applyGeometry(): void {
	const cols = tuiRef?.terminal?.columns ?? 120;
	const rows = tuiRef?.terminal?.rows ?? 40;
	composedTermCols = cols;
	composedTermRows = rows;
	activeStrategy().applyGeometry(cols, rows);
}

/** Header buttons occupy the 6 columns before the right corner, when the
 * header has room (≥ 16 content columns). */
const HEADER_BUTTONS_MIN = 16;
function headerButtons(theme: Theme, id: PanelId): string {
	return (
		theme.fg("muted", `[${zoomed === id ? "↙" : "↗"}]`) + theme.fg("muted", "[×]")
	);
}
function buttonAt(ev: TuiMouseEvent): "zoom" | "close" | null {
	if (ev.y !== 0 || ev.width - 2 < HEADER_BUTTONS_MIN) return null;
	const z = ev.width - 7;
	if (ev.x >= z && ev.x < z + 3) return "zoom";
	if (ev.x >= z + 3 && ev.x < z + 6) return "close";
	return null;
}

/** Tools panel bottom frame: the live-output button sits at the right end,
 * `╰──…──[▶]─╯`, away from the header's zoom/close buttons. Shown while a
 * tool streams ([▶]) or live mode is on ([◼]); needs the same minimum width
 * as the header buttons. Its columns: [width-5, width-2). */
function liveButtonShown(id: PanelId | undefined, width: number): boolean {
	return id === "tools" && width - 2 >= HEADER_BUTTONS_MIN && liveButtonVisible();
}
function liveButtonAt(ev: TuiMouseEvent, id: PanelId): boolean {
	return (
		ev.y === 0 &&
		liveButtonShown(id, ev.width) &&
		ev.x >= ev.width - 5 &&
		ev.x < ev.width - 2
	);
}

let lastMessagesScrollTop = -1;

/** Sync visible turns from the Messages ScrollView viewport. Only clears a
 * manual `pinnedTurn` when scrollTop actually changed (explicit scroll), never
 * on a pure viewportHeight shrink (e.g. a drawer auto-opening). */
function syncVisibleTurnsFromMessages(scheduleRender = true): number[] {
	const scrollTop = messagesScrollRef?.scrollTop ?? -1;
	const scrollMoved =
		lastMessagesScrollTop !== -1 && scrollTop !== lastMessagesScrollTop;
	lastMessagesScrollTop = scrollTop;
	const visible = messagesScrollRef
		? visibleTurnsInViewport(
				messageTurnSpans,
				messagesScrollRef.scrollTop,
				messagesScrollRef.viewportHeight,
			)
		: [];
	const key = visible.join(",");
	if (key !== lastVisibleTurnsKey) {
		if (suppressNextPinClear) {
			suppressNextPinClear = false;
		} else if (
			scrollMoved &&
			lastVisibleTurnsKey !== "" &&
			messagesScrollRef &&
			!messagesScrollRef.isFollowingEnd
		) {
			pinnedTurn = null;
		}
		lastVisibleTurnsKey = key;
		toolsVersionCounter++;
		thinking.version++;
		if (scheduleRender) {
			requestRender();
		} else {
			queueMicrotask(() => {
				if (anyPanelActive()) requestRender();
			});
		}
	}
	return visible;
}

/** Currently active turn(s) for Tool Usage and Thinking, or null for all. */
function activeTurnSelection(): number[] | null {
	const visible = messagesScrollRef
		? visibleTurnsInViewport(
				messageTurnSpans,
				messagesScrollRef.scrollTop,
				messagesScrollRef.viewportHeight,
			)
		: [];
	return selectActiveTurns({
		scope: toolsScope,
		totalTurns: currentTurn,
		pinnedTurn,
		visibleTurns: visible,
	});
}

function toolsPagerLabel(activeTurns: number[] | null, totalTurns: number): string {
	if (activeTurns === null) return `All (${totalTurns})`;
	if (activeTurns.length === 0) return `Turn 0/${totalTurns}`;
	if (activeTurns.length === 1) return `Turn ${activeTurns[0]}/${totalTurns}`;
	return `Turn ${activeTurns[0]}-${activeTurns[activeTurns.length - 1]}/${totalTurns}`;
}

function scrollMessagesToTurn(turn: number): void {
	if (!messagesScrollRef) return;
	const span = messageTurnSpans.find((s) => s.turn === turn);
	if (!span) return;
	suppressNextPinClear = true;
	messagesScrollRef.scrollTo(span.startRow);
}

function stepTurn(delta: -1 | 1): void {
	if (currentTurn <= 0) return;
	const activeTurns = activeTurnSelection();
	const anchor =
		pinnedTurn !== null
			? Math.max(1, Math.min(currentTurn, pinnedTurn))
			: activeTurns && activeTurns.length > 0
				? delta < 0
					? activeTurns[0]!
					: activeTurns[activeTurns.length - 1]!
				: currentTurn;
	if (delta < 0) {
		const target = Math.max(1, anchor - 1);
		pinnedTurn = target;
		scrollMessagesToTurn(target);
	} else {
		const target = Math.min(currentTurn, anchor + 1);
		if (target >= currentTurn) {
			pinnedTurn = null;
			messagesScrollRef?.scrollToEnd();
		} else {
			pinnedTurn = target;
			scrollMessagesToTurn(target);
		}
	}
	toolsVersionCounter++;
	thinking.version++;
	requestRender();
}

function toggleToolsScopeAll(): void {
	toolsScope = toolsScope === "all" ? "visible" : "all";
	pinnedTurn = null;
	toolsVersionCounter++;
	thinking.version++;
	requestRender();
}

function pagerHitTest(
	ev: TuiMouseEvent,
	id: PanelId,
): "prev" | "next" | "toggle" | null {
	if (ev.y !== 0 || id !== "tools" || currentTurn <= 0 || ev.width < 30) {
		return null;
	}
	const activeTurns = activeTurnSelection();
	const label = toolsPagerLabel(activeTurns, currentTurn);
	const hasLive = liveButtonShown(id, ev.width);
	const layout = toolsPagerButtons(ev.width, label, toolsScope, hasLive);
	if (!layout) return null;
	if (ev.x >= layout.prev.start && ev.x < layout.prev.end) return "prev";
	if (ev.x >= layout.next.start && ev.x < layout.next.end) return "next";
	if (ev.x >= layout.toggle.start && ev.x < layout.toggle.end) return "toggle";
	return null;
}

function recompose(): void {
	if (themeGetter) reconcileLayout(themeGetter());
}

function toggleZoom(id: PanelId): void {
	zoomed = zoomed === id ? null : id;
	recompose();
}

/** Bottom-frame button: leave live mode, or pin the newest running
 * streaming tool. (The command offers a picker for the other cases.) */
function toggleToolsLive(): void {
	if (liveToolId !== null) {
		setLiveTool(null);
		notifyFn?.("Tool panel: all tools", "info");
		return;
	}
	const id = streamingActiveIds().pop();
	if (!id) return;
	setLiveTool(id);
	notifyFn?.(`Tool panel: live output of ${toolsBy.get(id)?.name ?? "tool"}`, "info");
}

const PANEL_LABELS: Record<PanelId, [string, string]> = {
	thinking: ["Thinking", "/split-thinking"],
	tools: ["Tools", "/split-tools"],
	files: ["Files", "/files"],
	messages: ["Messages", "/split-slot"],
};

function hidePanel(id: PanelId): void {
	const s = slotOf(id);
	if (s) layoutSlots[s] = null;
	if (
		layoutSlots.topLeft === null &&
		layoutSlots.topRight === null &&
		layoutSlots.main === null &&
		layoutSlots.dock === null
	) {
		layoutSlots.main = "messages";
	}
	syncFlagsFromSlots();
	if (zoomed === id) zoomed = null;
	recompose();
	const [label, cmd] = PANEL_LABELS[id];
	notifyFn?.(`${label} hidden · ${cmd} to show`, "info");
}

/** Shared mouse handling for panel chrome: header buttons (top), band-height
 * drag (band bottom border), width drag (left edge), wheel routing. */
function panelMouse(
	ev: TuiMouseEvent,
	ctl: PanelCtl | undefined,
	where: "top" | "bottom" | "body",
): TuiMouseEventResult | undefined {
	const strat = activeStrategy();
	if (strat.hasActiveDrag() && (ev.type === "drag" || ev.type === "release")) {
		return ctl?.onDragEvent?.(ev) ?? strat.handleDragEvent(ev);
	}
	if (!ctl) return undefined;
	if (ev.type === "wheel") {
		ctl.scroll?.scrollBy(ev.wheelDelta ?? 0);
		if (ctl.id === "messages") {
			suppressNextPinClear = false;
			syncVisibleTurnsFromMessages(true);
		}
		return { handled: true };
	}
	if (ev.button !== "left") return undefined;
	if (ev.type === "press") {
		if (where === "top" && buttonAt(ev)) return { capture: true };
		if (where === "bottom" && (liveButtonAt(ev, ctl.id) || pagerHitTest(ev, ctl.id)))
			return { capture: true };
		if (ev.x === 0) {
			const edgeRes = ctl.onEdgePress?.("left", ev);
			if (edgeRes) return edgeRes;
		}
		if (where === "bottom") {
			const edgeRes = ctl.onEdgePress?.("bottom", ev);
			if (edgeRes) return edgeRes;
		}
		return undefined;
	}
	if (ev.type === "click" && where === "top") {
		const b = buttonAt(ev);
		if (b === "zoom") toggleZoom(ctl.id);
		else if (b === "close") hidePanel(ctl.id);
		if (b) return { handled: true };
	}
	if (ev.type === "click" && where === "bottom") {
		if (liveButtonAt(ev, ctl.id)) {
			toggleToolsLive();
			return { handled: true };
		}
		const pagerHit = pagerHitTest(ev, ctl.id);
		if (pagerHit === "prev") {
			stepTurn(-1);
			return { handled: true };
		}
		if (pagerHit === "next") {
			stepTurn(1);
			return { handled: true };
		}
		if (pagerHit === "toggle") {
			toggleToolsScopeAll();
			return { handled: true };
		}
	}
	return undefined;
}

// ─── framed panel components ─────────────────────────────────────────────────

class BorderTop implements Component {
	constructor(
		private theme: Theme,
		private title: string,
		private color: "accent" | "muted",
		private streaming: () => boolean,
		private ctl?: PanelCtl,
	) {}
	render(width: number): string[] {
		const th = this.theme;
		const contentWidth = Math.max(1, width - 2);
		const buttons =
			this.ctl && contentWidth >= HEADER_BUTTONS_MIN ? headerButtons(th, this.ctl.id) : "";
		const room = contentWidth - visibleWidth(buttons);
		const title = th.fg(this.color, ` ${this.title} `);
		const dot = this.streaming() ? th.fg("warning", "●") : "";
		const label = truncateToWidth(title + dot, room);
		const fill = th.fg("border", "─".repeat(Math.max(0, room - visibleWidth(label))));
		return [th.fg("border", "╭") + label + fill + buttons + th.fg("border", "╮")];
	}
	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		return panelMouse(ev, this.ctl, "top");
	}
	invalidate(): void {}
	dispose(): void {}
}

class BorderBottom implements Component {
	constructor(
		private theme: Theme,
		private ctl?: PanelCtl,
	) {}
	render(width: number): string[] {
		const th = this.theme;
		const hasLive = liveButtonShown(this.ctl?.id, width);
		if (this.ctl?.id === "tools" && currentTurn > 0 && width >= 30) {
			const activeTurns = activeTurnSelection();
			const label = toolsPagerLabel(activeTurns, currentTurn);
			const layout = toolsPagerButtons(width, label, toolsScope, hasLive);
			if (layout) {
				const on = liveToolId !== null;
				const anchor =
					pinnedTurn !== null
						? Math.max(1, Math.min(currentTurn, pinnedTurn))
						: activeTurns && activeTurns.length > 0
							? activeTurns[0]!
							: currentTurn;
				const canPrev = anchor > 1;
				const canNext =
					pinnedTurn !== null ||
					(activeTurns !== null &&
						activeTurns.length > 0 &&
						activeTurns[activeTurns.length - 1]! < currentTurn);
				const isAll = toolsScope === "all" && pinnedTurn === null;
				const prevBtn = th.fg(canPrev ? "accent" : "dim", "[◀]");
				const nextBtn = th.fg(canNext ? "accent" : "dim", "[▶]");
				const labelStr = th.fg(
					pinnedTurn !== null ? "warning" : "muted",
					` ${layout.label} `,
				);
				const toggleBtn = th.fg(
					isAll ? "accent" : "muted",
					layout.toggle.text,
				);
				const fill = th.fg("border", "─".repeat(layout.fillCols));
				const right = hasLive
					? th.fg(on ? "warning" : "muted", on ? "[◼]" : "[▶]") +
						th.fg("border", "─╯")
					: th.fg("border", "╯");
				return [
					th.fg("border", "╰─") +
						prevBtn +
						labelStr +
						nextBtn +
						th.fg("border", "─") +
						toggleBtn +
						fill +
						right,
				];
			}
		}
		if (hasLive) {
			const on = liveToolId !== null;
			return [
				th.fg("border", "╰" + "─".repeat(width - 6)) +
					th.fg(on ? "warning" : "muted", on ? "[◼]" : "[▶]") +
					th.fg("border", "─╯"),
			];
		}
		return [
			th.fg("border", "╰") +
				th.fg("border", "─".repeat(Math.max(0, width - 2))) +
				th.fg("border", "╯"),
		];
	}
	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		return panelMouse(ev, this.ctl, "bottom");
	}
	invalidate(): void {}
	dispose(): void {}
}

// MeasurementSafeVStack is imported from ./layout-types.ts.

/**
 * OracleSpec body: renders the recent window with a left │ edge only — the
 * ScrollView's always-on scrollbar column is the right frame edge. Pads every
 * row to EXACT width and always emits at least `minRows` rows so the left
 * edge is continuous when content is short. Output is cached on
 * (version, minRows, width); wrapped rows are memoized per source line, so a
 * streaming flush only re-wraps lines that changed (the tail).
 *
 * Row sources are BodyItems: text lines go through the wrap/edge/pad path;
 * image items render raw via a cached pi-tui Image component (atomic group,
 * no edge/pad — the escape lines must stay contiguous and unsliced, exactly
 * the structure pi's transcript feeds its ScrollView; the TUI engine is
 * image-aware: the scrollbar skips image lines, scrolling crops placements,
 * full repaints clear them).
 */
class RecentBody implements Component {
	private cacheVersion = -1;
	private cacheMinRows = -1;
	/** SV-19: bounded width cache (current width + small LRU). */
	private cacheByWidth = new Map<number, string[]>();
	private static readonly MAX_CACHED_WIDTHS = 4;
	/** Per-line wrap memo for one width; holds only the lines last shown. */
	private wrapWidth = -1;
	private wrapMemo = new Map<string, string[]>();
	/** Image components by (mimeType:data), small LRU. Cached so a re-render
	 * re-emits the SAME Kitty image ID — a fresh instance per frame would
	 * allocate a new placement every frame and leak them in the terminal. */
	private imageCache = new Map<string, Image>();
	private static readonly MAX_CACHED_IMAGES = 8;
	constructor(
		private theme: Theme,
		private style: (line: string) => string,
		private lines: (width: number) => BodyItem[],
		private version: () => number,
		private empty: string,
		/** Rows to guarantee so the left edge has no gaps (viewport height). */
		private minRows: () => number,
		private ctl?: PanelCtl,
		/** SV-27: false = emit every row of the source instead of the newest
		 * MAX_BODY_ROWS window. See BandDef.windowed. */
		private windowed = true,
	) {}
	render(width: number): string[] {
		const th = this.theme;
		const v = this.version();
		const min = Math.max(1, this.minRows());
		if (v !== this.cacheVersion || min !== this.cacheMinRows) {
			this.cacheVersion = v;
			this.cacheMinRows = min;
			this.cacheByWidth.clear();
		}
		const cached = this.cacheByWidth.get(width);
		if (cached) {
			// SV-19: refresh recency so eviction is genuinely LRU.
			this.cacheByWidth.delete(width);
			this.cacheByWidth.set(width, cached);
			return cached;
		}
		if (width !== this.wrapWidth) {
			this.wrapWidth = width;
			this.wrapMemo.clear();
		}
		const memo = this.wrapMemo;
		const nextMemo = new Map<string, string[]>();
		const edge = th.fg("border", "│");
		const pad = (s: string) => " ".repeat(Math.max(0, width - 1 - visibleWidth(s)));
		// Wrap newest-first, keep only the newest MAX_BODY_ROWS visual rows.
		// SV-03/SV-04: fragments of ONE source line are wrapped as a group and
		// inserted in order; the cap counts VISUAL rows. A group that would
		// straddle the cap is skipped whole; a single group larger than the
		// whole cap keeps only its newest fragments — except an image group,
		// which is atomic (its escape lines must stay contiguous and unsliced)
		// and therefore kept whole (its height is bounded by the Image
		// component's maxHeightCells, far below MAX_BODY_ROWS in practice).
		const src = this.lines(width);
		const groups: { frags: string[]; raw: boolean }[] = [];
		let used = 0;
		// SV-27: a non-windowed body walks the source back to its START — no
		// sliding window, so a panel scrolled away from the end keeps its
		// position — but it is still bounded by VISUAL rows: MAX_LINES counts
		// LOGICAL lines and one of them can wrap into hundreds. Past the cap it
		// degrades to the windowed behaviour rather than rendering without limit.
		const cap = this.windowed ? MAX_BODY_ROWS : MAX_UNWINDOWED_ROWS;
		for (let i = src.length - 1; i >= 0; i--) {
			const { frags, raw } = this.itemFrags(src[i], width, memo, nextMemo);
			if (used + frags.length > cap) {
				if (groups.length === 0 && frags.length > cap)
					groups.push({
						frags: raw ? frags : frags.slice(frags.length - cap),
						raw,
					});
				break;
			}
			groups.push({ frags, raw });
			used += frags.length;
		}
		this.wrapMemo = nextMemo;
		const rows: string[] = [];
		for (let g = groups.length - 1; g >= 0; g--)
			for (const f of groups[g].frags)
				rows.push(groups[g].raw ? f : edge + f + pad(f));
		let out: string[];
		if (rows.length === 0) {
			const empty = " " + th.fg("dim", this.empty);
			out = [edge + empty + pad(empty)];
		} else {
			// Rows already carry the edge/pad (text) or are raw (image).
			out = rows;
		}
		const filler = edge + " ".repeat(Math.max(0, width - 1));
		while (out.length < min) out.push(filler);
		this.cacheByWidth.set(width, out);
		while (this.cacheByWidth.size > RecentBody.MAX_CACHED_WIDTHS) {
			const oldest = this.cacheByWidth.keys().next().value as number;
			this.cacheByWidth.delete(oldest);
		}
		return out;
	}
	/** Fragments for one row-source item: text lines are wrapped (memoized
	 * per line) and emit with the frame edge; image items go to imageRows.
	 * `raw` rows bypass the edge/pad pass. */
	private itemFrags(
		item: BodyItem,
		width: number,
		memo: Map<string, string[]>,
		nextMemo: Map<string, string[]>,
	): { frags: string[]; raw: boolean } {
		if (typeof item !== "string")
			return this.imageRows(item.image, width, item.maxRows);
		const memoFrags = nextMemo.get(item) ?? memo.get(item);
		const frags =
			memoFrags ??
			wrapTextWithAnsi(
				this.style(capDisplayLine(item, MAX_LINE_CHARS)),
				Math.max(1, width - 3),
			).map((w: string) => " " + w);
		nextMemo.set(item, frags);
		return { frags, raw: false };
	}
	/** Render one image item. Terminals with image support get the raw rows
	 * from a cached pi-tui Image component. Without image support, pi's text
	 * fallback (imageFallback), as a normal padded text row. */
	private imageRows(
		img: ImageBlock,
		width: number,
		maxRows?: number,
	): { frags: string[]; raw: boolean } {
		const th = this.theme;
		if (!getCapabilities().images) {
			const dims = getImageDimensions(img.data, img.mimeType) ?? undefined;
			// Aligned with the tool's output rows ("  · …").
			const fb = th.fg("toolOutput", `  · ${imageFallback(img.mimeType, dims)}`);
			return {
				frags: wrapTextWithAnsi(
					capDisplayLine(fb, MAX_LINE_CHARS),
					Math.max(1, width - 3),
				).map((w: string) => " " + w),
				raw: false,
			};
		}
		const key = `${maxRows ?? ""}:${img.mimeType}:${img.data}`;
		let component = this.imageCache.get(key);
		if (component) {
			// LRU touch.
			this.imageCache.delete(key);
			this.imageCache.set(key, component);
		} else {
			component = new Image(
				img.data,
				img.mimeType,
				{ fallbackColor: (s: string) => th.fg("toolOutput", s) },
				maxRows ? { maxHeightCells: maxRows } : {},
			);
			this.imageCache.set(key, component);
			while (this.imageCache.size > RecentBody.MAX_CACHED_IMAGES)
				this.imageCache.delete(this.imageCache.keys().next().value as string);
		}
		// Frame edge + 2-col inset before the image. Placement escapes draw at
		// the cursor column (Kitty C=1, iTerm2 cursor-up keeps the column), so
		// prefixing shifts the image right; blank reserved rows get the edge
		// and pad like any text row.
		const edge = th.fg("border", "│");
		const inset = edge + "  ";
		const blank = edge + " ".repeat(Math.max(0, width - 1));
		const rows = component
			.render(Math.max(1, width - 4))
			.map((l: string) => (l ? inset + l : blank));
		return { frags: rows, raw: true };
	}
	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		return panelMouse(ev, this.ctl, "body");
	}
	invalidate(): void {
		this.cacheVersion = -1;
		this.cacheByWidth.clear();
		this.wrapMemo.clear();
	}
	dispose(): void {}
}

/** True if a line contains a Kitty or iTerm2 inline-image escape sequence. */
function isRawImageLine(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

/**
 * Locate live `ToolExecutionComponent` instances in pi's chat container,
 * keyed by `toolCallId`. Returns an empty map if the base root or chat
 * container is unavailable or has an unexpected shape.
 */
function findLiveToolComponents(): Map<string, any> {
	const map = new Map<string, any>();
	const base = getBaseRoot();
	if (!base) return map;
	try {
		const kids = (baseTranscriptOf(base) as any)?.child?.children;
		const chat = Array.isArray(kids) && kids.length === 3 ? kids[2] : null;
		const chatChildren = chat?.children;
		if (!Array.isArray(chatChildren)) return map;
		for (const child of chatChildren) {
			if (
				child?.constructor?.name === "ToolExecutionComponent" &&
				typeof child.toolCallId === "string"
			) {
				map.set(child.toolCallId, child);
			}
		}
	} catch {
		/* unexpected base tree shape */
	}
	return map;
}

const MAX_FALLBACK_ARG_LINES = 12;

/**
 * Rich tool-usage panel body: renders each tool call as a compact header row
 * with an expand/collapse caret, and when expanded reuses pi's own live
 * `ToolExecutionComponent` (syntax-highlighted code, colored diffs, custom
 * tool renderers, inline images) or falls back to highlighted JSON args,
 * diffs, and syntax-highlighted output for subagent / resumed entries.
 */
class RichToolsBody implements Component {
	private cacheVersion = -1;
	private cacheMinRows = -1;
	private cacheZoomed = false;
	private cacheLiveId: string | null = null;
	private cacheTurnsKey = "";
	private cacheByWidth = new Map<
		number,
		{ rows: string[]; headerRows: Map<number, string> }
	>();
	private headerRows = new Map<number, string>();
	private static readonly MAX_CACHED_WIDTHS = 4;
	private imageCache = new Map<string, Image>();
	private static readonly MAX_CACHED_IMAGES = 8;

	constructor(
		private theme: Theme,
		private version: () => number,
		private empty: string,
		private minRows: () => number,
		private ctl?: PanelCtl,
	) {}

	render(width: number): string[] {
		const th = this.theme;
		const v = this.version();
		const min = Math.max(1, this.minRows());
		const zoomedTools = zoomed === "tools";
		const activeTurns = activeTurnSelection();
		const turnsKey = activeTurns === null ? "all" : activeTurns.join(",");
		if (
			v !== this.cacheVersion ||
			min !== this.cacheMinRows ||
			zoomedTools !== this.cacheZoomed ||
			liveToolId !== this.cacheLiveId ||
			turnsKey !== this.cacheTurnsKey
		) {
			this.cacheVersion = v;
			this.cacheMinRows = min;
			this.cacheZoomed = zoomedTools;
			this.cacheLiveId = liveToolId;
			this.cacheTurnsKey = turnsKey;
			this.cacheByWidth.clear();
		}
		const cached = this.cacheByWidth.get(width);
		if (cached) {
			this.cacheByWidth.delete(width);
			this.cacheByWidth.set(width, cached);
			this.headerRows = cached.headerRows;
			return cached.rows;
		}

		const edge = th.fg("border", "│");
		const innerWidth = Math.max(10, width - 3);
		const filler = edge + " ".repeat(Math.max(0, width - 1));
		const rows: string[] = [];
		const headerRows = new Map<number, string>();

		const emitLine = (content: string) => {
			if (isRawImageLine(content)) {
				rows.push(content);
				return;
			}
			const clipped =
				visibleWidth(content) > innerWidth
					? truncateToWidth(content, innerWidth)
					: content;
			const reset = clipped.includes("\x1b[") ? "\x1b[0m" : "";
			const padLen = Math.max(0, width - 2 - visibleWidth(clipped));
			rows.push(edge + " " + clipped + reset + " ".repeat(padLen));
		};

		const live = liveEntry();
		if (live) {
			const items = liveToolItems(th, live, Math.max(8, width - 3));
			const wrapped: string[] = [];
			for (const item of items) {
				if (typeof item !== "string") continue;
				for (const w of wrapTextWithAnsi(
					capDisplayLine(item, MAX_LINE_CHARS),
					Math.max(1, width - 3),
				)) {
					wrapped.push(w);
				}
			}
			const start = Math.max(0, wrapped.length - MAX_BODY_ROWS);
			for (let i = start; i < wrapped.length; i++) emitLine(wrapped[i]!);
		} else if (toolOrder.length === 0) {
			emitLine(th.fg("dim", this.empty));
		} else {
			const filteredIds =
				activeTurns === null
					? toolOrder
					: toolOrder.filter((id) => {
							const e = toolsBy.get(id);
							return e ? activeTurns.includes(e.turn) : false;
						});
			if (filteredIds.length === 0) {
				const turnDesc =
					activeTurns && activeTurns.length === 1
						? `Turn ${activeTurns[0]}`
						: activeTurns && activeTurns.length > 1
							? `Turns ${activeTurns[0]}-${activeTurns[activeTurns.length - 1]}`
							: "this turn";
				emitLine(th.fg("dim", `No tools in ${turnDesc} (click ◀/▶ or [All])`));
			} else {
				const liveComps = findLiveToolComponents();
				const showTurnHeaders = activeTurns !== null && activeTurns.length > 1;
				let lastRenderedTurn = -1;
				for (const id of filteredIds) {
					const entry = toolsBy.get(id);
					if (!entry) continue;
					if (showTurnHeaders && entry.turn !== lastRenderedTurn) {
						lastRenderedTurn = entry.turn;
						const preview = turnPreviews.get(entry.turn);
						const header =
							th.fg("dim", "── ") +
							th.fg("accent", `Turn ${entry.turn}`) +
							(preview ? th.fg("dim", ` · ${preview}`) : "") +
							th.fg("dim", " ──");
						emitLine(header);
					}
					const expanded = isToolExpanded(
						entry,
						toolExpandOverrides,
						toolExpandGlobal,
						zoomedTools,
					);
					headerRows.set(rows.length, entry.id);
					emitLine(this.formatHeader(entry, expanded, innerWidth));

					if (!expanded) continue;

					const lower = entry.name.toLowerCase();
					if (lower === "bash") {
						this.renderRichBashBody(entry, innerWidth, zoomedTools, emitLine);
					} else if (
						(lower === "read" || lower === "write") &&
						!entry.image &&
						this.renderRichCodeBody(entry, innerWidth, zoomedTools, emitLine)
					) {
						// Rendered with Tree-sitter / syntax highlighting.
					} else {
						const comp = liveComps.get(entry.id);
						if (comp && typeof comp.render === "function") {
							const prevExpanded = Boolean((comp as any).expanded);
							const canToggle = typeof comp.setExpanded === "function";
							let rendered: string[] = [];
							try {
								if (!prevExpanded && canToggle) {
									comp.setExpanded(true);
								}
								rendered = stripLeadingTrailingBlankLines(comp.render(innerWidth));
						} catch {
							rendered = [];
						} finally {
							if (!prevExpanded && canToggle) {
								try {
									comp.setExpanded(prevExpanded);
								} catch {
									/* ignore restore errors */
								}
							}
						}
						if (rendered.length > 0) {
							for (const line of rendered) emitLine(line);
						} else {
							this.renderFallbackBody(entry, innerWidth, width, zoomedTools, emitLine, rows);
						}
					} else {
						this.renderFallbackBody(entry, innerWidth, width, zoomedTools, emitLine, rows);
					}
				}
				// Visual separation after an expanded card.
				rows.push(filler);
				}
			}
		}

		while (rows.length < min) rows.push(filler);

		this.headerRows = headerRows;
		this.cacheByWidth.set(width, { rows, headerRows });
		while (this.cacheByWidth.size > RichToolsBody.MAX_CACHED_WIDTHS) {
			const oldest = this.cacheByWidth.keys().next().value as number;
			this.cacheByWidth.delete(oldest);
		}
		return rows;
	}

	private formatHeader(e: ToolEntry, expanded: boolean, innerWidth: number): string {
		const th = this.theme;
		const caret = th.fg("muted", expanded ? "▾" : "▸");
		const mark = e.active
			? th.fg("warning", "⟳")
			: e.isError
				? th.fg("error", "✗")
				: th.fg("success", "✓");
		const name = th.fg("toolTitle", th.bold(e.name));
		const badge = e.subagent ? th.fg("muted", ` [${e.agent ?? "sub"}]`) : "";
		let dur = "";
		if (e.startedAt !== undefined) {
			if (e.endedAt !== undefined)
				dur = th.fg("muted", ` ${formatDuration(e.endedAt - e.startedAt)}`);
			else if (e.active && Date.now() - e.startedAt >= 1000)
				dur = th.fg("muted", ` ${formatDuration(Date.now() - e.startedAt, true)}`);
		}
		const prefix = `${caret} ${mark} ${name}${badge}${dur}`;
		const room = innerWidth - visibleWidth(prefix) - 1;
		const summary = room >= 4 ? formatToolArgSummary(e.name, e.args, room) : "";
		if (!summary) return prefix;
		if (e.name.toLowerCase() === "bash") {
			const highlighted = highlightBashCommand(summary, th, isLightTheme(th));
			const clipped =
				visibleWidth(highlighted) > room
					? truncateToWidth(highlighted, room)
					: highlighted;
			return `${prefix} ${clipped}`;
		}
		return `${prefix} ${th.fg("muted", summary)}`;
	}

	private renderRichBashBody(
		entry: ToolEntry,
		innerWidth: number,
		zoomedTools: boolean,
		emitLine: (content: string) => void,
	): void {
		const th = this.theme;
		const isLight = isLightTheme(th);
		const bodyWidth = Math.max(8, innerWidth - 2);
		let cmd = "";
		if (entry.args) {
			try {
				const parsed = JSON.parse(entry.args);
				if (
					parsed &&
					typeof parsed === "object" &&
					!Array.isArray(parsed) &&
					typeof (parsed as Record<string, unknown>).command === "string"
				) {
					cmd = ((parsed as Record<string, unknown>).command as string).trim();
				}
			} catch {
				/* ignore malformed args */
			}
		}

		let emittedAny = false;
		if (cmd) {
			const cmdLines = cmd.split(/\r?\n/);
			const promptPrefix = th.fg("accent", "$ ");
			const cmdWidth = Math.max(8, bodyWidth - 2);
			for (let i = 0; i < cmdLines.length; i++) {
				const styled = highlightBashCommand(cmdLines[i]!, th, isLight);
				const wrapped = wrapTextWithAnsi(styled, cmdWidth);
				for (let j = 0; j < wrapped.length; j++) {
					const lead = i === 0 && j === 0 ? promptPrefix : "  ";
					emitLine(`  ${lead}${wrapped[j]!}`);
				}
			}
			emittedAny = true;
		}

		const rawOut = (entry.liveText ?? entry.output ?? "").trimEnd();
		if (rawOut) {
			const allLines = rawOut.split(/\r?\n/);
			const cap = zoomedTools ? allLines.length : MAX_EXPANDED_RICH_LINES;
			const shown = allLines.slice(-cap);
			const totalLines = entry.active
				? allLines.length
				: Math.max(allLines.length, entry.outputLines ?? allLines.length);
			const hidden = Math.max(0, totalLines - shown.length);
			if (hidden > 0) {
				emitLine(th.fg("dim", `  … +${hidden} earlier lines`));
			}
			for (const raw of shown) {
				const styled = highlightCliOutputLine(capDisplayLine(raw, MAX_LINE_CHARS), th);
				for (const w of wrapTextWithAnsi(styled, bodyWidth)) {
					emitLine(`  ${w}`);
				}
			}
			emittedAny = true;
		}

		if (!emittedAny && entry.active) {
			emitLine(th.fg("dim", "  …"));
		}
	}

	private renderRichCodeBody(
		entry: ToolEntry,
		innerWidth: number,
		zoomedTools: boolean,
		emitLine: (content: string) => void,
	): boolean {
		// Never hide error messages on failed read/write calls behind parsed args.
		if (entry.isError) return false;
		const th = this.theme;
		const isLight = isLightTheme(th);
		const bodyWidth = Math.max(8, innerWidth - 2);
		let parsed: Record<string, unknown> | null = null;
		if (entry.args) {
			try {
				const raw = JSON.parse(entry.args);
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					parsed = raw as Record<string, unknown>;
				}
			} catch {
				parsed = null;
			}
		}

		const filePath = typeof parsed?.path === "string" ? parsed.path : "";
		const lower = entry.name.toLowerCase();
		const code =
			lower === "write"
				? typeof parsed?.content === "string"
					? parsed.content
					: entry.output
				: entry.output;

		if (!filePath || !code) {
			if (entry.active) {
				emitLine(th.fg("dim", "  …"));
				return true;
			}
			return false;
		}

		let highlighted = highlightCodeTreeSitter(code, filePath, isLight);
		if (!highlighted) {
			const lang = getLanguageFromPath(filePath);
			if (lang) {
				try {
					highlighted = highlightCode(code, lang);
				} catch {
					highlighted = null;
				}
			}
		}
		const lines =
			highlighted ?? code.split(/\r?\n/).map((l) => th.fg("toolOutput", l));
		const cap = zoomedTools ? lines.length : MAX_EXPANDED_RICH_LINES;
		const shown = lines.slice(0, cap);
		const totalLines =
			lower === "read"
				? Math.max(lines.length, entry.outputLines ?? lines.length)
				: lines.length;
		const hidden = Math.max(0, totalLines - shown.length);

		if (lower === "read") {
			const offsetVal = parsed?.offset;
			const startLine =
				typeof offsetVal === "number" && Number.isFinite(offsetVal) && offsetVal >= 1
					? Math.floor(offsetVal)
					: 1;
			const gutterWidth = String(startLine + Math.max(0, shown.length - 1)).length;
			const codeWidth = Math.max(8, bodyWidth - gutterWidth - 1);
			const blankGutter = " ".repeat(gutterWidth);
			for (let i = 0; i < shown.length; i++) {
				const num = th.fg("dim", String(startLine + i).padStart(gutterWidth));
				const wrapped = wrapTextWithAnsi(shown[i]!, codeWidth);
				emitLine(`  ${num} ${wrapped[0] ?? ""}`);
				for (let j = 1; j < wrapped.length; j++) {
					emitLine(`  ${blankGutter} ${wrapped[j]!}`);
				}
			}
		} else {
			for (const l of shown) {
				for (const w of wrapTextWithAnsi(l, bodyWidth)) {
					emitLine(`  ${w}`);
				}
			}
		}

		if (hidden > 0) {
			emitLine(th.fg("dim", `  +${hidden} more`));
		}
		return true;
	}

	private renderFallbackBody(
		entry: ToolEntry,
		innerWidth: number,
		width: number,
		zoomedTools: boolean,
		emitLine: (content: string) => void,
		rows: string[],
	): void {
		const th = this.theme;
		const bodyWidth = Math.max(8, innerWidth - 2);
		let parsed: unknown;
		if (entry.args) {
			try {
				parsed = JSON.parse(entry.args);
			} catch {
				parsed = undefined;
			}
		}

		let emittedAny = false;

		// 1. Pretty-printed syntax-highlighted JSON args (capped).
		if (
			parsed !== undefined &&
			!(
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed) &&
				Object.keys(parsed).length === 0
			)
		) {
			try {
				const pretty = JSON.stringify(parsed, null, 2);
				const argLines =
					highlightCodeTreeSitter(pretty, "json", isLightTheme(th)) ??
					highlightCode(pretty, "json");
				const shown = argLines.slice(0, MAX_FALLBACK_ARG_LINES);
				for (const l of shown) emitLine(`  ${l}`);
				if (argLines.length > MAX_FALLBACK_ARG_LINES) {
					emitLine(th.fg("dim", `  +${argLines.length - MAX_FALLBACK_ARG_LINES} more`));
				}
				emittedAny = true;
			} catch {
				/* skip unhighlightable args */
			}
		}

		// 2. Edit diff if present.
		if (entry.diff) {
			for (const l of renderDiff(entry.diff).split(/\r?\n/)) {
				emitLine(`  ${l}`);
			}
			emittedAny = true;
		}

		// 3. Syntax-highlighted output (if file path known for read/write), else toolOutput.
		if (entry.output) {
			const lower = entry.name.toLowerCase();
			let filePath: string | undefined;
			let lang: string | undefined;
			if (
				(lower === "read" || lower === "write") &&
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				typeof (parsed as Record<string, unknown>).path === "string"
			) {
				filePath = (parsed as Record<string, unknown>).path as string;
				lang = getLanguageFromPath(filePath);
			}
			const tsHighlighted = filePath
				? highlightCodeTreeSitter(entry.output, filePath, isLightTheme(th))
				: null;
			if (tsHighlighted) {
				for (const hl of tsHighlighted) {
					for (const w of wrapTextWithAnsi(hl, bodyWidth)) emitLine(`  ${w}`);
				}
			} else if (lang) {
				try {
					for (const hl of highlightCode(entry.output, lang)) {
						for (const w of wrapTextWithAnsi(hl, bodyWidth)) emitLine(`  ${w}`);
					}
				} catch {
					for (const raw of entry.output.split(/\r?\n/)) {
						for (const w of wrapTextWithAnsi(
							th.fg("toolOutput", capDisplayLine(raw, MAX_LINE_CHARS)),
							bodyWidth,
						))
							emitLine(`  ${w}`);
					}
				}
			} else {
				for (const raw of entry.output.split(/\r?\n/)) {
					for (const w of wrapTextWithAnsi(
						th.fg("toolOutput", capDisplayLine(raw, MAX_LINE_CHARS)),
						bodyWidth,
					))
						emitLine(`  ${w}`);
				}
			}
			emittedAny = true;
		}

		// 4. Inline image if present.
		if (entry.image) {
			this.emitImage(
				entry.image,
				width,
				zoomedTools ? undefined : BAND_IMAGE_ROWS,
				emitLine,
				rows,
			);
			emittedAny = true;
		}

		if (!emittedAny && entry.active) {
			emitLine(th.fg("dim", "  …"));
		}
	}

	private emitImage(
		img: ImageBlock,
		width: number,
		maxRows: number | undefined,
		emitLine: (content: string) => void,
		rows: string[],
	): void {
		const th = this.theme;
		if (!getCapabilities().images) {
			const dims = getImageDimensions(img.data, img.mimeType) ?? undefined;
			emitLine(th.fg("toolOutput", `  ${imageFallback(img.mimeType, dims)}`));
			return;
		}
		const key = `${maxRows ?? ""}:${img.mimeType}:${img.data}`;
		let component = this.imageCache.get(key);
		if (component) {
			this.imageCache.delete(key);
			this.imageCache.set(key, component);
		} else {
			component = new Image(
				img.data,
				img.mimeType,
				{ fallbackColor: (s: string) => th.fg("toolOutput", s) },
				maxRows ? { maxHeightCells: maxRows } : {},
			);
			this.imageCache.set(key, component);
			while (this.imageCache.size > RichToolsBody.MAX_CACHED_IMAGES) {
				this.imageCache.delete(this.imageCache.keys().next().value as string);
			}
		}
		const edge = th.fg("border", "│");
		const inset = edge + "  ";
		const blank = edge + " ".repeat(Math.max(0, width - 1));
		for (const l of component.render(Math.max(1, width - 4))) {
			rows.push(l ? inset + l : blank);
		}
	}

	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		const res = panelMouse(ev, this.ctl, "body");
		if (res) return res;
		if (ev.button !== "left" || ev.x <= 0) return undefined;
		if (ev.type === "press" && this.headerRows.has(ev.y)) {
			return { capture: true };
		}
		if (ev.type === "click") {
			const id = this.headerRows.get(ev.y);
			if (id && toolsBy.has(id)) {
				const entry = toolsBy.get(id)!;
				const currentlyExpanded = isToolExpanded(
					entry,
					toolExpandOverrides,
					toolExpandGlobal,
					zoomed === "tools",
				);
				toolExpandOverrides.set(id, !currentlyExpanded);
				toolsVersionCounter++;
				requestRender();
				return { handled: true };
			}
		}
		return undefined;
	}

	invalidate(): void {
		this.cacheVersion = -1;
		this.cacheByWidth.clear();
	}

	dispose(): void {}
}

// ─── files panel (list + edit-diff subpanel) ──────────────────────────────────

class FilesPanel {
	private cacheKey = "";
	private cacheLines: string[] = [];

	constructor(
		private theme: Theme,
		/** Fullscreen dock: live terminal rows. Overlay: undefined. */
		private heightProvider?: () => number,
		/** Mouse wiring (dock / zoom only; the regular-mode overlay has none). */
		private ctl?: PanelCtl,
	) {}

	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		const where =
			ev.y === 0 ? "top" : ev.y >= ev.height - 1 ? "bottom" : "body";
		return panelMouse(ev, this.ctl, where);
	}

	// No handleInput: the regular-mode overlay is nonCapturing, so it never
	// receives keys — Escape belongs to the editor/Pi, and /files is the
	// close/reopen path (Option C, decisions/D-overlay-lifecycle.md).

	render(width: number): string[] {
		if (REG.gen !== MY_GEN) return [];
		const height =
			this.heightProvider?.() || termHeight || recentEntries().length + 12;
		const { showDiffSection, listRows, diffRows } = filesPanelRowBudget(
			height,
			showDiff,
			Boolean(editDiff.diff),
		);
		// Cache key MUST include height and showDiffSection: a height-only
		// terminal resize or toggling/acquiring an edit diff changes the
		// list/diff row split without bumping filesVersion or width.
		const key = `${filesVersion}|${editDiff.version}|${width}|${height}|${showDiffSection ? 1 : 0}`;
		if (key === this.cacheKey) return this.cacheLines;

		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const pad = (s: string) =>
			s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
		const row = (c: string) =>
			th.fg("border", "│") + pad(truncateToWidth(c, inner)) + th.fg("border", "│");

		const entries = recentEntries();

		const meta = (e: FileEntry) =>
			th.fg("muted", `${e.ops}${e.count > 1 ? `×${e.count}` : ""}`);

		const rows: { line: string; files: number }[] = [];
		let i = 0;
		while (i < entries.length) {
			const dir = path.dirname(entries[i].path);
			let j = i;
			while (j < entries.length && path.dirname(entries[j].path) === dir) j++;
			const run = entries.slice(i, j);
			if (run.length > 3) {
				const label = displayPath(dir);
				rows.push({
					line: row(` ${th.fg("accent", label === "." ? "./" : `${label}/`)}`),
					files: 0,
				});
				for (const e of run)
					rows.push({
						line: row(`   ${meta(e)} ${th.fg("text", path.basename(e.path))}`),
						files: 1,
					});
			} else {
				for (const e of run)
					rows.push({
						line: row(` ${meta(e)} ${th.fg("text", path.basename(e.path))}`),
						files: 1,
					});
			}
			i = j;
		}

		const body: string[] = [];
		let filesShown = 0;
		for (const r of rows) {
			if (body.length >= listRows - 2) break;
			body.push(r.line);
			filesShown += r.files;
		}
		if (body.length === 0 && entries.length === 0)
			body.push(row(` ${th.fg("dim", "No files touched yet")}`));
		if (entries.length > filesShown)
			body.push(row(` ${th.fg("dim", `… +${entries.length - filesShown} more`)}`));
		body.push(row(` ${th.fg("dim", LEGEND)}`));
		while (body.length < listRows) body.push(row(""));

		// ── edit-diff subpanel (optional: /split-diff, shown only when an edit exists) ──
		const diffBody: string[] = [];
		if (showDiffSection) {
			diffBody.push(th.fg("border", `├${"─".repeat(inner)}┤`));
			// SV-05: truncate the title by DISPLAY COLUMNS (wide/CJK/emoji paths)
			// and compute the fill from the truncated title's visible width, so the
			// title can never overrun the fill and collide with the right border.
			// Budget: leading " ✎ " + trailing " " around the path text.
			const title = editDiff.path
				? th.fg("accent", ` ✎ ${truncateToWidth(displayPath(editDiff.path), inner - 4, "…")} `)
				: th.fg("dim", " Last Edit ");
			const titleFill = "─".repeat(
				Math.max(0, inner - visibleWidth(title)),
			);
			diffBody.push(
				th.fg("border", "│") +
					title +
					th.fg("border", titleFill) +
					th.fg("border", "│"),
			);

			const rendered = renderDiff(editDiff.diff).split(/\r?\n/);
			// SV-06: cap content one row below the pad target so the "… +N more"
			// marker always fits; the section is then padded to diffRows so the
			// frame closes on the last row.
			const shown = rendered.slice(0, Math.max(0, diffRows - 1));
			for (const l of shown) diffBody.push(row(` ${l}`));
			if (rendered.length > shown.length && diffRows > 0)
				diffBody.push(
					row(` ${th.fg("dim", `… +${rendered.length - shown.length} more`)}`),
				);
			while (diffBody.length < diffRows + 2) diffBody.push(row(""));
		}

		const out = [
			this.ctl && inner >= HEADER_BUTTONS_MIN
				? th.fg("border", `╭${"─".repeat(inner - 6)}`) +
					headerButtons(th, this.ctl.id) +
					th.fg("border", "╮")
				: th.fg("border", `╭${"─".repeat(inner)}╮`),
			row(` ${th.fg("accent", `📂 Files (${entries.length})`)}`),
			th.fg("border", `├${"─".repeat(inner)}┤`),
			...body,
			...diffBody,
			th.fg("border", `╰${"─".repeat(inner)}╯`),
		];
		this.cacheKey = key;
		this.cacheLines = out;
		return out;
	}

	invalidate(): void {
		this.cacheKey = "";
	}
	dispose(): void {}
}

// ─── layout composition (one layer) ──────────────────────────────────────────

interface BandDef {
	title: string;
	color: "accent" | "muted";
	streaming: () => boolean;
	style: (line: string) => string;
	lines: (width: number) => BodyItem[];
	version: () => number;
	empty: string;
	/** SV-27: false = the body emits its whole row source instead of the newest
	 * MAX_BODY_ROWS window. Defaults to true (windowed). */
	windowed?: boolean;
}

function thinkingHudPalette(theme: Theme): ThinkingHudPalette {
	return {
		plain: (t) => theme.fg("thinkingText", t),
		heading: (t) => theme.bold(theme.fg("accent", t)),
		path: (t) => theme.fg("mdLink", t),
		symbol: (t) => theme.fg("syntaxFunction", t),
		command: (t) => theme.fg("syntaxKeyword", t),
		metric: (t) => theme.fg("syntaxNumber", t),
		focus: (t) => theme.fg("syntaxType", t),
		action: (t) => theme.fg("success", t),
		pivot: (t) => theme.bold(theme.fg("warning", t)),
		risk: (t) => theme.bold(theme.fg("error", t)),
		question: (t) => theme.italic(theme.fg("syntaxComment", t)),
	};
}

function bandDef(theme: Theme, id: "thinking" | "tools"): BandDef {
	if (id === "thinking") {
		const palette = thinkingHudPalette(theme);
		return {
			title: "Thinking",
			color: "accent",
			streaming: () => thinking.streaming,
			style: (l) => {
				if (thinkingHudMode === "off") return theme.fg("thinkingText", l);
				if (thinkingHudMode === "ai") {
					const cached = aiRefiner.getCached(l);
					if (cached) return renderThinkingSpans(applyAiSpansOverLine(l, cached), palette);
				}
				return renderThinkingSpans(analyzeThinkingLineLocal(l), palette);
			},
			lines: (w) => thinkingLines(theme, w),
			version: () => thinking.version,
			empty: "Thinking idle",
			// SV-27: the thinking buffer is already capped at MAX_LINES, and a
			// sliding newest-N window makes a fixed scrollTop resolve to
			// different text on every streaming flush — scroll up and the panel
			// keeps sliding under you. Emit the whole buffer instead.
			windowed: false,
		};
	}
	return {
		title: "Tool Usage",
		color: "muted",
		streaming: () => toolOrder.some((id) => toolsBy.get(id)?.active),
		style: (l) => l,
		lines: (w) => toolItems(theme, w),
		version: toolsVersion,
		empty: "No tools called yet",
	};
}

/**
 * Panel scaffold: no separate border columns, no inner HStack — the always-on
 * scrollbar column is the right frame edge (track styled as border; the idle
 * full-height thumb is border-colored too, accent only while actively
 * scrolling), so nothing ever paints over a frame line and there is no
 * second composite layer. The MeasurementSafeVStack wrapper keeps the
 * engine's discarded measurement passes O(1).
 */
function framedPanel(theme: Theme, d: BandDef, ctl: PanelCtl): Component {
	// Filler rows track the real viewport (band, drawer, or zoomed), so the left
	// edge stays continuous at any allocated height.
	const minRows = () =>
		ctl.scroll?.viewportHeight ||
		(ctl.minRows
			? ctl.minRows()
			: Math.max(1, (tuiRef?.terminal?.rows ?? 24) - bandHeight - 2));
	const body: Component =
		ctl.id === "tools"
			? new RichToolsBody(theme, d.version, d.empty, minRows, ctl)
			: new RecentBody(
					theme,
					d.style,
					d.lines,
					d.version,
					d.empty,
					minRows,
					ctl,
					d.windowed ?? true,
				);
	const scroll = new ScrollView(body, {
		follow: "end",
		overscroll: "contain",
		scrollbar: "always",
		scrollbarTrackStyle: (t: string) => theme.fg("border", t),
		// SV-25: map the IDLE thumb "┃" to the track's "│" so the right frame
		// edge is uniform at rest; the ACTIVE thumb keeps "█" in accent.
		scrollbarThumbStyle: (t: string) =>
			theme.fg(t === "█" ? "accent" : "border", t === "┃" ? "│" : t),
	});
	ctl.scroll = scroll;
	if (ctl.id === "tools") toolsScroll = scroll;
	if (ctl.id === "thinking" && body instanceof RecentBody) thinkingBody = body;
	return new MeasurementSafeVStack([
		{ component: new BorderTop(theme, d.title, d.color, d.streaming, ctl), basis: 1, grow: 0, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: new BorderBottom(theme, ctl), basis: 1, grow: 0, shrink: 0 },
	]);
}

function buildSlotPanel(
	theme: Theme,
	id: Exclude<SlotPanel, null>,
	slot: SlotName,
	base: Component | null,
	ctl: PanelCtl,
): Component {
	if (id === "thinking" || id === "tools") {
		return framedPanel(theme, bandDef(theme, id), ctl);
	}
	if (id === "files") {
		const heightProviderForSlot = (): number => {
			if (slot === "topLeft" || slot === "topRight") return bandHeight;
			const rows = tuiRef?.terminal?.rows ?? 24;
			if (slot === "dock") return rows;
			// slot === "main": terminal rows minus band (if visible & fits) and editor dock.
			const cols = tuiRef?.terminal?.columns ?? 80;
			const editorDock = base ? baseDockOf(base) : null;
			const dockH = editorDock ? editorDock.render(bandBase(cols)).length : 0;
			const hasBand =
				(layoutSlots.topLeft !== null || layoutSlots.topRight !== null) &&
				rows - bandHeight - 1 >= MIN_ROWS_BELOW_BAND;
			const bandH = hasBand ? bandHeight + 1 : 0;
			return Math.max(8, rows - bandH - dockH);
		};
		return new FilesPanel(theme, heightProviderForSlot, ctl);
	}
	// id === "messages"
	const msgScroll =
		trimResponse && base
			? ensureResponseScrollView(theme, base)
			: (base ? baseTranscriptOf(base) : null) ??
				(base ? ensureResponseScrollView(theme, base) : new Spacer(1));
	if (msgScroll instanceof ScrollView) messagesScrollRef = msgScroll;
	if (slot === "main") {
		return msgScroll;
	}
	if (msgScroll instanceof ScrollView) ctl.scroll = msgScroll;
	return new MeasurementSafeVStack([
		{
			component: new BorderTop(theme, "Messages", "accent", () => false, ctl),
			basis: 1,
			grow: 0,
			shrink: 0,
		},
		{ component: msgScroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: new BorderBottom(theme, ctl), basis: 1, grow: 0, shrink: 0 },
	]);
}

/** Whether a zoomable panel is currently visible in the active layout strategy. */
function panelOn(id: PanelId): boolean {
	return activeStrategy().panelVisible(
		id,
		typeof tuiRef?.setLayoutRoot === "function",
	);
}

/** D1: one panel over the whole area above pi's editor dock (reused verbatim,
 * like trim mode); the other slots are hidden until the zoom is restored. */
function buildZoom(theme: Theme, id: PanelId): Component | null {
	const base = getBaseRoot();
	const dock = base ? baseDockOf(base) : null;
	if (!dock) return null;
	const ctl: PanelCtl = { id };
	const panel =
		id === "files"
			? new FilesPanel(
					theme,
					// The panel sizes itself: terminal rows minus the dock's height.
					() =>
						Math.max(
							8,
							(tuiRef?.terminal?.rows ?? 24) -
								dock.render(tuiRef?.terminal?.columns ?? 80).length,
						),
					ctl,
				)
			: id === "messages"
				? buildSlotPanel(theme, "messages", "dock", base, ctl)
				: framedPanel(theme, bandDef(theme, id), ctl);
	return new VStack([
		{ component: panel, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
}

/**
 * Panel C trim mode: replace the transcript region of the base root with a
 * ScrollView over our response doc. The editor dock (pending/status/editor/
 * widgets/footer) is reused verbatim from the base root's second entry, so
 * input is untouched and the composition stays lossless to toggle.
 */
let responseScrollView: ScrollView | null = null;

/** Container for the trimmed doc (startup containers + response doc), the
 * child of responseScrollView. Built lazily; holds live references into pi's
 * base tree, so it stays valid across theme changes and resource reloads. */
let responseDocHost: Container | null = null;

/** Extract the transcript ScrollView from pi's base root (VStack[transcript,
 * dock]): the entry with an own `child` property (baseDockOf finds the other
 * one). */
function baseTranscriptOf(base: any): Component | null {
	const entries = base?.entries;
	if (!Array.isArray(entries)) return null;
	for (const e of entries) {
		const c = e?.component;
		if (c && Object.hasOwn(c, "child")) return c as Component;
	}
	return null;
}

/** Extract the editor dock from pi's base root (VStack[transcript, dock]). */
function baseDockOf(base: any): Component | null {
	const entries = base?.entries;
	if (!Array.isArray(entries)) return null;
	// The transcript entry holds the ScrollView (own `child`); the dock is the
	// other entry.
	for (const e of entries) {
		const c = e?.component;
		if (!c) continue;
		if (!Object.hasOwn(c, "child")) return c as Component; // not a ScrollView → dock
	}
	return null;
}

/**
 * SV-26: build the trimmed panel's document: pi's own startup header and
 * loaded-resources containers mounted above the response doc. Those two
 * containers are children[0..1] of the transcript's documentContainer and
 * hold the startup banner + [Context]/[Skills]/[Prompts]/[Extensions]
 * listing. Trim mode unmounts the base transcript, which erased them; the
 * response doc mirrors branch messages only and never contained them.
 * Mounting the LIVE instances here (not snapshots) keeps ctrl+o header
 * expansion, theme updates and /reload resource refreshes working, and never
 * double-mounts: while trim is on the base transcript is unmounted, and when
 * trim toggles off these containers return with it. Requires exactly the
 * expected [header, resources, chat] triple; any other shape degrades to the
 * old response-only doc (never risk mounting chatContainer here).
 */
class ResponseDocHostContainer extends Container {
	override render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			if (child instanceof ResponseBody) {
				child.setRowOffset(lines.length);
			}
			for (const l of child.render(width)) lines.push(l);
		}
		return lines;
	}
}

function buildTrimDoc(base: Component): Container {
	if (!responseDocHost) {
		responseDocHost = new ResponseDocHostContainer();
		try {
			const kids = (baseTranscriptOf(base) as any)?.child?.children;
			if (Array.isArray(kids) && kids.length === 3) {
				responseDocHost.addChild(kids[0]);
				responseDocHost.addChild(kids[1]);
			}
		} catch {
			/* unexpected tree shape — response doc only */
		}
		responseDocHost.addChild(new ResponseBody(base));
	}
	return responseDocHost;
}

/**
 * pi's own transcript minus tool calls. It draws the LIVE components of pi's
 * chat container, so whatever pi and other extensions draw there (markdown
 * transformers, custom entries, custom messages, notices) renders and takes
 * mouse input as in the full transcript. The kept children are re-read on
 * every render and mouse event because pi adds and replaces them.
 */
class TranscriptWithoutTools extends Container {
	private readonly chat: Container;

	constructor(chat: Container) {
		super();
		this.chat = chat;
	}

	syncChildren(): void {
		this.children = this.chat.children.filter((child) =>
			keepsInResponseOnly(child as any),
		);
	}

	override render(width: number): string[] {
		this.syncChildren();
		return super.render(width);
	}

	override handleMouse(event: any) {
		this.syncChildren();
		return super.handleMouse(event);
	}

	override invalidate(): void {
		this.chat.invalidate();
	}
}

/**
 * The body of the trimmed doc: the response doc, or pi's transcript minus tool
 * calls when responseSource is "transcript". The source is read on every
 * render, so /split-response-source switches it without rebuilding the doc.
 * An unexpected base tree shape (no chat container) keeps the response doc.
 */
class ResponseBody implements Component {
	private readonly transcript: TranscriptWithoutTools | null;
	private rowOffset = 0;

	constructor(base: Component) {
		let chat: unknown;
		try {
			const kids = (baseTranscriptOf(base) as any)?.child?.children;
			if (Array.isArray(kids) && kids.length === 3) chat = kids[2];
		} catch {
			/* unexpected tree shape — response doc only */
		}
		this.transcript =
			chat && Array.isArray((chat as any).children)
				? new TranscriptWithoutTools(chat as Container)
				: null;
	}

	setRowOffset(offset: number): void {
		this.rowOffset = offset;
	}

	private active(): Container {
		return responseSource === "transcript" && this.transcript
			? this.transcript
			: responseDoc;
	}

	render(width: number): string[] {
		const active = this.active();
		if (active instanceof TranscriptWithoutTools) {
			active.syncChildren();
		}
		const lines: string[] = [];
		const spans: TurnSpan[] = [];
		let turn = 0;
		let activeSpan: TurnSpan | null = null;
		for (const child of active.children) {
			const childLines = child.render(width);
			const startRow = this.rowOffset + lines.length;
			for (const l of childLines) lines.push(l);
			const endRow = this.rowOffset + lines.length;
			if (child.constructor?.name === "UserMessageComponent") {
				const childText = (child as any).text;
				if (typeof childText === "string" && isInternalNotificationText(childText)) {
					if (activeSpan) activeSpan.endRow = endRow;
					continue;
				}
				turn++;
				activeSpan = { turn, startRow, endRow };
				spans.push(activeSpan);
			} else if (activeSpan) {
				activeSpan.endRow = endRow;
			}
		}
		messageTurnSpans = alignTurnSpans(spans, currentTurn);
		syncVisibleTurnsFromMessages(false);
		return lines;
	}

	handleMouse(event: any) {
		return this.active().handleMouse(event);
	}

	invalidate(): void {
		responseDoc.invalidate();
		this.transcript?.invalidate();
	}
}

/** Lazily create/reuse the response-only ScrollView over buildTrimDoc(base). */
function ensureResponseScrollView(theme: Theme, base: Component): ScrollView {
	if (!responseScrollView) {
		responseScrollView = new ScrollView(buildTrimDoc(base), {
			follow: "end",
			// A1: in trim mode pi's own transcript (primary) is not mounted;
			// without this the FIRST laid-out ScrollView — the Thinking panel —
			// became primary and received PgUp/PgDn, Ctrl+F and wheel fallback.
			primary: true,
			overscroll: "chain",
			scrollbar: "auto",
			scrollbarTrackStyle: (t: string) => theme.fg("dim", t),
			scrollbarThumbStyle: (t: string) => theme.fg("accent", t),
		});
	}
	return responseScrollView;
}

function buildBodyScrollPair(
	theme: Theme,
	id: "thinking" | "tools",
	ctl: PanelCtl,
): { scroll: ScrollView; bottom: Component; reattach: () => void } {
	const d = bandDef(theme, id);
	const minRows = () =>
		ctl.scroll?.viewportHeight ||
		(ctl.minRows
			? ctl.minRows()
			: Math.max(1, (tuiRef?.terminal?.rows ?? 24) - bandHeight - 2));
	const body: Component =
		id === "tools"
			? new RichToolsBody(theme, d.version, d.empty, minRows, ctl)
			: new RecentBody(
					theme,
					d.style,
					d.lines,
					d.version,
					d.empty,
					minRows,
					ctl,
					d.windowed ?? true,
				);
	const scroll = new ScrollView(body, {
		follow: "end",
		overscroll: "contain",
		scrollbar: "always",
		scrollbarTrackStyle: (t: string) => theme.fg("border", t),
		scrollbarThumbStyle: (t: string) =>
			theme.fg(t === "█" ? "accent" : "border", t === "┃" ? "│" : t),
	});
	ctl.scroll = scroll;
	const reattach = () => {
		if (id === "tools") toolsScroll = scroll;
		if (id === "thinking" && body instanceof RecentBody) thinkingBody = body;
	};
	reattach();
	return { scroll, bottom: new BorderBottom(theme, ctl), reattach };
}

function summarizeDrawerPanel(id: "thinking" | "tools"): {
	text: string;
	streaming: boolean;
	errorCount: number;
} {
	const activeTurns = activeTurnSelection();
	if (id === "thinking") {
		let lineCount = 0;
		const filterTurns = thinkingScope === "session" ? activeTurns : null;
		for (const b of thinking.blocks) {
			if (filterTurns !== null && !filterTurns.includes(b.turn)) continue;
			lineCount += b.lines.length;
		}
		if (
			thinking.current &&
			(filterTurns === null || filterTurns.includes(thinking.current.turn))
		) {
			lineCount +=
				thinking.current.lines.length + (thinking.current.tail ? 1 : 0);
		}
		const streaming = thinking.streaming;
		if (lineCount === 0) {
			return { text: streaming ? "streaming" : "idle", streaming, errorCount: 0 };
		}
		const turnTag =
			currentTurn > 0 ? ` · ${toolsPagerLabel(activeTurns, currentTurn)}` : "";
		return {
			text: `${lineCount} line${lineCount === 1 ? "" : "s"}${turnTag}`,
			streaming,
			errorCount: 0,
		};
	}
	const activeSet = activeTurns !== null ? new Set(activeTurns) : null;
	let total = 0;
	let running = 0;
	let errorCount = 0;
	let latestName = "";
	for (const tid of toolOrder) {
		const entry = toolsBy.get(tid);
		if (!entry) continue;
		if (activeSet !== null && !activeSet.has(entry.turn)) continue;
		total++;
		if (entry.active) running++;
		if (entry.isError) errorCount++;
		latestName = entry.name;
	}
	if (total === 0) {
		return { text: "idle", streaming: false, errorCount: 0 };
	}
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	const done = total - running;
	if (done > 0) parts.push(`${done} done`);
	if (latestName) parts.push(latestName);
	return {
		text: parts.join(" · "),
		streaming: running > 0,
		errorCount,
	};
}

/** Build the full composed layout root via the active LayoutStrategy. */
function composeLayout(theme: Theme, inner: Component): Component {
	const strat = activeStrategy();
	strat.resetGeometry();
	toolsScroll = null;
	thinkingBody = null;
	messagesScrollRef = null;
	const cols = tuiRef?.terminal?.columns ?? 120;
	const rows = tuiRef?.terminal?.rows ?? 40;
	composedTermCols = cols;
	composedTermRows = rows;
	if (zoomed && panelOn(zoomed)) {
		const z = buildZoom(theme, zoomed);
		if (z) return z;
	}
	const base = getBaseRoot();
	const editorDock = base ? baseDockOf(base) : null;
	const ctx: LayoutContext = {
		theme,
		base,
		inner,
		editorDock,
		hasFullscreenLayout: Boolean(
			tuiRef && typeof tuiRef.setLayoutRoot === "function",
		),
		trimResponse,
		cols,
		rows,
		buildSlotPanel: (id, slot, ctl) => buildSlotPanel(theme, id, slot, base, ctl),
		buildBodyScroll: (id, ctl) => buildBodyScrollPair(theme, id, ctl),
		panelSummary: (id) => summarizeDrawerPanel(id),
		toggleZoom: (id) => toggleZoom(id),
		pagerState: () => {
			const activeTurns = activeTurnSelection();
			const anchor =
				pinnedTurn !== null
					? Math.max(1, Math.min(currentTurn, pinnedTurn))
					: activeTurns && activeTurns.length > 0
						? activeTurns[0]!
						: currentTurn;
			const canPrev = anchor > 1;
			const canNext =
				pinnedTurn !== null ||
				(activeTurns !== null &&
					activeTurns.length > 0 &&
					activeTurns[activeTurns.length - 1]! < currentTurn);
			return {
				currentTurn,
				label: toolsPagerLabel(activeTurns, currentTurn),
				canPrev,
				canNext,
				isAll: toolsScope === "all" && pinnedTurn === null,
				pinned: pinnedTurn !== null,
				liveShown: liveButtonVisible(),
				liveOn: liveToolId !== null,
			};
		},
		stepTurn: (delta) => stepTurn(delta),
		toggleToolsScopeAll: () => toggleToolsScopeAll(),
		toggleToolsLive: () => toggleToolsLive(),
		isMessagesFollowingEnd: () => messagesScrollRef?.isFollowingEnd ?? true,
		getMessagesViewportHeight: () => messagesScrollRef?.viewportHeight ?? 0,
		isTurnPinned: () => pinnedTurn !== null,
		requestRender: () => requestRender(),
	};
	return strat.compose(ctx);
}

/** Reconcile the single "ui" layout layer with the active LayoutStrategy. */
function reconcileLayout(theme: Theme): void {
	activeStrategy().cancelDrag();
	if (zoomed && !panelOn(zoomed)) zoomed = null;
	const wantAny = activeStrategy().wantsLayer();
	if (!wantAny || !tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
		if (isLayoutLayerActive("ui")) setLayoutLayer("ui", null);
		return;
	}
	setLayoutLayer("ui", (inner: Component) => composeLayout(theme, inner));
	// SV-08: remember the theme this composition was built with.
	composedThemeFp = themeFingerprint(theme);
}

// ─── wiring ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-split", {
		description: "Start bare: skip the split-view panels (thinking/tools/files)",
		type: "boolean",
		default: false,
	});

	const ensureWidget = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || widgetSet) return;
		widgetSet = true;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				tuiRef = tui;
				docTheme = theme;
				themeGetter = () => ctx.ui.theme;
				notifyFn = (msg, level) => ctx.ui.notify(msg, level);
				initLayoutManager(tui);
				// SV-14: apply the still-pending startup composition here. The
				// factory runs synchronously during session_start (before the
				// first paint) and the fullscreen root is available right now, so
				// the saved panels land in the FIRST painted frame. The deferred
				// startupTimer remains as the fallback for a later-ready root.
				if (startupPending && REG.gen === MY_GEN) {
					startupPending = false;
					reconcileLayout(ctx.ui.theme);
				}
				return {
					render: (width: number) => {
						selfHealLayout();
						// SV-08: pi swaps the global theme object on a theme change
						// (extensions get no event) and the composition + response doc
						// capture ANSI at build time. Compare a color fingerprint and
						// recompose with the live theme ONLY on a change — ordinary
						// state changes never rebuild the tree.
						const liveTheme = ctx.ui.theme;
						const fp = themeFingerprint(liveTheme);
						if (composedThemeFp === null) composedThemeFp = fp;
						else if (fp !== composedThemeFp) {
							composedThemeFp = fp;
							drawersStrategy.clearScrollCache();
							if (anyPanelActive()) {
								rebuildResponseDoc(ctx);
								reconcileLayout(liveTheme);
							}
						}
						// SV-07/F2: dock width and the band's width split derive from the
						// terminal width; on any resize re-apply them to the composed
						// entries in place (no rebuild, scroll positions survive).
						if (
							typeof tuiRef?.setLayoutRoot === "function" &&
							isLayoutLayerActive("ui") &&
							((tuiRef?.terminal?.columns ?? 120) !== composedTermCols ||
								(tuiRef?.terminal?.rows ?? 40) !== composedTermRows)
						)
							applyGeometry();
						return widgetLines(liveTheme, width);
					},
					invalidate: () => {},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	/** Rebuild all buffers from the current branch (start / reload / tree). */
	const reconstruct = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		aiRefiner.clear();
		thinking.reset();
		toolsBy.clear();
		toolOrder.length = 0;
		toolExpandOverrides.clear();
		liveToolId = null;
		currentTurn = 0;
		turnPreviews.clear();
		pinnedTurn = null;
		messageTurnSpans = [];
		lastVisibleTurnsKey = "";
		lastMessagesScrollTop = -1;
		suppressNextPinClear = false;
		activeStrategy().onReconstruct?.();
		toolsVersionCounter++;
		files.clear();
		bumpFilesVersion();
		clearEditDiff();
		rebuildResponseDoc(ctx);

		const branch = ctx.sessionManager.getBranch();
		// SV-27: the "turn" scope has to survive a restart / branch switch, so the
		// reconstruction makes the same cut the live buffer does. Without this a
		// resumed session would show every earlier turn until the next user
		// message happened to clear it.
		const turns: { isUser: boolean; turn: number; thoughts: string[] }[] = [];
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = (entry as any).message;
			if (!msg) continue;
			if (msg.role === "user") {
				const text = messageText(msg);
				if (isInternalNotificationText(text)) continue;
				currentTurn++;
				const preview = truncateInline(text, 32);
				if (preview) turnPreviews.set(currentTurn, preview);
			}
			const msgThoughts: string[] = [];
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const c of msg.content) {
					if (c?.type === "thinking" && typeof c.thinking === "string")
						msgThoughts.push(c.thinking);
					if (c?.type === "toolCall" && c.name) {
						try {
							// SV-17: rebuild the bounded tools buffer from the
							// branch through the same ingest path live events use.
							if (typeof c.id === "string")
								ingestToolCall(c.id, c.name, c.arguments ?? {});
							record(c.name, c.arguments ?? {});
						} catch {
							/* skip */
						}
					}
				}
			}
			if (msg.role === "user" || msg.role === "assistant")
				turns.push({
					isUser: msg.role === "user",
					turn: Math.max(1, currentTurn),
					thoughts: msgThoughts,
				});
			// Reconstruct the last edit diff from persisted tool-result details.
			if (msg.role === "toolResult" && msg.toolName === "edit") {
				const d = msg.details;
				if (d?.diff) {
					const p = (msg.input && msg.input.path) || editDiff.path;
					setEditDiff(p, d.diff);
				}
			}
			// SV-17: rebuild tool outputs from persisted results, correlated
			// to their calls by toolCallId.
			if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
				try {
					// Pass the whole message (content + details), the same
					// shape as a live result.
					ingestToolResult(msg.toolCallId, msg, msg.isError);
				} catch {
					/* skip */
				}
			}
		}
		const thoughts: { text: string; turn: number }[] = [];
		if (thinkingScope === "turn") {
			const latestTurn = Math.max(1, currentTurn);
			for (const t of thoughtsSinceLastUser(turns))
				thoughts.push({ text: t, turn: latestTurn });
		} else {
			for (const turn of turns)
				for (const t of turn.thoughts) thoughts.push({ text: t, turn: turn.turn });
		}
		if (thoughts.length) {
			for (const t of thoughts) {
				thinking.current = {
					lines: t.text.split(/\r?\n/),
					tail: "",
					complete: true,
					turn: t.turn,
				};
				thinking.blocks.push(thinking.current);
				thinking.current = null;
			}
			thinking.trim();
			thinking.version++;
			enqueueRecentThinkingLines(8);
		}
		ensureWidget(ctx);
		if (anyPanelActive()) requestRender();
	};

	pi.on("session_start", (_e, ctx) => {
		void initToolHighlighter(() => {
			toolsVersionCounter++;
			requestRender();
		});
		let cfg = normalizeConfig(loadUiPanelsConfig());
		if (pi.getFlag("no-split")) {
			// --no-split: start bare, ignoring the saved ui-panels.json defaults.
			cfg = {
				...cfg,
				split: false,
				thinking: false,
				tools: false,
				files: false,
				trimResponse: false,
				slots: {
					topLeft: null,
					topRight: null,
					main: "messages",
					dock: null,
				},
			};
		}
		layoutSlots = { ...cfg.slots };
		syncFlagsFromSlots();
		layoutMode = pi.getFlag("no-split") ? "grid" : cfg.layoutMode;
		drawersStrategy.setEnabled(layoutMode === "drawers");
		if (cfg.layouts.drawers) {
			drawersStrategy.hydrate(cfg.layouts.drawers);
		}
		thinkingScope = cfg.thinkingScope;
		thinkingHudMode = cfg.thinkingHudMode;
		toolMode = cfg.toolMode;
		toolsScope = cfg.toolsScope;
		toolExpandGlobal = null;
		bandHeight = cfg.bandHeight;
		toolsWidthPct = cfg.toolsWidthPct;
		filesWidth = cfg.filesWidth;
		dockSide = cfg.dockSide;
		zoomed = null;
		showDiff = cfg.diff;
		answerDividerMode = cfg.answerDivider;
		trimResponse = cfg.trimResponse;
		responseSource = cfg.responseSource;
		// SV-14: arm the startup composition BEFORE reconstruct — the widget
		// factory runs synchronously inside it and is the first point where the
		// fullscreen root is available (before the first paint). The deferred
		// timer below used to be the ONLY composition point, but it fires after
		// the first paint, so the first screen never showed the saved panels.
		startupPending = ctx.mode === "tui";
		reconstruct(ctx);
		// Reapply the saved composition after the fullscreen root is ready.
		if (ctx.mode === "tui") {
			if (startupTimer) clearTimeout(startupTimer);
			startupTimer = setTimeout(() => {
				startupTimer = null;
				if (REG.gen !== MY_GEN) return;
				try {
					if (tuiRef && typeof tuiRef.setLayoutRoot === "function") {
						// SV-14: fallback — the factory composes when the root is
						// already available there; this timer only composes if
						// that has not happened yet.
						if (startupPending) {
							startupPending = false;
							reconcileLayout(ctx.ui.theme);
						}
						if (cfg.split) ctx.ui.notify("Split view on", "info");
					} else if (cfg.files) {
						// Regular mode uses an overlay; filesOn is already the saved
						// state, so clear it before calling the toggle.
						filesOn = false;
						toggleFilesPanel(ctx);
					}
				} catch {
					/* never crash pi from a deferred callback */
				}
			}, 0);
		}
	});
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));
	pi.on("session_compact", (_e, ctx) => reconstruct(ctx));

	// Thinking stream.
	pi.on("message_update", (event, ctx) => {
		lastCtx = ctx;
		const d = (event as any).assistantMessageEvent;
		if (d) {
			if (d.type === "thinking_start") {
				thinking.start();
				activeStrategy().onThinkingStart?.();
			} else if (d.type === "thinking_delta") thinking.append(d.delta ?? "");
			else if (d.type === "thinking_end") thinking.end(d.content ?? "");
		}
		responseMessageUpdate((event as any).message);
		if (anyPanelActive()) requestRender();
	});

	// Response stream (panel C trim mode): mirror user/assistant messages into
	// the response doc. Always maintained so toggling trim mid-turn is seamless.
	// Assistant components are created lazily on first visible text (update),
	// so tool-only / thinking-only rounds add nothing to the doc.
	pi.on("message_start", (event) => {
		const msg = (event as any).message;
		// SV-27: a new user message starts a new turn — with thinkingScope
		// "turn" the panel drops the previous turn's reasoning here (it stays in
		// the transcript, and reconstruct() restores it on resume/branch switch).
		// Clearing on thinking_start instead would wipe the earlier blocks of the
		// SAME turn, since one assistant message can stream several of them.
		if (msg?.role === "user") {
			const text = messageText(msg);
			if (!isInternalNotificationText(text)) {
				currentTurn++;
				const preview = truncateInline(text, 32);
				if (preview) turnPreviews.set(currentTurn, preview);
				pinnedTurn = null;
				toolsVersionCounter++;
				thinking.version++;
				if (thinkingScope === "turn") {
					thinking.reset();
				}
				activeStrategy().onTurnStart?.();
				addResponseMessage(msg);
			}
		}
		if (anyPanelActive()) requestRender();
	});
	pi.on("message_end", (event) => {
		responseMessageEnd((event as any).message);
		if (anyPanelActive()) requestRender();
	});

	// Tool stream.
	pi.on("tool_execution_start", (event) => {
		// SV-17: same ingest path the branch rebuild uses.
		ingestToolCall(event.toolCallId, event.toolName, event.args, Date.now());
		activeStrategy().onToolStart?.(false);
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_update", (event) => {
		const e = toolsBy.get(event.toolCallId);
		if (e) {
			// First partial result ⇒ the tool streams via onUpdate: it is a
			// candidate for the panel's live-output mode (bottom-frame [▶]).
			// The raw (capped) snapshot feeds the live view directly; it costs
			// one string reference, the text is allocated by resultText anyway.
			e.streaming = true;
			const text = resultText((event as any).partialResult);
			setToolOutput(e, text);
			e.liveText = text;
			markToolsDirty();
		}
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_end", (event) => {
		// SV-17: same ingest path the branch rebuild uses.
		ingestToolResult(event.toolCallId, (event as any).result, event.isError, Date.now());
		// Live mode is NOT left here: the user may still be reading the output.
		// The pinned tool keeps its final text (status turns to finished/failed);
		// any other finished streamer drops its raw stream text.
		const e = toolsBy.get(event.toolCallId);
		if (e?.streaming) {
			if (e.id === liveToolId) {
				const final = resultText((event as any).result);
				if (final) e.liveText = final;
			} else delete e.liveText;
		}
		if (anyPanelActive()) requestRender();
	});

	// Edit diff: preview on tool_call (preflight args), authoritative on result.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "edit") {
			// Still record files for non-edit tools (write/read/bash/grep...).
			try {
				record(event.toolName, event.input ?? {});
			} catch {
				/* skip */
			}
			bumpFilesVersion();
			if (anyPanelActive()) requestRender();
			return;
		}
		const input = event.input ?? {};
		const p = typeof input.path === "string" ? input.path : "";
		const edits = Array.isArray(input.edits) ? input.edits : [];
		const token = ++pendingDiffToken;
		// SV-23: this call is the newest edit — it owns the preview; forget
		// older generations so a late result from an older edit cannot match.
		const gen = ++editGeneration;
		editGenByCallId.clear();
		if (typeof event.toolCallId === "string")
			editGenByCallId.set(event.toolCallId, gen);
		// Compute a diff from the edit pairs (synchronous, no file read needed).
		// generateDiffString(oldText, newText, contextLines) produces a unified diff.
		const parts: string[] = [];
		for (const e of edits) {
			const o = typeof e.oldText === "string" ? e.oldText : "";
			const n = typeof e.newText === "string" ? e.newText : "";
			if (o !== n) parts.push(generateDiffString(o, n, 3).diff);
		}
		if (token !== pendingDiffToken) return;
		if (parts.length) setEditDiff(p, parts.join("\n"));
		try {
			record("edit", input);
		} catch {
			/* skip */
		}
		bumpFilesVersion();
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit") return;
		// Authoritative diff from the result details (branch-correct).
		const d = (event as any).details;
		if (d?.diff) {
			// SV-23: apply only when this result belongs to the current edit
			// generation (its own preview); an older result never overwrites a
			// newer preview. A result with no/unknown ID applies only when
			// unambiguous (a single edit generation, no recorded ID).
			const id = (event as any).toolCallId;
			const gen = typeof id === "string" ? editGenByCallId.get(id) : undefined;
			const applies =
				gen === editGeneration ||
				(gen === undefined &&
					editGeneration === 1 &&
					editGenByCallId.size === 0);
			if (applies) {
				const inputPath = (event as any).input?.path;
				const p = typeof inputPath === "string" ? inputPath : editDiff.path;
				setEditDiff(p, d.diff);
				if (anyPanelActive()) requestRender();
			}
		}
	});

	// Subagent tool calls: record files with "a" op AND tool panel entries.
	pi.events.on("subagents:tool_call", (data) => {
		const { toolName, input, agent } = (data ?? {}) as {
			toolName?: string;
			input?: unknown;
			agent?: string;
		};
		if (!toolName) return;
		// Files tracking with "a" op.
		try {
			for (const { abs } of pathsFrom(toolName, input ?? {})) {
				const prev = files.get(abs);
				if (prev) {
					files.delete(abs);
					prev.count++;
					if (!prev.ops.includes("a")) prev.ops += "a";
					files.set(abs, prev);
				} else {
					if (files.size >= MAX_FILES)
						files.delete(files.keys().next().value as string);
					files.set(abs, { path: abs, ops: "a", count: 1 });
				}
			}
			bumpFilesVersion();
		} catch {
			/* never break the listener */
		}
		// Tool panel entry with [agent] badge.
		const id = `sub:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
		toolOrder.push(id);
		toolsBy.set(id, {
			id,
			name: toolName,
			args: argsJson(input),
			output: "",
			active: false,
			isError: false,
			turn: Math.max(1, currentTurn),
			subagent: true,
			agent,
		});
		toolsVersionCounter++;
		if (toolOrder.length > MAX_TOOLS) {
			const evict = toolOrder.shift()!;
			toolsBy.delete(evict);
			toolExpandOverrides.delete(evict);
		}
		if (anyPanelActive()) requestRender();
	});

	pi.on("session_shutdown", (_e, ctx) => {
		aiRefiner.clear();
		lastCtx = null;
		stopToolTicker();
		activeStrategy().cancelDrag();
		if (startupTimer) {
			clearTimeout(startupTimer);
			startupTimer = null;
		}
		// SV-02/SV-15 (Option C): retire the overlay through the same valid
		// owner for the CURRENT generation AND for a stale one. The
		// identity-specific handle's hide() removes only its own entry (a safe
		// no-op if Pi already removed it — it never pops an unrelated topmost
		// overlay), and the stored component is disposed with it. Never merely
		// forget REG.active: an undisposed stale-generation panel keeps
		// rendering blank.
		if (REG.active) {
			REG.active.hide();
			REG.active = null;
		}
		if (REG.panel) {
			REG.panel.dispose();
			REG.panel = null;
		}
		REG.activeGen = undefined;
		if (isLayoutLayerActive("ui")) setLayoutLayer("ui", null);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetSet = false;
	});

	// ── panel toggles ──

	/** Toggle the files panel (dock in fullscreen, overlay in regular). */
	const toggleFilesPanel = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/files requires interactive mode", "error");
			return filesActive();
		}
		// Fullscreen grid mode: use the composed dock layer.
		// In drawers mode, fall through to the non-capturing right overlay so
		// single-column Messages stays intact.
		if (
			layoutMode === "grid" &&
			tuiRef &&
			typeof tuiRef.setLayoutRoot === "function"
		) {
			const existingSlot = slotOf("files");
			if (existingSlot !== null) {
				layoutSlots[existingSlot] = null;
				if (
					layoutSlots.topLeft === null &&
					layoutSlots.topRight === null &&
					layoutSlots.main === null &&
					layoutSlots.dock === null
				) {
					layoutSlots.main = "messages";
				}
				syncFlagsFromSlots();
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Files panel closed", "info");
				return false;
			}
			layoutSlots = assignSlot(layoutSlots, "dock", "files");
			syncFlagsFromSlots();
			reconcileLayout(ctx.ui.theme);
			// SV-24: be truthful when the dock is composed but gated invisible
			// — the entry's visible callback hides it below MIN_TERM_WIDTH, so
			// "docked right" alone would overstate what the user sees.
			const dockCols = tuiRef?.terminal?.columns ?? 0;
			if (dockCols > 0 && dockCols < MIN_TERM_WIDTH) {
				ctx.ui.notify(
					`Files panel on — hidden below ${MIN_TERM_WIDTH} cols (now ${dockCols})`,
					"warning",
				);
			} else {
				ctx.ui.notify("Files panel docked right", "info");
			}
			return true;
		}
		// Regular mode: passive TUI overlay (Option C — decisions/D-overlay-lifecycle.md).
		// No ctx.ui.custom() promise is created, so nothing can be stranded; the
		// extension owns the lifecycle: the identity-specific OverlayHandle is
		// the only close path, and the panel component is disposed with it.
		// Escape belongs to the editor/Pi — /files is the close/reopen path.
		if (REG.active) {
			const wasStale = REG.activeGen !== MY_GEN;
			// SV-15: retire even a stale-generation overlay through the same
			// valid owner (handle hide + component dispose) instead of merely
			// forgetting REG.active.
			REG.active.hide();
			REG.panel?.dispose();
			REG.active = null;
			REG.panel = null;
			REG.activeGen = undefined;
			if (!wasStale) {
				ctx.ui.notify("Files panel closed", "info");
				return false;
			}
			// A stale overlay was retired — fall through and open a fresh one
			// so a single /files leaves exactly one live overlay.
		}
		if ((process.stdout.columns ?? 0) < MIN_TERM_WIDTH) {
			ctx.ui.notify(`Terminal too narrow (min ${MIN_TERM_WIDTH} cols)`, "warning");
			return false;
		}
		if (!tuiRef || typeof tuiRef.showOverlay !== "function") {
			ctx.ui.notify("/files requires interactive mode", "error");
			return false;
		}
		const panel = new FilesPanel(ctx.ui.theme);
		const cols = tuiRef?.terminal?.columns ?? process.stdout.columns ?? 0;
		REG.panel = panel;
		REG.active = tuiRef.showOverlay(panel, {
			anchor: "top-right",
			width: dockColsFor(cols),
			margin: 0,
			maxHeight: "100%",
			nonCapturing: true,
			visible: (w: number, h: number) => {
				termHeight = h;
				return w >= MIN_TERM_WIDTH;
			},
		});
		REG.activeGen = MY_GEN;
		return true;
	};

	pi.registerCommand("split", {
		description:
			"Toggle all panels: off = bare pi layout, on = saved startup defaults",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split requires interactive mode", "error");
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split requires fullscreen mode", "warning");
				return;
			}
			// Full toggle pair (revised SV-01): OFF clears every panel flag so
			// pi's native layout is fully restored (no band, no files dock, no
			// trim/response-only swap). ON restores the panel flags saved as
			// startup defaults (ui-panels.json, written by /split-save); if the
			// saved layout has no panels on (or was never saved), fall back to
			// the classic default of thinking + tools. Geometry (bandHeight,
			// toolMode, toolsWidthPct) is session-local and not reset here.
			const wasOn = panelsActive();
			if (wasOn) {
				if (layoutMode === "drawers") {
					drawersStrategy.setEnabled(false);
				} else {
					layoutSlots = {
						topLeft: null,
						topRight: null,
						main: "messages",
						dock: null,
					};
					syncFlagsFromSlots();
				}
				trimResponse = false;
				zoomed = null;
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view off (all panels) · /split-save saves defaults", "info");
			} else {
				const cfg = normalizeConfig(loadUiPanelsConfig());
				if (layoutMode === "drawers" || cfg.layoutMode === "drawers") {
					layoutMode = "drawers";
					drawersStrategy.setEnabled(true);
					if (cfg.layouts.drawers) drawersStrategy.hydrate(cfg.layouts.drawers);
					const base = getBaseRoot();
					if (base && baseDockOf(base)) trimResponse = true;
				} else {
					const savedBare =
						cfg.slots.topLeft === null &&
						cfg.slots.topRight === null &&
						cfg.slots.main === "messages" &&
						cfg.slots.dock === null &&
						!cfg.trimResponse;
					if (savedBare) {
						layoutSlots = {
							topLeft: "thinking",
							topRight: "tools",
							main: "messages",
							dock: null,
						};
					} else {
						layoutSlots = { ...cfg.slots };
						showDiff = cfg.diff;
						answerDividerMode = cfg.answerDivider;
						trimResponse = cfg.trimResponse;
						responseSource = cfg.responseSource;
					}
					syncFlagsFromSlots();
				}
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view on (saved layout) · /split-save saves defaults", "info");
			}
		},
	});

	/** Toggle a band panel (thinking/tools) in/out of layoutSlots while keeping
	 * flags in sync. */
	const toggleBandPanel = (
		panel: "thinking" | "tools",
		preferredSlot: "topLeft" | "topRight",
	): boolean => {
		const existing = slotOf(panel);
		if (existing !== null) {
			layoutSlots[existing] = null;
			if (
				layoutSlots.topLeft === null &&
				layoutSlots.topRight === null &&
				layoutSlots.main === null &&
				layoutSlots.dock === null
			) {
				layoutSlots.main = "messages";
			}
			syncFlagsFromSlots();
			return false;
		}
		const fallbackSlot = preferredSlot === "topLeft" ? "topRight" : "topLeft";
		const target =
			layoutSlots[preferredSlot] === null
				? preferredSlot
				: layoutSlots[fallbackSlot] === null
					? fallbackSlot
					: preferredSlot;
		layoutSlots = assignSlot(layoutSlots, target, panel);
		syncFlagsFromSlots();
		return true;
	};

	pi.registerCommand("split-thinking", {
		description: "Toggle the thinking panel (or Thinking drawer in drawers mode)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (layoutMode === "drawers") {
				drawersStrategy.toggleDrawer("thinking");
				const st = drawersStrategy.getDrawerState("thinking");
				ctx.ui.notify(`Thinking drawer ${st.open ? "expanded" : "collapsed"}`, "info");
				return;
			}
			const on = toggleBandPanel("thinking", "topLeft");
			reconcileLayout(ctx.ui.theme);
			if (layoutSlots.topLeft !== null || layoutSlots.topRight !== null) {
				ctx.ui.notify(`Thinking ${on ? "on" : "off"}`, "info");
			} else {
				ctx.ui.notify("Band off (no panels)", "info");
			}
		},
	});

	pi.registerCommand("split-thinking-scope", {
		description:
			"Thinking panel buffer: turn (current turn only) | session (all turns)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "turn") thinkingScope = "turn";
			else if (arg === "session") thinkingScope = "session";
			else thinkingScope = thinkingScope === "turn" ? "session" : "turn";
			// Switching back to "turn" takes effect now instead of at the next
			// user message, so the command's feedback matches the panel. The live
			// stream indicator survives: `current` is rebuilt by the next delta.
			if (thinkingScope === "turn") thinking.reset(true);
			if (anyPanelActive()) requestRender();
			ctx.ui.notify(
				`Thinking panel: ${thinkingScope === "turn" ? "current turn only" : "all turns"}`,
				"info",
			);
		},
	});

	pi.registerCommand("split-thinking-hud", {
		description: "Cycle or set Thinking Semantic HUD mode [ai|local|off|on]",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			lastCtx = ctx;
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "ai" || arg === "on") thinkingHudMode = "ai";
			else if (arg === "local") thinkingHudMode = "local";
			else if (arg === "off") thinkingHudMode = "off";
			else if (thinkingHudMode === "ai") thinkingHudMode = "local";
			else if (thinkingHudMode === "local") thinkingHudMode = "off";
			else thinkingHudMode = "ai";
			if (thinkingHudMode === "ai") enqueueRecentThinkingLines(8);
			thinking.version++;
			thinkingBody?.invalidate();
			if (anyPanelActive()) requestRender();
			ctx.ui.notify(`Thinking HUD: ${thinkingHudMode}`, "info");
		},
	});

	pi.registerCommand("split-tools", {
		description: "Toggle the tools panel (or Tool Usage drawer in drawers mode)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (layoutMode === "drawers") {
				drawersStrategy.toggleDrawer("tools");
				const st = drawersStrategy.getDrawerState("tools");
				ctx.ui.notify(`Tools drawer ${st.open ? "expanded" : "collapsed"}`, "info");
				return;
			}
			const on = toggleBandPanel("tools", "topRight");
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Tools ${on ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("split-drawer", {
		description: "Toggle a collapsible drawer in drawers mode: thinking | tools",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const arg = String(args ?? "").trim().toLowerCase();
			if (layoutMode !== "drawers") {
				ctx.ui.notify("Switch to drawers mode first: /split-preset drawers", "info");
				return;
			}
			if (arg === "thinking" || arg === "tools") {
				drawersStrategy.toggleDrawer(arg);
				const st = drawersStrategy.getDrawerState(arg);
				ctx.ui.notify(
					`${arg === "thinking" ? "Thinking" : "Tools"} drawer ${st.open ? "expanded" : "collapsed"}`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /split-drawer <thinking|tools>", "info");
		},
	});

	pi.registerCommand("files", {
		description: "Toggle the files panel (dock or overlay)",
		handler: async (_args, ctx) => {
			toggleFilesPanel(ctx);
		},
	});

	pi.registerCommand("split-diff", {
		description: "Toggle the files panel's edit-diff subpanel",
		handler: async (_args, ctx) => {
			showDiff = !showDiff;
			filesVersion++;
			requestRender();
			ctx.ui.notify(`Edit diff ${showDiff ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("split-tools-view", {
		description: "Toggle tool panel compact ↔ full detail",
		handler: async (_args, ctx) => {
			toolMode = toolMode === "compact" ? "full" : "compact";
			toolExpandOverrides.clear();
			toolExpandGlobal = toolMode === "full" ? "all" : null;
			toolsVersionCounter++;
			ctx.ui.notify(`Tool panel: ${toolMode}`, "info");
			requestRender();
		},
	});

	pi.registerCommand("split-tools-expand", {
		description: "Expand/collapse all tool cards (all | collapse | auto; omit to cycle)",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim().toLowerCase();
			let next: ToolExpandGlobal;
			if (!arg) {
				next =
					toolExpandGlobal === null
						? "all"
						: toolExpandGlobal === "all"
							? "none"
							: null;
			} else if (arg === "all") {
				next = "all";
			} else if (arg === "collapse" || arg === "none") {
				next = "none";
			} else if (arg === "auto") {
				next = null;
			} else {
				ctx.ui.notify("Usage: /split-tools-expand [all|collapse|auto]", "warning");
				return;
			}
			toolExpandOverrides.clear();
			toolExpandGlobal = next;
			toolsVersionCounter++;
			requestRender();
			const label =
				next === "all"
					? "expand all"
					: next === "none"
						? "collapse all"
						: "auto (running & errors)";
			ctx.ui.notify(`Tool cards: ${label}`, "info");
		},
	});

	pi.registerCommand("split-tools-live", {
		description:
			"Live output of a streaming tool in the tool panel (picker if several; 'off' to leave)",
		handler: async (args, ctx) => {
			if (args.trim() === "off") {
				if (liveToolId !== null) setLiveTool(null);
				ctx.ui.notify("Tool panel: all tools", "info");
				return;
			}
			// Candidates: running streaming tools other than the pinned one,
			// newest first.
			const cands = streamingActiveIds()
				.filter((id) => id !== liveToolId)
				.reverse();
			if (cands.length === 0) {
				if (liveToolId !== null) {
					setLiveTool(null);
					ctx.ui.notify("Tool panel: all tools", "info");
				} else ctx.ui.notify("No streaming tool is running", "info");
				return;
			}
			let pick: string | undefined = cands[0];
			if (cands.length > 1 || liveToolId !== null) {
				const EXIT = "Exit live view (all tools)";
				const labels = cands.map((id, i) => {
					const e = toolsBy.get(id)!;
					const t = e.startedAt ? ` · ${formatDuration(Date.now() - e.startedAt, true)}` : "";
					return `${i + 1}. ${e.name}${t} · ${truncateInline(e.args, 60)}`;
				});
				const options = liveToolId !== null ? [...labels, EXIT] : labels;
				const choice = await ctx.ui.select("Live output of which tool?", options);
				if (choice === undefined) return;
				if (choice === EXIT) {
					setLiveTool(null);
					ctx.ui.notify("Tool panel: all tools", "info");
					return;
				}
				pick = cands[labels.indexOf(choice)];
			}
			// The tool may have been evicted while the picker was open.
			if (!pick || !toolsBy.has(pick)) return;
			setLiveTool(pick);
			ctx.ui.notify(`Tool panel: live output of ${toolsBy.get(pick)!.name}`, "info");
		},
	});

	pi.registerCommand("split-height", {
		description: "Set the top band height in rows (6-40)",
		handler: async (args, ctx) => {
			const n = Number.parseInt(String(args ?? "").trim(), 10);
			if (Number.isNaN(n)) {
				ctx.ui.notify(
					`Band height: ${bandHeight} rows (usage: /split-height 6-40)`,
					"info",
				);
				return;
			}
			bandHeight = Math.max(6, Math.min(40, n));
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Band height: ${bandHeight} rows`, "info");
		},
	});

	pi.registerCommand("split-tools-width", {
		description: "Set right band panel width as % of the band (20-80, default 35)",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim();
			if (!arg) {
				ctx.ui.notify(
					`Right band panel width: ${toolsWidthPct}% of the band (usage: /split-tools-width 20-80)`,
					"info",
				);
				return;
			}
			const n = Number.parseInt(arg, 10);
			if (Number.isNaN(n)) {
				ctx.ui.notify(
					"Invalid percentage (usage: /split-tools-width 20-80)",
					"error",
				);
				return;
			}
			toolsWidthPct = Math.max(20, Math.min(80, n));
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Right band panel width: ${toolsWidthPct}%`, "info");
		},
	});

	const PRESET_OPTIONS: { name: PresetName; label: string }[] = [
		{
			name: "drawers",
			label: "drawers — Full-width Messages · collapsible Thinking & Tools drawers above prompt",
		},
		{
			name: "chat-left",
			label: "chat-left — Messages + prompt left · Thinking + Tools right",
		},
		{
			name: "workbench",
			label: "workbench — Tools main · Thinking | Messages top · Files dock",
		},
		{
			name: "sidebar-chat",
			label: "sidebar-chat — Tools main · Thinking top · Messages dock right",
		},
		{
			name: "classic",
			label: "classic — Messages main · Thinking | Tools top · Files dock",
		},
		{
			name: "deep-think",
			label: "deep-think — Thinking main · Messages | Tools top · Files dock",
		},
		{
			name: "focused-tools",
			label: "focused-tools — Tools main · Messages top · no dock",
		},
	];

	pi.registerCommand("split-preset", {
		description:
			"Apply a layout preset (drawers | chat-left | workbench | sidebar-chat | classic | deep-think | focused-tools)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split-preset requires interactive mode", "error");
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split-preset requires fullscreen mode", "warning");
				return;
			}
			let chosen: PresetName | undefined;
			const arg = String(args ?? "").trim().toLowerCase();
			if (!arg) {
				const labels = PRESET_OPTIONS.map((p) => p.label);
				const pick = await ctx.ui.select("Choose a split-view layout preset", labels);
				if (pick === undefined) return;
				const idx = labels.indexOf(pick);
				chosen = idx >= 0 ? PRESET_OPTIONS[idx]?.name : undefined;
			} else if (Object.hasOwn(LAYOUT_PRESETS, arg)) {
				chosen = arg as PresetName;
			} else {
				ctx.ui.notify(
					`Unknown preset "${arg}". Available: ${PRESET_OPTIONS.map((p) => p.name).join(", ")}`,
					"error",
				);
				return;
			}
			if (!chosen) return;
			const preset = LAYOUT_PRESETS[chosen];
			const nextMode: LayoutMode = preset.layoutMode ?? "grid";
			layoutMode = nextMode;
			drawersStrategy.setEnabled(nextMode === "drawers");
			if (nextMode === "drawers" && preset.layoutState) {
				drawersStrategy.hydrate(preset.layoutState);
			}
			layoutSlots = { ...preset.slots };
			bandHeight = preset.bandHeight;
			toolsWidthPct = preset.toolsWidthPct;
			filesWidth = preset.filesWidth;
			dockSide = preset.dockSide ?? "right";
			zoomed = null;
			syncFlagsFromSlots();
			const base = getBaseRoot();
			if (
				(nextMode === "drawers" ||
					(slotOf("messages") !== null &&
						slotOf("messages") !== "main" &&
						slotOf("tools") !== null)) &&
				base &&
				baseDockOf(base)
			) {
				trimResponse = true;
			}
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Layout preset: ${chosen}`, "info");
		},
	});

	pi.registerCommand("split-slot", {
		description:
			"Assign a panel to a slot: /split-slot <topLeft|topRight|main|dock> <thinking|tools|messages|files|none>",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split-slot requires interactive mode", "error");
				return;
			}
			if (layoutMode !== "grid") {
				ctx.ui.notify(
					"/split-slot applies to grid layouts (switch with /split-preset chat-left)",
					"info",
				);
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split-slot requires fullscreen mode", "warning");
				return;
			}
			const parts = String(args ?? "")
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			if (parts.length !== 2) {
				ctx.ui.notify(
					"Usage: /split-slot <topLeft|topRight|main|dock> <thinking|tools|messages|files|none>",
					"info",
				);
				return;
			}
			const slotMap: Record<string, SlotName> = {
				topleft: "topLeft",
				topright: "topRight",
				main: "main",
				dock: "dock",
			};
			const slot = slotMap[parts[0]!.toLowerCase()];
			if (!slot) {
				ctx.ui.notify(
					`Invalid slot "${parts[0]}". Use: topLeft, topRight, main, dock`,
					"error",
				);
				return;
			}
			const panelRaw = parts[1]!.toLowerCase();
			let panel: SlotPanel;
			if (panelRaw === "none" || panelRaw === "null") {
				panel = null;
			} else if (
				panelRaw === "thinking" ||
				panelRaw === "tools" ||
				panelRaw === "messages" ||
				panelRaw === "files"
			) {
				panel = panelRaw;
			} else {
				ctx.ui.notify(
					`Invalid panel "${parts[1]}". Use: thinking, tools, messages, files, none`,
					"error",
				);
				return;
			}
			layoutSlots = assignSlot(layoutSlots, slot, panel);
			if (
				layoutSlots.topLeft === null &&
				layoutSlots.topRight === null &&
				layoutSlots.main === null &&
				layoutSlots.dock === null
			) {
				layoutSlots.main = "messages";
			}
			syncFlagsFromSlots();
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Slot ${slot}: ${panel ?? "none"}`, "info");
		},
	});

	pi.registerCommand("split-divider", {
		description:
			"Response-only divider between successive answers: rule | space",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "rule") answerDividerMode = "rule";
			else if (arg === "space") answerDividerMode = "space";
			else answerDividerMode = answerDividerMode === "rule" ? "space" : "rule";
			// Doc children were built with the old mode → rebuild from branch.
			rebuildResponseDoc(ctx);
			if (anyPanelActive()) requestRender();
			ctx.ui.notify(`Answer divider: ${answerDividerMode}`, "info");
		},
	});

	pi.registerCommand("split-response-source", {
		description:
			"Response-only content: messages (user + assistant text) | transcript (pi's transcript minus tool calls, with other extensions' rendering)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "messages" || arg === "transcript") responseSource = arg;
			else responseSource = responseSource === "messages" ? "transcript" : "messages";
			if (anyPanelActive()) requestRender();
			ctx.ui.notify(`Response-only content: ${responseSource}`, "info");
		},
	});

	pi.registerCommand("split-trim-response", {
		description:
			"Panel C: full transcript ↔ response-only (on|off) — response-only: text-only (native parity), full scrollback, scroll offset preserved on branch switch",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split-trim-response requires interactive mode", "error");
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split-trim-response requires fullscreen mode", "warning");
				return;
			}
			const arg = String(args ?? "")
				.trim()
				.toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !trimResponse;
			if (next) {
				const base = getBaseRoot();
				if (!base) {
					ctx.ui.notify("Layout root not ready yet", "warning");
					return;
				}
				// SV-22: trim mode swaps the transcript for the response doc and
				// keeps only the extracted editor dock. If the dock cannot be
				// extracted, fail loudly instead of silently leaving the native
				// transcript while claiming response-only.
				if (!baseDockOf(base)) {
					ctx.ui.notify(
						"Panel C unavailable: editor dock not found in the layout root",
						"error",
					);
					return;
				}
			}
			trimResponse = next;
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(
				`Panel C: ${trimResponse ? "response only" : "full transcript"}`,
				"info",
			);
		},
	});

	pi.registerCommand("split-dock-side", {
		description: "Move the dock column to the left or right (left | right)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (layoutMode !== "grid") {
				ctx.ui.notify(
					"/split-dock-side applies to grid layouts (switch with /split-preset chat-left)",
					"info",
				);
				return;
			}
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "left" || arg === "right") dockSide = arg;
			else dockSide = dockSide === "left" ? "right" : "left";
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Dock side: ${dockSide}`, "info");
		},
	});

	pi.registerCommand("split-turn", {
		description: "Page Tool Usage & Thinking panels by turn: prev | next | live | all | <N>",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (!arg) {
				const activeTurns = activeTurnSelection();
				const label = toolsPagerLabel(activeTurns, currentTurn);
				ctx.ui.notify(
					`Tools turn: ${label} (scope: ${toolsScope}${pinnedTurn !== null ? `, pinned #${pinnedTurn}` : ""})`,
					"info",
				);
				return;
			}
			if (arg === "prev") {
				if (currentTurn <= 0) {
					ctx.ui.notify("No turns yet", "info");
					return;
				}
				stepTurn(-1);
				const label = toolsPagerLabel(activeTurnSelection(), currentTurn);
				ctx.ui.notify(`Tools turn: ${label}`, "info");
				return;
			}
			if (arg === "next") {
				if (currentTurn <= 0) {
					ctx.ui.notify("No turns yet", "info");
					return;
				}
				stepTurn(1);
				const label = toolsPagerLabel(activeTurnSelection(), currentTurn);
				ctx.ui.notify(`Tools turn: ${label}`, "info");
				return;
			}
			if (arg === "live" || arg === "visible") {
				toolsScope = "visible";
				pinnedTurn = null;
				messagesScrollRef?.scrollToEnd();
				toolsVersionCounter++;
				thinking.version++;
				requestRender();
				ctx.ui.notify("Tools turn: live auto-sync (visible)", "info");
				return;
			}
			if (arg === "all") {
				toolsScope = "all";
				pinnedTurn = null;
				toolsVersionCounter++;
				thinking.version++;
				requestRender();
				ctx.ui.notify("Tools turn: showing all turns", "info");
				return;
			}
			if (/^\d+$/.test(arg)) {
				const parsed = parseInt(arg, 10);
				if (parsed < 1) {
					ctx.ui.notify("Usage: /split-turn [prev|next|live|all|<N>]", "warning");
					return;
				}
				if (currentTurn <= 0) {
					ctx.ui.notify("No turns yet", "info");
					return;
				}
				const target = Math.max(1, Math.min(currentTurn, parsed));
				pinnedTurn = target;
				scrollMessagesToTurn(target);
				toolsVersionCounter++;
				thinking.version++;
				requestRender();
				ctx.ui.notify(`Tools turn: pinned to Turn ${target}/${currentTurn}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /split-turn [prev|next|live|all|<N>]", "warning");
		},
	});

	pi.registerCommand("split-save", {
		description: "Save current panel layout as the startup defaults",
		handler: async (_args, ctx) => {
			// SV-11: serialize the EFFECTIVE files state — a regular-mode files
			// overlay of the CURRENT generation counts as files-on; an overlay left
			// over from a stale generation must not save a phantom panel.
			const filesEffective =
				filesOn || (REG.active !== null && REG.activeGen === MY_GEN);
			// SV-13: report the real outcome — success only after a durable write.
			const saved = saveUiPanelsConfig({
				split:
					layoutSlots.topLeft !== null ||
					layoutSlots.topRight !== null ||
					layoutSlots.main !== "messages",
				thinking: thinkingOn,
				tools: toolsOn,
				files: filesEffective,
				slots: { ...layoutSlots },
				toolMode,
				toolsScope,
				trimResponse,
				thinkingScope,
				thinkingHud: thinkingHudMode !== "off",
				thinkingHudMode,
				bandHeight,
				toolsWidthPct,
				...(filesWidth === null ? {} : { filesWidth }),
				dockSide,
				layoutMode,
				layouts: {
					drawers: drawersStrategy.serialize(),
				},
				diff: showDiff,
				answerDivider: answerDividerMode,
				responseSource,
			});
			ctx.ui.notify(
				saved
					? "Panel layout saved as startup defaults for new windows"
					: "Could not save panel layout (config write failed)",
				saved ? "info" : "error",
			);
		},
	});
}
