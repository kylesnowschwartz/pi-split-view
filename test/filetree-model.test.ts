import assert from "node:assert/strict";
import { test } from "node:test";
import { type FileNode, replaceChildren, toNodes, visibleRows } from "../filetree/model.ts";
import { ancestorsOf, inside, prunedUnder, relative, resolve, underAny } from "../filetree/paths.ts";

const dir = (id: string, loaded: boolean): FileNode => ({
	id,
	parent: id.slice(0, id.lastIndexOf("/")) || "/",
	name: id.slice(id.lastIndexOf("/") + 1),
	kind: "dir",
	hidden: false,
	loaded,
});
const file = (id: string): FileNode => ({ ...dir(id, false), kind: "file" });
const entry = (name: string, kind: "file" | "dir" = "file") => ({ name, kind, isLink: false });

test("replacing many folders in one batch keeps unchanged nodes and drops what vanished", () => {
	const nodes = [dir("/r/a", true), dir("/r/b", true), file("/r/a/x"), dir("/r/b/y", true), file("/r/b/y/z")];
	const out = replaceChildren(
		nodes,
		new Map([
			["/r/a", toNodes("/r/a", [entry("w")])],
			["/r/b", []],
			["/r/b/y", toNodes("/r/b/y", [entry("z")])],
		]),
	);
	assert.deepEqual(out.map((n) => n.id).sort(), ["/r/a", "/r/a/w", "/r/b"]);
	assert.equal(out.find((n) => n.id === "/r/b")?.loaded, true);
});

test("listing a folder again keeps a listed child folder listed, with its own children", () => {
	const nodes = [dir("/r/a", true), dir("/r/a/sub", true), file("/r/a/sub/x")];
	const out = replaceChildren(
		nodes,
		new Map([["/r/a", toNodes("/r/a", [entry("sub", "dir"), entry("new.ts")])]]),
	);
	assert.deepEqual(out.map((n) => n.id).sort(), ["/r/a", "/r/a/new.ts", "/r/a/sub", "/r/a/sub/x"]);
	assert.equal(out.find((n) => n.id === "/r/a/sub")?.loaded, true);
});

test("entries sort folders first, then by name with numbers in order", () => {
	const names = toNodes("/r", [entry("b10.ts"), entry("b2.ts"), entry("zeta", "dir"), entry("Alpha", "dir"), entry(".env")]).map((n) => n.name);
	assert.deepEqual(names, ["Alpha", "zeta", ".env", "b2.ts", "b10.ts"]);
});

test("rows: only open folders show their children, at their depth", () => {
	const nodes = [dir("/r/a", true), file("/r/a/x"), dir("/r/b", true), file("/r/b/y"), file("/r/c")];
	const rows = visibleRows(nodes, "/r", new Set(["/r/a"]));
	assert.deepEqual(
		rows.map((r) => [r.node.id, r.depth, r.open]),
		[
			["/r/a", 0, true],
			["/r/a/x", 1, false],
			["/r/b", 0, false],
			["/r/c", 0, false],
		],
	);
});

test("rows: a folder with unlisted entries ends with one note row", () => {
	const nodes = [{ ...dir("/r/a", true), more: 40 }, file("/r/a/x")];
	const rows = visibleRows(nodes, "/r", new Set(["/r/a"]), 7);
	assert.deepEqual(
		rows.map((r) => r.note ?? r.node.id),
		["/r/a", "/r/a/x", "… 40 more", "… 7 more"],
	);
	assert.equal(replaceChildren(nodes, new Map([["/r/a", [file("/r/a/x")]]]), new Map([["/r/a", 0]])).find((n) => n.id === "/r/a")?.more, undefined);
});

test("paths: resolve folds dots, expands the home folder and keeps absolute paths", () => {
	assert.equal(resolve("/r/sub", "a/../b/./c.ts"), "/r/sub/b/c.ts");
	assert.equal(resolve("/r/sub", "../x"), "/r/x");
	assert.equal(resolve("/r", "/abs/y/"), "/abs/y");
	assert.equal(resolve("/r", "~/notes.md", "/home/me"), "/home/me/notes.md");
	assert.equal(resolve("/r", "."), "/r");
	assert.equal(resolve("/", "../.."), "/");
});

test("paths: inside, relative, ancestors and underAny", () => {
	assert.equal(inside("/r", "/r/a"), true);
	assert.equal(inside("/r", "/r"), true);
	assert.equal(inside("/r", "/rr/a"), false);
	assert.equal(relative("/r", "/r/a/b.ts"), "a/b.ts");
	assert.deepEqual(ancestorsOf("/r/a/b/c.ts", "/r"), ["/r/a/b", "/r/a"]);
	assert.deepEqual(ancestorsOf("/r/c.ts", "/r"), []);
	assert.deepEqual(ancestorsOf("/x/c.ts", "/r"), []);
	assert.equal(underAny("/r/a/b", new Set(["/r/a"]), "/r"), true);
	assert.equal(underAny("/r/c", new Set(["/r/a"]), "/r"), false);
});

test("paths: pruned names apply below the root, and system folders only in a broad root", () => {
	assert.equal(prunedUnder("/r", "/home/me", "/r/node_modules"), true);
	assert.equal(prunedUnder("/r", "/home/me", "/r/a/dist/b"), true);
	assert.equal(prunedUnder("/r", "/home/me", "/r/src"), false);
	assert.equal(prunedUnder("/r", "/home/me", "/r/Library"), false);
	assert.equal(prunedUnder("/home/me", "/home/me", "/home/me/Library"), true);
});
