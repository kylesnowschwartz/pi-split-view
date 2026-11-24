/**
 * What the file tree may do to the world: the file system, git, and timers.
 * The tree takes one TreeIo; tests pass a fake.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";

export type FsKind = "file" | "dir" | "other";

export interface FsEntry {
	name: string;
	kind: FsKind;
	isLink: boolean;
}

export interface FsStat {
	kind: FsKind;
	mtimeMs: number;
	size: number;
}

export interface Timer {
	cancel(): void;
}

export interface ExecResult {
	code: number;
	stdout: string;
}

export interface TreeIo {
	fs: {
		list(dir: string): Promise<FsEntry[]>;
		stat(path: string): Promise<FsStat>;
		read(path: string): Promise<string>;
	};
	/** Run a command without a shell. Resolves with a nonzero code on any failure. */
	exec(argv: readonly string[], opts: { cwd: string; timeoutMs: number }): Promise<ExecResult>;
	clock: {
		now(): number;
		after(ms: number, fn: () => void): Timer;
		every(ms: number, fn: () => void): Timer;
	};
	/** The home folder, with forward slashes. */
	home: string;
}

const kindOf = (e: { isDirectory(): boolean; isFile(): boolean }): FsKind =>
	e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";

/** The TreeIo over Node's fs, child_process and timers. */
export function nodeIo(): TreeIo {
	return {
		fs: {
			async list(dir) {
				const entries = await readdir(dir, { withFileTypes: true });
				return entries.map((e) => ({
					name: e.name,
					kind: kindOf(e),
					isLink: e.isSymbolicLink(),
				}));
			},
			async stat(path) {
				const st = await stat(path);
				return { kind: kindOf(st), mtimeMs: st.mtimeMs, size: st.size };
			},
			read: (path) => readFile(path, "utf8"),
		},
		exec: (argv, opts) =>
			new Promise((resolve) => {
				const [cmd = "", ...args] = argv;
				execFile(
					cmd,
					args,
					{
						cwd: opts.cwd,
						timeout: opts.timeoutMs,
						maxBuffer: 64 * 1024 * 1024,
						env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
					},
					(err, stdout) => {
						const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
						resolve({ code, stdout: String(stdout ?? "") });
					},
				);
			}),
		clock: {
			now: () => Date.now(),
			after(ms, fn) {
				const t = setTimeout(fn, ms);
				t.unref?.();
				return { cancel: () => clearTimeout(t) };
			},
			every(ms, fn) {
				const t = setInterval(fn, ms);
				t.unref?.();
				return { cancel: () => clearInterval(t) };
			},
		},
		home: homedir().replace(/\\/g, "/"),
	};
}
