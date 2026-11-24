import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DIR_ENTRIES, notedSelectionOf, SELECTION_NOTE_TYPE, TreeController } from "../filetree/controller.ts";
import { CLOSE_INTERVAL_MS, HOLD_MS, TICK_MS } from "../filetree/timing.ts";
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
	assert.equal(tree.rowIdOf("/r"), "/r");
	assert.equal(tree.rowIdOf("/r/no/such/x.ts"), "/r");
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

// ─── fold and follow ────────────────────────────────────────────────────────

/** A root with `n` folders (d00, d01, …), each with a `sub` folder of 6 files and 6 files of its own. */
function wide(n: number): World {
	const w: World = { dirs: { "/r": [] } };
	for (let d = 0; d < n; d++) {
		const name = `d${String(d).padStart(2, "0")}`;
		w.dirs["/r"]!.push([name, "dir"]);
		w.dirs[`/r/${name}`] = [["sub", "dir"], ...Array.from({ length: 6 }, (_, f) => [`f${f}.ts`, "file"] as [string, "file"])];
		w.dirs[`/r/${name}/sub`] = Array.from({ length: 6 }, (_, f) => [`s${f}.ts`, "file"] as [string, "file"]);
	}
	return w;
}

const shown = (tree: TreeController, room: number) => tree.window(room).rows.map((r) => r.node.id);

test("follow: the window moves to a running row that is off screen, and stays put for one that is drawn", async () => {
	const { tree } = await make(wide(30));
	assert.equal(tree.window(10).from, 0);
	tree.toolStart("c1", "read", { path: "d20/sub/s3.ts" });
	await settle();
	assert.ok(shown(tree, 10).includes("/r/d20/sub/s3.ts"));
	const from = tree.window(10).from;
	tree.toolStart("c2", "read", { path: "d20/sub/s1.ts" });
	await settle();
	assert.equal(tree.window(10).from, from, "a row already on screen is not re-centred");
	tree.toolEnd("c1", false, "");
	tree.toolEnd("c2", false, "");
	await settle();
	assert.equal(tree.window(10).from, from);
});

test("follow: a wheel turn lets go of the window until the next call starts", async () => {
	const { tree } = await make(wide(30));
	tree.window(10);
	tree.toolStart("c1", "read", { path: "d20/f0.ts" });
	await settle();
	tree.window(10);
	tree.wheel(-30);
	assert.equal(tree.window(10).from, 0);
	assert.deepEqual([tree.window(10).above, tree.window(10).below], [0, 1]);
	tree.toolStart("c2", "read", { path: "d25/f0.ts" });
	await settle();
	assert.ok(shown(tree, 10).includes("/r/d25/f0.ts"));
});

test("three quick reads in far-apart folders: no folder above a touched file closes before its hold ends", async () => {
	const { io, tree } = await make(wide(30));
	tree.window(8);
	const files = ["/r/d02/sub/s1.ts", "/r/d15/sub/s2.ts", "/r/d28/sub/s3.ts"];
	const endedAt: number[] = [];
	for (const [i, path] of files.entries()) {
		tree.toolStart(`c${i}`, "read", { path });
		await settle();
		io.advance(20);
		tree.toolEnd(`c${i}`, false, "");
		endedAt.push(io.clock.now());
		await settle();
		io.advance(600);
	}
	// Sample every 500 ms until the last hold has ended.
	for (let t = 0; t <= 15_000; t += 500) {
		const now = io.clock.now();
		tree.window(8);
		for (const [i, path] of files.entries()) {
			if (now >= endedAt[i]! + HOLD_MS) continue;
			assert.ok(ids(tree).includes(path), `${path} is listed ${now - endedAt[i]!} ms after its call ended`);
			assert.equal(tree.marks().get(path)?.state, "recent");
		}
		io.advance(500);
		await settle();
	}
	// The holds are over and no new call came: the folders are still open.
	assert.deepEqual(stateOf(tree), {});
	for (const path of files) assert.ok(ids(tree).includes(path));
});

test("held rows that cannot fit are counted above and below the window", async () => {
	const { io, tree } = await make(wide(30));
	tree.window(8);
	for (const [i, path] of ["d02/sub/s1.ts", "d15/sub/s2.ts", "d28/sub/s3.ts"].entries()) {
		tree.toolStart(`c${i}`, "read", { path });
		await settle();
		tree.toolEnd(`c${i}`, false, "");
		await settle();
		io.advance(100);
	}
	const win = tree.window(8);
	assert.ok(win.rows.some((r) => r.node.id === "/r/d28/sub/s3.ts"));
	assert.deepEqual([win.above, win.below], [2, 0]);
});

