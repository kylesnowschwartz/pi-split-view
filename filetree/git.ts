/** Git for the tree: status and numstat parsing, the refresh that reads
 * them, the diff of two reads, and the poll that notices outside changes. */

import type { TreeIo, Timer } from "./io.ts";
import { dirname, join, resolve } from "./paths.ts";
import { FULL_SYNC_POLLS, GIT_POLL_MS } from "./timing.ts";

export type Branch = { head: string; upstream: string; ahead: number; behind: number };

/** A git status letter: U unmerged, D deleted, M modified, T type changed,
 * R renamed, C copied, A added, ? untracked. */
export type GitLetter = "U" | "D" | "M" | "T" | "R" | "C" | "A" | "?";

export type LineCounts = { added: number; removed: number };

export type Change = "new" | "mod" | "del";

export type GitStatus = {
	git: Record<string, GitLetter>;
	folderStatus: Record<string, GitLetter>;
	ignored: string[];
	untrackedDirs: string[];
	branch: Branch | null;
	files: Record<string, Change>;
};

export function parseBranch(record: string): Branch {
	const body = record.replace(/^## /, "");
	if (body.startsWith("HEAD (no branch)")) return { head: "detached", upstream: "", ahead: 0, behind: 0 };
	const head = body.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|\s|$)/)?.[1] ?? body;
	const upstream = body.match(/\.\.\.(\S+)/)?.[1] ?? "";
	const ahead = Number(body.match(/ahead (\d+)/)?.[1] ?? 0);
	const behind = Number(body.match(/behind (\d+)/)?.[1] ?? 0);
	return { head, upstream, ahead, behind };
}

/** Maps a path git prints (relative to the repo top) to a tree path; null
 * for a path outside the tree root. `prefix` is the root's path below the top. */
export function mapper(root: string, prefix: string): (rel: string) => string | null {
	return (rel) =>
		rel.startsWith(prefix)
			? join(root, rel.slice(prefix.length).replace(/\/$/, "")).replace(/\/$/, "")
			: null;
}

const PRIORITY: GitLetter[] = ["U", "D", "M", "T", "R", "C", "A", "?"];
/** The order a folder's one letter is picked in: conflicts first, then untracked files, then edits. */
const FOLDER_PRIORITY: GitLetter[] = ["U", "?", "M", "A", "D", "T", "R", "C"];

export function stronger(a: GitLetter | undefined, b: GitLetter, order = PRIORITY): GitLetter {
	if (!a) return b;
	return order.indexOf(b) < order.indexOf(a) ? b : a;
}

/** Parse `git status --porcelain=v1 -b -z`. */
export function parseGit(stdout: string, root: string, prefix: string): GitStatus {
	const map = mapper(root, prefix);
	const git: Record<string, GitLetter> = {};
	const folderStatus: Record<string, GitLetter> = {};
	const ignored: string[] = [];
	const untrackedDirs: string[] = [];
	const files: Record<string, Change> = {};
	let branch: Branch | null = null;
	const parts = stdout.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i] ?? "";
		if (rec.startsWith("## ")) {
			branch = parseBranch(rec);
			continue;
		}
		if (rec.length < 4) continue;
		const xy = rec.slice(0, 2);
		const raw = rec.slice(3);
		if (xy[0] === "R" || xy[0] === "C") i++;
		const path = map(raw);
		if (!path) continue;
		if (xy === "!!") {
			ignored.push(path);
			continue;
		}
		if (xy === "??" && raw.endsWith("/")) untrackedDirs.push(path);
		else
			files[path] =
				xy === "??" || (xy.includes("A") && !xy.includes("D"))
					? "new"
					: xy.includes("D") && !/U/.test(xy)
						? "del"
						: "mod";
		const letter: GitLetter | "" =
			xy === "??"
				? "?"
				: /U/.test(xy) || xy === "AA" || xy === "DD"
					? "U"
					: ((["D", "M", "R", "C", "A", "T"] as const).find((c) => xy.includes(c)) ?? "");
		if (!letter) continue;
		git[path] = stronger(git[path], letter);
		folderStatus[path] = stronger(folderStatus[path], letter, FOLDER_PRIORITY);
		let dir = dirname(path);
		while (dir.length >= root.length && (dir !== "/" || root === "/")) {
			git[dir] = stronger(git[dir], letter);
			folderStatus[dir] = stronger(folderStatus[dir], letter, FOLDER_PRIORITY);
			if (dir === root) break;
			dir = dirname(dir);
		}
	}
	return { git, folderStatus, ignored, untrackedDirs, branch, files };
}

