/**
 * split-view.ts — drawers view TUI extension
 *
 * One layout, composed in ONE layer owned by layout-manager (fullscreen):
 *
 *   VStack(
 *     Messages            pi's transcript, or the response-only doc
 *     editor dock         pi's own pending/status/editor/footer, reused verbatim
 *     Thinking drawer     one-row bar when collapsed, framed panel when open
 *     Tool Usage drawer   one-row bar when collapsed, framed panel when open
 *   )
 *
 * layout-drawers.ts owns the drawer state, geometry and drag handling; this
 * file owns the buffers, the panel bodies and chrome, the Messages region,
 * events and commands. A drawer's [↗] zooms its panel over the whole area
 * above the editor dock. With the drawers off (/split, --no-split) no layer
 * is set and pi's own layout shows. The drawers need the layout engine and
 * only work in fullscreen.
 *
 * With trimResponse on, Messages is the response doc ScrollView instead of
 * pi's transcript.
 *
 * Commands:
 *   /split              toggle the drawers view: OFF = bare pi layout, ON =
 *                       drawers with the drawer state saved as startup defaults
 *   /split-thinking     toggle the Thinking drawer open/closed
 *   /split-tools        toggle the Tool Usage drawer open/closed
 *   /split-drawer <id>  toggle a drawer: thinking | tools
 *   /split-thinking-scope / -view / -hud   Thinking body options
 *   /split-tools-view / -expand / -live    Tool Usage body options
 *   /split-turn         page Thinking and Tool Usage by turn
 *   /split-trim-response toggle panel C: pi transcript ↔ response-only view
 *   /split-response-source / /split-divider   response-only options
 *   /split-save       persist current state as startup defaults for NEW
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
 * Mouse (fullscreen): click a drawer bar to open / close it, [↗] zooms it,
 * the zoomed header's [↙]/[×] leave the zoom; drag an open drawer's top
 * border to resize it. Drags mutate the composed stack entries in place
 * (applyGeometry) so panel scroll positions survive.
 *
 * Shortcuts (ctrl+o/ctrl+t) are dropped: reserved built-ins, un-registrable.
 */

import {
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
	Image,
	ScrollView,
	Spacer,
	VStack,
	getCapabilities,
	getImageDimensions,
	imageFallback,
	type Component,
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
	type ToolMode as ToolModeCfg,
	type ThinkingScope,
	type ThinkingMode,
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
	MeasurementSafeVStack,
	type PanelCtl,
	type PanelId,
} from "./layout-types.ts";
import { DrawersLayout } from "./layout-drawers.ts";
import { FileTree, MIN_TREE_COLS } from "./filetree/index.ts";
import {
	alignTurnSpans,
	appendStreamTail,
	capDisplayLine,
	capToolText,
	formatDuration,
	formatToolArgSummary,
	isInternalNotificationText,
	isToolExpanded,
	keepsInResponseOnly,
	lastImageBlock,
	liveTailLines,
	pickThinkingHeadline,
	pickThinkingSummary,
	selectActiveTurns,
	stripLeadingTrailingBlankLines,
	toolHudBadge,
	toolsPagerButtons,
	truncateInline,
	thoughtsSinceLastUser,
	visibleTurnsInViewport,
	type ImageBlock,
	type ToolExpandGlobal,
	type ToolsScope,
	type TurnSpan,
} from "./helpers.ts";

const WIDGET_KEY = "split-view";
const MAX_TOOLS = 60;
// Display window (logical lines) for the thinking panel. The full transcript
// keeps everything; the drawer is a recent-history view. Must stay small: the
// per-flush render cost is dominated by wrapping the visible window.
const MAX_LINES = 400;
// A newline-free streaming tail grows char by char and re-wraps on every
// flush. Bounded by dropping its older HALF on overflow (appendStreamTail),
// so the visible paragraph re-flows once per ~8K chars, not on every flush.
const MAX_TAIL_CHARS = 16000;
const MAX_TOOL_OUTPUT_LINES = 80;
/** Max lines rendered in an expanded rich bash/read/write card when not zoomed. */
const MAX_EXPANDED_RICH_LINES = 40;
/** Lines of an edit's unified diff kept per tool entry (zoomed tools view). */
const MAX_TOOL_DIFF_LINES = 150;
// OracleSpec body window: hard cap on FINAL VISUAL rows rendered by drawer
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
// ─── module-lifetime state ───────────────────────────────────────────────────

let tuiRef: any;
let widgetSet = false;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
/** SV-14: the saved startup composition is still unapplied. Armed in
 * session_start before reconstruct(); consumed by the widget factory (the
 * first point where the fullscreen root is available, BEFORE the first
 * paint) or by the deferred startup timer as a fallback. */
let startupPending = false;

// Module generation counter (survives /reload): deferred callbacks of a
// replaced module instance compare it and do nothing.
const REG_KEY = Symbol.for("pi.split-view");
interface Registry {
	gen: number;
}
const G = globalThis as Record<symbol, Registry>;
const REG: Registry = G[REG_KEY] ?? { gen: 0 };
G[REG_KEY] = REG;
const MY_GEN = ++REG.gen;

/** SV-27: "turn" = the thinking panel carries the current turn only (the
 * buffer is cleared on each new user message); "session" = accumulate every
 * turn (default). Session-local; /split-thinking-scope, persisted by
 * /split-save. */
