import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	analyzeThinkingLineLocal,
	applyAiSpansOverLine,
	buildAiRefinementPayload,
	parseAiSpansResponse,
	renderThinkingSpans,
	selectFastThinkingModel,
	type AiThinkingRole,
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

	// Specific balanced identifier, path, command, heading, pivot, and risk preservation checks
	const p1 = analyzeThinkingLineLocal(BENCHMARK_PARAGRAPHS[0]!);
	assert.ok(
		p1.some((s) => s.role === "symbol" && s.text === "RichToolsBody.render"),
		`RichToolsBody.render should be a single symbol span: ${JSON.stringify(p1)}`,
	);
	assert.ok(
		p1.some((s) => s.role === "symbol" && s.text === "comp.setExpanded(true)"),
		`comp.setExpanded(true) should be a single balanced symbol span: ${JSON.stringify(p1)}`,
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
		p2.some((s) => s.role === "symbol" && s.text === "root.files"),
		`root.files should be preserved whole as symbol: ${JSON.stringify(p2)}`,
	);
	assert.ok(
		p2.some((s) => s.role === "command" && s.text === "/split-save"),
		`/split-save should be preserved whole as command: ${JSON.stringify(p2)}`,
	);
	assert.ok(
		p2.some((s) => s.role === "pivot" && s.text === "only if"),
		`only if should be detected as pivot: ${JSON.stringify(p2)}`,
	);

	const p3 = analyzeThinkingLineLocal(BENCHMARK_PARAGRAPHS[2]!);
	assert.ok(
		p3.some((s) => s.role === "path" && s.text === "src/foo/bar.ts"),
		`src/foo/bar.ts should be preserved as path: ${JSON.stringify(p3)}`,
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
		p4.some((s) => s.role === "symbol" && s.text === "`bandHeight`"),
		`backtick code should be symbol: ${JSON.stringify(p4)}`,
	);
	assert.ok(
		p4.some((s) => s.role === "path" && s.text === "ui-panels-config.ts"),
		`bare filename should be path: ${JSON.stringify(p4)}`,
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

test("analyzeThinkingLineLocal: detects all 9 semantic roles + heading + plain accurately", () => {
	// path + command + metric (realistic sentence length within ~30% density budget)
	const line1 =
		"Running tsc and rg across ~/.pi/agent/ui-panels.json and package.json completed in 2.3ms with 35/35 passing at 32% budget in the test suite.";
	const spans1 = analyzeThinkingLineLocal(line1);
	assert.equal(spans1.map((s) => s.text).join(""), line1);
	assert.ok(spans1.some((s) => s.role === "command" && s.text === "tsc"), JSON.stringify(spans1));
	assert.ok(spans1.some((s) => s.role === "command" && s.text === "rg"), JSON.stringify(spans1));
	assert.ok(
		spans1.some((s) => s.role === "path" && s.text === "~/.pi/agent/ui-panels.json"),
		JSON.stringify(spans1),
	);
	assert.ok(
		spans1.some((s) => s.role === "path" && s.text === "package.json"),
		JSON.stringify(spans1),
	);
	assert.ok(spans1.some((s) => s.role === "metric" && s.text === "2.3ms"), JSON.stringify(spans1));
	assert.ok(spans1.some((s) => s.role === "metric" && s.text === "35/35"), JSON.stringify(spans1));
	assert.ok(spans1.some((s) => s.role === "metric" && s.text === "32%"), JSON.stringify(spans1));

	// Additional metrics: commas, collapsed/expanded, 5000ms, 12 languages + risk
	const line2 =
		"The profile trace recorded 115,497ms across 12 languages with 4 collapsed entries and 65 expanded entries right before the 5000ms timeout fired on the background worker thread.";
	const spans2 = analyzeThinkingLineLocal(line2);
	assert.equal(spans2.map((s) => s.text).join(""), line2);
	assert.ok(
		spans2.some((s) => s.role === "metric" && s.text === "115,497ms"),
		JSON.stringify(spans2),
	);
	assert.ok(
		spans2.some((s) => s.role === "metric" && s.text === "12 languages"),
		JSON.stringify(spans2),
	);
	assert.ok(
		spans2.some((s) => s.role === "metric" && s.text === "4 collapsed"),
		JSON.stringify(spans2),
	);
	assert.ok(
		spans2.some((s) => s.role === "metric" && s.text === "65 expanded"),
		JSON.stringify(spans2),
	);
	assert.ok(spans2.some((s) => s.role === "metric" && s.text === "5000ms"), JSON.stringify(spans2));
	assert.ok(spans2.some((s) => s.role === "risk" && s.text === "timeout"), JSON.stringify(spans2));

	// Pi tools + slash commands
	const line3 =
		"We can delegate the background task through Agent or ask_user and SendMessage, or invoke /split-preset while inspecting bash logs.";
	const spans3 = analyzeThinkingLineLocal(line3);
	assert.equal(spans3.map((s) => s.text).join(""), line3);
	assert.ok(spans3.some((s) => s.role === "command" && s.text === "Agent"), JSON.stringify(spans3));
	assert.ok(
		spans3.some((s) => s.role === "command" && s.text === "ask_user"),
		JSON.stringify(spans3),
	);
	assert.ok(
		spans3.some((s) => s.role === "command" && s.text === "SendMessage"),
		JSON.stringify(spans3),
	);
	assert.ok(
		spans3.some((s) => s.role === "command" && s.text === "/split-preset"),
		JSON.stringify(spans3),
	);
	assert.ok(spans3.some((s) => s.role === "command" && s.text === "bash"), JSON.stringify(spans3));

	// Hypotheses & uncertainty cues → question
	const line3b =
		"Maybe this is a caching artifact, so it remains unclear if we should keep the older fallback path around.";
	const spans3b = analyzeThinkingLineLocal(line3b);
	assert.equal(spans3b.map((s) => s.text).join(""), line3b);
	assert.ok(
		spans3b.some((s) => s.role === "question" && s.text === "Maybe"),
		JSON.stringify(spans3b),
	);
	assert.ok(
		spans3b.some((s) => s.role === "question" && s.text === "unclear"),
		JSON.stringify(spans3b),
	);
	assert.ok(
		spans3b.some((s) => s.role === "question" && s.text === "if we"),
		JSON.stringify(spans3b),
	);

	// action + focus + heading + plain
	const line4 =
		"**Cache Strategy**: We should debounce updates in the pipeline while maintaining zero-latency throughput so every panel stays responsive during streaming.";
	const spans4 = analyzeThinkingLineLocal(line4);
	assert.equal(spans4.map((s) => s.text).join(""), line4);
	assert.ok(
		spans4.some((s) => s.role === "heading" && s.text === "**Cache Strategy**"),
		JSON.stringify(spans4),
	);
	assert.ok(spans4.some((s) => s.role === "action"), JSON.stringify(spans4));
	assert.ok(spans4.some((s) => s.role === "focus"), JSON.stringify(spans4));
	assert.ok(spans4.some((s) => s.role === "plain"), JSON.stringify(spans4));
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
		path: (t) => `[PA:${t}]`,
		symbol: (t) => `[S:${t}]`,
		command: (t) => `[C:${t}]`,
		metric: (t) => `[M:${t}]`,
		focus: (t) => `[F:${t}]`,
		action: (t) => `[A:${t}]`,
		pivot: (t) => `[P:${t}]`,
		risk: (t) => `[R:${t}]`,
		question: (t) => `[Q:${t}]`,
	};
	const spans: ThinkingSpan[] = [
		{ role: "heading", text: "**Plan**" },
		{ role: "plain", text: " " },
		{ role: "pivot", text: "Wait" },
		{ role: "plain", text: " " },
		{ role: "path", text: "split-view.ts" },
		{ role: "plain", text: " " },
		{ role: "symbol", text: "root.files" },
		{ role: "plain", text: " " },
		{ role: "command", text: "/split-save" },
		{ role: "plain", text: " " },
		{ role: "metric", text: "2.3ms" },
		{ role: "plain", text: " " },
		{ role: "focus", text: "named slots" },
		{ role: "plain", text: " " },
		{ role: "action", text: "restore it" },
		{ role: "plain", text: " " },
		{ role: "risk", text: "regression" },
		{ role: "plain", text: " " },
		{ role: "question", text: "maybe" },
	];
	assert.equal(
		renderThinkingSpans(spans, palette),
		"[H:**Plan**] [P:Wait] [PA:split-view.ts] [S:root.files] [C:/split-save] [M:2.3ms] [F:named slots] [A:restore it] [R:regression] [Q:maybe]",
	);
});

