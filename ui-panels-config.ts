/**
 * ui-panels-config.ts — shared persistent config for the unified split-view
 * extension (thinking / tools / files panels). Stored at ~/.pi/agent/ui-panels.json.
 *
 * Defaults: thinking and tools default ON (when `split` is on); files defaults OFF.
 * `toolMode` defaults to "compact".
 *
 * IMPORTANT: the JSON on disk is a TEMPLATE of startup defaults, NOT live
 * state. Toggle commands only mutate in-process state (session-local);
 * only /split-save writes the current layout back to disk. This keeps
 * concurrent pi windows from clobbering each other's panels.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "ui-panels.json");

export type ToolMode = "compact" | "full";

/** SV-27: how much of the reasoning stream the thinking panel keeps.
 * "turn" = only the current turn (the buffer is cleared on each new user
 * message); "session" = accumulate every turn until MAX_LINES pushes the
 * oldest rows out. */
export type ThinkingScope = "turn" | "session";
export type ResponseSource = "messages" | "transcript";
export type SlotName = "topLeft" | "topRight" | "main" | "dock";
export type SlotPanel = "thinking" | "tools" | "messages" | "files" | null;
export type LayoutSlots = Record<SlotName, SlotPanel>;
export type PresetName =
	| "workbench"
	| "sidebar-chat"
	| "classic"
	| "deep-think"
	| "focused-tools";

export interface LayoutPreset {
	slots: LayoutSlots;
	bandHeight: number;
	toolsWidthPct: number;
	filesWidth: number | null;
}

export const LAYOUT_PRESETS: Record<PresetName, LayoutPreset> = {
	classic: {
		slots: {
			topLeft: "thinking",
			topRight: "tools",
			main: "messages",
			dock: "files",
		},
		bandHeight: 20,
		toolsWidthPct: 35,
		filesWidth: null,
	},
	workbench: {
		slots: {
			topLeft: "thinking",
			topRight: "messages",
			main: "tools",
			dock: "files",
		},
		bandHeight: 14,
		toolsWidthPct: 50,
		filesWidth: 34,
	},
	"sidebar-chat": {
		slots: {
			topLeft: "thinking",
			topRight: null,
			main: "tools",
			dock: "messages",
		},
		bandHeight: 10,
		toolsWidthPct: 35,
		filesWidth: 48,
	},
	"deep-think": {
		slots: {
			topLeft: "messages",
			topRight: "tools",
			main: "thinking",
			dock: "files",
		},
		bandHeight: 14,
		toolsWidthPct: 55,
		filesWidth: 34,
	},
	"focused-tools": {
		slots: {
			topLeft: "messages",
			topRight: null,
			main: "tools",
			dock: null,
		},
		bandHeight: 12,
		toolsWidthPct: 35,
		filesWidth: null,
	},
};

const VALID_PANELS = new Set<string>(["thinking", "tools", "messages", "files"]);
const SLOT_DEDUP_ORDER: readonly SlotName[] = ["main", "topLeft", "topRight", "dock"];

/** Assign `panel` to `slot`. If `panel` is non-null and currently occupies
 * another slot, swap that slot with the previous occupant of `slot` so a panel
 * is never duplicated across slots. */
export function assignSlot(
	slots: LayoutSlots,
	slot: SlotName,
	panel: SlotPanel,
): LayoutSlots {
	const next: LayoutSlots = { ...slots };
	const prev = next[slot];
	if (panel === prev) return next;
	if (panel !== null) {
		for (const other of SLOT_DEDUP_ORDER) {
			if (other !== slot && next[other] === panel) {
				next[other] = prev;
				break;
			}
		}
	}
	next[slot] = panel;
	return next;
}

export interface UiPanelsConfig {
	/** Master: is the top band (thinking | tools over chat) active. */
	split?: boolean;
	/** Thinking panel within the band. Defaults to true when absent. */
	thinking?: boolean;
	/** Thinking panel buffer scope. Defaults to "session" (accumulate, the
	 * pre-SV-27 behaviour) when absent. */
	thinkingScope?: ThinkingScope;
	/** Inline semantic keyword highlighting in the Thinking panel. Defaults to
	 * true when absent. */
	thinkingHud?: boolean;
	/** Tools panel within the band. Defaults to true when absent. */
	tools?: boolean;
	/** Files side panel (fullscreen dock or regular overlay). */
	files?: boolean;
	/** Files panel edit-diff subpanel. Defaults to true when absent. */
	diff?: boolean;
	/** Divider between successive assistant messages in response-only mode:
	 * "rule" = dim dashed line, "space" = plain blank line. Defaults to "rule". */
	answerDivider?: "rule" | "space";
	/** Tool panel detail mode. */
	toolMode?: ToolMode;
	/** Panel C shows response-only (own-rendered) instead of pi's full transcript. */
	trimResponse?: boolean;
	/** What response-only mode draws: "messages" = user + assistant text built
	 * by this extension; "transcript" = pi's own transcript components minus
	 * tool calls, so other extensions' markdown transformers, custom entries
	 * and custom messages render. Defaults to "messages". */
	responseSource?: ResponseSource;
	/** Top band height in rows (6–40, default 20). */
	bandHeight?: number;
	/** Right band panel's share of the band width in percent (20–80, default 35). */
	toolsWidthPct?: number;
	/** Dock width in columns (set by dragging its edge). Absent = auto
	 * (25% of the terminal, 34–48 cols). */
	filesWidth?: number;
	/** Named layout slot assignments (topLeft, topRight, main, dock). */
	slots?: Partial<LayoutSlots>;
}