let thinkingScope: ThinkingScope = "session";
let thinkingMode: ThinkingMode = "compact";
const thinkingExpandOverrides = new Map<number, boolean>();
let nextThinkingBlockId = 1;
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
/** The tools panel's body ScrollView (drawer or zoomed; set on compose), so
 * entering / leaving live mode can jump to the end of the swapped content
 * instead of keeping a scroll offset that points into unrelated rows. */
let toolsScroll: ScrollView | null = null;
/** The thinking panel's body (drawer or zoomed; set on compose), so
 * toggling /split-thinking-hud can invalidate its per-line wrap memo immediately. */
let thinkingBody: { invalidate(): void } | null = null;
/** Panel C: response-only view instead of pi's transcript (persisted). */
let trimResponse = false;
/** Panel expanded to the whole area above the editor (header ↗ button).
 * Transient: never persisted. */
// PanelId is imported from ./layout-types.ts.
let zoomed: PanelId | null = null;

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
	id: number;
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
		this.current = {
			id: nextThinkingBlockId++,
			lines: [],
			tail: "",
			complete: false,
			turn: Math.max(1, currentTurn),
		};
		this.streaming = true;
		this.version++;
	},
	append(delta: string) {
		if (!this.current)
			this.current = {
				id: nextThinkingBlockId++,
				lines: [],
				tail: "",
				complete: false,
				turn: Math.max(1, currentTurn),
			};
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

function trimBlankEdgeLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]!.trim() === "") start++;
	while (end > start && lines[end - 1]!.trim() === "") end--;
	return lines.slice(start, end);
}

