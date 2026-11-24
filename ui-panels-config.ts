/**
 * ui-panels-config.ts — persistent config for the split-view extension
 * (Thinking / Tool Usage drawers, Messages options). Stored at
 * ~/.pi/agent/ui-panels.json.
 *
 * Defaults: both drawers start collapsed. `toolMode` defaults to "compact".
 * Keys this module does not know are ignored.
 *
 * IMPORTANT: the JSON on disk is a TEMPLATE of startup defaults, NOT live
 * state. Toggle commands only mutate in-process state (session-local);
 * only /split-save writes the current state back to disk. This keeps
 * concurrent pi windows from clobbering each other's panels.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolsScope } from "./helpers.ts";

export type { ToolsScope };

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "ui-panels.json");

export type ToolMode = "compact" | "full";

/** SV-27: how much of the reasoning stream the thinking panel keeps.
 * "turn" = only the current turn (the buffer is cleared on each new user
 * message); "session" = accumulate every turn until MAX_LINES pushes the
 * oldest rows out. */
export type ThinkingScope = "turn" | "session";
export type ThinkingMode = "compact" | "full";
export type ThinkingHudMode = "ai" | "local" | "off";
export type ResponseSource = "messages" | "transcript";

/** Saved state of one drawer: expanded or collapsed, and its height in rows
 * when expanded (frame rows included). */
export interface DrawerConfig {
	open: boolean;
	height: number;
}

/** Saved state of the two drawers. */
export interface DrawersConfig {
	thinking: DrawerConfig;
	tools: DrawerConfig;
}

/** Drawer state as read from disk: only well-typed fields are present. */
export type DrawersConfigInput = Partial<
	Record<keyof DrawersConfig, Partial<DrawerConfig>>
>;

export interface UiPanelsConfig {
	/** Thinking panel buffer scope. Defaults to "session" (accumulate, the
	 * pre-SV-27 behaviour) when absent. */
	thinkingScope?: ThinkingScope;
	/** Thinking panel view mode: "compact" (collapsible 1-line-per-block cards)
	 * or "full" (continuous prose). Defaults to "compact". */
	thinkingMode?: ThinkingMode;
	/** Thinking Semantic HUD mode: "ai" (Tier 1 local + Tier 2 async fast-AI),
	 * "local" (Tier 1 local salience only), or "off" (plain thinkingText).
	 * Defaults to "ai". */
	thinkingHudMode?: ThinkingHudMode;
	/** Divider between successive assistant messages in response-only mode:
	 * "rule" = dim dashed line, "space" = plain blank line. Defaults to "rule". */
	answerDivider?: "rule" | "space";
	/** Tool panel detail mode. */
	toolMode?: ToolMode;
	/** Tool panel turn scope: "visible" (auto-sync with Messages viewport),
	 * "turn" (latest turn only), or "all" (all turns). Defaults to "visible". */
	toolsScope?: ToolsScope;
	/** Panel C shows response-only (own-rendered) instead of pi's full transcript. */
	trimResponse?: boolean;
	/** What response-only mode draws: "messages" = user + assistant text built
	 * by this extension; "transcript" = pi's own transcript components minus
	 * tool calls, so other extensions' markdown transformers, custom entries
	 * and custom messages render. Defaults to "messages". */
	responseSource?: ResponseSource;
	/** Drawer state at startup. Absent drawers start collapsed at their
	 * default height. */
	drawers?: DrawersConfigInput;
}

/** SV-12: strict boolean read — only real booleans count; absent or
 * wrongly-typed values (strings, numbers, objects, null) fall back to the
 * same defaults as a missing field, so bad JSON can never become an
 * accidental truthy flag. */
function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Normalize raw config with defaults (never throws). */
export function normalizeConfig(raw: UiPanelsConfig): Required<{
	answerDivider: "rule" | "space";
	toolMode: ToolMode;
	toolsScope: ToolsScope;
	thinkingScope: ThinkingScope;
	thinkingMode: ThinkingMode;
	thinkingHudMode: ThinkingHudMode;
	trimResponse: boolean;
	responseSource: ResponseSource;
	drawers: DrawersConfigInput;
}> {
	// SV-12: tolerate any shape — a null root, an array or a primitive reads
	// as an empty config instead of throwing on property access.
	const root: UiPanelsConfig =
		typeof raw === "object" && raw !== null && !Array.isArray(raw)
			? raw
			: {};
	const tm: ToolMode = root.toolMode === "full" ? "full" : "compact";
	const thinkingHudMode: ThinkingHudMode =
		root.thinkingHudMode === "local" || root.thinkingHudMode === "off"
			? root.thinkingHudMode
			: "ai";

	// Strict read per drawer: `open` only as a real boolean, `height` only as
	// a real finite number. The drawers layout clamps the height.
	const drawers: DrawersConfigInput = {};
	const rawDrawers: unknown = root.drawers;
	if (rawDrawers && typeof rawDrawers === "object" && !Array.isArray(rawDrawers)) {
		for (const id of ["thinking", "tools"] as const) {
			const item = (rawDrawers as Record<string, unknown>)[id];
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const rec = item as Record<string, unknown>;
			const out: Partial<DrawerConfig> = {};
			if (typeof rec.open === "boolean") out.open = rec.open;
			if (typeof rec.height === "number" && Number.isFinite(rec.height))
				out.height = rec.height;
			drawers[id] = out;
		}
	}

	return {
		answerDivider: root.answerDivider === "space" ? "space" : "rule",
		toolMode: tm,
		toolsScope:
			root.toolsScope === "turn" || root.toolsScope === "all"
				? root.toolsScope
				: "visible",
		// SV-27: strict read — only the literal "turn" opts in; anything else
		// falls back to the "session" default, preserving the original behaviour.
		thinkingScope: root.thinkingScope === "turn" ? "turn" : "session",
		thinkingMode: root.thinkingMode === "full" ? "full" : "compact",
		thinkingHudMode,
		trimResponse: boolOr(root.trimResponse, false),
		// Strict read: only the literal "transcript" opts in.
		responseSource: root.responseSource === "transcript" ? "transcript" : "messages",
		drawers,
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