test("folders opened by hand close only when marked rows need the room, and only once per interval", async () => {
	const { io, tree } = await make(wide(30));
	tree.window(12);
	tree.toggleDir("/r/d05");
	tree.toggleDir("/r/d06");
	await settle();
	// One read: it fits alone, the hand-opened folders stay.
	tree.toolStart("c1", "read", { path: "d04/f5.ts" });
	await settle();
	assert.ok(tree.expanded.has("/r/d05") && tree.expanded.has("/r/d06"));
	// A second read on the far side of them: both rows now need the room.
	tree.toolStart("c2", "read", { path: "d07/f0.ts" });
	await settle();
	assert.ok(!tree.expanded.has("/r/d05") && !tree.expanded.has("/r/d06"));
	assert.ok(tree.expanded.has("/r/d04") && tree.expanded.has("/r/d07"));
	// Opened again by hand, then new activity inside the interval: the close waits.
	tree.toggleDir("/r/d05");
	io.advance(500);
	tree.toolStart("c3", "read", { path: "d07/f1.ts" });
	await settle();
	assert.ok(tree.expanded.has("/r/d05"), "no second close pass inside the interval");
	io.advance(CLOSE_INTERVAL_MS);
	assert.ok(!tree.expanded.has("/r/d05"), "the paced close runs when the interval ends");
});

// ─── selection ──────────────────────────────────────────────────────────────

test("a click selects a file, a second click clears it, and a folder click never selects", async () => {
	const { tree } = await make(base());
	tree.clickRow(2);
	assert.equal(tree.selected, "/r/a.ts");
	tree.clickRow(2);
	assert.equal(tree.selected, "");
	tree.clickRow(1);
	await settle();
	assert.equal(tree.selected, "");
	tree.clickRow(3);
	assert.equal(tree.selected, "/r/src/b.ts");
	tree.clickRow(4);
	assert.equal(tree.selected, "/r/a.ts");
});

test("the selection note goes out once per change, names the file, and reports a cleared selection", async () => {
	const { tree } = await make(base());
	assert.equal(tree.selectionNote(), null);
	tree.select("/r/src/b.ts");
	const note = tree.selectionNote();
	assert.equal(note?.path, "/r/src/b.ts");
	assert.match(note?.text ?? "", /src\/b\.ts/);
	assert.match(note?.text ?? "", /\/r\/src\/b\.ts/);
	assert.equal(tree.selectionNote(), null);
	tree.select("");
	const cleared = tree.selectionNote();
	assert.equal(cleared?.path, "");
	assert.match(cleared?.text ?? "", /No file is selected/);
	assert.equal(tree.selectionNote(), null);
	tree.select("/r/a.ts");
	tree.select("");
	assert.equal(tree.selectionNote(), null, "a selection made and cleared between prompts sends nothing");
});

test("a forgotten note is sent again, and a selected file that is deleted is deselected", async () => {
	const w = base();
	const { tree } = await make(w);
	tree.select("/r/a.ts");
	assert.ok(tree.selectionNote());
	tree.forgetSelectionNote();
	assert.match(tree.selectionNote()?.text ?? "", /a\.ts/);
	w.dirs["/r"] = w.dirs["/r"]!.filter(([name]) => name !== "a.ts");
	await tree.sync();
	assert.equal(tree.selected, "");
});

// ─── bash beside write calls ────────────────────────────────────────────────

const kindOf = (tree: TreeController, id: string) => {
	const m = tree.marks().get(id);
	return m ? `${m.state}:${m.kind}:${m.tool}` : undefined;
};

/** A repo where a.ts is clean; `edit()` makes git report it as modified. */
function repoWorld() {
	const w = base();
	w.top = "/r";
	w.status = "## main\0";
	w.numstat = "";
	w.files = { "/r/a.ts": "x\n", "/r/src/b.ts": "y\n" };
	const edit = (rel: string) => {
		w.status += ` M ${rel}\0`;
		w.numstat += `1\t0\t${rel}\0`;
	};
	return { w, edit };
}

test("edit and bash in one batch, edit ends first: the edited file keeps its write mark", async () => {
	const { w, edit } = repoWorld();
	const { tree } = await make(w);
	tree.toolStart("e1", "edit", { path: "a.ts", edits: [] });
	tree.toolStart("b1", "bash", { command: "echo y >> src/b.ts" });
	await settle();
	edit("a.ts");
	tree.toolEnd("e1", false, "ok");
	await settle();
	assert.equal(kindOf(tree, "/r/a.ts"), "recent:write:edit");
	edit("src/b.ts");
	tree.toolEnd("b1", false, "");
	await settle();
	assert.equal(kindOf(tree, "/r/a.ts"), "recent:write:edit");
	assert.equal(kindOf(tree, "/r/src/b.ts"), "recent:bash:bash");
});

