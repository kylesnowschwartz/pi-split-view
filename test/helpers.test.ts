import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import * as path from "node:path";
import {
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
	styleThinkingLine,
	thoughtsSinceLastUser,
	tokenizeThinkingLine,
	toolsPagerButtons,
	truncateInline,
	alignTurnSpans,
	computeDrawerHeights,
	drawerBarLayout,
	toolHudBadge,
	visibleTurnsInViewport,
	type ThinkingPalette,
	type TurnSpan,
} from "../helpers.ts";
import { normalizeConfig } from "../ui-panels-config.ts";

test("truncateInline collapses whitespace and never splits a surrogate pair", () => {
	assert.equal(truncateInline("  a\n  b\tc  "), "a b c");
	assert.equal(truncateInline("abcdefghij", 5), "abcd…");
	// "abc😀…": the cut would land between the emoji's surrogates → drop it.
	const out = truncateInline("abc😀defgh", 5);
	assert.equal(out, "abc…");
});

test("capToolText keeps the newest suffix with a marker, within the cap", () => {
	assert.equal(capToolText("short", 100), "short");
	const s = "x".repeat(500) + "TAIL";
	const out = capToolText(s, 100);
	assert.ok(out.length <= 100);
	assert.ok(out.startsWith("[truncated: newest 100 of 504 chars]\n"));
	assert.ok(out.endsWith("TAIL"));
	// Never starts the kept suffix on a lone low surrogate.
	const emoji = "😀".repeat(200);
	const e = capToolText(emoji, 101).split("\n")[1];
	assert.ok(e.length % 2 === 0 && e.startsWith("😀"));
});

test("formatDuration", () => {
	assert.equal(formatDuration(420), "0.4s");
	assert.equal(formatDuration(2345), "2.3s");
	assert.equal(formatDuration(42_900), "42s");
	assert.equal(formatDuration(185_000), "3m05s");
	assert.equal(formatDuration(3_720_000), "1h02m");
	assert.equal(formatDuration(2345, true), "2s");
	assert.equal(formatDuration(-5), "0.0s");
});

test("appendStreamTail splits lines before capping (no lost lines)", () => {
	const lines: string[] = [];
	let tail = appendStreamTail(lines, "", "ab", 10);
	tail = appendStreamTail(lines, tail, "c\r\nline2\n" + "y".repeat(30) + "\nend", 10);
	assert.deepEqual(lines, ["abc", "line2", "y".repeat(30)]);
	assert.equal(tail, "end");
});

test("appendStreamTail drops the older half on overflow, not a sliding window", () => {
	const lines: string[] = [];
	let tail = "";
	const seen = new Set<number>();
	for (let i = 0; i < 100; i++) {
		tail = appendStreamTail(lines, tail, "abcdefghij", 40);
		seen.add(tail.length);
		assert.ok(tail.length <= 40);
	}
	assert.equal(lines.length, 0);
	// Start index changes only when the tail overflows (halves), so lengths
	// cycle 20..40 instead of pinning at 40 (which would slide every delta).
	assert.ok(seen.has(30) && seen.has(40));
});

test("capDisplayLine keeps the newest chars with an ellipsis", () => {
	assert.equal(capDisplayLine("short", 10), "short");
	assert.equal(capDisplayLine("0123456789abc", 8), "… 789abc"); // 8 units total
});

test("normalizeConfig: a non-object root reads as an empty config", () => {
	assert.deepEqual(normalizeConfig(null as never), normalizeConfig({}));
	assert.deepEqual(normalizeConfig([] as never), normalizeConfig({}));
	assert.deepEqual(normalizeConfig("x" as never), normalizeConfig({}));
});

test("normalizeConfig: thinkingScope is a strict turn|session read", () => {
	assert.equal(normalizeConfig({}).thinkingScope, "session");
	assert.equal(normalizeConfig({ thinkingScope: "session" }).thinkingScope, "session");
	assert.equal(normalizeConfig({ thinkingScope: "turn" }).thinkingScope, "turn");
	// Anything that is not the literal "turn" must fall back to the default.
	assert.equal(normalizeConfig({ thinkingScope: "all" as never }).thinkingScope, "session");
	assert.equal(normalizeConfig({ thinkingScope: true as never }).thinkingScope, "session");
	assert.equal(normalizeConfig(null as never).thinkingScope, "session");
});