function thinkingLines(theme: Theme, width: number): string[] {
	const out: string[] = [];
	const sep = theme.fg("dim", "─".repeat(Math.max(8, Math.min(60, width - 3))));
	const activeTurns = thinkingScope === "session" ? activeTurnSelection() : null;
	for (const b of thinking.blocks) {
		if (activeTurns !== null && !activeTurns.includes(b.turn)) continue;
		const trimmed = trimBlankEdgeLines(b.lines);
		if (trimmed.length === 0) continue;
		if (out.length) out.push(sep);
		for (const l of trimmed) out.push(l);
	}
	if (
		thinking.current &&
		(activeTurns === null || activeTurns.includes(thinking.current.turn))
	) {
		const raw = thinking.current.tail
			? [...thinking.current.lines, thinking.current.tail]
			: thinking.current.lines;
		const trimmed = trimBlankEdgeLines(raw);
		if (trimmed.length > 0) {
			if (out.length) out.push(sep);
			for (const l of trimmed) out.push(l);
		}
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
/** Read the active context entries (respecting compaction boundaries, matching
 * Pi's interactive chatContainer), falling back to getBranch(). */
function activeContextEntries(ctx: ExtensionContext): any[] {
	const sm = ctx.sessionManager as any;
	if (typeof sm?.buildContextEntries === "function") {
		return sm.buildContextEntries();
	}
	return ctx.sessionManager.getBranch();
}

function rebuildResponseDoc(ctx: ExtensionContext): void {
	responseDoc.clear();
	streamingResponseComponent = null;
	lastResponseRole = null;
	const branch = activeContextEntries(ctx);
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
		if (anyPanelActive()) requestRender();
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

/** One row-source item of a panel body: a styled text line, or an
 * inline image block. Image items render RAW via pi-tui's Image component
 * (never wrapped, capped or padded) — the same line structure pi's own
 * transcript feeds its ScrollView, which the TUI engine handles (image-aware
 * scrollbar, scroll cropping, placement cleanup on full repaints). */
type BodyItem = string | { image: ImageBlock; maxRows?: number };

/** Tool Usage drawer (not zoomed): inline images are thumbnails capped at
 * this many rows so they don't crowd the drawer. Zoomed: pi's default. */
const DRAWER_IMAGE_ROWS = 6;

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

const toolsVersion = () => toolsVersionCounter;

// ─── shared helpers ──────────────────────────────────────────────────────────

function requestRender(): void {
	try {
		tuiRef?.requestRender?.();
	} catch {
		/* ignore */
	}
}

const anyPanelActive = () => isLayoutLayerActive("ui");

// ─── mouse: drag-resize, header buttons, wheel routing ───────────────────────

/** Terminal dimensions the current geometry was computed for (resize hook). */
let composedTermCols = -1;
let composedTermRows = -1;

/** Late-bound UI access for mouse actions (set by the widget factory). */
let themeGetter: (() => Theme) | null = null;
let notifyFn: ((msg: string, level: "info" | "warning") => void) | null = null;

/** The drawers layout: owns drawer state, geometry and drag handling. */
const drawers = new DrawersLayout(
	() => ({
		cols: tuiRef?.terminal?.columns ?? 120,
		rows: tuiRef?.terminal?.rows ?? 40,
	}),
	() => requestRender(),
);

/** The file tree pane: a right column beside the drawers layout. */
const fileTree = new FileTree({
	requestRender: () => requestRender(),
	terminalSize: () => ({
		cols: tuiRef?.terminal?.columns ?? 120,
		rows: tuiRef?.terminal?.rows ?? 40,
	}),
	theme: () => themeGetter?.() ?? null,
});

/** Re-apply layout geometry in place on resize or state mutation. */
function applyGeometry(): void {
	const cols = tuiRef?.terminal?.columns ?? 120;
	const rows = tuiRef?.terminal?.rows ?? 40;
	composedTermCols = cols;
	composedTermRows = rows;
	drawers.applyGeometry(cols, rows);
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

/** Zoomed-panel header [×]: leave the zoom. */
function closeZoom(id: PanelId): void {
	if (zoomed !== id) return;
	zoomed = null;
	recompose();
}

/** Shared mouse handling for panel chrome: header buttons (top), bottom-frame
 * pager and live buttons, drawer drag continuation, wheel routing. */
function panelMouse(
	ev: TuiMouseEvent,
	ctl: PanelCtl | undefined,
	where: "top" | "bottom" | "body",
): TuiMouseEventResult | undefined {
	if (drawers.hasActiveDrag() && (ev.type === "drag" || ev.type === "release")) {
		return ctl?.onDragEvent?.(ev) ?? drawers.handleDragEvent(ev);
	}
	if (!ctl) return undefined;
	if (ev.type === "wheel") {
		ctl.scroll?.scrollBy(ev.wheelDelta ?? 0);
		return { handled: true };
	}
	if (ev.button !== "left") return undefined;
	if (ev.type === "press") {
		if (where === "top" && buttonAt(ev)) return { capture: true };
		if (where === "bottom" && (liveButtonAt(ev, ctl.id) || pagerHitTest(ev, ctl.id)))
			return { capture: true };
		return undefined;
	}
	if (ev.type === "click" && where === "top") {
		const b = buttonAt(ev);
		if (b === "zoom") toggleZoom(ctl.id);
		else if (b === "close") closeZoom(ctl.id);
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
		 * MAX_BODY_ROWS window. See PanelDef.windowed. */
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

/**
 * Thinking panel body: delegates to RecentBody in "full" mode, and renders
 * collapsible 1-line-per-block HUD cards with anchor-on-expand and an accent
 * ┃ left-gutter collapse rail in "compact" mode (matching RichToolsBody).
 */
class ThinkingBody implements Component {
	private readonly fullBody: RecentBody;
	private cacheVersion = -1;
	private cacheMinRows = -1;
	private cacheZoomed = false;
	private cacheTurnsKey = "";
	private cacheMode: ThinkingMode = "compact";
	private cacheByWidth = new Map<
		number,
		{
			rows: string[];
			headerRows: Map<number, number>;
			bodyRows: Map<number, { id: number; startRow: number }>;
		}
	>();
	private headerRows = new Map<number, number>();
	private bodyRows = new Map<number, { id: number; startRow: number }>();
	private pendingAnchorBlockId: number | null = null;
	private static readonly MAX_CACHED_WIDTHS = 4;

	constructor(
		private theme: Theme,
		private style: (line: string) => string,
		lines: (w: number) => BodyItem[],
		private version: () => number,
		private empty: string,
		private minRows: () => number,
		private ctl?: PanelCtl,
		windowed = true,
	) {
		this.fullBody = new RecentBody(
			theme,
			style,
			lines,
			version,
			empty,
			minRows,
			ctl,
			windowed,
		);
	}

	private activeBlocks(): ThinkingBlock[] {
		const activeTurns = thinkingScope === "session" ? activeTurnSelection() : null;
		const out: ThinkingBlock[] = [];
		for (const b of thinking.blocks) {
			if (activeTurns !== null && !activeTurns.includes(b.turn)) continue;
			if (trimBlankEdgeLines(b.lines).length === 0) continue;
			out.push(b);
		}
		if (
			thinking.current &&
			(activeTurns === null || activeTurns.includes(thinking.current.turn))
		) {
			const raw = thinking.current.tail
				? [...thinking.current.lines, thinking.current.tail]
				: thinking.current.lines;
			if (trimBlankEdgeLines(raw).length > 0 || thinking.streaming) {
				out.push(thinking.current);
			}
		}
		return out;
	}

	private isBlockExpanded(block: ThinkingBlock, zoomedThinking: boolean): boolean {
		if (thinkingExpandOverrides.has(block.id)) {
			return thinkingExpandOverrides.get(block.id)!;
		}
		if (zoomedThinking) return true;
		return !block.complete;
	}

	render(width: number): string[] {
		if (thinkingMode === "full") {
			return this.fullBody.render(width);
		}
		const th = this.theme;
		const v = this.version();
		const min = Math.max(1, this.minRows());
		const zoomedThinking = zoomed === "thinking";
		const activeTurns = thinkingScope === "session" ? activeTurnSelection() : null;
		const turnsKey = activeTurns === null ? "all" : activeTurns.join(",");
		if (
			v !== this.cacheVersion ||
			min !== this.cacheMinRows ||
			zoomedThinking !== this.cacheZoomed ||
			turnsKey !== this.cacheTurnsKey ||
			thinkingMode !== this.cacheMode
		) {
			this.cacheVersion = v;
			this.cacheMinRows = min;
			this.cacheZoomed = zoomedThinking;
			this.cacheTurnsKey = turnsKey;
			this.cacheMode = thinkingMode;
			this.cacheByWidth.clear();
		}
		const cached = this.cacheByWidth.get(width);
		if (cached) {
			this.cacheByWidth.delete(width);
			this.cacheByWidth.set(width, cached);
			this.headerRows = cached.headerRows;
			this.bodyRows = cached.bodyRows;
			this.flushPendingAnchor();
			return cached.rows;
		}

		const edge = th.fg("border", "│");
		const gutter = th.fg("accent", "┃");
		const innerWidth = Math.max(10, width - 3);
		const filler = edge + " ".repeat(Math.max(0, width - 1));
		const rows: string[] = [];
		const headerRows = new Map<number, number>();
		const bodyRows = new Map<number, { id: number; startRow: number }>();

		const emitLine = (content: string) => {
			const clipped =
				visibleWidth(content) > innerWidth
					? truncateToWidth(content, innerWidth)
					: content;
			const reset = clipped.includes("\x1b[") ? "\x1b[0m" : "";
			const padLen = Math.max(0, width - 2 - visibleWidth(clipped));
			rows.push(edge + " " + clipped + reset + " ".repeat(padLen));
		};

		const blocks = this.activeBlocks();
		if (blocks.length === 0) {
			emitLine(th.fg("dim", this.empty));
		} else {
			const lavender = isLightTheme(th)
				? "\x1b[38;2;114;135;253m"
				: "\x1b[38;2;180;190;254m";
			const bulbIcon = `${lavender}\uF0EB\x1b[0m`;
			const distinctTurns = new Set(blocks.map((b) => b.turn)).size;
			const showTurnHeaders =
				(activeTurns !== null && activeTurns.length > 1) ||
				(activeTurns === null && distinctTurns > 1);
			let lastRenderedTurn = -1;

			for (const block of blocks) {
				if (showTurnHeaders && block.turn !== lastRenderedTurn) {
					lastRenderedTurn = block.turn;
					const preview = turnPreviews.get(block.turn);
					const header =
						th.fg("dim", "── ") +
						th.fg("accent", `Turn ${block.turn}`) +
						(preview ? th.fg("dim", ` · ${preview}`) : "") +
						th.fg("dim", " ──");
					emitLine(header);
				}
				const rawLines = block.tail
					? [...block.lines, block.tail]
					: block.lines;
				const trimmed = trimBlankEdgeLines(rawLines);
				const expanded = this.isBlockExpanded(block, zoomedThinking);
				const cardStartRow = rows.length;
				headerRows.set(cardStartRow, block.id);

				const caret = th.fg("muted", expanded ? "▾" : "▸");
				const streamMark = !block.complete ? th.fg("warning", " ⟳") : "";
				const countTag =
					trimmed.length > 0 ? th.fg("dim", ` (${trimmed.length}L)`) : "";
				const prefix = `${caret} ${bulbIcon}${streamMark}`;
				const headlineRoom = Math.max(
					4,
					innerWidth - visibleWidth(prefix) - visibleWidth(countTag) - 1,
				);
				const summary = pickThinkingSummary(
					trimmed,
					Math.max(120, headlineRoom * 2),
				);
				let styledHeadline: string;
				if (summary.title) {
					const titleStyled = th.fg("toolTitle", th.bold(summary.title));
					if (summary.body) {
						styledHeadline = `${titleStyled} ${this.style(summary.body)}`;
					} else {
						styledHeadline = titleStyled;
					}
				} else if (summary.body) {
					styledHeadline = this.style(summary.body);
				} else {
					styledHeadline = this.style(
						pickThinkingHeadline(trimmed) || (!block.complete ? "streaming…" : "…"),
					);
				}
				const clippedHeadline =
					visibleWidth(styledHeadline) > headlineRoom
						? truncateToWidth(styledHeadline, headlineRoom)
						: styledHeadline;
				const gap = Math.max(
					1,
					innerWidth -
						visibleWidth(prefix) -
						1 -
						visibleWidth(clippedHeadline) -
						visibleWidth(countTag),
				);
				emitLine(
					`${prefix} ${clippedHeadline}${" ".repeat(gap)}${countTag}`,
				);

				if (!expanded) continue;

				const bodyWidth = Math.max(8, innerWidth - 1);
				for (const line of trimmed) {
					const styled = this.style(capDisplayLine(line, MAX_LINE_CHARS));
					const wrapped = wrapTextWithAnsi(styled, bodyWidth);
					for (const w of wrapped.length > 0 ? wrapped : [""]) {
						const rowIdx = rows.length;
						const clipped =
							visibleWidth(w) > bodyWidth
								? truncateToWidth(w, bodyWidth)
								: w;
						const reset = clipped.includes("\x1b[") ? "\x1b[0m" : "";
						const padLen = Math.max(
							0,
							width - 3 - visibleWidth(clipped),
						);
						rows.push(
							edge + gutter + " " + clipped + reset + " ".repeat(padLen),
						);
						bodyRows.set(rowIdx, { id: block.id, startRow: cardStartRow });
					}
				}
			}
		}

		while (rows.length < min) rows.push(filler);

		this.headerRows = headerRows;
		this.bodyRows = bodyRows;
		this.cacheByWidth.set(width, { rows, headerRows, bodyRows });
		while (this.cacheByWidth.size > ThinkingBody.MAX_CACHED_WIDTHS) {
			const oldest = this.cacheByWidth.keys().next().value as number;
			this.cacheByWidth.delete(oldest);
		}
		this.flushPendingAnchor();
		return rows;
	}

	private flushPendingAnchor(): void {
		const targetId = this.pendingAnchorBlockId;
		if (targetId === null) return;
		this.pendingAnchorBlockId = null;
		let targetRow = -1;
		for (const [row, id] of this.headerRows) {
			if (id === targetId) {
				targetRow = row;
				break;
			}
		}
		if (targetRow >= 0 && this.ctl?.scroll) {
			const scroll = this.ctl.scroll;
			queueMicrotask(() => {
				scroll.scrollTo(targetRow);
				requestRender();
			});
		}
	}

	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (thinkingMode === "full") {
			return this.fullBody.handleMouse(ev);
		}
		const res = panelMouse(ev, this.ctl, "body");
		if (res) return res;
		if (ev.button !== "left" || ev.x <= 0) return undefined;
		const isHeaderHit = this.headerRows.has(ev.y);
		const isGutterHit = ev.x <= 2 && this.bodyRows.has(ev.y);
		if (ev.type === "press" && (isHeaderHit || isGutterHit)) {
			return { capture: true };
		}
		if (ev.type === "click") {
			const blockId = this.headerRows.get(ev.y);
			if (blockId !== undefined) {
				const block = this.activeBlocks().find((b) => b.id === blockId);
				if (block) {
					const cur = this.isBlockExpanded(block, zoomed === "thinking");
					const next = !cur;
					thinkingExpandOverrides.set(blockId, next);
					if (next) this.pendingAnchorBlockId = blockId;
					thinking.version++;
					requestRender();
					return { handled: true };
				}
			}
			if (isGutterHit) {
				const hit = this.bodyRows.get(ev.y);
				if (hit) {
					thinkingExpandOverrides.set(hit.id, false);
					this.pendingAnchorBlockId = hit.id;
					thinking.version++;
					requestRender();
					return { handled: true };
				}
			}
		}
		return undefined;
	}

	invalidate(): void {
		this.cacheVersion = -1;
		this.cacheByWidth.clear();
		this.fullBody.invalidate();
	}

	dispose(): void {
		this.fullBody.dispose();
	}
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
		{
			rows: string[];
			headerRows: Map<number, string>;
			bodyRows: Map<number, { id: string; startRow: number }>;
		}
	>();
	private headerRows = new Map<number, string>();
	private bodyRows = new Map<number, { id: string; startRow: number }>();
	private pendingAnchorToolId: string | null = null;
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
			this.bodyRows = cached.bodyRows;
			this.flushPendingAnchor();
			return cached.rows;
		}

		const edge = th.fg("border", "│");
		const gutter = th.fg("accent", "┃");
		const innerWidth = Math.max(10, width - 3);
		const filler = edge + " ".repeat(Math.max(0, width - 1));
		const rows: string[] = [];
		const headerRows = new Map<number, string>();
		const bodyRows = new Map<number, { id: string; startRow: number }>();

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
					const cardStartRow = rows.length;
					headerRows.set(cardStartRow, entry.id);
					emitLine(this.formatHeader(entry, expanded, innerWidth));

					if (!expanded) continue;

					const emitCardBodyLine = (content: string) => {
						const rowIdx = rows.length;
						if (isRawImageLine(content)) {
							rows.push(content);
							bodyRows.set(rowIdx, { id: entry.id, startRow: cardStartRow });
							return;
						}
						const clipped =
							visibleWidth(content) > innerWidth
								? truncateToWidth(content, innerWidth)
								: content;
						const reset = clipped.includes("\x1b[") ? "\x1b[0m" : "";
						const padLen = Math.max(0, width - 2 - visibleWidth(clipped));
						rows.push(edge + gutter + clipped + reset + " ".repeat(padLen));
						bodyRows.set(rowIdx, { id: entry.id, startRow: cardStartRow });
					};

					const bodyStartLen = rows.length;
					const lower = entry.name.toLowerCase();
					if (lower === "bash") {
						this.renderRichBashBody(entry, innerWidth, zoomedTools, emitCardBodyLine);
					} else if (
						(lower === "read" || lower === "write") &&
						!entry.image &&
						this.renderRichCodeBody(entry, innerWidth, zoomedTools, emitCardBodyLine)
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
								for (const line of rendered) emitCardBodyLine(line);
							} else {
								this.renderFallbackBody(
									entry,
									innerWidth,
									width,
									zoomedTools,
									emitCardBodyLine,
									rows,
								);
							}
						} else {
							this.renderFallbackBody(
								entry,
								innerWidth,
								width,
								zoomedTools,
								emitCardBodyLine,
								rows,
							);
						}
					}
					for (let r = bodyStartLen; r < rows.length; r++) {
						if (!bodyRows.has(r)) {
							bodyRows.set(r, { id: entry.id, startRow: cardStartRow });
						}
					}
					// Visual separation after an expanded card.
					rows.push(filler);
				}
			}
		}

		while (rows.length < min) rows.push(filler);

		this.headerRows = headerRows;
		this.bodyRows = bodyRows;
		this.cacheByWidth.set(width, { rows, headerRows, bodyRows });
		while (this.cacheByWidth.size > RichToolsBody.MAX_CACHED_WIDTHS) {
			const oldest = this.cacheByWidth.keys().next().value as number;
			this.cacheByWidth.delete(oldest);
		}
		this.flushPendingAnchor();
		return rows;
	}

	private flushPendingAnchor(): void {
		const targetId = this.pendingAnchorToolId;
		if (!targetId) return;
		this.pendingAnchorToolId = null;
		let targetRow = -1;
		for (const [row, id] of this.headerRows) {
			if (id === targetId) {
				targetRow = row;
				break;
			}
		}
		if (targetRow >= 0 && this.ctl?.scroll) {
			const scroll = this.ctl.scroll;
			queueMicrotask(() => {
				scroll.scrollTo(targetRow);
				requestRender();
			});
		}
	}

	private formatHeader(e: ToolEntry, expanded: boolean, innerWidth: number): string {
		const th = this.theme;
		const caret = th.fg("muted", expanded ? "▾" : "▸");
		const mark = e.active
			? th.fg("warning", "⟳")
			: e.isError
				? th.fg("error", "✗")
				: th.fg("success", "✓");
		const hud = toolHudBadge(e.name, isLightTheme(th));
		const iconStr = `${hud.ansiColor}${hud.icon}\x1b[0m`;
		const nameStr = hud.showName ? ` ${th.fg("toolTitle", th.bold(e.name))}` : "";
		const badge = e.subagent ? th.fg("muted", ` [${e.agent ?? "sub"}]`) : "";
		let dur = "";
		if (e.startedAt !== undefined) {
			if (e.endedAt !== undefined)
				dur = th.fg("muted", ` ${formatDuration(e.endedAt - e.startedAt)}`);
			else if (e.active && Date.now() - e.startedAt >= 1000)
				dur = th.fg("muted", ` ${formatDuration(Date.now() - e.startedAt, true)}`);
		}
		const prefix = `${caret} ${mark} ${iconStr}${nameStr}${badge}${dur}`;
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
				zoomedTools ? undefined : DRAWER_IMAGE_ROWS,
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
		const isHeaderHit = this.headerRows.has(ev.y);
		const isGutterHit = ev.x <= 2 && this.bodyRows.has(ev.y);
		if (ev.type === "press" && (isHeaderHit || isGutterHit)) {
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
				const nextExpanded = !currentlyExpanded;
				toolExpandOverrides.set(id, nextExpanded);
				if (nextExpanded) {
					this.pendingAnchorToolId = id;
				}
				toolsVersionCounter++;
				requestRender();
				return { handled: true };
			}
			if (isGutterHit) {
				const hit = this.bodyRows.get(ev.y);
				if (hit && toolsBy.has(hit.id)) {
					toolExpandOverrides.set(hit.id, false);
					this.pendingAnchorToolId = hit.id;
					toolsVersionCounter++;
					requestRender();
					return { handled: true };
				}
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

// ─── layout composition (one layer) ──────────────────────────────────────────

interface PanelDef {
	title: string;
	color: "accent" | "muted";
	streaming: () => boolean;
	/** Line style and row source of the Thinking body's full-prose mode (the
	 * Tool Usage body draws its own cards). */
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

function panelDef(theme: Theme, id: "thinking" | "tools"): PanelDef {
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
		lines: () => [],
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
function framedPanel(theme: Theme, d: PanelDef, ctl: PanelCtl): Component {
	// Filler rows track the real viewport, so the left edge stays continuous
	// at any allocated height.
	const minRows = () => ctl.scroll?.viewportHeight || ctl.minRows?.() || 1;
	const body: Component =
		ctl.id === "tools"
			? new RichToolsBody(theme, d.version, d.empty, minRows, ctl)
			: new ThinkingBody(
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
	if (ctl.id === "thinking" && body instanceof ThinkingBody) thinkingBody = body;
	return new MeasurementSafeVStack([
		{ component: new BorderTop(theme, d.title, d.color, d.streaming, ctl), basis: 1, grow: 0, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: new BorderBottom(theme, ctl), basis: 1, grow: 0, shrink: 0 },
	]);
}

/** The Messages region: the response-only ScrollView when trimResponse is on,
 * else pi's own transcript ScrollView. */
function buildMessages(theme: Theme, base: Component | null): Component {
	const msgScroll =
		trimResponse && base
			? ensureResponseScrollView(theme, base)
			: (base ? baseTranscriptOf(base) : null) ??
				(base ? ensureResponseScrollView(theme, base) : new Spacer(1));
	if (msgScroll instanceof ScrollView) messagesScrollRef = msgScroll;
	return msgScroll;
}

/** D1: one panel over the whole area above pi's editor dock (reused verbatim,
 * like trim mode); the rest of the layout is hidden until the zoom is restored. */
function buildZoom(theme: Theme, id: PanelId): Component | null {
	const base = getBaseRoot();
	const dock = base ? baseDockOf(base) : null;
	if (!dock) return null;
	const ctl: PanelCtl = {
		id,
		// First-frame estimate: terminal rows minus the dock and the two frame rows.
		minRows: () =>
			Math.max(
				1,
				(tuiRef?.terminal?.rows ?? 24) -
					dock.render(tuiRef?.terminal?.columns ?? 80).length -
					2,
			),
	};
	const panel = framedPanel(theme, panelDef(theme, id), ctl);
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
	const d = panelDef(theme, id);
	const minRows = () => ctl.scroll?.viewportHeight || ctl.minRows?.() || 1;
	const body: Component =
		id === "tools"
			? new RichToolsBody(theme, d.version, d.empty, minRows, ctl)
			: new ThinkingBody(
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
		if (id === "thinking" && body instanceof ThinkingBody) thinkingBody = body;
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
		let blockCount = 0;
		const filterTurns = thinkingScope === "session" ? activeTurns : null;
		for (const b of thinking.blocks) {
			if (filterTurns !== null && !filterTurns.includes(b.turn)) continue;
			const trimmed = trimBlankEdgeLines(b.lines);
			if (trimmed.length === 0) continue;
			blockCount++;
			lineCount += trimmed.length;
		}
		if (
			thinking.current &&
			(filterTurns === null || filterTurns.includes(thinking.current.turn))
		) {
			const raw = thinking.current.tail
				? [...thinking.current.lines, thinking.current.tail]
				: thinking.current.lines;
			const trimmed = trimBlankEdgeLines(raw);
			if (trimmed.length > 0 || thinking.streaming) {
				blockCount++;
				lineCount += trimmed.length;
			}
		}
		const streaming = thinking.streaming;
		if (lineCount === 0 && blockCount === 0) {
			return { text: streaming ? "streaming" : "idle", streaming, errorCount: 0 };
		}
		const turnTag =
			currentTurn > 0 ? ` · ${toolsPagerLabel(activeTurns, currentTurn)}` : "";
		const countText =
			thinkingMode === "compact"
				? `${blockCount} block${blockCount === 1 ? "" : "s"}`
				: `${lineCount} line${lineCount === 1 ? "" : "s"}`;
		return {
			text: `${countText}${turnTag}`,
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

/** Build the composed layout root: the stack (the zoomed panel, or the
 * drawers layout) with the file tree pane to its right. A zoomed panel
 * covers the stack only; the pane stays. */
function composeLayout(theme: Theme): Component {
	return fileTree.wrap(composeStack(theme));
}

function composeStack(theme: Theme): Component {
	drawers.resetGeometry();
	toolsScroll = null;
	thinkingBody = null;
	messagesScrollRef = null;
	const cols = tuiRef?.terminal?.columns ?? 120;
	const rows = tuiRef?.terminal?.rows ?? 40;
	composedTermCols = cols;
	composedTermRows = rows;
	if (zoomed && drawers.isEnabled()) {
		const z = buildZoom(theme, zoomed);
		if (z) return z;
	}
	const base = getBaseRoot();
	const editorDock = base ? baseDockOf(base) : null;
	const ctx: LayoutContext = {
		theme,
		editorDock,
		cols,
		rows,
		buildMessages: () => buildMessages(theme, base),
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
			};
		},
		stepTurn: (delta) => stepTurn(delta),
		toggleToolsScopeAll: () => toggleToolsScopeAll(),
		isMessagesFollowingEnd: () => messagesScrollRef?.isFollowingEnd ?? true,
		getMessagesViewportHeight: () => messagesScrollRef?.viewportHeight ?? 0,
		isTurnPinned: () => pinnedTurn !== null,
	};
	return drawers.compose(ctx);
}

/** Reconcile the single "ui" layout layer with the drawers on/off state. */
function reconcileLayout(theme: Theme): void {
	drawers.cancelDrag();
	if (zoomed && !drawers.isEnabled()) zoomed = null;
	if (!drawers.isEnabled() || !tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
		if (isLayoutLayerActive("ui")) setLayoutLayer("ui", null);
		fileTree.unwrap();
		return;
	}
	setLayoutLayer("ui", () => composeLayout(theme));
	// SV-08: remember the theme this composition was built with.
	composedThemeFp = themeFingerprint(theme);
}

// ─── wiring ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-split", {
		description: "Start bare: skip the split-view drawers (Thinking / Tool Usage)",
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
							drawers.clearScrollCache();
							if (anyPanelActive()) {
								rebuildResponseDoc(ctx);
								reconcileLayout(liveTheme);
							}
						}
						// SV-07/F2: drawer heights derive from the terminal size; on any
						// resize re-apply them to the composed entries in place (no
						// rebuild, scroll positions survive).
						if (
							typeof tuiRef?.setLayoutRoot === "function" &&
							isLayoutLayerActive("ui") &&
							((tuiRef?.terminal?.columns ?? 120) !== composedTermCols ||
								(tuiRef?.terminal?.rows ?? 40) !== composedTermRows)
						)
							applyGeometry();
						// The widget draws no rows; pi calls it on each frame, which
						// keeps the layout checks above running.
						return [];
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
		thinkingExpandOverrides.clear();
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
		drawers.onReconstruct();
		toolsVersionCounter++;
		rebuildResponseDoc(ctx);

		const branch = activeContextEntries(ctx);
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
					id: nextThinkingBlockId++,
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
		const cfg = normalizeConfig(loadUiPanelsConfig());
		// --no-split: start bare, ignoring the saved ui-panels.json layout.
		const noSplit = Boolean(pi.getFlag("no-split"));
		drawers.setEnabled(!noSplit);
		drawers.hydrate(cfg.drawers);
		fileTree.hydrate(cfg.tree);
		if (ctx.mode === "tui") fileTree.start(ctx.cwd);
		thinkingScope = cfg.thinkingScope;
		thinkingMode = cfg.thinkingMode;
		thinkingHudMode = cfg.thinkingHudMode;
		toolMode = cfg.toolMode;
		toolsScope = cfg.toolsScope;
		toolExpandGlobal = null;
		zoomed = null;
		answerDividerMode = cfg.answerDivider;
		trimResponse = noSplit ? false : cfg.trimResponse;
		responseSource = cfg.responseSource;
		// SV-14: arm the startup composition BEFORE reconstruct — the widget
		// factory runs synchronously inside it and is the first point where the
		// fullscreen root is available, so the drawers are in the first paint.
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
				drawers.onThinkingStart();
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
				addResponseMessage(msg);
			}
		}
		if (anyPanelActive()) requestRender();
	});
	pi.on("message_end", (event) => {
		responseMessageEnd((event as any).message);
		if (anyPanelActive()) requestRender();
	});

	// The file tree reads git before each run, so what a bash call changes
	// is compared against a current state.
	pi.on("before_agent_start", () => {
		fileTree.promptStart();
	});

	// Tool stream.
	pi.on("tool_execution_start", (event) => {
		// SV-17: same ingest path the branch rebuild uses.
		ingestToolCall(event.toolCallId, event.toolName, event.args, Date.now());
		fileTree.toolStart(event.toolCallId, event.toolName, event.args);
		drawers.onToolStart();
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
		fileTree.toolEnd(event.toolCallId, event.isError, (event as any).result);
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

	// Subagent tool calls: tool panel entries with an [agent] badge.
	pi.events.on("subagents:tool_call", (data) => {
		const { toolName, input, agent } = (data ?? {}) as {
			toolName?: string;
			input?: unknown;
			agent?: string;
		};
		if (!toolName) return;
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
		drawers.cancelDrag();
		if (startupTimer) {
			clearTimeout(startupTimer);
			startupTimer = null;
		}
		if (isLayoutLayerActive("ui")) setLayoutLayer("ui", null);
		fileTree.unwrap();
		fileTree.stop();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetSet = false;
	});

	pi.registerCommand("split", {
		description:
			"Toggle the drawers view: off = bare pi layout, on = drawers with the saved state",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split requires interactive mode", "error");
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split requires fullscreen mode", "warning");
				return;
			}
			// OFF restores pi's native layout (no drawers, no response-only
			// swap). ON brings the drawers back with the drawer state saved as
			// startup defaults (ui-panels.json, written by /split-save).
			const wasOn = drawers.isEnabled();
			if (wasOn) {
				drawers.setEnabled(false);
				trimResponse = false;
				zoomed = null;
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view off · /split-save saves defaults", "info");
			} else {
				const cfg = normalizeConfig(loadUiPanelsConfig());
				drawers.setEnabled(true);
				drawers.hydrate(cfg.drawers);
				fileTree.hydrate(cfg.tree);
				const base = getBaseRoot();
				if (base && baseDockOf(base)) trimResponse = true;
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view on (saved layout) · /split-save saves defaults", "info");
			}
		},
	});

	pi.registerCommand("split-tree", {
		description: "Toggle the file tree pane on the right",
		handler: async (_args, ctx) => {
			if (!anyPanelActive()) {
				ctx.ui.notify("/split-tree needs the split view (fullscreen, /split on)", "warning");
				return;
			}
			fileTree.setOpen(!fileTree.isOpen());
			const cols = tuiRef?.terminal?.columns ?? 120;
			ctx.ui.notify(
				!fileTree.isOpen()
					? "File tree hidden"
					: fileTree.isVisible()
						? "File tree shown"
						: `File tree on (hidden: the terminal is ${cols} columns wide, it needs ${MIN_TREE_COLS})`,
				"info",
			);
		},
	});

	pi.registerCommand("split-thinking", {
		description: "Toggle the Thinking drawer open/closed",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			drawers.toggleDrawer("thinking");
			const st = drawers.getDrawerState("thinking");
			ctx.ui.notify(`Thinking drawer ${st.open ? "expanded" : "collapsed"}`, "info");
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

	pi.registerCommand("split-thinking-view", {
		description: "Thinking panel view: compact (collapsible 1-line cards) | full (prose)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "compact") thinkingMode = "compact";
			else if (arg === "full") thinkingMode = "full";
			else thinkingMode = thinkingMode === "compact" ? "full" : "compact";
			thinking.version++;
			thinkingBody?.invalidate();
			if (anyPanelActive()) requestRender();
			ctx.ui.notify(
				`Thinking view: ${thinkingMode === "compact" ? "compact (collapsible cards)" : "full prose"}`,
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
		description: "Toggle the Tool Usage drawer open/closed",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			drawers.toggleDrawer("tools");
			const st = drawers.getDrawerState("tools");
			ctx.ui.notify(`Tools drawer ${st.open ? "expanded" : "collapsed"}`, "info");
		},
	});

	pi.registerCommand("split-drawer", {
		description: "Toggle a drawer: thinking | tools",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const parts = String(args ?? "")
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);
			const arg = parts[0] ?? "";
			if (arg === "thinking" || arg === "tools") {
				drawers.toggleDrawer(arg);
				const st = drawers.getDrawerState(arg);
				ctx.ui.notify(
					`${arg === "thinking" ? "Thinking" : "Tools"} drawer ${st.open ? "expanded" : "collapsed"}`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /split-drawer <thinking|tools>", "info");
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
			// SV-13: report the real outcome — success only after a durable write.
			const saved = saveUiPanelsConfig({
				toolMode,
				toolsScope,
				trimResponse,
				thinkingScope,
				thinkingMode,
				thinkingHudMode,
				drawers: drawers.serialize(),
				tree: fileTree.serialize(),
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