test("buildAiRefinementPayload produces compact JSON with line and non-plain localDraft entries", () => {
	const line =
		"Wait, normalizeConfig in ui-panels-config.ts silently ignores root.files when the dock slot is missing after /split-save runs on disk.";
	const localSpans = analyzeThinkingLineLocal(line);
	const raw = buildAiRefinementPayload(line, localSpans);
	const parsed = JSON.parse(raw) as {
		line: string;
		localDraft: Array<{ phrase: string; role: string }>;
	};

	assert.equal(parsed.line, line);
	assert.ok(Array.isArray(parsed.localDraft) && parsed.localDraft.length >= 4);
	assert.ok(parsed.localDraft.every((d) => d.role !== "plain"));
	assert.ok(parsed.localDraft.some((d) => d.phrase === "Wait" && d.role === "pivot"));
	assert.ok(
		parsed.localDraft.some((d) => d.phrase === "ui-panels-config.ts" && d.role === "path"),
	);
	assert.ok(parsed.localDraft.some((d) => d.phrase === "root.files" && d.role === "symbol"));
	assert.ok(parsed.localDraft.some((d) => d.phrase === "/split-save" && d.role === "command"));
});

test("applyAiSpansOverLine merges AI spans with local anchors, enforces <=5 word cap and <=32% density, lossless round-trip", () => {
	const line =
		"Wait, calling comp.setExpanded(true) in split-view.ts via /split-save permanently mutates shared state, so we must save prevExpanded and restore it after painting each frame.";
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
	// Local symbol, path, command & pivot anchors merged where non-overlapping
	assert.ok(
		spans.some((s) => s.role === "symbol" && s.text === "comp.setExpanded(true)"),
		`local balanced symbol should be merged: ${JSON.stringify(spans)}`,
	);
	assert.ok(
		spans.some((s) => s.role === "path" && s.text === "split-view.ts"),
		`local path should be merged: ${JSON.stringify(spans)}`,
	);
	assert.ok(
		spans.some((s) => s.role === "command" && s.text === "/split-save"),
		`local command should be merged: ${JSON.stringify(spans)}`,
	);
	assert.ok(
		spans.some((s) => s.role === "pivot" && s.text === "Wait"),
		`local pivot should be merged: ${JSON.stringify(spans)}`,
	);

	// Density cap bounded
	const density = highlightedWordDensity(line, spans);
	assert.ok(
		density <= 0.45,
		`expected bounded density, got ${(density * 100).toFixed(1)}%`,
	);

	// ANSI passthrough
	const ansi = "\x1b[32mok\x1b[0m";
	assert.deepEqual(applyAiSpansOverLine(ansi, [{ phrase: "ok", role: "focus" }]), [
		{ role: "plain", text: ansi },
	]);
});