test("thoughtsSinceLastUser keeps only the reasoning after the last user turn", () => {
	assert.deepEqual(
		thoughtsSinceLastUser([
			{ isUser: true, thoughts: [] },
			{ isUser: false, thoughts: ["a1", "a2"] },
			{ isUser: true, thoughts: [] },
			{ isUser: false, thoughts: ["b1"] },
		]),
		["b1"],
	);
	// No user message yet: the whole sequence counts as one turn.
	assert.deepEqual(thoughtsSinceLastUser([{ isUser: false, thoughts: ["only"] }]), ["only"]);
	// A trailing user message that has not been answered yet leaves it empty.
	assert.deepEqual(
		thoughtsSinceLastUser([
			{ isUser: false, thoughts: ["old"] },
			{ isUser: true, thoughts: [] },
		]),
		[],
	);
	assert.deepEqual(thoughtsSinceLastUser([]), []);
});

test("lastImageBlock returns the last well-formed image block", () => {
	// String content (plain-text results) has no image.
	assert.equal(lastImageBlock("plain text"), undefined);
	assert.equal(lastImageBlock(undefined), undefined);
	assert.equal(lastImageBlock({}), undefined);
	// Text-only block list.
	assert.equal(lastImageBlock([{ type: "text", text: "hi" }]), undefined);
	// A read-on-image result: text note + image block.
	const readResult = [
		{ type: "text", text: "Read image file [image/png]" },
		{ type: "image", data: "aGk=", mimeType: "image/png" },
	];
	assert.deepEqual(lastImageBlock(readResult), {
		data: "aGk=",
		mimeType: "image/png",
	});
	// Malformed blocks (missing/non-string data or mimeType) are skipped.
	assert.equal(
		lastImageBlock([
			{ type: "image", data: "aGk=" },
			{ type: "image", mimeType: "image/png" },
		]),
		undefined,
	);
	// The LAST image block wins when several are present.
	const multi = [
		{ type: "image", data: "MQ==", mimeType: "image/png" },
		{ type: "image", data: "Mg==", mimeType: "image/jpeg" },
	];
	assert.deepEqual(lastImageBlock(multi), { data: "Mg==", mimeType: "image/jpeg" });
});

test("liveTailLines keeps indentation, blanks and the newest lines", () => {
	assert.deepEqual(liveTailLines("a\n  b\n\nc\n\n", 10), { lines: ["a", "  b", "", "c"], hidden: 0 });
	assert.deepEqual(liveTailLines("1\n2\n3\n4", 2), { lines: ["3", "4"], hidden: 2 });
	assert.deepEqual(liveTailLines("", 5), { lines: [], hidden: 0 });
});

test("liveTailLines sanitises escapes, carriage returns and tabs", () => {
	// Colours and OSC hyperlinks are dropped; a CRLF ending is harmless.
	assert.deepEqual(
		liveTailLines("\x1b[31mred\x1b[0m\r\n\x1b]8;;http://x\x07link\x1b]8;;\x07", 5).lines,
		["red", "link"],
	);
	// Progress bar redraws: only the text after the last \r stays.
	assert.deepEqual(liveTailLines("10%\r50%\r100%", 5).lines, ["100%"]);
	// Tabs expand to 8-column stops; other control chars vanish.
	assert.deepEqual(liveTailLines("a\tb\x07", 5).lines, ["a       b"]);
});

