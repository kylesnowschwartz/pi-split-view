import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	appendStreamTail,
	bashPathCandidates,
	bandToolsColsFor,
	capDisplayLine,
	capToolText,
	dockColsFor,
	filesPanelRowBudget,
	formatDuration,
	formatToolArgSummary,
	headTailPreview,
	isCappedToolText,
	isToolExpanded,
	keepsInResponseOnly,
	lastImageBlock,
	liveTailLines,
	outputPreview,
	stripLeadingTrailingBlankLines,
	styleThinkingLine,
	thoughtsSinceLastUser,
	tokenizeThinkingLine,
	truncateInline,
	type ThinkingPalette,
} from "../helpers.ts";
import {
	assignSlot,
	LAYOUT_PRESETS,
	normalizeConfig,
	type LayoutSlots,
	type PresetName,
} from "../ui-panels-config.ts";

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

test("bandToolsColsFor applies the ratio and minimum clamps", () => {
	assert.equal(bandToolsColsFor(200, 35), 70);
	assert.equal(bandToolsColsFor(60, 20), 20); // tools min 20
	assert.equal(bandToolsColsFor(50, 60), 26); // think min 24
	assert.equal(bandToolsColsFor(30, 50), 15); // both mins impossible → raw
});

test("dockColsFor: auto 25% clamped 34–48, manual clamped to the terminal", () => {
	assert.equal(dockColsFor(100), 34);
	assert.equal(dockColsFor(160), 40);
	assert.equal(dockColsFor(400), 48);
	assert.equal(dockColsFor(160, 70), 70);
	assert.equal(dockColsFor(160, 10), 24);
	assert.equal(dockColsFor(160, 150), 110); // keeps 50 cols for the left side
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

test("normalizeConfig: filesWidth is a validated optional number", () => {
	assert.equal(normalizeConfig({}).filesWidth, null);
	assert.equal(normalizeConfig({ filesWidth: 60 }).filesWidth, 60);
	assert.equal(normalizeConfig({ filesWidth: 10 }).filesWidth, null);
	assert.equal(normalizeConfig({ filesWidth: "60" as never }).filesWidth, null);
	assert.equal(normalizeConfig({ filesWidth: 999 }).filesWidth, 200);
	assert.equal(normalizeConfig(null as never).bandHeight, 20);
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

test("outputPreview shows the first `cap` lines and counts the hidden rest", () => {
	assert.deepEqual(outputPreview([], 2), { shown: [], hidden: 0 });
	assert.deepEqual(outputPreview(["a", "b"], 2), { shown: ["a", "b"], hidden: 0 });
	assert.deepEqual(outputPreview(["a", "b", "c"], 2), {
		shown: ["a", "b"],
		hidden: 1,
	});
	// cap 0 (compact mode) shows nothing but still counts the hidden lines.
	assert.deepEqual(outputPreview(["a", "b"], 0), { shown: [], hidden: 2 });
	// A cap larger than the list hides nothing.
	assert.deepEqual(outputPreview(["a"], 20), { shown: ["a"], hidden: 0 });
});

test("headTailPreview shows head, hidden count, and tail without duplication", () => {
	// Fits entirely: everything goes to head, tail stays empty (no dupes).
	assert.deepEqual(headTailPreview(["a", "b", "c"], 1, 2), {
		head: ["a", "b", "c"],
		hidden: 0,
		tail: [],
	});
	assert.deepEqual(headTailPreview([], 1, 2), { head: [], hidden: 0, tail: [] });
	// Longer than head+tail: first line, hidden middle count, last 2 lines.
	assert.deepEqual(headTailPreview(["a", "b", "c", "d", "e"], 1, 2), {
		head: ["a"],
		hidden: 2,
		tail: ["d", "e"],
	});
	// Exactly head+tail: still the whole list, nothing hidden.
	assert.deepEqual(headTailPreview(["a", "b", "c"], 1, 2), {
		head: ["a", "b", "c"],
		hidden: 0,
		tail: [],
	});
	// tail larger than the list: slice handles it, everything in head.
	assert.deepEqual(headTailPreview(["a", "b"], 1, 5), {
		head: ["a", "b"],
		hidden: 0,
		tail: [],
	});
});

test("headTailPreview counts hidden lines against the real total", () => {
	// A 20-line stored window of a 100-line output: hidden = 100 - 1 - 2.
	const win = Array.from({ length: 20 }, (_, i) => `l${81 + i}`);
	const r = headTailPreview(win, 1, 2, 100);
	assert.equal(r.hidden, 97);
	assert.deepEqual(r.tail, ["l99", "l100"]);
	// A total smaller than the list is ignored (never negative / undercounted).
	assert.equal(headTailPreview(["a", "b", "c", "d"], 1, 2, 1).hidden, 1);
	// Short window of a longer output: all shown, the rest counted.
	assert.deepEqual(headTailPreview(["a", "b"], 1, 2, 5), { head: ["a", "b"], hidden: 3, tail: [] });
});

test("isCappedToolText recognises capToolText's marker", () => {
	assert.equal(isCappedToolText(capToolText("x".repeat(100), 50)), true);
	assert.equal(isCappedToolText("plain output"), false);
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

test("normalizeConfig reads responseSource strictly", () => {
	assert.equal(normalizeConfig({}).responseSource, "messages");
	assert.equal(normalizeConfig({ responseSource: "transcript" }).responseSource, "transcript");
	assert.equal(normalizeConfig({ responseSource: "other" as any }).responseSource, "messages");
});

test("bashPathCandidates resolves words against the cd target and the home directory", () => {
	const paths = (command: string) => bashPathCandidates(command, "/work", "/home/me");
	assert.deepEqual(paths("cat src/a.ts"), ["/work/cat", "/work/src/a.ts"]);
	assert.ok(paths("cd pkg && head -30 CHANGELOG.md").includes("/work/pkg/CHANGELOG.md"));
	assert.ok(paths("cd ~/notes; cat todo.md").includes("/home/me/notes/todo.md"));
	assert.ok(paths("cat ~/.config/app.json").includes("/home/me/.config/app.json"));
	assert.ok(paths("cd /srv && cd logs && tail app.log | rg error").includes("/srv/logs/app.log"));
	assert.ok(paths("cd && cat x").includes("/home/me/x"));
	assert.ok(paths("cd - && cat x").includes("/work/x"));
});

test("bashPathCandidates gives loop and assigned variables their values", () => {
	const paths = (command: string) => bashPathCandidates(command, "/work", "/home/me");
	const loop = paths('cd docs && for f in a b; do echo "== $f"; cat $f.md; done');
	assert.ok(loop.includes("/work/docs/a.md") && loop.includes("/work/docs/b.md"));
	assert.ok(paths("P=~/src; cd $P && cat ${P}/x.ts main.ts").includes("/home/me/src/x.ts"));
	assert.ok(paths("P=~/src; cd $P && cat main.ts").includes("/home/me/src/main.ts"));
	assert.ok(paths('d=lib; cat "$d/index.ts"').includes("/work/lib/index.ts"));
});

test("bashPathCandidates skips globs, redirects, and unknown variables", () => {
	const paths = (command: string) => bashPathCandidates(command, "/work", "/home/me");
	assert.deepEqual(paths("cat $UNKNOWN/a.ts *.md 2>/dev/null"), ["/work/cat"]);
	assert.deepEqual(paths("p=$(pwd); cat $p/a.ts"), ["/work/cat"]);
	assert.ok(!paths("cd $UNKNOWN && cat a.ts").includes("/a.ts"));
});

test("normalizeConfig: legacy config without slots derives slots from flags", () => {
	const bare = normalizeConfig({});
	assert.deepEqual(bare.slots, {
		topLeft: null,
		topRight: null,
		main: "messages",
		dock: null,
	});
	const classic = normalizeConfig({ split: true, files: true });
	assert.deepEqual(classic.slots, {
		topLeft: "thinking",
		topRight: "tools",
		main: "messages",
		dock: "files",
	});
	assert.equal(classic.thinking, true);
	assert.equal(classic.tools, true);
	assert.equal(classic.files, true);
	const thinkOnly = normalizeConfig({ split: true, tools: false });
	assert.deepEqual(thinkOnly.slots, {
		topLeft: "thinking",
		topRight: null,
		main: "messages",
		dock: null,
	});
	// Invalid slots shape falls back to legacy flags.
	const badSlots = normalizeConfig({ split: true, slots: "bad" as never });
	assert.deepEqual(badSlots.slots, {
		topLeft: "thinking",
		topRight: "tools",
		main: "messages",
		dock: null,
	});
});

test("normalizeConfig: explicit slots normalize, deduplicate, and sync flags", () => {
	const wb = normalizeConfig({
		slots: {
			topLeft: "thinking",
			topRight: "messages",
			main: "tools",
			dock: "files",
		},
	});
	assert.deepEqual(wb.slots, {
		topLeft: "thinking",
		topRight: "messages",
		main: "tools",
		dock: "files",
	});
	assert.equal(wb.split, true);
	assert.equal(wb.thinking, true);
	assert.equal(wb.tools, true);
	assert.equal(wb.files, true);

	// Deduplication order: main, topLeft, topRight, dock.
	const dedup = normalizeConfig({
		slots: {
			main: "tools",
			topLeft: "tools",
			topRight: "thinking",
			dock: "thinking",
		},
	});
	assert.deepEqual(dedup.slots, {
		main: "tools",
		topLeft: null,
		topRight: "thinking",
		dock: null,
	});
	assert.equal(dedup.tools, true);
	assert.equal(dedup.thinking, true);
	assert.equal(dedup.files, false);

	// Invalid panel values become null; all-empty falls back to main: "messages".
	const allBad = normalizeConfig({
		slots: {
			topLeft: "bogus" as never,
			topRight: 123 as never,
			main: null,
			dock: null,
		},
	});
	assert.deepEqual(allBad.slots, {
		topLeft: null,
		topRight: null,
		main: "messages",
		dock: null,
	});
	assert.equal(allBad.split, false);
	assert.equal(allBad.thinking, false);
	assert.equal(allBad.tools, false);
	assert.equal(allBad.files, false);
});

test("LAYOUT_PRESETS: all 6 presets exist and normalize cleanly", () => {
	const names: PresetName[] = [
		"chat-left",
		"classic",
		"workbench",
		"sidebar-chat",
		"deep-think",
		"focused-tools",
	];
	assert.deepEqual(Object.keys(LAYOUT_PRESETS).sort(), [...names].sort());
	for (const name of names) {
		const p = LAYOUT_PRESETS[name];
		const norm = normalizeConfig({
			slots: p.slots,
			bandHeight: p.bandHeight,
			toolsWidthPct: p.toolsWidthPct,
			...(p.filesWidth === null ? {} : { filesWidth: p.filesWidth }),
			...(p.dockSide ? { dockSide: p.dockSide } : {}),
		});
		assert.deepEqual(norm.slots, p.slots);
		assert.equal(norm.bandHeight, p.bandHeight);
		assert.equal(norm.toolsWidthPct, p.toolsWidthPct);
		assert.equal(norm.filesWidth, p.filesWidth);
		assert.equal(norm.dockSide, p.dockSide ?? "right");
	}
	assert.equal(normalizeConfig({}).dockSide, "right");
	assert.equal(normalizeConfig({ dockSide: "left" }).dockSide, "left");
	assert.equal(normalizeConfig({ dockSide: "bogus" as any }).dockSide, "right");
});

test("assignSlot assigns to empty slot, swaps occupied slots, and clears with null", () => {
	const base: LayoutSlots = {
		topLeft: "thinking",
		topRight: null,
		main: "messages",
		dock: "files",
	};
	// Assign unplaced panel into empty slot.
	const added = assignSlot(base, "topRight", "tools");
	assert.deepEqual(added, {
		topLeft: "thinking",
		topRight: "tools",
		main: "messages",
		dock: "files",
	});
	// Swap two occupied slots (tools into main swaps messages into topRight).
	const swapped = assignSlot(added, "main", "tools");
	assert.deepEqual(swapped, {
		topLeft: "thinking",
		topRight: "messages",
		main: "tools",
		dock: "files",
	});
	// Move occupied panel into an empty slot (clears its old slot).
	const moved = assignSlot(base, "topRight", "files");
	assert.deepEqual(moved, {
		topLeft: "thinking",
		topRight: "files",
		main: "messages",
		dock: null,
	});
	// Clear a slot with null.
	const cleared = assignSlot(added, "dock", null);
	assert.deepEqual(cleared, {
		topLeft: "thinking",
		topRight: "tools",
		main: "messages",
		dock: null,
	});
	// Input object is not mutated.
	assert.equal(base.topRight, null);
});

test("filesPanelRowBudget shows diff section only when enabled and an edit diff exists", () => {
	// No diff yet (even with showDiff: true) → full list rows, no diff rows.
	assert.deepEqual(filesPanelRowBudget(30, true, false), {
		showDiffSection: false,
		listRows: 26,
		diffRows: 0,
	});
	// Diff exists and showDiff: true → split rows (exact row accounting: listRows + diffRows + 6 === height).
	const split = filesPanelRowBudget(30, true, true);
	assert.deepEqual(split, {
		showDiffSection: true,
		listRows: 11,
		diffRows: 13,
	});
	assert.equal(split.listRows + split.diffRows + 6, 30);
	// Diff exists but showDiff: false → full list rows, no diff rows.
	assert.deepEqual(filesPanelRowBudget(30, false, true), {
		showDiffSection: false,
		listRows: 26,
		diffRows: 0,
	});
	// Very short height clamps safely.
	assert.deepEqual(filesPanelRowBudget(4, true, false), {
		showDiffSection: false,
		listRows: 1,
		diffRows: 0,
	});
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

	// Default (globalOverride = null, not zoomed): active & error expand; clean collapses.
	assert.equal(isToolExpanded(active, empty, null), true);
	assert.equal(isToolExpanded(errored, empty, null), true);
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

test("normalizeConfig handles thinkingHud with strict boolean default true", () => {
	assert.equal(normalizeConfig({}).thinkingHud, true);
	assert.equal(normalizeConfig({ thinkingHud: true }).thinkingHud, true);
	assert.equal(normalizeConfig({ thinkingHud: false }).thinkingHud, false);
	// Wrongly-typed values fall back to default true.
	assert.equal(normalizeConfig({ thinkingHud: "false" as any }).thinkingHud, true);
	assert.equal(normalizeConfig({ thinkingHud: 0 as any }).thinkingHud, true);
	assert.equal(normalizeConfig({ thinkingHud: null as any }).thinkingHud, true);
});

test("normalizeConfig preserves regular-mode files: true when slots has no files slot", () => {
	const regularFiles = normalizeConfig({
		split: false,
		thinking: false,
		tools: false,
		files: true,
		slots: { topLeft: null, topRight: null, main: "messages", dock: null },
	});
	assert.equal(regularFiles.files, true);
	assert.equal(regularFiles.slots.dock, null);

	const hiddenFiles = normalizeConfig({
		split: false,
		thinking: false,
		tools: false,
		files: false,
		slots: { topLeft: null, topRight: null, main: "messages", dock: null },
	});
	assert.equal(hiddenFiles.files, false);
});



