/** A fake TreeIo for the file tree tests: a file system, git output and a
 * clock the test moves by hand. */

import type { ExecResult, FsEntry, FsStat, Timer, TreeIo } from "../filetree/io.ts";

export type World = {
	/** Each folder's entries: [name, kind]. */
	dirs: Record<string, [string, "file" | "dir"][]>;
	/** Folders that exist but cannot be listed. */
	denied?: string[];
	/** File contents by path. */
	files?: Record<string, string>;
	mtimes?: Record<string, number>;
	/** The repo's top level; "" for no repo. */
	top?: string;
	status?: string;
	numstat?: string;
	/** Output of `git ls-files -o`. */
	others?: string;
	/** Listings of a folder that wait: one gate per coming list call. */
	gates?: Record<string, Promise<void>[]>;
};

export type FakeIo = TreeIo & {
	/** Every argv run, in order. */
	ran: string[][];
	/** Folders listed, in order. */
	listed: string[];
	/** Move the clock and fire the timers that fall due. */
	advance(ms: number): void;
	pending(): number;
};

export function fakeIo(w: World, now = 1_000_000): FakeIo {
	let time = now;
	let seq = 0;
	const timers = new Map<number, { at: number; every: number; fn: () => void }>();
	const add = (ms: number, every: number, fn: () => void): Timer => {
		const id = ++seq;
		timers.set(id, { at: time + ms, every, fn });
		return { cancel: () => void timers.delete(id) };
	};
	const ran: string[][] = [];
	const listed: string[] = [];
	return {
		ran,
		listed,
		home: "/home/me",
		fs: {
			async list(dir): Promise<FsEntry[]> {
				listed.push(dir);
				const gate = w.gates?.[dir]?.shift();
				// Read the entries before waiting, as a slow disk read would.
				const kids = w.dirs[dir];
				const denied = w.denied?.includes(dir);
				if (gate) await gate;
				if (denied) throw new Error(`EACCES: permission denied, scandir '${dir}'`);
				if (!kids) throw new Error(`ENOENT ${dir}`);
				return kids.map(([name, kind]) => ({ name, kind, isLink: false }));
			},
			async stat(path): Promise<FsStat> {
				if (w.dirs[path] || w.denied?.includes(path)) return { kind: "dir", mtimeMs: 1, size: 0 };
				const text = w.files?.[path];
				if (text === undefined) throw new Error(`ENOENT ${path}`);
				return { kind: "file", mtimeMs: w.mtimes?.[path] ?? 1, size: text.length };
			},
			async read(path): Promise<string> {
				const text = w.files?.[path];
				if (text === undefined) throw new Error(`ENOENT ${path}`);
				return text;
			},
		},
		async exec(argv): Promise<ExecResult> {
			ran.push([...argv]);
			const args = argv.slice(4);
			if (args[0] === "rev-parse")
				return w.top ? { code: 0, stdout: `\n${w.top}\n` } : { code: 128, stdout: "" };
			if (args[0] === "status") return { code: 0, stdout: w.status ?? "" };
			if (args[0] === "diff") return { code: 0, stdout: w.numstat ?? "" };
			if (args[0] === "ls-files") return { code: 0, stdout: w.others ?? "" };
			return { code: 1, stdout: "" };
		},
		clock: {
			now: () => time,
			after: (ms, fn) => add(ms, 0, fn),
			every: (ms, fn) => add(ms, ms, fn),
		},
		advance(ms) {
			const end = time + ms;
			for (;;) {
				let next: [number, { at: number; every: number; fn: () => void }] | undefined;
				for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
				if (!next) break;
				time = next[1].at;
				if (next[1].every) next[1].at += next[1].every;
				else timers.delete(next[0]);
				next[1].fn();
			}
			time = end;
		},
		pending: () => timers.size,
	};
}

/** Let queued promise callbacks run. */
export async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}