test("keepsInResponseOnly drops tool calls and text-less assistant messages only", () => {
	const child = (name: string, lastMessage?: { content?: unknown }) => ({
		constructor: { name },
		lastMessage,
	});
	assert.equal(keepsInResponseOnly(child("ToolExecutionComponent")), false);
	assert.equal(keepsInResponseOnly(child("UserMessageComponent")), true);
	assert.equal(keepsInResponseOnly(child("CustomEntryComponent")), true);
	assert.equal(keepsInResponseOnly(child("Spacer")), true);
	const text = { type: "text", text: "Done." };
	const thinking = { type: "thinking", thinking: "hm" };
	const call = { type: "toolCall", name: "bash" };
	assert.equal(
		keepsInResponseOnly(child("AssistantMessageComponent", { content: [thinking, text] })),
		true,
	);
	assert.equal(
		keepsInResponseOnly(child("AssistantMessageComponent", { content: [thinking, call] })),
		false,
	);
	assert.equal(
		keepsInResponseOnly(
			child("AssistantMessageComponent", { content: [{ type: "text", text: "  " }] }),
		),
		false,
	);
	// Still streaming, with no message yet: kept, it draws nothing.
	assert.equal(keepsInResponseOnly(child("AssistantMessageComponent")), true);
});

test("isInternalNotificationText matches task-notification and progress-warning XML only", () => {
	assert.equal(
		isInternalNotificationText("<task-notification>\n<task-id>1</task-id>\n</task-notification>"),
		true,
	);
	assert.equal(
		isInternalNotificationText("  \n\t<progress-warning>\n<summary>x</summary>\n</progress-warning>"),
		true,
	);
	assert.equal(isInternalNotificationText("Please inspect <task-notification> rendering"), false);
	assert.equal(isInternalNotificationText("normal user message"), false);
	assert.equal(isInternalNotificationText(""), false);
});

test("keepsInResponseOnly drops internal notification user components while keeping normal user messages", () => {
	const user = (text?: unknown) => ({
		constructor: { name: "UserMessageComponent" },
		text,
	});
	assert.equal(
		keepsInResponseOnly(user("<task-notification>\n<status>completed</status>\n</task-notification>")),
		false,
	);
	assert.equal(
		keepsInResponseOnly(user("  <progress-warning>\n<summary>work</summary>\n</progress-warning>")),
		false,
	);
	assert.equal(keepsInResponseOnly(user("Explain <task-notification>")), true);
	assert.equal(keepsInResponseOnly(user("Hello")), true);
	assert.equal(keepsInResponseOnly(user(undefined)), true);
});

test("normalizeConfig reads responseSource strictly", () => {
	assert.equal(normalizeConfig({}).responseSource, "messages");
	assert.equal(normalizeConfig({ responseSource: "transcript" }).responseSource, "transcript");
	assert.equal(normalizeConfig({ responseSource: "other" as any }).responseSource, "messages");
});

test("normalizeConfig: drawers keeps only well-typed open and height per drawer", () => {
	assert.deepEqual(normalizeConfig({}).drawers, {});
	assert.deepEqual(normalizeConfig({ drawers: "bad" as any }).drawers, {});
	assert.deepEqual(normalizeConfig({ drawers: [] as any }).drawers, {});
	assert.deepEqual(
		normalizeConfig({
			drawers: {
				thinking: { open: true, height: 12 },
				tools: { open: false, height: 14 },
			},
		}).drawers,
		{
			thinking: { open: true, height: 12 },
			tools: { open: false, height: 14 },
		},
	);
	assert.deepEqual(
		normalizeConfig({
			drawers: {
				thinking: { open: "yes", height: "12" },
				tools: { height: 9 },
				other: { open: true },
			} as any,
		}).drawers,
		{ thinking: {}, tools: { height: 9 } },
	);
});

test("normalizeConfig ignores keys it does not know", () => {
	const withExtras = normalizeConfig({
		toolMode: "full",
		slots: { main: "messages" },
		layoutMode: "drawers",
		layouts: { drawers: { thinking: { open: true } } },
		thinkingHud: false,
		bandHeight: 13,
	} as any);
	assert.deepEqual(withExtras, normalizeConfig({ toolMode: "full" }));
});

