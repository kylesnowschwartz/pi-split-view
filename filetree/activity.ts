/**
 * The activity model: which rows tool calls touch right now, and which they
 * touched a moment ago. Calls are keyed by tool call id; every method takes
 * the clock value, so the model has no timers of its own.
 */

import { inside, resolve } from "./paths.ts";
import type { MarkKind, RowMark } from "./rows.ts";
import { HOLD_MS, SHIMMER_MS } from "./timing.ts";

export type Call = { id: string; tool: string; kind: MarkKind; paths: string[]; seq: number };

type Held = { kind: MarkKind; tool: string; error: boolean; since: number; until: number; seq: number };

/** A marked path: its state and the order it was marked in (higher is newer). */
export type PathMark = RowMark & { path: string; seq: number };

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
/** Argument names a tool outside pi's built-ins may carry a path in. */
const PATH_ARGS = ["path", "file_path", "filePath", "file"];

/** Result files of one search marked at most; a search that finds more marks
 * only its folder. */
export const RESULT_FILES_MAX = 12;

/** A path argument as pi's tools read it: a leading "@" dropped, "~" expanded,
 * resolved against the session directory. */
function argPath(raw: string, cwd: string, home: string): string {
	return resolve(cwd, raw.startsWith("@") ? raw.slice(1) : raw, home);
}

/** What a tool call touches: its kind and the paths under `root` it names.
 * null for a call the tree ignores: no recognisable path argument, or every
 * path outside the root. A bash call has a kind and no paths. */
export function toolTargets(
	tool: string,
	args: unknown,
	cwd: string,
	root: string,
	home: string,
): { kind: MarkKind; paths: string[] } | null {
	const name = tool.trim().toLowerCase();
	if (name === "bash") return { kind: "bash", paths: [] };
	const rec = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	let raw: string | undefined;
	if (SEARCH_TOOLS.has(name)) raw = typeof rec.path === "string" && rec.path ? rec.path : ".";
	else if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) raw = typeof rec.path === "string" ? rec.path : undefined;
	else raw = PATH_ARGS.map((k) => rec[k]).find((v): v is string => typeof v === "string" && v !== "");
	if (!raw) return null;
	const path = argPath(raw, cwd, home);
	if (!inside(root, path)) return null;
	return { kind: WRITE_TOOLS.has(name) ? "write" : "read", paths: [path] };
}

/** The text of a tool result. */
export function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: unknown } | null | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}

/** The files a finished `find` or `grep` names, relative to its search
 * folder; [] for any other tool, for no result, and for more than
 * RESULT_FILES_MAX files. `find` prints one path per line; `grep` prints
 * `path:line: text` per match. Both end with an optional blank line and a
 * bracketed notice. */
export function resultFiles(tool: string, text: string): string[] {
	const name = tool.trim().toLowerCase();
	if (name !== "find" && name !== "grep") return [];
	const out = new Set<string>();
	for (const line of text.split("\n")) {
		if (name === "find") {
			if (!line.trim()) break;
			if (line === "No files found matching pattern") return [];
			out.add(line.replace(/\/$/, ""));
		} else {
			const m = /^(.+?):\d+: /.exec(line);
			if (m?.[1]) out.add(m[1]);
		}
		if (out.size > RESULT_FILES_MAX) return [];
	}
	return [...out];
}

export class Activity {
	private readonly calls = new Map<string, Call>();
	private readonly held = new Map<string, Held>();
	private seq = 0;

	/** A call started. A second start of the same id replaces the first. */
	start(id: string, tool: string, kind: MarkKind, paths: string[]): Call {
		const call: Call = { id, tool, kind, paths, seq: ++this.seq };
		this.calls.set(id, call);
		return call;
	}

	/** A call ended: its paths hold their tone until `now + HOLD_MS`. Returns
	 * the call, or undefined for an end with no start. */
	end(id: string, isError: boolean, now: number): Call | undefined {
		const call = this.calls.get(id);
		if (!call) return undefined;
		this.calls.delete(id);
		this.mark(call.paths, call.kind, call.tool, now, isError);
		return call;
	}

	/** Hold `paths` in a tone from now, with no call behind them. */
	mark(paths: string[], kind: MarkKind, tool: string, now: number, error = false): void {
		for (const path of paths)
			this.held.set(path, { kind, tool, error, since: now, until: now + HOLD_MS, seq: ++this.seq });
	}

	/** Drop the holds that have run out. True when one did. */
	expire(now: number): boolean {
		let changed = false;
		for (const [path, h] of this.held) {
			if (h.until > now) continue;
			this.held.delete(path);
			changed = true;
		}
		return changed;
	}

	/** When the next hold runs out. */
	nextExpiry(): number | undefined {
		let next: number | undefined;
		for (const h of this.held.values()) if (next === undefined || h.until < next) next = h.until;
		return next;
	}

	/** The paths a write-kind call names that are running or inside their
	 * hold at `now`. */
	written(now: number): Set<string> {
		const out = new Set<string>();
		for (const [path, h] of this.held) if (h.kind === "write" && h.until > now) out.add(path);
		for (const c of this.calls.values()) if (c.kind === "write") for (const path of c.paths) out.add(path);
		return out;
	}

	/** Whether a running call names a path. */
	hasRunning(): boolean {
		for (const c of this.calls.values()) if (c.paths.length > 0) return true;
		return false;
	}

	/** Whether a row's name moves at `now`: a running call names a path, or a
	 * held path is inside its shimmer time. */
	animating(now: number): boolean {
		if (this.hasRunning()) return true;
		for (const h of this.held.values()) if (h.until > now && now - h.since < SHIMMER_MS) return true;
		return false;
	}

	/** Every marked path at `now`, oldest mark first. A path that a running
	 * call names is running, whatever ended on it before; among running calls
	 * on one path the newest gives the tool. */
	marks(now: number): PathMark[] {
		const out = new Map<string, PathMark>();
		for (const [path, h] of this.held) {
			if (h.until <= now) continue;
			out.set(path, {
				path,
				state: "recent",
				kind: h.kind,
				tool: h.tool,
				error: h.error,
				shimmer: now - h.since < SHIMMER_MS,
				seq: h.seq,
			});
		}
		for (const c of this.calls.values()) {
			for (const path of c.paths) {
				const cur = out.get(path);
				if (cur?.state === "running" && cur.seq > c.seq) continue;
				out.set(path, { path, state: "running", kind: c.kind, tool: c.tool, error: false, shimmer: true, seq: c.seq });
			}
		}
		return [...out.values()].sort((a, b) => a.seq - b.seq);
	}

	clear(): void {
		this.calls.clear();
		this.held.clear();
	}
}
