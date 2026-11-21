import test from "node:test";
import assert from "node:assert/strict";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	initToolHighlighter,
	isTreeSitterReady,
	languageForPathOrName,
	highlightCodeTreeSitter,
	highlightBashCommand,
	highlightCliOutputLine,
	highlightCliOutput,
	isLightTheme,
} from "../tool-highlighter.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/**
 * Minimal deterministic mock Theme that tags each semantic token with a unique
 * ANSI SGR code so tests can assert exact color assignments AND lossless
 * ANSI-stripped round-trips.
 */
const TOKEN_SGR: Record<string, string> = {
	success: "\x1b[32m",
	error: "\x1b[31m",
	warning: "\x1b[33m",
	mdLink: "\x1b[36m",
	mdCode: "\x1b[35m",
	dim: "\x1b[2m",
	accent: "\x1b[34m",
	syntaxFunction: "\x1b[94m",
	syntaxString: "\x1b[92m",
	syntaxOperator: "\x1b[96m",
	syntaxVariable: "\x1b[91m",
	syntaxNumber: "\x1b[93m",
};

function makeMockTheme(appearance: "dark" | "light" = "dark"): Theme {
	return {
		appearance,
		fg(color: ThemeColor, text: string): string {
			const code = TOKEN_SGR[color] ?? "\x1b[37m";
			return `${code}${text}\x1b[0m`;
		},
		bold(text: string): string {
			return `\x1b[1m${text}\x1b[22m`;
		},
	} as unknown as Theme;
}

test("languageForPathOrName maps common extensions, paths, and aliases", () => {
	assert.equal(languageForPathOrName("split-view.ts"), "typescript");
	assert.equal(languageForPathOrName("/abs/path/App.tsx"), "typescript");
	assert.equal(languageForPathOrName("mod.mts"), "typescript");
	assert.equal(languageForPathOrName("mod.cts"), "typescript");
	assert.equal(languageForPathOrName("index.js"), "javascript");
	assert.equal(languageForPathOrName("App.jsx"), "javascript");
	assert.equal(languageForPathOrName("util.mjs"), "javascript");
	assert.equal(languageForPathOrName("util.cjs"), "javascript");
	assert.equal(languageForPathOrName("script.sh"), "bash");
	assert.equal(languageForPathOrName("init.zsh"), "bash");
	assert.equal(languageForPathOrName("bash"), "bash");
	assert.equal(languageForPathOrName("app.rb"), "ruby");
	assert.equal(languageForPathOrName("tasks.rake"), "ruby");
	assert.equal(languageForPathOrName("foo.gemspec"), "ruby");
	assert.equal(languageForPathOrName("main.go"), "go");
	assert.equal(languageForPathOrName("train.py"), "python");
	assert.equal(languageForPathOrName("lib.rs"), "rust");
	assert.equal(languageForPathOrName("package.json"), "json");
	assert.equal(languageForPathOrName("events.jsonl"), "json");
	assert.equal(languageForPathOrName("tsconfig.jsonc"), "json");
	assert.equal(languageForPathOrName("changes.diff"), "diff");
	assert.equal(languageForPathOrName("fix.patch"), "diff");
	assert.equal(languageForPathOrName("README.md"), "markdown");
	assert.equal(languageForPathOrName("config.yml"), "yaml");
	assert.equal(languageForPathOrName("config.yaml"), "yaml");
	assert.equal(languageForPathOrName("regex"), "regex");

	// Unsupported / empty inputs return null.
	assert.equal(languageForPathOrName(undefined), null);
	assert.equal(languageForPathOrName(""), null);
	assert.equal(languageForPathOrName("image.png"), null);
	assert.equal(languageForPathOrName("notes.txt"), null);
	assert.equal(languageForPathOrName("binary.wasm"), null);
});

test("isLightTheme detects light appearance and defaults to dark", () => {
	assert.equal(isLightTheme(undefined), false);
	assert.equal(isLightTheme(makeMockTheme("dark")), false);
	assert.equal(isLightTheme(makeMockTheme("light")), true);
});

test("highlightBashCommand fallback works before Tree-sitter init and is lossless", () => {
	const theme = makeMockTheme("dark");
	const cmd = 'rg -n --glob="*.ts" "RichToolsBody" src/split-view.ts | head -n 5';
	const styled = highlightBashCommand(cmd, theme, false);

	assert.ok(styled.includes("\x1b["), "expected ANSI escape codes");
	assert.equal(stripAnsi(styled), cmd, "stripping ANSI must preserve exact command");
	// Flags should be styled with warning color, distinct from quoted strings.
	assert.ok(styled.includes(`${TOKEN_SGR.warning}-n\x1b[0m`));
	assert.ok(styled.includes(`${TOKEN_SGR.warning}--glob\x1b[0m`));
	assert.ok(styled.includes(`${TOKEN_SGR.mdLink}src/split-view.ts\x1b[0m`));

	// ANSI-passthrough invariant.
	const preColored = "\x1b[32mecho ok\x1b[0m";
	assert.equal(highlightBashCommand(preColored, theme), preColored);
	assert.equal(highlightBashCommand("", theme), "");
});