test("formatToolArgSummary formats read, edit, bash, grep, Agent, generic JSON, and non-JSON", () => {
	const home = homedir();
	// read: path (homedir shortened) + offset/limit
	assert.equal(
		formatToolArgSummary("read", JSON.stringify({ path: path.join(home, "proj/a.ts") })),
		"~/proj/a.ts",
	);
	assert.equal(
		formatToolArgSummary("read", JSON.stringify({ path: "src/app.ts", offset: 10, limit: 25 })),
		"src/app.ts:10-34",
	);
	assert.equal(
		formatToolArgSummary("read", JSON.stringify({ path: "src/app.ts", offset: 50 })),
		"src/app.ts:50",
	);
	assert.equal(
		formatToolArgSummary("read", JSON.stringify({ path: "src/app.ts", limit: 20 })),
		"src/app.ts (limit 20)",
	);
	// edit & write
	assert.equal(
		formatToolArgSummary("edit", JSON.stringify({ path: "split-view.ts", edits: [] })),
		"split-view.ts",
	);
	// bash: collapsed to one line
	assert.equal(
		formatToolArgSummary("bash", JSON.stringify({ command: "git status\n&& npm test" })),
		"git status && npm test",
	);
	// grep / find / ls
	assert.equal(
		formatToolArgSummary("grep", JSON.stringify({ pattern: "RichToolsBody", path: "src/" })),
		"RichToolsBody src/",
	);
	assert.equal(
		formatToolArgSummary("grep", JSON.stringify({ pattern: "TODO" })),
		"TODO",
	);
	// Agent: single description & tasks array
	assert.equal(
		formatToolArgSummary("Agent", JSON.stringify({ description: "Explore codebase" })),
		"Explore codebase",
	);
	assert.equal(
		formatToolArgSummary("Agent", JSON.stringify({ tasks: [{ id: 1 }, { id: 2 }, { id: 3 }] })),
		"3 tasks",
	);
	assert.equal(
		formatToolArgSummary("Agent", JSON.stringify({ tasks: [{ id: 1 }] })),
		"1 task",
	);
	// Generic JSON object: key=val pairs
	assert.equal(
		formatToolArgSummary("custom_tool", JSON.stringify({ query: "hello", limit: 5, exact: true })),
		"query=hello limit=5 exact=true",
	);
	// Empty JSON object
	assert.equal(formatToolArgSummary("custom_tool", "{}"), "");
	// Non-JSON string falls back to truncateInline
	assert.equal(formatToolArgSummary("bash", "  not   valid\njson  ", 12), "not valid j…");
});

test("stripLeadingTrailingBlankLines trims blank and ANSI-only-whitespace lines", () => {
	assert.deepEqual(
		stripLeadingTrailingBlankLines([
			"",
			"   ",
			"\x1b[32m   \x1b[0m",
			"\x1b[1mhello\x1b[0m",
			"",
			"world",
			"\x1b[0m  \t ",
			"",
		]),
		["\x1b[1mhello\x1b[0m", "", "world"],
	);
	// All blank → empty array
	assert.deepEqual(stripLeadingTrailingBlankLines(["", "\x1b[31m  \x1b[0m"]), []);
	// Preserves Kitty/iTerm2 image escape lines as non-blank
	const kitty = "\x1b_Ga=T,f=100;AAAA\x1b\\";
	assert.deepEqual(stripLeadingTrailingBlankLines(["", kitty, ""]), [kitty]);
});

test("isToolExpanded resolves precedence: override > zoom > global > default", () => {
	const empty = new Map<string, boolean>();
	const active = { id: "t1", active: true, isError: false };
	const errored = { id: "t2", active: false, isError: true };
	const clean = { id: "t3", active: false, isError: false };

	// Default (globalOverride = null, not zoomed): only active expands; completed/errored collapse.
	assert.equal(isToolExpanded(active, empty, null), true);
	assert.equal(isToolExpanded(errored, empty, null), false);
	assert.equal(isToolExpanded(clean, empty, null), false);

	// Global "all" expands even clean completed tools.
	assert.equal(isToolExpanded(clean, empty, "all"), true);
	assert.equal(isToolExpanded(active, empty, "all"), true);

	// Global "none" collapses even active & errored tools.
	assert.equal(isToolExpanded(active, empty, "none"), false);
	assert.equal(isToolExpanded(errored, empty, "none"), false);
	assert.equal(isToolExpanded(clean, empty, "none"), false);

	// zoomedTools expands everything (including when globalOverride === "none").
	assert.equal(isToolExpanded(clean, empty, null, true), true);
	assert.equal(isToolExpanded(clean, empty, "none", true), true);

	// Per-tool override beats default, global, AND zoomedTools.
	const overrides = new Map<string, boolean>([
		["t1", false],
		["t3", true],
	]);
	assert.equal(isToolExpanded(active, overrides, null), false);
	assert.equal(isToolExpanded(active, overrides, "all", true), false);
	assert.equal(isToolExpanded(clean, overrides, null), true);
	assert.equal(isToolExpanded(clean, overrides, "none"), true);
});

