import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DIR_ENTRIES, TreeController } from "../filetree/controller.ts";
import { HOLD_MS, TICK_MS } from "../filetree/timing.ts";
import { fakeIo, settle, type World } from "./filetree-world.ts";

const base = (): World => ({
	dirs: {
		"/r": [
			["src", "dir"],
			["node_modules", "dir"],
			[".git", "dir"],
			["a.ts", "file"],
		],
		"/r/src": [
			["deep", "dir"],
			["b.ts", "file"],
		],
		"/r/src/deep": [["c.ts", "file"]],
		"/r/node_modules": [["pkg", "dir"]],
		"/r/node_modules/pkg": [["index.js", "file"]],
		"/r/.git": [["HEAD", "file"]],
	},
});

async function make(w: World) {
	const io = fakeIo(w);
	let changes = 0;
	const tree = new TreeController(io, { changed: () => changes++, visible: () => true });
	await tree.start("/r");
	return { io, tree, changes: () => changes };
}

const ids = (tree: TreeController) => tree.rows().map((r) => r.node.id);

test("start lists only the root, without the .git folder", async () => {
	const { io, tree } = await make(base());
	assert.deepEqual(ids(tree), ["/r/node_modules", "/r/src", "/r/a.ts"]);
	assert.deepEqual(io.listed, ["/r"]);
});

test("a folder click lists the folder once and shows its entries; a second click closes it", async () => {
	const { io, tree } = await make(base());
	tree.clickRow(1);
	await settle();
	assert.deepEqual(ids(tree), ["/r/node_modules", "/r/src", "/r/src/deep", "/r/src/b.ts", "/r/a.ts"]);
	tree.clickRow(1);
	assert.deepEqual(ids(tree), ["/r/node_modules", "/r/src", "/r/a.ts"]);
	tree.clickRow(1);
	await settle();
	assert.deepEqual(io.listed, ["/r", "/r/src"]);
});

test("reveal lists the folders above a path, and never a pruned folder", async () => {
	const { io, tree } = await make(base());
	await tree.reveal(["/r/src/deep/c.ts", "/r/node_modules/pkg/index.js", "/elsewhere/x"]);
	assert.deepEqual(io.listed, ["/r", "/r/src", "/r/src/deep"]);
	assert.equal(tree.rowIdOf("/r/src/deep/c.ts"), "/r/src/deep/c.ts");
	assert.equal(tree.rowIdOf("/r/src/deep/missing.ts"), "/r/src/deep");
	assert.equal(tree.rowIdOf("/r/node_modules/pkg/index.js"), "/r/node_modules");
	assert.equal(tree.rowIdOf("/elsewhere/x"), "");
	assert.equal(tree.rowIdOf("/r"), "");
});

test("a sync keeps an open folder open and shows the entries added to it", async () => {
	const w = base();
	const { tree } = await make(w);
	tree.toggleDir("/r/src");
	await settle();
	w.dirs["/r/src"]!.push(["fresh", "dir"]);
	w.dirs["/r/src/fresh"] = [["n.ts", "file"]];
	await tree.sync();
	tree.toggleDir("/r/src/fresh");
	await settle();
	await tree.sync();
	await tree.sync();
	assert.deepEqual(ids(tree), [
		"/r/node_modules",
		"/r/src",
		"/r/src/deep",
		"/r/src/fresh",
		"/r/src/fresh/n.ts",
		"/r/src/b.ts",
		"/r/a.ts",
	]);
});

test("a folder that is gone loses its rows; one that cannot be listed keeps them", async () => {
	const w = base();
	const { tree } = await make(w);
	tree.toggleDir("/r/src");
	await settle();
	w.denied = ["/r/src"];
	await tree.sync();
	assert.ok(ids(tree).includes("/r/src/b.ts"));
	w.denied = [];
	delete w.dirs["/r/src"];
	w.dirs["/r"] = w.dirs["/r"]!.filter(([name]) => name !== "src");
	await tree.sync();
	assert.deepEqual(ids(tree), ["/r/node_modules", "/r/a.ts"]);
	assert.equal(tree.expanded.has("/r/src"), false);
});

test("an older directory listing never overwrites a newer one", async () => {
	const w = base();
	let open!: () => void;
	w.gates = { "/r/src": [new Promise<void>((r) => (open = r))] };
	const { tree } = await make(w);
	tree.toggleDir("/r/src");
	await settle();
	// The first listing still waits with the old entries; a second one runs.
	w.dirs["/r/src"] = [["newer.ts", "file"]];
	tree.expanded.add("/r/src");
	const second = (tree as unknown as { loadDirs(d: string[]): Promise<void> }).loadDirs(["/r/src"]);
	await second;
	open();
	await settle();
	assert.deepEqual(ids(tree), ["/r/node_modules", "/r/src", "/r/src/newer.ts", "/r/a.ts"]);
});

