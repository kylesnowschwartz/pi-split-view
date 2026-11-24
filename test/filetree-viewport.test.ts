import assert from "node:assert/strict";
import { test } from "node:test";
import { scrolledBy, thumbOf } from "../filetree/viewport.ts";

test("thumbOf: no thumb when every row is drawn", () => {
	assert.equal(thumbOf(10, 0, 10), null);
	assert.equal(thumbOf(10, 0, 3), null);
	assert.equal(thumbOf(0, 0, 50), null);
});

test("thumbOf: thumb spans the track from top to bottom", () => {
	assert.deepEqual(thumbOf(10, 0, 100), { top: 0, size: 1 });
	assert.deepEqual(thumbOf(10, 90, 100), { top: 9, size: 1 });
	assert.deepEqual(thumbOf(10, 5, 20), { top: 3, size: 5 });
	assert.deepEqual(thumbOf(10, 999, 20), { top: 5, size: 5 });
});

test("scrolledBy: clamps to the first and last window", () => {
	assert.equal(scrolledBy(0, -3, 50, 10), 0);
	assert.equal(scrolledBy(5, 3, 50, 10), 8);
	assert.equal(scrolledBy(38, 9, 50, 10), 40);
	assert.equal(scrolledBy(4, 3, 8, 10), 0);
});