test("initToolHighlighter + highlightCodeTreeSitter highlights TS, Bash, JSON, and Diff", async () => {
	let readyCount = 0;
	await initToolHighlighter(() => {
		readyCount++;
	});
	assert.equal(isTreeSitterReady(), true);
	assert.equal(readyCount, 1);

	// Idempotent second call invokes callback without re-initializing.
	await initToolHighlighter(() => {
		readyCount++;
	});
	assert.equal(readyCount, 2);

	// TypeScript (including multiline comment to verify per-line ANSI self-containment).
	const tsCode = [
		"/* line 1",
		" * line 2",
		" */",
		"export const count: number = 42;",
	].join("\n");
	const tsLines = highlightCodeTreeSitter(tsCode, "split-view.ts", false);
	assert.ok(tsLines !== null);
	assert.equal(tsLines.length, 4);
	assert.ok(tsLines[3]!.includes("\x1b["), "TS output should contain ANSI codes");
	assert.equal(tsLines.map(stripAnsi).join("\n"), tsCode);
	assert.ok(tsLines[1]!.includes("\x1b["), "multiline comment continuation should carry ANSI");

	// Light theme produces distinct ANSI RGB codes from dark theme.
	const tsLight = highlightCodeTreeSitter("const x = 1;", "ts", true);
	const tsDark = highlightCodeTreeSitter("const x = 1;", "ts", false);
	assert.ok(tsLight && tsDark);
	assert.notEqual(tsLight[0], tsDark[0]);

	// Bash
	const bashLines = highlightCodeTreeSitter('echo "hello" && ls -la', "script.sh", false);
	assert.ok(bashLines !== null && bashLines.length === 1);
	assert.ok(bashLines[0]!.includes("\x1b["));
	assert.equal(stripAnsi(bashLines[0]!), 'echo "hello" && ls -la');

	// JSON
	const jsonCode = '{\n  "name": "pi-split-view",\n  "count": 3\n}';
	const jsonLines = highlightCodeTreeSitter(jsonCode, "package.json", false);
	assert.ok(jsonLines !== null && jsonLines.length === 4);
	assert.ok(jsonLines[1]!.includes("\x1b["));
	assert.equal(jsonLines.map(stripAnsi).join("\n"), jsonCode);

	// Diff
	const diffCode = "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;";
	const diffLines = highlightCodeTreeSitter(diffCode, "patch.diff", false);
	assert.ok(diffLines !== null && diffLines.length === 3);
	assert.ok(diffLines.some((l) => l.includes("\x1b[")));
	assert.equal(diffLines.map(stripAnsi).join("\n"), diffCode);

	// Unsupported extension returns null for fallback.
	assert.equal(highlightCodeTreeSitter("plain text", "notes.txt", false), null);
	assert.equal(highlightCodeTreeSitter("plain text", undefined, false), null);
});

test("highlightBashCommand with Tree-sitter ready preserves plain text and highlights flags/paths", () => {
	assert.equal(isTreeSitterReady(), true);
	const theme = makeMockTheme("dark");
	const cmd = 'rg -n --glob "*.ts" --max-count=5 "foo" src/index.ts | head -n 10';
	const styled = highlightBashCommand(cmd, theme, false);

	assert.ok(styled.includes("\x1b["));
	assert.equal(stripAnsi(styled), cmd, "stripping ANSI must equal original command verbatim");
	assert.ok(styled.includes(`${TOKEN_SGR.warning}-n\x1b[0m`));
	assert.ok(styled.includes(`${TOKEN_SGR.warning}--glob\x1b[0m`));
	assert.ok(styled.includes(`${TOKEN_SGR.warning}--max-count\x1b[0m`));
	assert.ok(styled.includes(`${TOKEN_SGR.mdLink}src/index.ts\x1b[0m`));
});