/** SV-12: strict boolean read — only real booleans count; absent or
 * wrongly-typed values (strings, numbers, objects, null) fall back to the
 * same defaults as a missing field, so bad JSON can never become an
 * accidental truthy flag. */
function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeSlotValue(value: unknown): SlotPanel {
	return typeof value === "string" && VALID_PANELS.has(value)
		? (value as Exclude<SlotPanel, null>)
		: null;
}

/** Normalize raw config with defaults (never throws). */
export function normalizeConfig(raw: UiPanelsConfig): Required<{
	split: boolean;
	thinking: boolean;
	tools: boolean;
	files: boolean;
	diff: boolean;
	answerDivider: "rule" | "space";
	toolMode: ToolMode;
	thinkingScope: ThinkingScope;
	thinkingHud: boolean;
	trimResponse: boolean;
	responseSource: ResponseSource;
	bandHeight: number;
	toolsWidthPct: number;
	filesWidth: number | null;
	slots: LayoutSlots;
}> {
	// SV-12: tolerate any shape — a null root, an array or a primitive reads
	// as an empty config instead of throwing on property access.
	const root: UiPanelsConfig =
		typeof raw === "object" && raw !== null && !Array.isArray(raw)
			? raw
			: {};
	const tm: ToolMode = root.toolMode === "full" ? "full" : "compact";
	// SV-12: only a real finite number is usable; Number(null) === 0 would
	// otherwise clamp to 6. Non-numeric/unusable values use the default.
	const rawHeight: unknown = root.bandHeight;
	const usableHeight =
		typeof rawHeight === "number" && Number.isFinite(rawHeight)
			? Math.trunc(rawHeight)
			: 20;
	const bandHeight = Math.max(6, Math.min(40, usableHeight));
	// F: toolsWidthPct — same strict typing as bandHeight (real finite number,
	// default 35 on garbage), clamped to 20–80.
	const rawPct: unknown = root.toolsWidthPct;
	const usablePct =
		typeof rawPct === "number" && Number.isFinite(rawPct)
			? Math.trunc(rawPct)
			: 35;
	const toolsWidthPct = Math.max(20, Math.min(80, usablePct));
	// filesWidth: a real finite number ≥ 24 cols (capped at 200), else auto.
	const rawFw: unknown = root.filesWidth;
	const filesWidth =
		typeof rawFw === "number" && Number.isFinite(rawFw) && rawFw >= 24
			? Math.min(200, Math.trunc(rawFw))
			: null;

	const rawSlots: unknown = root.slots;
	const hasExplicitSlots =
		typeof rawSlots === "object" &&
		rawSlots !== null &&
		!Array.isArray(rawSlots);

	let split: boolean;
	let thinking: boolean;
	let tools: boolean;
	let files: boolean;
	let slots: LayoutSlots;

	if (hasExplicitSlots) {
		const src = rawSlots as Record<string, unknown>;
		const seen = new Set<string>();
		const out: LayoutSlots = {
			topLeft: null,
			topRight: null,
			main: null,
			dock: null,
		};
		for (const slot of SLOT_DEDUP_ORDER) {
			const val = normalizeSlotValue(src[slot]);
			if (val !== null && !seen.has(val)) {
				seen.add(val);
				out[slot] = val;
			}
		}
		if (
			out.topLeft === null &&
			out.topRight === null &&
			out.main === null &&
			out.dock === null
		) {
			out.main = "messages";
			seen.add("messages");
		}
		slots = out;
		thinking = seen.has("thinking");
		tools = seen.has("tools");
		// Preserve regular-mode files overlay persistence (files: true with no dock slot).
		files = seen.has("files") || boolOr(root.files, false);
		split =
			slots.topLeft !== null ||
			slots.topRight !== null ||
			slots.main !== "messages";
	} else {
		split = boolOr(root.split, false);
		thinking = split && boolOr(root.thinking, true);
		tools = split && boolOr(root.tools, true);
		files = boolOr(root.files, false);
		slots = {
			topLeft: thinking ? "thinking" : null,
			topRight: tools ? "tools" : null,
			main: "messages",
			dock: files ? "files" : null,
		};
	}

	return {
		split,
		thinking,
		tools,
		files,
		diff: boolOr(root.diff, true),
		answerDivider: root.answerDivider === "space" ? "space" : "rule",
		toolMode: tm,
		// SV-27: strict read — only the literal "turn" opts in; anything else
		// falls back to the "session" default, preserving the original behaviour.
		thinkingScope: root.thinkingScope === "turn" ? "turn" : "session",
		thinkingHud: boolOr(root.thinkingHud, true),
		trimResponse: boolOr(root.trimResponse, false),
		// Strict read: only the literal "transcript" opts in.
		responseSource: root.responseSource === "transcript" ? "transcript" : "messages",
		bandHeight,
		toolsWidthPct,
		filesWidth,
		slots,
	};
}

export function loadUiPanelsConfig(): UiPanelsConfig {
	try {
		// SV-12: validate the parsed root is a plain object before casting;
		// JSON null, arrays or primitives fall back to defaults.
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		)
			return {};
		return parsed as UiPanelsConfig;
	} catch {
		return {};
	}
}

/** Persist the config. SV-13: returns whether the write actually succeeded
 * instead of swallowing the error, so callers can report the real outcome. */
export function saveUiPanelsConfig(cfg: UiPanelsConfig): boolean {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
		return true;
	} catch {
		/* never break the extension on a config write failure */
		return false;
	}
}

/**
 * This module is a shared utility imported by split-view.ts. pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here.
 */
export default function (_pi: ExtensionAPI) {
	/* no-op: this is a shared config module, not a real extension */
}
