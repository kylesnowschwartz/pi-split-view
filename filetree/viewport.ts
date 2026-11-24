/** Scroll math for the pane's row window. */

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