test("highlightCliOutputLine: node:test, tsc, git --stat, lossless round-trip & ANSI passthrough", () => {
	const theme = makeMockTheme("dark");

	const lines = [
		"✔ truncateInline collapses whitespace (0.614ms)",
		"✖ broken test case (12.5ms)",
		"ℹ tests 42",
		"ℹ pass 42",
		"ℹ fail 0",
		"ℹ fail 1",
		"ℹ duration_ms 320.737",
		"split-view.ts:1828:5 - error TS2339: Property 'foo' does not exist on type 'Bar'.",
		"⚠ WARN deprecated flag '--old'",
		"npm ERR! code ELIFECYCLE",
		"commit 564ee1a9b2c3d4",
		" split-view.ts | 12 +++++++-----",
		" 2 files changed, 10 insertions(+), 3 deletions(-)",
	];

	// Lossless text invariant across all lines.
	const styledLines = highlightCliOutput(lines.join("\n"), theme);
	assert.equal(styledLines.length, lines.length);
	for (let i = 0; i < lines.length; i++) {
		assert.equal(
			stripAnsi(styledLines[i]!),
			lines[i],
			`line ${i} failed lossless round-trip`,
		);
	}

	// Specific semantic color assertions:
	// 1. Pass + duration
	assert.ok(styledLines[0]!.includes(`${TOKEN_SGR.success}✔\x1b[0m`));
	assert.ok(styledLines[0]!.includes(`${TOKEN_SGR.dim}(0.614ms)\x1b[0m`));

	// 2. Fail bold + duration
	assert.ok(styledLines[1]!.includes(`${TOKEN_SGR.error}\x1b[1m✖\x1b[22m\x1b[0m`));
	assert.ok(styledLines[1]!.includes(`${TOKEN_SGR.dim}(12.5ms)\x1b[0m`));

	// 3. Summary info
	assert.ok(styledLines[2]!.includes(`${TOKEN_SGR.accent}ℹ\x1b[0m`));
	assert.ok(styledLines[2]!.includes(`${TOKEN_SGR.accent}tests 42\x1b[0m`));

	// 4. pass 42 -> success
	assert.ok(styledLines[3]!.includes(`${TOKEN_SGR.success}pass 42\x1b[0m`));

	// 5. fail 0 -> success (NOT error!)
	assert.ok(styledLines[4]!.includes(`${TOKEN_SGR.success}fail 0\x1b[0m`));
	assert.ok(!styledLines[4]!.includes(TOKEN_SGR.error), "fail 0 must NOT be colored red");

	// 6. fail 1 -> error (red)
	assert.ok(styledLines[5]!.includes(`${TOKEN_SGR.error}fail 1\x1b[0m`));

	// 7. duration_ms -> dim
	assert.ok(styledLines[6]!.includes(`${TOKEN_SGR.dim}duration_ms 320.737\x1b[0m`));

	// 8. tsc diagnostic: file:line:col -> mdLink, error TS2339 -> bold error, 'foo'/'Bar' -> mdCode
	assert.ok(styledLines[7]!.includes(`${TOKEN_SGR.mdLink}split-view.ts:1828:5\x1b[0m`));
	assert.ok(styledLines[7]!.includes(`${TOKEN_SGR.error}\x1b[1merror TS2339\x1b[22m\x1b[0m`));
	assert.ok(styledLines[7]!.includes(`${TOKEN_SGR.mdCode}'foo'\x1b[0m`));
	assert.ok(styledLines[7]!.includes(`${TOKEN_SGR.mdCode}'Bar'\x1b[0m`));

	// 9. warning
	assert.ok(styledLines[8]!.includes(`${TOKEN_SGR.warning}⚠\x1b[0m`));
	assert.ok(styledLines[8]!.includes(`${TOKEN_SGR.warning}WARN\x1b[0m`));

	// 10. npm ERR!
	assert.ok(styledLines[9]!.includes(`${TOKEN_SGR.error}ERR!\x1b[0m`));

	// 11. git commit header
	assert.ok(styledLines[10]!.includes(`${TOKEN_SGR.warning}commit 564ee1a9b2c3d4\x1b[0m`));

	// 12. git diff --stat bar
	assert.ok(styledLines[11]!.includes(`${TOKEN_SGR.success}+++++++\x1b[0m`));
	assert.ok(styledLines[11]!.includes(`${TOKEN_SGR.error}-----\x1b[0m`));

	// 13. git diff --stat summary
	assert.ok(styledLines[12]!.includes(`${TOKEN_SGR.accent}2 files changed\x1b[0m`));
	assert.ok(styledLines[12]!.includes(`${TOKEN_SGR.success}10 insertions(+)\x1b[0m`));
	assert.ok(styledLines[12]!.includes(`${TOKEN_SGR.error}3 deletions(-)\x1b[0m`));

	// ANSI-passthrough invariant: pre-colored line returned completely untouched.
	const preColored = "\x1b[38;5;208merror TS2339: already styled\x1b[0m";
	assert.equal(highlightCliOutputLine(preColored, theme), preColored);
});