/** Parse `git diff --numstat -z` into `into`, summing per path. */
export function parseNumstat(
	stdout: string,
	root: string,
	prefix: string,
	into: Record<string, LineCounts>,
): void {
	const map = mapper(root, prefix);
	const parts = stdout.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i] ?? "";
		if (!rec) continue;
		const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
		if (!m) continue;
		let path = m[3] ?? "";
		if (path === "") {
			i += 2;
			path = parts[i] ?? "";
		}
		if (!path) continue;
		const add = m[1] === "-" ? 0 : Number(m[1]);
		const del = m[2] === "-" ? 0 : Number(m[2]);
		const abs = map(path);
		if (!abs) continue;
		const prev = into[abs] ?? { added: 0, removed: 0 };
		into[abs] = { added: prev.added + add, removed: prev.removed + del };
	}
}

/** Per-file line counts, with each folder above a file carrying the sum below it. */
export function rollUp(diff: Record<string, LineCounts>, root: string): Record<string, LineCounts> {
	const out: Record<string, LineCounts> = { ...diff };
	for (const [path, { added, removed }] of Object.entries(diff)) {
		let dir = dirname(path);
		while (dir.length >= root.length && (dir !== "/" || root === "/")) {
			const prev = out[dir] ?? { added: 0, removed: 0 };
			out[dir] = { added: prev.added + added, removed: prev.removed + removed };
			if (dir === root) break;
			dir = dirname(dir);
		}
	}
	return out;
}

/** One read of the repo, as the tree shows it. */
export type GitState = {
	/** The repo's top level; "" when the tree root is not in a repo. */
	top: string;
	/** The tree root's path below the top, with a trailing slash; "" at the top. */
	prefix: string;
	branch: Branch | null;
	git: Record<string, GitLetter>;
	folderStatus: Record<string, GitLetter>;
	ignored: string[];
	untrackedDirs: string[];
	/** Lines added and removed against HEAD per file (a new file's lines count
	 * as added), summed into each folder above it. */
	diff: Record<string, LineCounts>;
	/** One signature per changed file: its change, line counts, modification
	 * time and size. Two reads differ for a file exactly when its signature does. */
	files: Record<string, string>;
};

export const NO_GIT: GitState = {
	top: "",
	prefix: "",
	branch: null,
	git: {},
	folderStatus: {},
	ignored: [],
	untrackedDirs: [],
	diff: {},
	files: {},
};

/** The files whose status, line counts or content stamp differ between two
 * reads: changed, newly changed, and no longer changed (committed or reverted). */
export function changedBetween(before: Record<string, string>, after: Record<string, string>): string[] {
	const out: string[] = [];
	for (const [path, sig] of Object.entries(after)) if (before[path] !== sig) out.push(path);
	for (const path of Object.keys(before)) if (!(path in after)) out.push(path);
	return out.sort();
}

// Changed files are stamped, and new files have their lines counted, only up
// to these limits: how many files, how large a file, how many at once.
const FILES_STAMPED = 400;
const NEW_FILES_COUNTED = 200;
const NEW_FILE_MAX_BYTES = 256 * 1024;
const PARALLEL = 8;

type Counted = { mtimeMs: number; size: number; lines: number };

async function each<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	const worker = async () => {
		for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
	};
	await Promise.all(Array.from({ length: PARALLEL }, worker));
}

export function git(io: Pick<TreeIo, "exec">, cwd: string, args: string[], timeoutMs = 20_000) {
	return io.exec(["git", "--no-optional-locks", "-C", cwd, ...args], { cwd, timeoutMs });
}

/** Reads the repo around `root`; calls made while a read runs share one
 * follow-up read, so reads never overlap. */
