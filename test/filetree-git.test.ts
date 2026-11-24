import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBranch, parseGit, parseNumstat, rollUp } from "../filetree/git.ts";

const ROOT = "/r";

/** Every key of `want` has the same value in `got`. */
function matches(got: Record<string, unknown>, want: Record<string, unknown>): void {
	for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, k);
}
type LineCounts = Record<string, { added: number; removed: number }>;

test('a branch line gives the head, its upstream, and how far ahead and behind it is', () => {
	assert.deepEqual(parseBranch('## main...origin/main [ahead 2, behind 1]'), { head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
	assert.deepEqual(parseBranch('## feature/x...origin/feature/x [gone]'), { head: 'feature/x', upstream: 'origin/feature/x', ahead: 0, behind: 0 });
});

test('a branch with no upstream has an empty upstream and no counts', () => {
	assert.deepEqual(parseBranch('## main'), { head: 'main', upstream: '', ahead: 0, behind: 0 });
});

test('a detached HEAD reads as detached', () => {
	assert.deepEqual(parseBranch('## HEAD (no branch)'), { head: 'detached', upstream: '', ahead: 0, behind: 0 });
});

test('a branch with no commits yet is named without the git preamble', () => {
	assert.equal(parseBranch('## No commits yet on main').head, 'main');
	assert.equal(parseBranch('## Initial commit on dev').head, 'dev');
});

test('git status letters land on each file and the strongest one rolls up to every folder above it', () => {
	const status = parseGit('## main\0 M src/a.ts\0 M src/lib/b.ts\0?? notes.md\0', ROOT, '');
	assert.deepEqual(status.branch, { head: 'main', upstream: '', ahead: 0, behind: 0 });
	assert.deepEqual(status.git, { '/r/src/a.ts': 'M', '/r/src/lib/b.ts': 'M', '/r/src/lib': 'M', '/r/src': 'M', '/r/notes.md': '?', '/r': 'M' });
	assert.deepEqual(status.files, { '/r/src/a.ts': 'mod', '/r/src/lib/b.ts': 'mod', '/r/notes.md': 'new' });
});

test('a conflict outranks every other letter on the folders above it', () => {
	const status = parseGit(' M a.ts\0UU conflict.ts\0', ROOT, '');
	assert.equal(status.git['/r/conflict.ts'], 'U');
	assert.equal(status.git['/r'], 'U');
	assert.equal(status.files['/r/conflict.ts'], 'mod');
});

test('each folder takes one letter from what is below it: a conflict, then untracked, modified, added, deleted', () => {
	const status = parseGit(' D a/gone.ts\0A  a/b/new.ts\0 M a/b/c/x.ts\0?? a/b/c/d/y.ts\0UU a/b/c/d/e/z.ts\0', ROOT, '');
	matches(status.folderStatus, { '/r': 'U', '/r/a/b/c/d/e': 'U', '/r/a/b/c/d/y.ts': '?' });
	const plain = parseGit(' D a/gone.ts\0A  a/b/new.ts\0 M a/b/c/x.ts\0?? a/b/c/d/y.ts\0', ROOT, '');
	matches(plain.folderStatus, { '/r/a': '?', '/r/a/b/c/d': '?' });
	matches(parseGit(' D a/gone.ts\0A  a/b/new.ts\0 M a/b/c/x.ts\0', ROOT, '').folderStatus, { '/r/a': 'M', '/r/a/b/c': 'M' });
	matches(parseGit(' D a/gone.ts\0A  a/b/new.ts\0', ROOT, '').folderStatus, { '/r/a': 'A', '/r/a/b': 'A' });
	assert.equal(parseGit(' D a/gone.ts\0R  a/b.ts\0old.ts\0', ROOT, '').folderStatus['/r/a'], 'D');
	assert.equal(plain.git['/r/a'], 'D');
});

test('added files count as new, deleted files as deleted, and an added file deleted again as deleted', () => {
	const status = parseGit('A  c.ts\0 D gone.ts\0AD x.ts\0', ROOT, '');
	assert.deepEqual(status.files, { '/r/c.ts': 'new', '/r/gone.ts': 'del', '/r/x.ts': 'del' });
	assert.equal(status.git['/r/c.ts'], 'A');
	assert.equal(status.git['/r/x.ts'], 'D');
});

test('a rename takes the new path and skips the old path record that follows it', () => {
	const status = parseGit('R  new.ts\0old.ts\0 M a.ts\0', ROOT, '');
	assert.equal(status.git['/r/new.ts'], 'R');
	assert.equal(status.git['/r/old.ts'], undefined);
	assert.equal(status.git['/r/a.ts'], 'M');
});

test('an untracked folder is listed as untracked without a file entry, and ignored paths are listed apart', () => {
	const status = parseGit('?? new/\0!! dist/\0', ROOT, '');
	assert.deepEqual(status.untrackedDirs, ['/r/new']);
	assert.deepEqual(status.ignored, ['/r/dist']);
	assert.deepEqual(status.files, {});
	assert.equal(status.git['/r/new'], '?');
	assert.equal(status.git['/r/dist'], undefined);
});

test('in a tree rooted below the repo top, only paths under the prefix map into the tree', () => {
	const status = parseGit(' M sub/a.ts\0 M other/b.ts\0', '/r/sub', 'sub/');
	assert.deepEqual(status.git, { '/r/sub/a.ts': 'M', '/r/sub': 'M' });
	assert.equal(status.branch, null);
});

test('numstat adds line counts per file, binary files count as zero, and a rename counts on its new path', () => {
	const counts: LineCounts = {};
	parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '2\t0\t\0old.ts\0new.ts\0' + '1\t1\tsrc/a.ts\0', ROOT, '', counts);
	assert.deepEqual(counts, { '/r/src/a.ts': { added: 4, removed: 2 }, '/r/img.png': { added: 0, removed: 0 }, '/r/new.ts': { added: 2, removed: 0 } });
});

test('numstat skips records outside the prefix and records it cannot read', () => {
	const counts: LineCounts = {};
	parseNumstat('3\t1\tsub/a.ts\0 4\t4\tother/b.ts\0garbage\0', '/r/sub', 'sub/', counts);
	assert.deepEqual(counts, { '/r/sub/a.ts': { added: 3, removed: 1 } });
});

test('rolling up line counts sums every file into each folder above it, up to the tree root', () => {
	const rolled = rollUp({ '/r/src/a.ts': { added: 3, removed: 1 }, '/r/src/lib/b.ts': { added: 2, removed: 2 }, '/r/c.ts': { added: 1, removed: 0 } }, ROOT);
	assert.deepEqual(rolled, { '/r/src/a.ts': { added: 3, removed: 1 }, '/r/src/lib/b.ts': { added: 2, removed: 2 }, '/r/c.ts': { added: 1, removed: 0 }, '/r/src/lib': { added: 2, removed: 2 }, '/r/src': { added: 5, removed: 3 }, '/r': { added: 6, removed: 3 } });
});

test('rolling up leaves the file counts it was given unchanged', () => {
	const counts: LineCounts = { '/r/a.ts': { added: 1, removed: 1 } };
	rollUp(counts, ROOT);
	assert.deepEqual(counts, { '/r/a.ts': { added: 1, removed: 1 } });
});

test('a tree rooted at the file system root rolls totals and letters up to the root itself', () => {
	assert.deepEqual(rollUp({ '/a.ts': { added: 1, removed: 1 }, '/src/b.ts': { added: 2, removed: 0 } }, '/'), { '/a.ts': { added: 1, removed: 1 }, '/src/b.ts': { added: 2, removed: 0 }, '/src': { added: 2, removed: 0 }, '/': { added: 3, removed: 1 } });
	assert.deepEqual(parseGit(' M a.ts\0', '/', '').git, { '/a.ts': 'M', '/': 'M' });
});
