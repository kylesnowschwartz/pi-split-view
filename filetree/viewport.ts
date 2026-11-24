/** Geometry of the pane: its width limits and the scroll math of its row window. */

/** The scroll thumb over `track` rows for a window starting at `from` of
 * `total` rows; null when every row is drawn. */
export function thumbOf(
	track: number,
	from: number,
	total: number,
): { top: number; size: number } | null {
	if (track <= 0 || total <= track) return null;
	const size = Math.max(1, Math.round((track * track) / total));
	const max = total - track;
	return { top: Math.round((Math.min(Math.max(0, from), max) / max) * (track - size)), size };
}

/** The scroll position after a wheel turn of `by` rows. */
export function scrolledBy(from: number, by: number, total: number, room: number): number {
	return Math.max(0, Math.min(Math.max(0, total - room), from + by));
}

export const DEFAULT_TREE_WIDTH = 36;
export const MIN_TREE_WIDTH = 24;
export const MAX_TREE_WIDTH = 80;
/** Columns the stack left of the pane keeps; the pane shrinks, then hides,
 * before the stack gets narrower than this. */
export const MIN_STACK_COLS = 76;
/** Narrowest terminal that shows the pane. */
export const MIN_TREE_COLS = MIN_STACK_COLS + MIN_TREE_WIDTH;

/** Clamp a requested pane width to the limits. */
export function clampTreeWidth(width: number): number {
	return Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, Math.round(width)));
}

/** Whether a terminal of `cols` columns has room for the pane. */
export function treeFits(cols: number): boolean {
	return cols >= MIN_TREE_COLS;
}

/** The pane width a drag to `width` gives on a terminal of `cols` columns:
 * within the limits, and leaving the stack its minimum. */
export function paneWidthFor(width: number, cols: number): number {
	return Math.min(clampTreeWidth(width), Math.max(MIN_TREE_WIDTH, cols - MIN_STACK_COLS));
}