test("tokenizeThinkingLine highlights semantic cues with lossless round-trip", () => {
	const samples = [
		"**Step 1**: Wait, check `foo()` in split-view.ts and src/a/b.ts (v1.5.0).",
		"Maybe there is a bug or error in ~/.pi/agent/ui-panels.json; let's plan to refactor via bash and Agent.",
		"Actually, the tests passed — verified with evidence using read and edit on package.json.",
		"See https://example.com/error/test.ts for version 1.5.0 and agent notes.",
		"Plain prose without any special cues at all.",
		"",
	];
	for (const line of samples) {
		const tokens = tokenizeThinkingLine(line);
		assert.equal(
			tokens.map((t) => t.text).join(""),
			line,
			`lossless round-trip failed for: ${line}`,
		);
		for (let i = 1; i < tokens.length; i++) {
			assert.notEqual(
				tokens[i - 1]!.kind === "plain" && tokens[i]!.kind === "plain",
				true,
				`adjacent plain tokens were not merged in: ${line}`,
			);
		}
	}

	// Headings, inline code, and paths take priority over inner keywords.
	assert.deepEqual(
		tokenizeThinkingLine("**Plan next** and `check()` in split-view.ts and src/a/b.ts"),
		[
			{ kind: "heading", text: "**Plan next**" },
			{ kind: "plain", text: " and " },
			{ kind: "code", text: "`check()`" },
			{ kind: "plain", text: " in " },
			{ kind: "path", text: "split-view.ts" },
			{ kind: "plain", text: " and " },
			{ kind: "path", text: "src/a/b.ts" },
		],
	);

	// Version numbers and bare URLs are NOT matched as paths or inner keywords.
	assert.deepEqual(
		tokenizeThinkingLine("Release 1.5.0 at https://example.com/error/foo.ts stays plain"),
		[{ kind: "plain", text: "Release 1.5.0 at https://example.com/error/foo.ts stays plain" }],
	);

	// All semantic categories: error, caution, verify, plan, hypothesis, tool.
	assert.deepEqual(
		tokenizeThinkingLine("Bug wait verify plan maybe bash Agent agent"),
		[
			{ kind: "error", text: "Bug" },
			{ kind: "plain", text: " " },
			{ kind: "caution", text: "wait" },
			{ kind: "plain", text: " " },
			{ kind: "verify", text: "verify" },
			{ kind: "plain", text: " " },
			{ kind: "plan", text: "plan" },
			{ kind: "plain", text: " " },
			{ kind: "hypothesis", text: "maybe" },
			{ kind: "plain", text: " " },
			{ kind: "tool", text: "bash" },
			{ kind: "plain", text: " " },
			{ kind: "tool", text: "Agent" },
			{ kind: "plain", text: " agent" },
		],
	);

	// ANSI passthrough: pre-styled divider returns a single plain token untouched.
	const ansiDivider = "\x1b[2m──────────\x1b[22m";
	assert.deepEqual(tokenizeThinkingLine(ansiDivider), [
		{ kind: "plain", text: ansiDivider },
	]);
});

test("styleThinkingLine maps each token kind through the palette", () => {
	const palette: ThinkingPalette = {
		plain: (t) => t,
		heading: (t) => `<H:${t}>`,
		code: (t) => `<C:${t}>`,
		path: (t) => `<P:${t}>`,
		tool: (t) => `<T:${t}>`,
		error: (t) => `<E:${t}>`,
		caution: (t) => `<W:${t}>`,
		verify: (t) => `<V:${t}>`,
		plan: (t) => `<PL:${t}>`,
		hypothesis: (t) => `<HY:${t}>`,
	};
	assert.equal(
		styleThinkingLine("**Goal**: wait, check `fn()` in helpers.ts via read (bug? maybe)", palette),
		"<H:**Goal**>: <W:wait>, <V:check> <C:`fn()`> in <P:helpers.ts> via <T:read> (<E:bug>? <HY:maybe>)",
	);
});

