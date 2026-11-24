import assert from "node:assert/strict";
import { test } from "node:test";
import { Activity, RESULT_FILES_MAX, resultFiles, resultText, toolTargets } from "../filetree/activity.ts";
import { changedBetween } from "../filetree/git.ts";
import { HOLD_MS } from "../filetree/timing.ts";

const T0 = 50_000;
const state = (a: Activity, now: number) =>
	Object.fromEntries(a.marks(now).map((m) => [m.path, `${m.state}:${m.tool}${m.error ? ":error" : ""}`]));

test("a row runs from its call's start to its end, then holds its tone for the hold time", () => {
	const a = new Activity();
	a.start("c1", "read", "read", ["/r/a.ts"]);
	assert.deepEqual(state(a, T0), { "/r/a.ts": "running:read" });
	assert.deepEqual(state(a, T0 + 60_000), { "/r/a.ts": "running:read" });
	a.end("c1", false, T0 + 60_000);
	assert.deepEqual(state(a, T0 + 60_000), { "/r/a.ts": "recent:read" });
	assert.deepEqual(state(a, T0 + 60_000 + HOLD_MS - 1), { "/r/a.ts": "recent:read" });
	assert.deepEqual(state(a, T0 + 60_000 + HOLD_MS), {});
});

test("a call that ends at once still holds its row for the full hold time", () => {
	const a = new Activity();
	a.start("c1", "read", "read", ["/r/a.ts"]);
	a.end("c1", false, T0);
	assert.equal(a.nextExpiry(), T0 + HOLD_MS);
	assert.equal(a.expire(T0 + HOLD_MS - 1), false);
	assert.deepEqual(state(a, T0 + HOLD_MS - 1), { "/r/a.ts": "recent:read" });
	assert.equal(a.expire(T0 + HOLD_MS), true);
	assert.equal(a.nextExpiry(), undefined);
});

test("two calls on one file: the row runs until the last one ends", () => {
	const a = new Activity();
	a.start("c1", "read", "read", ["/r/a.ts"]);
	a.start("c2", "edit", "write", ["/r/a.ts"]);
	assert.deepEqual(state(a, T0), { "/r/a.ts": "running:edit" });
	a.end("c2", false, T0 + 10);
	assert.deepEqual(state(a, T0 + 20), { "/r/a.ts": "running:read" });
	assert.equal(a.hasRunning(), true);
	a.end("c1", false, T0 + 30);
	assert.deepEqual(state(a, T0 + 40), { "/r/a.ts": "recent:read" });
	assert.equal(a.hasRunning(), false);
});

test("a failed call holds its row in the error state", () => {
	const a = new Activity();
	a.start("c1", "read", "read", ["/r/missing.ts"]);
	a.end("c1", true, T0);
	assert.deepEqual(state(a, T0 + 1), { "/r/missing.ts": "recent:read:error" });
});

test("an end with no start changes nothing", () => {
	const a = new Activity();
	assert.equal(a.end("ghost", false, T0), undefined);
	assert.deepEqual(state(a, T0), {});
	assert.equal(a.nextExpiry(), undefined);
});

test("a bash call has no row while it runs; files it changed are marked when it ends", () => {
	const a = new Activity();
	a.start("b1", "bash", "bash", []);
	assert.equal(a.hasRunning(), false);
	assert.deepEqual(state(a, T0), {});
	a.end("b1", false, T0 + 5_000);
	a.mark(["/r/x.ts"], "bash", "bash", T0 + 5_100);
	assert.deepEqual(state(a, T0 + 5_200), { "/r/x.ts": "recent:bash" });
	assert.equal(a.nextExpiry(), T0 + 5_100 + HOLD_MS);
});

test("marks come oldest first, so the last one is the newest", () => {
	const a = new Activity();
	a.start("c1", "read", "read", ["/r/a.ts"]);
	a.start("c2", "read", "read", ["/r/b.ts"]);
	a.end("c1", false, T0);
	assert.deepEqual(a.marks(T0).map((m) => m.path), ["/r/b.ts", "/r/a.ts"]);
	a.start("c3", "read", "read", ["/r/c.ts"]);
	assert.deepEqual(a.marks(T0).map((m) => m.path), ["/r/b.ts", "/r/a.ts", "/r/c.ts"]);
});

