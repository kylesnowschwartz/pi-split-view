/**
 * The tree's state and what changes it: listing, git, folder clicks and the
 * scroll position. It reaches the world only through a TreeIo.
 */

import { createGitWatch, createRefresher, type GitState, NO_GIT } from "./git.ts";
import type { TreeIo } from "./io.ts";
import { type Entry, type FileNode, replaceChildren, type Row, toNodes, visibleRows } from "./model.ts";
import { ancestorsOf, inside, join, prunedUnder } from "./paths.ts";
import { scrolledBy } from "./viewport.ts";

/** Entries listed per folder; the rest show as one "… N more" row. */
export const MAX_DIR_ENTRIES = 1000;

/** A folder's listing: its entries; gone when the folder no longer exists, so
 * its rows go too; unreadable when listing it failed, so the rows it had stay. */
type Listing = { kind: "listed"; nodes: FileNode[]; more: number } | { kind: "gone" } | { kind: "unreadable" };

export interface ControllerHost {
	/** The tree changed: draw it again. */
	changed(): void;
	/** Whether the pane is on screen; the poll rests while it is not. */
	visible(): boolean;
}

export class TreeController {
	root = "";
	nodes: FileNode[] = [];
	expanded = new Set<string>();
	git: GitState = NO_GIT;
	/** First drawn row. */
	from = 0;

	private rootMore = 0;
	private rootLoaded = false;
	private gen = 0;
	private version = 0;
	private rowsAt = -1;
	private rowsCache: Row[] = [];
	private room = 20;
	private listSeq = 0;
	private readonly listLatest = new Map<string, number>();
	private readonly refresher;
	private readonly watch;
	private gitSig = "";
	private ignoredSet = new Set<string>();
	private untrackedSet = new Set<string>();

	protected readonly io: TreeIo;
	protected readonly host: ControllerHost;

	constructor(io: TreeIo, host: ControllerHost) {
		this.io = io;
		this.host = host;
		this.refresher = createRefresher(io);
		this.watch = createGitWatch(
			io,
			() => this.sync(),
			() => !this.root || !this.host.visible(),
		);
	}

	/** Build the tree for a session's working directory. */
	async start(cwd: string): Promise<void> {
		this.reset();
		const mine = this.gen;
		this.root = cwd.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
		await this.loadDirs([this.root]);
		if (mine !== this.gen) return;
		this.host.changed();
		await this.refreshGit();
		if (mine !== this.gen) return;
		await this.watch.restart(this.git.top || this.root);
	}

	stop(): void {
		this.reset();
	}

	protected reset(): void {
		this.gen += 1;
		this.watch.stop();
		this.root = "";
		this.nodes = [];
		this.expanded = new Set();
		this.git = NO_GIT;
		this.gitSig = "";
		this.ignoredSet = new Set();
		this.untrackedSet = new Set();
		this.from = 0;
		this.rootMore = 0;
		this.rootLoaded = false;
		this.listLatest.clear();
		this.touch();
	}

	/** Mark the rows stale. */
	protected touch(): void {
		this.version += 1;
	}

	get ignored(): Set<string> {
		return this.ignoredSet;
	}

	get untracked(): Set<string> {
		return this.untrackedSet;
	}

	rows(): Row[] {
		if (this.rowsAt !== this.version) {
			this.rowsCache = visibleRows(this.nodes, this.root, this.expanded, this.rootMore);
			this.rowsAt = this.version;
		}
		return this.rowsCache;
	}

	/** The rows drawn in a pane with `room` rows. */
	window(room: number): { rows: Row[]; from: number; total: number } {
		this.room = Math.max(1, room);
		const all = this.rows();
		this.from = scrolledBy(this.from, 0, all.length, this.room);
		return { rows: all.slice(this.from, this.from + this.room), from: this.from, total: all.length };
	}

	get paneRoom(): number {
		return this.room;
	}

	wheel(delta: number): void {
		if (!delta) return;
		const by = Math.sign(delta) * Math.max(3, Math.abs(delta));
		this.from = scrolledBy(this.from, by, this.rows().length, this.room);
		this.host.changed();
	}

	/** A click on the drawn row `index`: a folder opens or closes. Returns the
	 * clicked row. */
	clickRow(index: number): Row | undefined {
		const row = this.rows()[this.from + index];
		if (!row || row.note) return undefined;
		if (row.node.kind === "dir") this.toggleDir(row.node.id);
		return row;
	}

	toggleDir(id: string): void {
		const node = this.nodes.find((n) => n.id === id);
		if (!node || node.kind !== "dir") return;
		if (this.expanded.has(id)) this.expanded.delete(id);
		else {
			this.expanded.add(id);
			if (!node.loaded) void this.loadDirs([id]).then(() => this.host.changed());
		}
		this.touch();
		this.host.changed();
	}

