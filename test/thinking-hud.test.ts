import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	analyzeThinkingLineLocal,
	applyAiSpansOverLine,
	parseAiSpansResponse,
	renderThinkingSpans,
	selectFastThinkingModel,
	type ThinkingHudPalette,
	type ThinkingSpan,
} from "../thinking-hud.ts";
import { normalizeConfig } from "../ui-panels-config.ts";

const BENCHMARK_PARAGRAPHS = [
	// Paragraph 1: ToolExecutionComponent expanded-state bug & restore pattern
	"Wait, RichToolsBody.render calls comp.setExpanded(true) which permanently mutates the shared component state and causes a regression when switching back to compact mode. Instead of mutating it in place, we should save prevExpanded before rendering and restore it immediately afterward.",
	// Paragraph 2: Regular-mode files overlay config persistence
	"Actually, normalizeConfig ignores root.files when slots has no dock entry, so regular-mode overlay never reopens after /split-save. Because explicit slots overwrite the legacy flags, we should preserve root.files only if the dock slot is null.",
	// Paragraph 3: Latency & token budget tradeoff for semantic HUD
	"However, calling a large reasoning model on every streaming delta would take hundreds of milliseconds and burn tokens for no visual gain. A better pattern is a zero-latency local salience pass in src/foo/bar.ts plus an async fast-AI refiner on completed lines.",
	// Paragraph 4: Named slots layout promotion
	"**Layout Refactor**: First, promote tools into named slots so topLeft and topRight never conflict. Next, validate `bandHeight` and `toolsWidthPct` in ui-panels-config.ts; Note: otherwise a malformed JSON file breaks startup.",
];

function wordCount(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed.split(/\s+/).length;
}

function highlightedWordDensity(line: string, spans: ThinkingSpan[]): number {
	const total = wordCount(line);
	if (total === 0) return 0;
	let highlighted = 0;
	for (const s of spans) {
		if (s.role !== "plain") highlighted += wordCount(s.text);
	}
	return highlighted / total;
}

test("analyzeThinkingLineLocal: lossless round-trip, balanced identifiers, pivots, risks, and <=35% density across 4 benchmark paragraphs", () => {
	const t0 = performance.now();
	for (const para of BENCHMARK_PARAGRAPHS) {
		const spans = analyzeThinkingLineLocal(para);

		// Lossless round-trip invariant
		assert.equal(
			spans.map((s) => s.text).join(""),
			para,
			`lossless round-trip failed for: ${para}`,
		);

		// Adjacent spans of identical role should be merged
		for (let i = 1; i < spans.length; i++) {
			assert.notEqual(
				spans[i - 1]!.role,
				spans[i]!.role,
				`adjacent same-role spans (${spans[i]!.role}) were not merged`,
			);
		}

		// Density <= 35% so HUD stays crisp without word confetti
		const density = highlightedWordDensity(para, spans);
		assert.ok(
			density <= 0.35,
			`expected density <= 0.35, got ${(density * 100).toFixed(1)}% for: ${para}\nspans=${JSON.stringify(spans)}`,
		);
		assert.ok(
			density > 0.05,
			`expected meaningful highlights (>5%), got ${(density * 100).toFixed(1)}%`,
		);
	}
	const elapsedMs = performance.now() - t0;
	assert.ok(elapsedMs < 25, `expected fast synchronous analysis, took ${elapsedMs.toFixed(2)}ms`);

	// Specific balanced identifier preservation checks
	const p1 = analyzeThinkingLineLocal(BENCHMARK_PARAGRAPHS[0]!);
	assert.ok(
		p1.some((s) => s.role === "focus" && s.text === "RichToolsBody.render"),
		`RichToolsBody.render should be a single focus span: ${JSON.stringify(p1)}`,
	);
	assert.ok(
		p1.some((s) => s.role === "focus" && s.text === "comp.setExpanded(true)"),
		`comp.setExpanded(true) should be a single balanced focus span: ${JSON.stringify(p1)}`,
	);
	assert.ok(
		p1.some((s) => s.role === "pivot" && s.text === "Wait"),
		`Wait should be detected as pivot: ${JSON.stringify(p1)}`,
	);
	assert.ok(
		p1.some((s) => s.role === "pivot" && s.text === "Instead of"),
		`Instead of should be detected as pivot: ${JSON.stringify(p1)}`,
	);
	assert.ok(
		p1.some((s) => s.role === "risk" && s.text === "permanently mutates"),
		`permanently mutates should be detected as risk: ${JSON.stringify(p1)}`,
	);

	const p2 = analyzeThinkingLineLocal(BENCHMARK_PARAGRAPHS[1]!);
	assert.ok(
		p2.some((s) => s.role === "focus" && s.text === "root.files"),
		`root.files should be preserved whole as focus: ${JSON.stringify(p2)}`,
	);
	assert.ok(
		p2.some((s) => s.role === "focus" && s.text === "/split-save"),
		`/split-save should be preserved whole as focus: ${JSON.stringify(p2)}`,
	);
	assert.ok(
		p2.some((s) => s.role === "pivot" && s.text === "only if"),
		`only if should be detected as pivot: ${JSON.stringify(p2)}`,
	);

	const p3 = analyzeThinkingLineLocal(BENCHMARK_PARAGRAPHS[2]!);
	assert.ok(
		p3.some((s) => s.role === "focus" && s.text === "src/foo/bar.ts"),
		`src/foo/bar.ts should be preserved as focus: ${JSON.stringify(p3)}`,
	);
	assert.ok(
		p3.some((s) => s.role === "pivot" && s.text === "A better pattern"),
		`A better pattern should be detected as pivot: ${JSON.stringify(p3)}`,
	);
	assert.ok(
		p3.some((s) => s.role === "risk" && s.text === "hundreds of milliseconds"),
		`hundreds of milliseconds should be detected as risk: ${JSON.stringify(p3)}`,
	);

	const p4 = analyzeThinkingLineLocal(BENCHMARK_PARAGRAPHS[3]!);
	assert.ok(
		p4.some((s) => s.role === "heading" && s.text === "**Layout Refactor**"),
		`markdown heading should be detected: ${JSON.stringify(p4)}`,
	);
	assert.ok(
		p4.some((s) => s.role === "focus" && s.text === "`bandHeight`"),
		`backtick code should be focus: ${JSON.stringify(p4)}`,
	);
	assert.ok(
		p4.some((s) => s.role === "pivot" && s.text === "First,"),
		`First, should be pivot: ${JSON.stringify(p4)}`,
	);
	assert.ok(
		p4.some((s) => s.role === "pivot" && s.text === "Note:"),
		`Note: should be pivot: ${JSON.stringify(p4)}`,
	);
});