test("a huge folder lists a capped number of entries and one note row", async () => {
	const w = base();
	w.dirs["/r/src"] = Array.from({ length: MAX_DIR_ENTRIES + 25 }, (_, i) => [`f${i}.ts`, "file"] as [string, "file"]);
	const { tree } = await make(w);
	tree.toggleDir("/r/src");
	await settle();
	const rows = tree.rows();
	assert.equal(rows.filter((r) => r.node.parent === "/r/src" && !r.note).length, MAX_DIR_ENTRIES);
	assert.equal(rows.find((r) => r.note)?.note, "… 25 more");
});

test("git state arrives after start, and a new session drops the old tree", async () => {
	const w = base();
	w.top = "/r";
	w.status = "## main\0 M a.ts\0?? src/deep/\0";
	w.numstat = "3\t1\ta.ts\0";
	w.others = "src/deep/c.ts\0";
	w.files = { "/r/a.ts": "x\n", "/r/src/deep/c.ts": "one\ntwo\n" };
	const { io, tree } = await make(w);
	assert.equal(tree.git.branch?.head, "main");
	assert.equal(tree.git.git["/r/a.ts"], "M");
	assert.deepEqual(tree.git.diff["/r/a.ts"], { added: 3, removed: 1 });
	assert.deepEqual(tree.git.diff["/r/src"], { added: 2, removed: 0 });
	assert.equal(tree.untracked.has("/r/src/deep"), true);
	w.dirs["/other"] = [["z.ts", "file"]];
	w.top = "";
	await tree.start("/other");
	assert.deepEqual(ids(tree), ["/other/z.ts"]);
	assert.deepEqual(tree.git.git, {});
	tree.stop();
	assert.equal(io.pending(), 0);
});

test("the poll syncs when the index changes and on every fifth poll, and rests while the pane is hidden", async () => {
	const w = base();
	w.top = "/r";
	w.files = { "/r/.git/index": "i", "/r/.git/HEAD": "h" };
	w.mtimes = { "/r/.git/index": 1 };
	const io = fakeIo(w);
	let visible = true;
	const tree = new TreeController(io, { changed: () => {}, visible: () => visible });
	await tree.start("/r");
	const statuses = () => io.ran.filter((a) => a[4] === "status").length;
	const first = statuses();
	io.advance(2_000);
	await settle();
	assert.equal(statuses(), first);
	w.mtimes["/r/.git/index"] = 2;
	io.advance(2_000);
	await settle();
	assert.equal(statuses(), first + 1);
	io.advance(2_000);
	await settle();
	io.advance(2_000);
	await settle();
	assert.equal(statuses(), first + 1);
	io.advance(2_000);
	await settle();
	assert.equal(statuses(), first + 2);
	visible = false;
	w.mtimes["/r/.git/index"] = 3;
	io.advance(20_000);
	await settle();
	assert.equal(statuses(), first + 2);
	tree.stop();
});

// ─── tool calls ─────────────────────────────────────────────────────────────

const stateOf = (tree: TreeController) =>
	Object.fromEntries([...tree.marks()].map(([id, m]) => [id, `${m.state}:${m.tool}${m.error ? ":error" : ""}`]));

test("a read runs on its row from start to end, opens the folders above it, then holds for the hold time", async () => {
	const { io, tree } = await make(base());
	tree.toolStart("c1", "read", { path: "src/deep/c.ts" });
	await settle();
	assert.deepEqual(stateOf(tree), { "/r/src/deep/c.ts": "running:read" });
	assert.ok(ids(tree).includes("/r/src/deep/c.ts"));
	io.advance(30_000);
	assert.deepEqual(stateOf(tree), { "/r/src/deep/c.ts": "running:read" });
	tree.toolEnd("c1", false, { content: [{ type: "text", text: "x" }] });
	await settle();
	assert.deepEqual(stateOf(tree), { "/r/src/deep/c.ts": "recent:read" });
	io.advance(HOLD_MS - 1);
	assert.deepEqual(stateOf(tree), { "/r/src/deep/c.ts": "recent:read" });
	io.advance(1);
	assert.deepEqual(stateOf(tree), {});
	assert.ok(ids(tree).includes("/r/src/deep/c.ts"), "the folders stay open after the hold");
});