test("tool targets: pi's file tools name one path, resolved against the session directory", () => {
	const t = (tool: string, args: unknown) => toolTargets(tool, args, "/r/sub", "/r", "/home/me");
	assert.deepEqual(t("read", { path: "a.ts" }), { kind: "read", paths: ["/r/sub/a.ts"] });
	assert.deepEqual(t("read", { path: "@../b.ts" }), { kind: "read", paths: ["/r/b.ts"] });
	assert.deepEqual(t("edit", { path: "/r/c.ts", edits: [] }), { kind: "write", paths: ["/r/c.ts"] });
	assert.deepEqual(t("write", { path: "new/d.ts", content: "" }), { kind: "write", paths: ["/r/sub/new/d.ts"] });
	assert.deepEqual(t("grep", { pattern: "x" }), { kind: "read", paths: ["/r/sub"] });
	assert.deepEqual(t("find", { pattern: "*.ts", path: "lib" }), { kind: "read", paths: ["/r/sub/lib"] });
	assert.deepEqual(t("ls", {}), { kind: "read", paths: ["/r/sub"] });
	assert.deepEqual(t("bash", { command: "rm -rf x" }), { kind: "bash", paths: [] });
});

test("tool targets: paths outside the root and tools with no path argument are ignored", () => {
	const t = (tool: string, args: unknown) => toolTargets(tool, args, "/r", "/r", "/home/me");
	assert.equal(t("read", { path: "/etc/hosts" }), null);
	assert.equal(t("read", { path: "~/notes.md" }), null);
	assert.equal(t("read", { path: "../r2/a.ts" }), null);
	assert.equal(t("read", {}), null);
	assert.equal(t("web_search", { query: "x" }), null);
	assert.equal(t("mcp__thing", undefined), null);
	assert.deepEqual(t("lsp_hover", { file_path: "src/a.ts" }), { kind: "read", paths: ["/r/src/a.ts"] });
});

test("result files: find lists one path per line up to the notice", () => {
	assert.deepEqual(resultFiles("find", "src/a.ts\nsrc/lib/\n\n[1000 results limit reached]"), ["src/a.ts", "src/lib"]);
	assert.deepEqual(resultFiles("find", "No files found matching pattern"), []);
});

test("result files: grep names each matched file once; context lines do not count", () => {
	const text = "src/a.ts:3: const x = 1\nsrc/a.ts-4- next\nsrc/a.ts:9: x\nlib/b.ts:1: x\n\n[100 matches limit reached]";
	assert.deepEqual(resultFiles("grep", text), ["src/a.ts", "lib/b.ts"]);
	assert.deepEqual(resultFiles("grep", "No matches found"), []);
});

test("result files: too many files, or another tool, gives none", () => {
	const many = Array.from({ length: RESULT_FILES_MAX + 1 }, (_, i) => `f${i}.ts`).join("\n");
	assert.deepEqual(resultFiles("find", many), []);
	assert.equal(resultFiles("find", many.split("\n").slice(1).join("\n")).length, RESULT_FILES_MAX);
	assert.deepEqual(resultFiles("ls", "a.ts\nb/"), []);
	assert.deepEqual(resultFiles("read", "a.ts:1: x"), []);
});

test("result text joins the text blocks of a tool result", () => {
	assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "ab");
	assert.equal(resultText("plain"), "plain");
	assert.equal(resultText(undefined), "");
});

test("bash snapshot diff: a file differs when its signature changed, appeared or went", () => {
	const before = { "/r/a.ts": "mod:1:0:5:10", "/r/b.ts": "mod:2:2:5:10", "/r/c.ts": "new:4:0:5:10" };
	const after = { "/r/a.ts": "mod:1:0:5:10", "/r/b.ts": "mod:3:2:6:11", "/r/d.ts": "new:1:0:7:2" };
	assert.deepEqual(changedBetween(before, after), ["/r/b.ts", "/r/c.ts", "/r/d.ts"]);
	assert.deepEqual(changedBetween(before, before), []);
	assert.deepEqual(changedBetween({}, {}), []);
});

test("bash snapshot diff: an edit that keeps the line counts still differs by its stamp", () => {
	assert.deepEqual(changedBetween({ "/r/a.ts": "mod:1:1:100:20" }, { "/r/a.ts": "mod:1:1:250:20" }), ["/r/a.ts"]);
});
