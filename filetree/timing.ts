/** The times that pace the tree, in milliseconds. */

/** How long a row keeps its steady tone after the call that touched it ends,
 * however short the call was. A folder above such a row is not closed. */
export const HOLD_MS = 12_000;

/** How long a row's name shimmers after a call touches it. A call that runs
 * longer shimmers until it ends. */
export const SHIMMER_MS = 3_000;

/** The least time between two automatic close passes of the fold rule. */
export const CLOSE_INTERVAL_MS = 2_000;

/** The redraw interval of the running-row animation. */
export const TICK_MS = 120;

/** The interval of the poll that checks the repo's index and HEAD. */
export const GIT_POLL_MS = 2_000;

/** Every this many polls the tree syncs even when the index and HEAD are
 * unchanged, so edits made outside pi to working files show too. */
export const FULL_SYNC_POLLS = 5;