	private async list(dir: string): Promise<Listing> {
		try {
			const entries = (await this.io.fs.list(dir)).filter((e) => e.name !== ".git");
			const more = Math.max(0, entries.length - MAX_DIR_ENTRIES);
			const resolved: Entry[] = await Promise.all(
				entries.slice(0, MAX_DIR_ENTRIES).map(async (e) => {
					if (!e.isLink) return { name: e.name, kind: e.kind, isLink: false };
					try {
						const target = await this.io.fs.stat(join(dir, e.name));
						return target.kind === "dir"
							? { name: e.name, kind: "dir" as const, isLink: false }
							: { name: e.name, kind: "file" as const, isLink: true };
					} catch {
						return { name: e.name, kind: "other" as const, isLink: true };
					}
				}),
			);
			return { kind: "listed", nodes: toNodes(dir, resolved), more };
		} catch {
			try {
				await this.io.fs.stat(dir);
				return { kind: "unreadable" };
			} catch {
				return { kind: "gone" };
			}
		}
	}

	/** List `dirs` and put their entries in the tree. A listing that a newer
	 * one of the same folder overtook is dropped. */
	protected async loadDirs(dirs: string[]): Promise<void> {
		const mine = this.gen;
		const seq = ++this.listSeq;
		for (const dir of dirs) this.listLatest.set(dir, seq);
		const results = await Promise.all(dirs.map(async (dir) => [dir, await this.list(dir)] as const));
		if (mine !== this.gen) return;
		const listed = new Map<string, FileNode[]>();
		const more = new Map<string, number>();
		for (const [dir, listing] of results) {
			if (this.listLatest.get(dir) !== seq) continue;
			this.listLatest.delete(dir);
			if (listing.kind === "unreadable") continue;
			listed.set(dir, listing.kind === "listed" ? listing.nodes : []);
			more.set(dir, listing.kind === "listed" ? listing.more : 0);
			if (dir === this.root) {
				this.rootLoaded = true;
				this.rootMore = more.get(dir) ?? 0;
			}
		}
		if (listed.size === 0) return;
		this.nodes = replaceChildren(this.nodes, listed, more);
		const alive = new Set(this.nodes.map((n) => n.id));
		for (const id of this.expanded) if (!alive.has(id)) this.expanded.delete(id);
		this.touch();
	}

	/** Whether the tree lists `dir` on its own (a pruned folder only lists on a click). */
	protected listable(dir: string): boolean {
		return !prunedUnder(this.root, this.io.home, dir);
	}

	/** List the folders above each of `paths` that are not listed yet, so the
	 * paths have rows. Pruned folders stay unlisted. */
	async reveal(paths: string[]): Promise<void> {
		const mine = this.gen;
		const tried = new Set<string>();
		for (let pass = 0; pass < 32; pass++) {
			if (mine !== this.gen) return;
			const loaded = new Set(this.nodes.filter((n) => n.loaded).map((n) => n.id));
			if (this.rootLoaded) loaded.add(this.root);
			const known = new Set(this.nodes.map((n) => n.id));
			known.add(this.root);
			const need = new Set<string>();
			for (const p of paths) {
				if (!inside(this.root, p)) continue;
				for (const dir of [this.root, ...ancestorsOf(p, this.root).reverse()]) {
					if (!known.has(dir) || !this.listable(dir)) break;
					if (!loaded.has(dir)) {
						if (!tried.has(dir)) need.add(dir);
						break;
					}
				}
			}
			if (need.size === 0) return;
			for (const dir of need) tried.add(dir);
			await this.loadDirs([...need]);
		}
	}

	/** The row a path shows on: the path itself when it is listed, else the
	 * nearest listed folder above it; "" when that is the root or outside it. */
	rowIdOf(path: string): string {
		if (!inside(this.root, path) || path === this.root) return "";
		const known = this.nodeIds();
		if (known.has(path)) return path;
		for (const dir of ancestorsOf(path, this.root)) if (known.has(dir)) return dir;
		return "";
	}

	private idsAt = -1;
	private idsCache = new Set<string>();
	protected nodeIds(): Set<string> {
		if (this.idsAt !== this.version) {
			this.idsCache = new Set(this.nodes.map((n) => n.id));
			this.idsAt = this.version;
		}
		return this.idsCache;
	}

	async refreshGit(): Promise<void> {
		const mine = this.gen;
		const root = this.root;
		if (!root) return;
		const state = await this.refresher.refresh(root);
		if (mine !== this.gen) return;
		const sig = JSON.stringify(state);
		if (sig === this.gitSig) return;
		const before = this.git;
		this.gitSig = sig;
		this.git = state;
		this.ignoredSet = new Set(state.ignored);
		this.untrackedSet = new Set(state.untrackedDirs);
		this.gitChanged(before, state);
		this.host.changed();
	}

	/** A git read differed from the one before it. */
	protected gitChanged(_before: GitState, _after: GitState): void {}

	/** List the root and the open folders again and read git again. */
	async sync(): Promise<void> {
		const mine = this.gen;
		if (!this.root) return;
		const open = this.nodes
			.filter((n) => n.kind === "dir" && n.loaded && this.expanded.has(n.id))
			.map((n) => n.id);
		const sigOf = () => this.nodes.map((n) => `${n.id}:${n.kind}:${n.more ?? 0}`).sort().join("\n");
		const before = sigOf();
		await this.loadDirs([this.root, ...open]);
		if (mine !== this.gen) return;
		if (sigOf() !== before) this.host.changed();
		await this.refreshGit();
	}
}