export function createRefresher(io: Pick<TreeIo, "exec" | "fs">) {
	let run: Promise<GitState> | null = null;
	let next: Promise<GitState> | null = null;
	let counted = new Map<string, Counted>();

	async function read(root: string): Promise<GitState> {
		try {
			const where = await git(io, root, ["rev-parse", "--show-prefix", "--show-toplevel"], 5_000);
			if (where.code !== 0) return NO_GIT;
			const [p = "", tl = ""] = where.stdout.split("\n");
			const prefix = p.trim();
			const top = tl.trim();
			if (!top) return NO_GIT;
			const status = await git(io, root, [
				"status",
				"--porcelain=v1",
				"-b",
				"-z",
				"--ignored=traditional",
				"--untracked-files=normal",
				"--",
				".",
			]);
			if (status.code !== 0) return { ...NO_GIT, top, prefix };
			const parsed = parseGit(status.stdout, root, prefix);
			const diff: Record<string, LineCounts> = {};
			const head = await git(io, root, ["diff", "HEAD", "--numstat", "-z", "--", "."]);
			if (head.code === 0) parseNumstat(head.stdout, root, prefix, diff);
			const changes = { ...parsed.files };
			if (parsed.untrackedDirs.length) {
				const others = await git(io, root, [
					"ls-files",
					"-o",
					"--exclude-standard",
					"-z",
					"--",
					...parsed.untrackedDirs.map((d) => d.slice(root.length + 1) || "."),
				]);
				if (others.code === 0)
					for (const rel of others.stdout.split("\0").filter(Boolean)) changes[join(root, rel)] = "new";
			}

			// Stamp each changed file, and count the lines of each new one that
			// git's numstat does not cover (untracked files).
			const seen = new Map<string, Counted>();
			const stamps: Record<string, string> = {};
			let countedNew = 0;
			await each(Object.keys(changes).slice(0, FILES_STAMPED), async (path) => {
				try {
					const st = await io.fs.stat(path);
					stamps[path] = `${st.mtimeMs}:${st.size}`;
					if (changes[path] !== "new" || path in diff || st.kind !== "file") return;
					if (st.size > NEW_FILE_MAX_BYTES || countedNew >= NEW_FILES_COUNTED) return;
					countedNew++;
					const prev = counted.get(path);
					let lines = prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size ? prev.lines : -1;
					if (lines < 0) {
						const text = await io.fs.read(path);
						lines =
							text.includes("\0") || text.length === 0
								? 0
								: text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
					}
					seen.set(path, { mtimeMs: st.mtimeMs, size: st.size, lines });
					if (lines > 0) diff[path] = { added: lines, removed: 0 };
				} catch {
					stamps[path] = "gone";
				}
			});
			counted = seen;

			const files: Record<string, string> = {};
			for (const [path, change] of Object.entries(changes)) {
				const c = diff[path];
				files[path] = `${change}:${c?.added ?? 0}:${c?.removed ?? 0}:${stamps[path] ?? ""}`;
			}
			return {
				top,
				prefix,
				branch: parsed.branch,
				git: parsed.git,
				folderStatus: parsed.folderStatus,
				ignored: parsed.ignored,
				untrackedDirs: parsed.untrackedDirs,
				diff: rollUp(diff, root),
				files,
			};
		} catch {
			return NO_GIT;
		}
	}

	function refresh(root: string): Promise<GitState> {
		if (!run) {
			run = read(root).finally(() => {
				run = null;
			});
			return run;
		}
		const rerun = () => {
			next = null;
			return refresh(root);
		};
		next ??= run.then(rerun, rerun);
		return next;
	}

	return { refresh };
}

/** The git dir above `cwd`: a .git folder, or the one a .git file points to; "" when there is none. */
async function gitDir(io: Pick<TreeIo, "fs">, cwd: string, home: string): Promise<string> {
	for (let dir = cwd, i = 0; i < 64; i++) {
		try {
			const dot = join(dir, ".git");
			const st = await io.fs.stat(dot);
			if (st.kind === "dir") return dot;
			const ref = /^gitdir:\s*(.+)$/m.exec(String(await io.fs.read(dot)))?.[1]?.trim();
			if (ref) return resolve(dir, ref, home);
		} catch {
			const up = dirname(dir);
			if (up === dir) return "";
			dir = up;
			continue;
		}
		return "";
	}
	return "";
}

/** The index's and HEAD's modification times as one value; a file that cannot be read counts as missing. */
async function stamp(io: Pick<TreeIo, "fs">, dir: string): Promise<string> {
	const times = await Promise.all(
		["index", "HEAD"].map((name) =>
			io.fs.stat(join(dir, name)).then(
				(st) => String(st.mtimeMs),
				() => "missing",
			),
		),
	);
	return times.join(":");
}

/** Polls the repo at `top` and calls `sync` when its index or HEAD changes
 * (a commit, checkout or stash) and on every FULL_SYNC_POLLS-th poll. A poll
 * is skipped while `idle()` is true or the last sync still runs. */
export function createGitWatch(
	io: Pick<TreeIo, "fs" | "clock" | "home">,
	sync: () => Promise<void>,
	idle: () => boolean,
) {
	let poll: Timer | null = null;
	let generation = 0;

	function stop(): void {
		generation += 1;
		poll?.cancel();
		poll = null;
	}

	async function restart(top: string): Promise<void> {
		stop();
		const mine = generation;
		const dir = top ? await gitDir(io, top, io.home) : "";
		if (mine !== generation) return;
		let last = dir ? await stamp(io, dir) : "";
		if (mine !== generation) return;
		let ticking = false;
		let polls = 0;
		poll = io.clock.every(GIT_POLL_MS, () => {
			if (ticking || idle()) return;
			ticking = true;
			void (async () => {
				polls += 1;
				const now = dir ? await stamp(io, dir) : "";
				if (mine !== generation) return;
				if (now === last && polls % FULL_SYNC_POLLS !== 0) return;
				last = now;
				await sync();
			})()
				.catch(() => undefined)
				.finally(() => {
					ticking = false;
				});
		});
	}

	return { restart, stop };
}
