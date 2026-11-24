/**
 * Fold and follow: which folders are open and where the pane scrolls, as
 * pure functions of the tree, the marked rows and the clock.
 *
 * Opening is immediate. Closing is paced and never touches a folder above a
 * running row or a row inside its hold time.
 */

import { ancestorsOf, inside } from "./paths.ts";
import { CLOSE_INTERVAL_MS } from "./timing.ts";

export interface FoldInput {
	/** The folders open now. */
	expanded: ReadonlySet<string>;
	/** The rows of running calls and of rows inside their hold time. */
	pinned: readonly string[];
	root: string;
	/** Rows the pane can draw. */
	room: number;
	now: number;
	/** When the last automatic close pass ran. */
	lastCloseAt: number;
	/** The ids of the rows the tree draws with a given set of open folders, top to bottom. */
	rowsOf(expanded: ReadonlySet<string>): readonly string[];
}

export interface FoldResult {
	expanded: Set<string>;
	/** The folders this pass closed. */
	closed: string[];
	/** When to run the rule again because a close is due but paced; null when none is. */
	retryAt: number | null;
}

/**
 * The folders to have open.
 *
 * Every folder above a pinned row opens at once. Nothing closes while the
 * pinned rows fit in the pane together. When they do not fit, the open
 * folders between the first and the last pinned row that have no pinned row
 * below them close, all in one pass, at most once per CLOSE_INTERVAL_MS. A
 * folder above a pinned row never closes, so when the pinned rows cannot fit
 * even then, the folders stay as they are.
 */
export function foldFor(i: FoldInput): FoldResult {
	const keep = new Set<string>();
	for (const id of i.pinned) for (const dir of ancestorsOf(id, i.root)) keep.add(dir);
	const expanded = new Set(i.expanded);
	for (const dir of keep) expanded.add(dir);
	const same = (): FoldResult => ({ expanded, closed: [], retryAt: null });

	const rows = i.rowsOf(expanded);
	const pinned = new Set(i.pinned);
	let lo = -1;
	let hi = -1;
	rows.forEach((id, at) => {
		if (!pinned.has(id)) return;
		if (lo < 0) lo = at;
		hi = at;
	});
	if (lo < 0 || hi - lo + 1 <= i.room) return same();

	const closable = rows.slice(lo + 1, hi).filter((id) => expanded.has(id) && !keep.has(id));
	if (closable.length === 0) return same();
	const due = i.lastCloseAt + CLOSE_INTERVAL_MS;
	if (i.now < due) return { expanded, closed: [], retryAt: due };

	for (const dir of closable) expanded.delete(dir);
	for (const dir of [...expanded]) if (closable.some((c) => dir !== c && inside(c, dir))) expanded.delete(dir);
	return { expanded, closed: closable, retryAt: null };
}

export interface ScrollInput {
	/** The first drawn row now. */
	from: number;
	room: number;
	total: number;
	/** Row index of the newest running row, or of the newest held row when
	 * no call runs; -1 when no row is marked. */
	target: number;
	/** Row indexes of the running rows and of the rows inside their hold time. */
	running: readonly number[];
	held: readonly number[];
}

/**
 * The first drawn row. The window moves only when the target row is off
 * screen; a target that is already drawn is never re-centred. When it moves,
 * it goes to the window that holds the target and the most running rows,
 * then the most held rows, then the one nearest to where it was.
 */
export function scrollFor(i: ScrollInput): number {
	const max = Math.max(0, i.total - i.room);
	const from = Math.max(0, Math.min(max, i.from));
	if (i.target < 0 || i.target >= i.total) return from;
	if (i.target >= from && i.target < from + i.room) return from;
	const count = (list: readonly number[], at: number) =>
		list.reduce((n, row) => n + (row >= at && row < at + i.room ? 1 : 0), 0);
	let best = Math.max(0, Math.min(max, i.target));
	let bestScore: [number, number, number] = [-1, -1, 0];
	for (let at = Math.max(0, i.target - i.room + 1); at <= Math.min(max, i.target); at++) {
		const score: [number, number, number] = [count(i.running, at), count(i.held, at), -Math.abs(at - from)];
		if (
			score[0] > bestScore[0] ||
			(score[0] === bestScore[0] &&
				(score[1] > bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2])))
		) {
			best = at;
			bestScore = score;
		}
	}
	return best;
}

/** How many of `rows` sit above and below a window. */
export function offscreen(from: number, room: number, rows: readonly number[]): { above: number; below: number } {
	let above = 0;
	let below = 0;
	for (const row of rows) {
		if (row < from) above++;
		else if (row >= from + room) below++;
	}
	return { above, below };
}