test("edit and bash in one batch, bash ends first: the file under edit stays running, then holds as a write", async () => {
	const { w, edit } = repoWorld();
	const { tree } = await make(w);
	tree.toolStart("e1", "edit", { path: "a.ts", edits: [] });
	tree.toolStart("b1", "bash", { command: "echo y >> src/b.ts" });
	await settle();
	edit("a.ts");
	edit("src/b.ts");
	tree.toolEnd("b1", false, "");
	await settle();
	assert.equal(kindOf(tree, "/r/a.ts"), "running:write:edit");
	assert.equal(kindOf(tree, "/r/src/b.ts"), "recent:bash:bash");
	tree.toolEnd("e1", false, "ok");
	await settle();
	assert.equal(kindOf(tree, "/r/a.ts"), "recent:write:edit");
});

test("a bash call that changes nothing after an edit leaves the edit's mark alone", async () => {
	const { w, edit } = repoWorld();
	const { io, tree } = await make(w);
	tree.toolStart("e1", "edit", { path: "a.ts", edits: [] });
	edit("a.ts");
	tree.toolEnd("e1", false, "ok");
	// The bash call starts before the read of git that follows the edit is in.
	tree.toolStart("b1", "bash", { command: "true" });
	await settle();
	io.advance(1_000);
	tree.toolEnd("b1", false, "");
	await settle();
	assert.equal(kindOf(tree, "/r/a.ts"), "recent:write:edit");
	assert.deepEqual(Object.keys(stateOf(tree)), ["/r/a.ts"]);
});

test("a file changed outside any write call while bash runs is still marked as a bash change", async () => {
	const { w, edit } = repoWorld();
	const { tree } = await make(w);
	tree.toolStart("b1", "bash", { command: "sleep 1" });
	await settle();
	edit("a.ts");
	tree.toolEnd("b1", false, "");
	await settle();
	assert.equal(kindOf(tree, "/r/a.ts"), "recent:bash:bash");
});

// ─── selection across a reload or resume ────────────────────────────────────

const noteEntry = (path: string) => ({ type: "custom_message", customType: SELECTION_NOTE_TYPE, content: "…", display: false, details: { path } });

test("the newest selection note on the branch gives the noted file", () => {
	const user = { type: "message", message: { role: "user", content: "hi" } };
	assert.equal(notedSelectionOf([]), null);
	assert.equal(notedSelectionOf([user, { type: "custom_message", customType: "other", details: { path: "/x" } }]), null);
	assert.equal(notedSelectionOf([noteEntry("/r/a.ts"), user, noteEntry("/r/src/b.ts"), user]), "/r/src/b.ts");
	assert.equal(notedSelectionOf([noteEntry("/r/a.ts"), noteEntry("")]), "");
	assert.equal(notedSelectionOf([{ type: "custom_message", customType: SELECTION_NOTE_TYPE }]), null);
});

test("start restores a noted file that still exists, in a folder not listed yet, and sends no new note", async () => {
	const w = base();
	w.files = { "/r/src/deep/c.ts": "x" };
	const io = fakeIo(w);
	const tree = new TreeController(io, { changed: () => {}, visible: () => true });
	await tree.start("/r", notedSelectionOf([noteEntry("/r/src/deep/c.ts")]));
	assert.equal(tree.selected, "/r/src/deep/c.ts");
	assert.equal(tree.selectionNote(), null);
	await tree.sync();
	assert.equal(tree.selected, "/r/src/deep/c.ts", "a sync of other folders keeps it");
	tree.select("");
	assert.equal(tree.selectionNote()?.path, "");
});

test("start with a noted file that is gone selects nothing and sends one cleared note", async () => {
	const io = fakeIo(base());
	const tree = new TreeController(io, { changed: () => {}, visible: () => true });
	await tree.start("/r", "/r/src/gone.ts");
	assert.equal(tree.selected, "");
	const note = tree.selectionNote();
	assert.equal(note?.path, "");
	assert.match(note?.text ?? "", /No file is selected/);
	assert.equal(tree.selectionNote(), null);
});

test("start with a cleared note, no note, or a noted path outside the root selects nothing", async () => {
	const w = base();
	w.files = { "/elsewhere/x.ts": "x" };
	for (const noted of ["", null]) {
		const tree = new TreeController(fakeIo(w), { changed: () => {}, visible: () => true });
		await tree.start("/r", noted);
		assert.equal(tree.selected, "");
		assert.equal(tree.selectionNote(), null);
	}
	const tree = new TreeController(fakeIo(w), { changed: () => {}, visible: () => true });
	await tree.start("/r", "/elsewhere/x.ts");
	assert.equal(tree.selected, "");
	assert.equal(tree.selectionNote()?.path, "");
});