test("applyAiSpansOverLine supports all 9 AiThinkingRole values", () => {
	const roles: AiThinkingRole[] = [
		"focus",
		"action",
		"pivot",
		"risk",
		"question",
		"metric",
		"path",
		"symbol",
		"command",
	];
	for (const role of roles) {
		const line = `Testing role ${role} inside a sufficiently long sentence with extra filler words so the density budget allows matching cleanly.`;
		const spans = applyAiSpansOverLine(line, [{ phrase: `role ${role}`, role }]);
		assert.equal(spans.map((s) => s.text).join(""), line);
		assert.ok(
			spans.some((s) => s.role === role && s.text === `role ${role}`),
			`expected role ${role} to be applied: ${JSON.stringify(spans)}`,
		);
	}
});

test("parseAiSpansResponse handles raw JSON, fenced JSON, all 9 roles, and rejects invalid items", () => {
	const fenced = [
		"```json",
		'[{"phrase":"root.files","role":"symbol"},{"phrase":"this phrase has way too many words here","role":"action"},{"phrase":"breaks","role":"risk"},{"phrase":"2.3ms","role":"metric"},{"phrase":"maybe","role":"question"},{"phrase":"bad","role":"unknown"}]',
		"```",
	].join("\n");
	assert.deepEqual(parseAiSpansResponse(fenced), [
		{ phrase: "root.files", role: "symbol" },
		{ phrase: "breaks", role: "risk" },
		{ phrase: "2.3ms", role: "metric" },
		{ phrase: "maybe", role: "question" },
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

test("analyzeThinkingLineLocal stays linear on slash-heavy adversarial input", () => {
	const input = "a/".repeat(2500) + "!";
	const t0 = performance.now();
	const spans = analyzeThinkingLineLocal(input);
	const elapsedMs = performance.now() - t0;
	assert.equal(spans.map((s) => s.text).join(""), input);
	assert.ok(elapsedMs < 100, `expected <100ms on 5k slash-heavy line, got ${elapsedMs.toFixed(1)}ms`);
});

test("applyAiSpansOverLine falls back cleanly to Tier 1 when AI returns no matching spans", () => {
	const line = "Wait, calling comp.setExpanded(true) permanently mutates shared state.";
	const local = analyzeThinkingLineLocal(line);
	assert.deepEqual(applyAiSpansOverLine(line, []), local);
	assert.deepEqual(
		applyAiSpansOverLine(line, [{ phrase: "nonexistent phrase", role: "focus" }]),
		local,
	);
});