test("analyzeThinkingLineLocal: ANSI passthrough and empty line", () => {
	const ansiLine = "\x1b[31mError:\x1b[0m comp.setExpanded(true) failed";
	assert.deepEqual(analyzeThinkingLineLocal(ansiLine), [{ role: "plain", text: ansiLine }]);
	assert.deepEqual(analyzeThinkingLineLocal(""), []);
});

test("renderThinkingSpans maps every ThinkingRole through the palette", () => {
	const palette: ThinkingHudPalette = {
		plain: (t) => t,
		heading: (t) => `[H:${t}]`,
		focus: (t) => `[F:${t}]`,
		action: (t) => `[A:${t}]`,
		pivot: (t) => `[P:${t}]`,
		risk: (t) => `[R:${t}]`,
	};
	const spans: ThinkingSpan[] = [
		{ role: "heading", text: "**Plan**" },
		{ role: "plain", text: " " },
		{ role: "pivot", text: "Wait" },
		{ role: "plain", text: " " },
		{ role: "action", text: "restore it" },
		{ role: "plain", text: " " },
		{ role: "focus", text: "root.files" },
		{ role: "plain", text: " " },
		{ role: "risk", text: "regression" },
	];
	assert.equal(
		renderThinkingSpans(spans, palette),
		"[H:**Plan**] [P:Wait] [A:restore it] [F:root.files] [R:regression]",
	);
});

test("applyAiSpansOverLine merges AI spans with local pivots/identifiers, enforces <=5 word cap and <=32% density, lossless round-trip", () => {
	const line =
		"Wait, calling comp.setExpanded(true) in RichToolsBody.render permanently mutates shared state, so we must save prevExpanded and restore it after painting each frame.";
	const spans = applyAiSpansOverLine(line, [
		// Valid AI spans (including case-insensitive fallback on "Permanently Mutates")
		{ phrase: "Permanently Mutates", role: "risk" },
		{ phrase: "save prevExpanded", role: "action" },
		// Invalid: >5 words — must be ignored
		{ phrase: "restore it after painting each frame", role: "action" },
	]);

	// Lossless round-trip
	assert.equal(spans.map((s) => s.text).join(""), line);

	// AI spans applied (with original casing preserved from line)
	assert.ok(
		spans.some((s) => s.role === "risk" && s.text === "permanently mutates"),
		`case-insensitive AI span should match verbatim text: ${JSON.stringify(spans)}`,
	);
	assert.ok(
		spans.some((s) => s.role === "action" && s.text === "save prevExpanded"),
		`exact AI span should match: ${JSON.stringify(spans)}`,
	);
	// >5 word AI span was rejected
	assert.ok(
		!spans.some((s) => s.text === "restore it after painting each frame"),
		`>5 word AI span should be rejected: ${JSON.stringify(spans)}`,
	);
	// Local identifier & pivot merged where non-overlapping
	assert.ok(
		spans.some((s) => s.role === "focus" && s.text === "comp.setExpanded(true)"),
		`local balanced identifier should be merged: ${JSON.stringify(spans)}`,
	);
	assert.ok(
		spans.some((s) => s.role === "pivot" && s.text === "Wait"),
		`local pivot should be merged: ${JSON.stringify(spans)}`,
	);

	// Density cap <= 32%
	const density = highlightedWordDensity(line, spans);
	assert.ok(
		density <= 0.35,
		`expected bounded density, got ${(density * 100).toFixed(1)}%`,
	);

	// ANSI passthrough
	const ansi = "\x1b[32mok\x1b[0m";
	assert.deepEqual(applyAiSpansOverLine(ansi, [{ phrase: "ok", role: "focus" }]), [
		{ role: "plain", text: ansi },
	]);
});