test("pickThinkingHeadline skips generic filler openers when a signal line follows", () => {
	assert.equal(
		pickThinkingHeadline([
			"",
			"Let me check the files.",
			"Inspecting layout-drawers.ts for the drag threshold.",
		]),
		"Inspecting layout-drawers.ts for the drag threshold.",
	);
	assert.equal(
		pickThinkingHeadline(["Fixing `alignTurnSpans` across compaction boundary"]),
		"Fixing `alignTurnSpans` across compaction boundary",
	);
	assert.equal(
		pickThinkingHeadline(["Let me think about this carefully."]),
		"Let me think about this carefully.",
	);
	assert.equal(pickThinkingHeadline(["", "   "]), "");
	assert.equal(normalizeConfig({}).thinkingMode, "compact");
	assert.equal(normalizeConfig({ thinkingMode: "full" }).thinkingMode, "full");
	assert.equal(normalizeConfig({ thinkingMode: "bogus" as any }).thinkingMode, "compact");
	assert.deepEqual(
		pickThinkingSummary([
			"**Constructing Wave 2 Features**",
			"",
			"Adding drawers-below and compact thinking cards.",
			"Next step is testing.",
		]),
		{
			title: "Constructing Wave 2 Features",
			body: "Adding drawers-below and compact thinking cards. Next step is testing.",
		},
	);
	assert.deepEqual(
		pickThinkingSummary(["## Checking Alignment", "Inspecting layout-drawers.ts"]),
		{
			title: "Checking Alignment",
			body: "Inspecting layout-drawers.ts",
		},
	);
	assert.deepEqual(
		pickThinkingSummary(["Let me check.", "Inspecting layout-drawers.ts now."]),
		{
			title: "",
			body: "Inspecting layout-drawers.ts now.",
		},
	);
});

test("toolHudBadge maps core tools to compact 1-cell Nerd Font glyphs and custom tools with names", () => {
	const bash = toolHudBadge("bash", false);
	assert.equal(bash.icon, "\u{F0BE0}");
	assert.equal(bash.showName, false);
	assert.ok(bash.ansiColor.includes("166;227;161"));

	const edit = toolHudBadge("Edit", false);
	assert.equal(edit.icon, "\uEE75");
	assert.equal(edit.showName, false);

	const read = toolHudBadge("read", true);
	assert.equal(read.icon, "\uE28B");
	assert.equal(read.showName, false);
	assert.ok(read.ansiColor.includes("30;102;245"));

	const agent = toolHudBadge("Agent", false);
	assert.equal(agent.icon, "\u{F167A}");
	assert.equal(agent.showName, false);

	const mcp = toolHudBadge("mcp_linear_search", false);
	assert.equal(mcp.icon, "\u{F059F}");
	assert.equal(mcp.showName, true);
});

test("computeDrawerHeights clamps open drawers proportionally and preserves Messages/editor budget", () => {
	// Plenty of room: exact requested heights.
	assert.deepEqual(
		computeDrawerHeights(45, { open: true, height: 10 }, { open: true, height: 14 }),
		{ thinking: 10, tools: 14 },
	);
	// Collapsed drawers always take 1 row.
	assert.deepEqual(
		computeDrawerHeights(45, { open: false, height: 10 }, { open: false, height: 14 }),
		{ thinking: 1, tools: 1 },
	);
	// Tight terminal (28 rows -> budget 16): shrinks proportionally, sums to 16.
	const tight = computeDrawerHeights(
		28,
		{ open: true, height: 12 },
		{ open: true, height: 18 },
	);
	assert.equal(tight.thinking + tight.tools, 16);
	assert.ok(tight.thinking >= 5 && tight.tools >= 5);
	// Single open drawer on tight terminal leaves 1 row for the collapsed sibling.
	const single = computeDrawerHeights(
		22,
		{ open: false, height: 10 },
		{ open: true, height: 20 },
	);
	assert.deepEqual(single, { thinking: 1, tools: 9 });
});

