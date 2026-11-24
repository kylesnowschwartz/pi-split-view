/** The tree model: nodes listed from disk, and the rows the pane draws. */

import { dirname, inside, join } from "./paths.ts";

export type FileNode = {
	id: string;
	parent: string;
	name: string;
	kind: "dir" | "file" | "link";
	hidden: boolean;
	/** A folder whose children are listed. */
	loaded: boolean;
	/** Entries of a folder left out of the listing because it is too large. */
	more?: number;
};

export type Entry = { name: string; kind: "file" | "dir" | "other"; isLink: boolean };

/** One drawn row. A note row stands for a folder's unlisted entries. */
export type Row = { node: FileNode; depth: number; open: boolean; note?: string };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Nodes below `dirs` removed, and each of `dirs` marked unlisted. */
export function dropBelow(nodes: FileNode[], dirs: string[]): FileNode[] {
	if (dirs.length === 0) return nodes;
	const under = (id: string) => dirs.some((d) => id !== d && inside(d, id));
	const gone = new Set(dirs);
	return nodes
		.filter((n) => !under(n.id))
		.map((n) => (gone.has(n.id) && n.loaded ? { ...n, loaded: false } : n));
}

/** A folder's entries as nodes: folders first, then by name. */
export function toNodes(dir: string, list: Entry[]): FileNode[] {
	return list
		.map((e) => ({
			id: join(dir, e.name),
			parent: dir,
			name: e.name,
			kind: e.isLink ? ("link" as const) : e.kind === "dir" ? ("dir" as const) : ("file" as const),
			hidden: e.name.startsWith("."),
			loaded: false,
		}))
		.sort(
			(a, b) =>
				(a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) ||
				collator.compare(a.name, b.name),
		);
}

/** `nodes` with the children of each listed folder replaced by its fresh
 * listing. A folder that is still there keeps its listed state and its own
 * children; what vanished goes, with everything below it. `more` gives the
 * unlisted entry count of a listed folder. */
export function replaceChildren(
	nodes: FileNode[],
	listed: Map<string, FileNode[]>,
	more: Map<string, number> = new Map(),
): FileNode[] {
	if (listed.size === 0) return nodes;
	const keep = new Map<string, FileNode>();
	for (const n of nodes) if (listed.has(n.parent)) keep.set(n.id, n);
	const freshIds = new Set<string>();
	for (const kids of listed.values()) for (const k of kids) freshIds.add(k.id);
	const gone = new Set([...keep.keys()].filter((id) => !freshIds.has(id)));
	const under = (id: string) => {
		if (gone.size === 0) return false;
		for (let dir = dirname(id), prev = id; dir !== prev; prev = dir, dir = dirname(dir))
			if (gone.has(dir)) return true;
		return false;
	};
	const mark = (n: FileNode): FileNode => {
		if (!listed.has(n.id)) return n;
		const out: FileNode = { ...n, loaded: true };
		const extra = more.get(n.id) ?? 0;
		if (extra > 0) out.more = extra;
		else delete out.more;
		return out;
	};
	const fresh: FileNode[] = [];
	for (const kids of listed.values()) {
		for (const k of kids) {
			if (under(k.id)) continue;
			const old = keep.get(k.id);
			fresh.push(
				mark(
					old && old.kind === "dir" && k.kind === "dir"
						? { ...k, loaded: old.loaded, ...(old.more ? { more: old.more } : {}) }
						: k,
				),
			);
		}
	}
	const out = nodes.filter((n) => !listed.has(n.parent) && !under(n.id));
	return [...out.map(mark), ...fresh];
}

/** The rows of the tree under `root`, with the folders in `expanded` open.
 * `rootMore` is the unlisted entry count of the root itself. */
export function visibleRows(
	nodes: FileNode[],
	root: string,
	expanded: ReadonlySet<string>,
	rootMore = 0,
): Row[] {
	const kids = new Map<string, FileNode[]>();
	for (const n of nodes) {
		const list = kids.get(n.parent);
		if (list) list.push(n);
		else kids.set(n.parent, [n]);
	}
	const rows: Row[] = [];
	const note = (dir: string, depth: number, count: number) => {
		if (count <= 0) return;
		const text = `… ${count} more`;
		rows.push({
			node: { id: `${dir}/#more`, parent: dir, name: text, kind: "file", hidden: false, loaded: false },
			depth,
			open: false,
			note: text,
		});
	};
	const walk = (dir: string, depth: number) => {
		for (const n of kids.get(dir) ?? []) {
			const isOpen = n.kind === "dir" && expanded.has(n.id);
			rows.push({ node: n, depth, open: isOpen });
			if (isOpen) {
				walk(n.id, depth + 1);
				note(n.id, depth + 1, n.more ?? 0);
			}
		}
	};
	walk(root, 0);
	note(root, 0, rootMore);
	return rows;
}