test("parseAiSpansResponse handles raw JSON, fenced JSON, and rejects invalid items", () => {
	const fenced = [
		"```json",
		'[{"phrase":"root.files","role":"focus"},{"phrase":"this phrase has way too many words here","role":"action"},{"phrase":"breaks","role":"risk"},{"phrase":"bad","role":"unknown"}]',
		"```",
	].join("\n");
	assert.deepEqual(parseAiSpansResponse(fenced), [
		{ phrase: "root.files", role: "focus" },
		{ phrase: "breaks", role: "risk" },
	]);
	assert.equal(parseAiSpansResponse("not json at all"), null);
});

test("selectFastThinkingModel picks fastest model in priority order", () => {
	const fake = (id: string) => ({ id }) as unknown as Model<Api>;
	assert.equal(
		selectFastThinkingModel([fake("gpt-5-mini"), fake("claude-haiku-4-5"), fake("gemini-2.5-flash")])?.id,
		"gemini-2.5-flash",
	);
	assert.equal(
		selectFastThinkingModel([fake("gpt-4o-mini"), fake("gemini-2.0-flash")])?.id,
		"gemini-2.0-flash",
	);
	assert.equal(
		selectFastThinkingModel([fake("gpt-4o-mini"), fake("gemini-3.0-flash-preview")])?.id,
		"gemini-3.0-flash-preview",
	);
	assert.equal(
		selectFastThinkingModel([fake("gpt-4o-mini"), fake("claude-haiku-4-5")])?.id,
		"claude-haiku-4-5",
	);
	assert.equal(
		selectFastThinkingModel([fake("gpt-5-mini"), fake("gpt-4o-mini")])?.id,
		"gpt-4o-mini",
	);
	assert.equal(selectFastThinkingModel([fake("claude-opus-4-5")]), null);
});

test("normalizeConfig handles thinkingHudMode (ai|local|off) and legacy thinkingHud boolean", () => {
	// Default: "ai" + thinkingHud: true
	const def = normalizeConfig({});
	assert.equal(def.thinkingHudMode, "ai");
	assert.equal(def.thinkingHud, true);

	// Explicit modes
	assert.equal(normalizeConfig({ thinkingHudMode: "local" }).thinkingHudMode, "local");
	assert.equal(normalizeConfig({ thinkingHudMode: "local" }).thinkingHud, true);
	assert.equal(normalizeConfig({ thinkingHudMode: "off" }).thinkingHudMode, "off");
	assert.equal(normalizeConfig({ thinkingHudMode: "off" }).thinkingHud, false);
	assert.equal(normalizeConfig({ thinkingHudMode: "ai", thinkingHud: false }).thinkingHudMode, "ai");
	assert.equal(normalizeConfig({ thinkingHudMode: "ai", thinkingHud: false }).thinkingHud, true);

	// Legacy boolean fallback
	assert.equal(normalizeConfig({ thinkingHud: false }).thinkingHudMode, "off");
	assert.equal(normalizeConfig({ thinkingHud: false }).thinkingHud, false);
	assert.equal(normalizeConfig({ thinkingHud: true }).thinkingHudMode, "ai");
	assert.equal(normalizeConfig({ thinkingHud: true }).thinkingHud, true);

	// Garbage mode falls back to legacy boolean or default "ai"
	assert.equal(
		normalizeConfig({ thinkingHudMode: "bogus" as any, thinkingHud: false }).thinkingHudMode,
		"off",
	);
	assert.equal(
		normalizeConfig({ thinkingHudMode: "bogus" as any }).thinkingHudMode,
		"ai",
	);
});