test("drawerBarLayout computes exact non-overlapping hit spans for buttons and collapsed pager", () => {
	const wide = drawerBarLayout(100, {
		showPager: true,
		pagerLabel: "Turn 3/8",
		pagerToggleText: "[All]",
		leftToggleCols: 12,
	});
	assert.equal(wide.showButtons, true);
	assert.deepEqual(wide.leftToggle, { start: 1, end: 13 });
	assert.deepEqual(wide.zoom, { start: 93, end: 96 });
	assert.deepEqual(wide.toggle, { start: 96, end: 99 });
	assert.ok(wide.pager !== null);
	assert.equal(wide.pager.prev.end - wide.pager.prev.start, 3);
	assert.equal(wide.pager.next.end - wide.pager.next.start, 3);
	assert.equal(wide.pager.toggle.end - wide.pager.toggle.start, 5);
	// Pager ends 1 border char before zoom button.
	assert.equal(wide.pager.toggle.end + 1, wide.zoom!.start);
	// Narrow terminal omits pager gracefully while keeping zoom/toggle buttons.
	const narrow = drawerBarLayout(36, {
		showPager: true,
		pagerLabel: "Turn 3/8",
		pagerToggleText: "[All]",
	});
	assert.equal(narrow.showButtons, true);
	assert.equal(narrow.pager, null);
	// Very narrow omits buttons too.
	const tiny = drawerBarLayout(14, { showPager: false });
	assert.equal(tiny.showButtons, false);
	assert.equal(tiny.zoom, null);
	assert.equal(tiny.toggle, null);
});

test("alignTurnSpans aligns post-compaction spans in both directions", () => {
	const raw = [
		{ turn: 1, startRow: 10, endRow: 25 },
		{ turn: 2, startRow: 25, endRow: 40 },
	];
	assert.deepEqual(alignTurnSpans(raw, 2), raw);
	// Fewer rendered spans than totalTurns: right-align.
	assert.deepEqual(alignTurnSpans(raw, 15), [
		{ turn: 14, startRow: 10, endRow: 25 },
		{ turn: 15, startRow: 25, endRow: 40 },
	]);
	// More rendered spans than totalTurns (live compaction before reload): keep trailing totalTurns renumbered 1..totalTurns.
	const preAndPost = [
		{ turn: 1, startRow: 0, endRow: 10 },
		{ turn: 2, startRow: 10, endRow: 20 },
		{ turn: 3, startRow: 20, endRow: 30 },
		{ turn: 4, startRow: 30, endRow: 45 },
	];
	assert.deepEqual(alignTurnSpans(preAndPost, 2), [
		{ turn: 1, startRow: 20, endRow: 30 },
		{ turn: 2, startRow: 30, endRow: 45 },
	]);
	assert.deepEqual(alignTurnSpans([], 15), []);
});

test("visibleTurnsInViewport handles single, multiple, out-of-range, and empty spans", () => {
	assert.deepEqual(visibleTurnsInViewport([], 0, 20), []);

	const spans: TurnSpan[] = [
		{ turn: 1, startRow: 10, endRow: 25 },
		{ turn: 2, startRow: 25, endRow: 45 },
		{ turn: 3, startRow: 45, endRow: 60 },
	];

	// Single visible turn
	assert.deepEqual(visibleTurnsInViewport(spans, 12, 10), [1]);
	assert.deepEqual(visibleTurnsInViewport(spans, 25, 20), [2]);

	// Multiple visible turns (overlapping boundary)
	assert.deepEqual(visibleTurnsInViewport(spans, 20, 10), [1, 2]);
	assert.deepEqual(visibleTurnsInViewport(spans, 20, 30), [1, 2, 3]);

	// Scroll before first span (e.g. startup header rows 0..9)
	assert.deepEqual(visibleTurnsInViewport(spans, 0, 5), [1]);

	// Scroll past last span
	assert.deepEqual(visibleTurnsInViewport(spans, 70, 10), [3]);

	// Zero/negative viewport height clamps to 1 row
	assert.deepEqual(visibleTurnsInViewport(spans, 25, 0), [2]);
});

