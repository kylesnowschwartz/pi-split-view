import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DIR_ENTRIES, TreeController } from "../filetree/controller.ts";
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
