/**
 * The tree's state and what changes it: listing, git, folder clicks and the
 * scroll position. It reaches the world only through a TreeIo.
 */

import { Activity, type PathMark, resultFiles, resultText, toolTargets } from "./activity.ts";
import { foldFor, offscreen, scrollFor } from "./fold.ts";
import { changedBetween, createGitWatch, createRefresher, type GitState, NO_GIT } from "./git.ts";
import type { Timer, TreeIo } from "./io.ts";
import { type Entry, type FileNode, replaceChildren, type Row, toNodes, visibleRows } from "./model.ts";
import { ancestorsOf, dirname, inside, join, prunedUnder } from "./paths.ts";
import type { RowMark } from "./rows.ts";
import { TICK_MS } from "./timing.ts";
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
	/** Animation frame counter; it advances only while a row is running. */
	tick = 0;

	private readonly activity = new Activity();
	/** The session directory tool paths resolve against. */
	private cwd = "";
	/** The changed files git reported before each running bash call. */
	private readonly bashBefore = new Map<string, Record<string, string>>();
	private ticker: Timer | null = null;
	private expiry: Timer | null = null;
	private marksAt = "";
	private marksCache = new Map<string, PathMark>();
	private activityVersion = 0;
	/** The window follows the marked rows; a wheel turn lets go until the next call. */
	private follow = true;
	private lastCloseAt = Number.NEGATIVE_INFINITY;
	private closeRetry: Timer | null = null;

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

	private readonly io: TreeIo;
	private readonly host: ControllerHost;

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
		this.cwd = this.root;
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

	private reset(): void {
		this.gen += 1;
		this.watch.stop();
		this.ticker?.cancel();
		this.ticker = null;
		this.expiry?.cancel();
		this.expiry = null;
		this.closeRetry?.cancel();
		this.closeRetry = null;
		this.lastCloseAt = Number.NEGATIVE_INFINITY;
		this.follow = true;
		this.activity.clear();
		this.bashBefore.clear();
		this.activityVersion += 1;
		this.tick = 0;
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
	private touch(): void {
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

	/** The rows drawn in a pane with `room` rows, and how many marked rows
	 * sit above and below them. While the window follows, it moves only to
	 * bring the newest running row (or, with no call running, the newest held
	 * row) on screen. */
	window(room: number): { rows: Row[]; from: number; total: number; above: number; below: number } {
		const fit = Math.max(1, room);
		if (fit !== this.room) {
			this.room = fit;
			this.refold();
		}
		const all = this.rows();
		const marks = this.marks();
		const running: number[] = [];
		const held: number[] = [];
		let target = -1;
		let targetMark: PathMark | undefined;
		const rank = (m: PathMark) => (m.state === "running" ? 1 : 0);
		if (marks.size > 0) {
			all.forEach((r, at) => {
				const m = marks.get(r.node.id);
				if (!m) return;
				(m.state === "running" ? running : held).push(at);
				const better =
					!targetMark ||
					rank(m) > rank(targetMark) ||
					(rank(m) === rank(targetMark) && m.seq > targetMark.seq);
				if (better) {
					target = at;
					targetMark = m;
				}
			});
		}
		this.from = scrollFor({
			from: this.from,
			room: this.room,
			total: all.length,
			target: this.follow ? target : -1,
			running,
			held,
		});
		return {
			rows: all.slice(this.from, this.from + this.room),
			from: this.from,
			total: all.length,
			...offscreen(this.from, this.room, [...running, ...held]),
		};
	}

	get paneRoom(): number {
		return this.room;
	}

	wheel(delta: number): void {
		if (!delta) return;
		const by = Math.sign(delta) * Math.max(3, Math.abs(delta));
		this.follow = false;
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
	private async loadDirs(dirs: string[]): Promise<void> {
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
	private listable(dir: string): boolean {
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
	private nodeIds(): Set<string> {
		if (this.idsAt !== this.version) {
			this.idsCache = new Set(this.nodes.map((n) => n.id));
			this.idsAt = this.version;
		}
		return this.idsCache;
	}

	// ─── tool calls ──────────────────────────────────────────────────────────

	/** A tool call started: the rows it names run until toolEnd. */
	toolStart(id: string, tool: string, args: unknown): void {
		if (!this.root) return;
		const target = toolTargets(tool, args, this.cwd, this.root, this.io.home);
		if (!target) return;
		this.activity.start(id, tool, target.kind, target.paths);
		this.follow = true;
		if (target.kind === "bash") {
			this.bashBefore.set(id, this.git.files);
			return;
		}
		this.activityChanged();
		void this.show(target.paths);
	}

	/** A tool call ended, in success or failure. An end with no start is ignored. */
	toolEnd(id: string, isError: boolean, result: unknown): void {
		const call = this.activity.end(id, isError, this.io.clock.now());
		if (!call) return;
		this.activityChanged();
		void this.settle(call.id, call.tool, call.kind, call.paths, isError, result).catch(() => undefined);
	}

	/** What follows a call's end: read the disk and git again, and mark what
	 * the call changed or found. */
	private async settle(
		id: string,
		tool: string,
		kind: RowMark["kind"],
		paths: string[],
		isError: boolean,
		result: unknown,
	): Promise<void> {
		const mine = this.gen;
		if (kind === "bash") {
			const before = this.bashBefore.get(id);
			this.bashBefore.delete(id);
			await this.sync();
			if (mine !== this.gen || !before || !this.git.top) return;
			const changed = changedBetween(before, this.git.files);
			// A call that is still running sees this call's changes as already there.
			for (const key of this.bashBefore.keys()) this.bashBefore.set(key, this.git.files);
			if (changed.length === 0) return;
			this.activity.mark(changed, "bash", "bash", this.io.clock.now());
			this.follow = true;
			await this.show(changed);
			return;
		}
		const builtinRead = kind === "read" && ["read", "grep", "find", "ls"].includes(tool.trim().toLowerCase());
		if (!builtinRead) {
			// The folder of a written file is listed again even while closed,
			// so a new file gets its row.
			await this.sync(paths.map((path) => dirname(path)));
			if (mine !== this.gen) return;
			this.activityChanged();
			await this.show(paths);
			return;
		}
		if (isError) return;
		const rels = resultFiles(tool, resultText(result));
		const base = paths[0];
		if (rels.length === 0 || !base) return;
		const found: string[] = [];
		try {
			const searched = await this.io.fs.stat(base);
			for (const rel of searched.kind === "dir" ? rels.map((r) => join(base, r)) : [base]) {
				if (!inside(this.root, rel)) continue;
				await this.io.fs.stat(rel).then(
					() => found.push(rel),
					() => undefined,
				);
			}
		} catch {
			return;
		}
		if (mine !== this.gen || found.length === 0) return;
		this.activity.mark(found, "read", tool, this.io.clock.now());
		await this.show(found);
	}

	/** List what is needed for `paths` to have rows, then draw. */
	private async show(paths: string[]): Promise<void> {
		const mine = this.gen;
		await this.reveal(paths);
		if (mine !== this.gen) return;
		this.activityChanged();
	}

	/** The activity or the rows it lands on changed: apply the fold rule,
	 * keep the timers in step, and draw. */
	private activityChanged(fold = true): void {
		this.activityVersion += 1;
		const now = this.io.clock.now();
		if (fold) this.refold();
		if (this.activity.hasRunning() && !this.ticker) {
			this.ticker = this.io.clock.every(TICK_MS, () => {
				if (!this.activity.hasRunning()) {
					this.ticker?.cancel();
					this.ticker = null;
					return;
				}
				this.tick += 1;
				this.host.changed();
			});
		}
		this.expiry?.cancel();
		this.expiry = null;
		const next = this.activity.nextExpiry();
		if (next !== undefined) {
			this.expiry = this.io.clock.after(Math.max(1, next - now), () => {
				this.expiry = null;
				this.activity.expire(this.io.clock.now());
				// A hold that ends changes no folder: what it kept open stays
				// open until new activity needs the room.
				this.activityChanged(false);
			});
		}
		this.host.changed();
	}

	/** Apply the fold rule: open the folders above the marked rows, and close
	 * what it allows when the marked rows need the room. A close that is due
	 * but paced runs when its interval ends. */
	private refold(): void {
		if (!this.root) return;
		const now = this.io.clock.now();
		const pinned = [...this.marks().keys()].filter((id) => id !== this.root);
		const res = foldFor({
			expanded: this.expanded,
			pinned,
			root: this.root,
			room: this.room,
			now,
			lastCloseAt: this.lastCloseAt,
			rowsOf: (expanded) => visibleRows(this.nodes, this.root, expanded, this.rootMore).map((r) => r.node.id),
		});
		if (res.closed.length > 0) this.lastCloseAt = now;
		if (res.expanded.size !== this.expanded.size || [...res.expanded].some((d) => !this.expanded.has(d))) {
			this.expanded = res.expanded;
			this.touch();
		}
		this.closeRetry?.cancel();
		this.closeRetry = null;
		if (res.retryAt !== null) {
			this.closeRetry = this.io.clock.after(Math.max(1, res.retryAt - now), () => {
				this.closeRetry = null;
				this.refold();
				this.host.changed();
			});
		}
	}

	/** The live state of each marked row, by row id (the root's id for the
	 * root itself). Several paths on one row give the row its running state
	 * first, then the newest mark. */
	marks(): Map<string, PathMark> {
		const key = `${this.version}:${this.activityVersion}`;
		if (key === this.marksAt) return this.marksCache;
		const out = new Map<string, PathMark>();
		for (const m of this.activity.marks(this.io.clock.now())) {
			const id = m.path === this.root ? this.root : this.rowIdOf(m.path);
			if (!id) continue;
			const cur = out.get(id);
			if (cur && cur.state === "running" && m.state !== "running") continue;
			out.set(id, m);
		}
		this.marksAt = key;
		this.marksCache = out;
		return out;
	}

	/** Read git again before a prompt runs, so the state a bash call is
	 * compared against is current. */
	promptStart(): void {
		void this.refreshGit().catch(() => undefined);
	}

	async refreshGit(): Promise<void> {
		const mine = this.gen;
		const root = this.root;
		if (!root) return;
		const state = await this.refresher.refresh(root);
		if (mine !== this.gen) return;
		const sig = JSON.stringify(state);
		if (sig === this.gitSig) return;
		this.gitSig = sig;
		this.git = state;
		this.ignoredSet = new Set(state.ignored);
		this.untrackedSet = new Set(state.untrackedDirs);
		this.host.changed();
	}

	/** List the root and the open folders again and read git again. */
	async sync(also: string[] = []): Promise<void> {
		const mine = this.gen;
		if (!this.root) return;
		const extra = new Set(also);
		const open = this.nodes
			.filter((n) => n.kind === "dir" && n.loaded && (this.expanded.has(n.id) || extra.has(n.id)))
			.map((n) => n.id);
		const sigOf = () => this.nodes.map((n) => `${n.id}:${n.kind}:${n.more ?? 0}`).sort().join("\n");
		const before = sigOf();
		await this.loadDirs([this.root, ...open]);
		if (mine !== this.gen) return;
		if (sigOf() !== before) this.host.changed();
		await this.refreshGit();
	}
}