test("selectActiveTurns handles all, pinnedTurn clamping, visible filtering, and fallback", () => {
	// scope === "all" with no pin -> null (show all)
	assert.equal(
		selectActiveTurns({
			scope: "all",
			totalTurns: 5,
			pinnedTurn: null,
			visibleTurns: [2, 3],
		}),
		null,
	);

	// totalTurns <= 0 -> []
	assert.deepEqual(
		selectActiveTurns({
			scope: "visible",
			totalTurns: 0,
			pinnedTurn: null,
			visibleTurns: [1],
		}),
		[],
	);

	// pinnedTurn overrides both "visible" and "all" and clamps to [1, totalTurns]
	assert.deepEqual(
		selectActiveTurns({
			scope: "all",
			totalTurns: 5,
			pinnedTurn: 3,
			visibleTurns: [1, 2],
		}),
		[3],
	);
	assert.deepEqual(
		selectActiveTurns({
			scope: "visible",
			totalTurns: 5,
			pinnedTurn: 0,
			visibleTurns: [2],
		}),
		[1],
	);
	assert.deepEqual(
		selectActiveTurns({
			scope: "visible",
			totalTurns: 5,
			pinnedTurn: 99,
			visibleTurns: [2],
		}),
		[5],
	);

	// scope === "visible" filters invalid turns, deduplicates, and sorts ascending
	assert.deepEqual(
		selectActiveTurns({
			scope: "visible",
			totalTurns: 5,
			pinnedTurn: null,
			visibleTurns: [4, 2, 4, 0, 9],
		}),
		[2, 4],
	);

	// Fallback to latest turn when visibleTurns is empty or all invalid, or scope === "turn"
	assert.deepEqual(
		selectActiveTurns({
			scope: "visible",
			totalTurns: 5,
			pinnedTurn: null,
			visibleTurns: [],
		}),
		[5],
	);
	assert.deepEqual(
		selectActiveTurns({
			scope: "visible",
			totalTurns: 5,
			pinnedTurn: null,
			visibleTurns: [0, 8],
		}),
		[5],
	);
	assert.deepEqual(
		selectActiveTurns({
			scope: "turn",
			totalTurns: 5,
			pinnedTurn: null,
			visibleTurns: [1, 2],
		}),
		[5],
	);
});

test("toolsPagerButtons computes exact non-overlapping column ranges", () => {
	assert.equal(toolsPagerButtons(29, "Turn 1/3", "visible", false), null);

	const withLive = toolsPagerButtons(40, "Turn 3/5", "visible", true);
	assert.ok(withLive);
	assert.deepEqual(withLive.prev, { start: 2, end: 5 });
	assert.deepEqual(withLive.next, { start: 15, end: 18 });
	assert.deepEqual(withLive.toggle, { start: 19, end: 24, text: "[All]" });
	assert.equal(withLive.fillCols, 11); // 24 + 11 + 5 === 40

	const allNoLive = toolsPagerButtons(32, "All (5)", "all", false);
	assert.ok(allNoLive);
	assert.equal(allNoLive.toggle.text, "[Sync]");
	assert.equal(allNoLive.toggle.end + allNoLive.fillCols + 1, 32);
});

test("normalizeConfig handles toolsScope strictly with default visible", () => {
	assert.equal(normalizeConfig({}).toolsScope, "visible");
	assert.equal(normalizeConfig({ toolsScope: "visible" }).toolsScope, "visible");
	assert.equal(normalizeConfig({ toolsScope: "turn" }).toolsScope, "turn");
	assert.equal(normalizeConfig({ toolsScope: "all" }).toolsScope, "all");
	assert.equal(
		normalizeConfig({ toolsScope: "bogus" as any }).toolsScope,
		"visible",
	);
	assert.equal(
		normalizeConfig({ toolsScope: 123 as any }).toolsScope,
		"visible",
	);
	assert.equal(
		normalizeConfig({ toolsScope: null as any }).toolsScope,
		"visible",
	);
});