test("the animation timer runs only while a row is running", async () => {
	const { io, tree } = await make(base());
	const idle = io.pending();
	tree.toolStart("c1", "read", { path: "a.ts" });
	await settle();
	assert.equal(io.pending(), idle + 1);
	const before = tree.tick;
	io.advance(TICK_MS * 3);
	assert.equal(tree.tick, before + 3);
	tree.toolEnd("c1", false, "");
	await settle();
	io.advance(TICK_MS * 3);
	assert.ok(tree.tick <= before + 4, "the timer stops within one tick of the end");
	// Only the hold timer is left; it goes when the hold ends.
	assert.equal(io.pending(), idle + 1);
	io.advance(HOLD_MS);
	assert.equal(io.pending(), idle);
});

test("a failed read of a missing file marks the nearest folder as failed", async () => {
	const { tree } = await make(base());
	tree.toolStart("c1", "read", { path: "src/deep/nope.ts" });
	await settle();
	assert.deepEqual(stateOf(tree), { "/r/src/deep": "running:read" });
	tree.toolEnd("c1", true, "ENOENT");
	await settle();
	assert.deepEqual(stateOf(tree), { "/r/src/deep": "recent:read:error" });
});

test("a write to a new file runs on its folder, then holds on the file once it exists", async () => {
	const w = base();
	const { tree } = await make(w);
	tree.toolStart("c1", "write", { path: "src/new.ts", content: "x" });
	await settle();
	assert.deepEqual(stateOf(tree), { "/r/src": "running:write" });
	w.dirs["/r/src"]!.push(["new.ts", "file"]);
	tree.toolEnd("c1", false, "ok");
	await settle();
	assert.deepEqual(stateOf(tree), { "/r/src/new.ts": "recent:write" });
});

test("a search marks its folder while it runs, and the files it found when it ends", async () => {
	const w = base();
	w.files = { "/r/src/deep/c.ts": "x", "/r/src/b.ts": "x" };
	const { tree } = await make(w);
	tree.toolStart("g1", "grep", { pattern: "x", path: "src" });
	await settle();
	assert.deepEqual(stateOf(tree), { "/r/src": "running:grep" });
	tree.toolEnd("g1", false, { content: [{ type: "text", text: "deep/c.ts:1: x\nb.ts:1: x\nghost.ts:2: x" }] });
	await settle();
	assert.deepEqual(stateOf(tree), {
		"/r/src": "recent:grep",
		"/r/src/deep/c.ts": "recent:grep",
		"/r/src/b.ts": "recent:grep",
	});
});

test("a search of the whole tree marks the root", async () => {
	const { tree } = await make(base());
	tree.toolStart("f1", "find", { pattern: "*.zig" });
	await settle();
	assert.deepEqual(stateOf(tree), { "/r": "running:find" });
	tree.toolEnd("f1", false, "No files found matching pattern");
	await settle();
	assert.deepEqual(stateOf(tree), { "/r": "recent:find" });
});

test("a bash call marks nothing while it runs, then the files whose git state changed", async () => {
	const w = base();
	w.top = "/r";
	w.status = "## main\0 M a.ts\0";
	w.numstat = "1\t0\ta.ts\0";
	w.files = { "/r/a.ts": "x\n", "/r/src/deep/c.ts": "one\n" };
	const { tree } = await make(w);
	tree.toolStart("b1", "bash", { command: "sleep 5 && echo x >> src/deep/c.ts" });
	await settle();
	assert.deepEqual(stateOf(tree), {});
	w.status = "## main\0 M a.ts\0 M src/deep/c.ts\0";
	w.numstat = "1\t0\ta.ts\x001\t0\tsrc/deep/c.ts\0";
	tree.toolEnd("b1", false, "");
	await settle();
	assert.deepEqual(stateOf(tree), { "/r/src/deep/c.ts": "recent:bash" });
	assert.ok(ids(tree).includes("/r/src/deep/c.ts"));
});

test("calls outside the tree, unknown tools and an end with no start leave the tree alone", async () => {
	const { io, tree, changes } = await make(base());
	const before = changes();
	const timers = io.pending();
	tree.toolStart("c1", "read", { path: "/etc/hosts" });
	tree.toolStart("c2", "web_search", { query: "x" });
	tree.toolEnd("c1", false, "");
	tree.toolEnd("ghost", true, "");
	await settle();
	assert.deepEqual(stateOf(tree), {});
	assert.equal(changes(), before);
	assert.equal(io.pending(), timers);
});

test("a new session drops running calls and holds", async () => {
	const w = base();
	w.dirs["/other"] = [["z.ts", "file"]];
	const { io, tree } = await make(w);
	tree.toolStart("c1", "read", { path: "a.ts" });
	tree.toolStart("c2", "read", { path: "src/b.ts" });
	tree.toolEnd("c2", false, "");
	await settle();
	await tree.start("/other");
	assert.deepEqual(stateOf(tree), {});
	tree.toolEnd("c1", false, "");
	assert.deepEqual(stateOf(tree), {});
	tree.stop();
	assert.equal(io.pending(), 0);
});
