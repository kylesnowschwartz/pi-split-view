import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeConfig } from "../ui-panels-config.ts";

test("tree config: absent key reads as empty, so the pane uses its defaults", () => {
	assert.deepEqual(normalizeConfig({}).tree, {});
});

test("tree config: well-typed fields are kept", () => {
	assert.deepEqual(normalizeConfig({ tree: { open: false, width: 42 } }).tree, {
		open: false,
		width: 42,
	});
});

test("tree config: wrongly typed fields and shapes are dropped", () => {
	const bad = [
		{ tree: null },
		{ tree: [] },
		{ tree: "on" },
		{ tree: { open: "yes", width: "40" } },
		{ tree: { open: 1, width: Number.NaN } },
		{ tree: { width: Number.POSITIVE_INFINITY } },
	];
	for (const raw of bad) assert.deepEqual(normalizeConfig(raw as never).tree, {}, JSON.stringify(raw));
	assert.deepEqual(normalizeConfig({ tree: { open: true, width: "x" } } as never).tree, { open: true });
});

test("tree config: a non-object root still yields the tree key", () => {
	assert.deepEqual(normalizeConfig(null as never).tree, {});
});
