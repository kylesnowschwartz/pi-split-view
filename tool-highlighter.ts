import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Highlighter, Theme as LumisTheme } from "@lumis-sh/lumis";
import type { TerminalFormatter, TerminalOptions } from "@lumis-sh/lumis/formatters";

// ─── ANSI utilities ───────────────────────────────────────────────────────────

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Split an ANSI-styled string into lines while keeping every line self-contained:
 * if an SGR sequence is active across a newline (e.g. multi-line comments or
 * template strings), close it before the break and re-open it on the next line.
 */
function splitAnsiLines(text: string): string[] {
	const rawLines = text.split(/\r?\n/);
	if (rawLines.length <= 1) return rawLines;

	const out: string[] = [];
	let activeSgr = "";

	for (const line of rawLines) {
		const prefixed = activeSgr ? activeSgr + line : line;
		// Track active SGR codes through this line.
		ANSI_SGR_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = ANSI_SGR_RE.exec(line)) !== null) {
			const seq = m[0];
			if (seq === "\x1b[0m" || seq === "\x1b[m") {
				activeSgr = "";
			} else {
				activeSgr += seq;
			}
		}
		out.push(activeSgr ? prefixed + "\x1b[0m" : prefixed);
	}
	return out;
}

// ─── Theme helper ─────────────────────────────────────────────────────────────

/**
 * Detect whether a pi Theme is light. Defaults to `false` (dark / Catppuccin Mocha)
 * when the theme is missing or does not declare light appearance.
 */
export function isLightTheme(theme?: Theme): boolean {
	return theme?.appearance === "light";
}

// ─── Language mapping ─────────────────────────────────────────────────────────

const LANGUAGE_MAP: Readonly<Record<string, string>> = {
	// TypeScript
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	typescript: "typescript",
	// JavaScript
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	javascript: "javascript",
	// Bash / Shell
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	shell: "bash",
	// Ruby
	rb: "ruby",
	rake: "ruby",
	gemspec: "ruby",
	ruby: "ruby",
	// Go
	go: "go",
	golang: "go",
	// Python
	py: "python",
	pyi: "python",
	python: "python",
	// Rust
	rs: "rust",
	rust: "rust",
	// JSON
	json: "json",
	jsonl: "json",
	jsonc: "json",
	// Diff
	diff: "diff",
	patch: "diff",
	// Markdown
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	// YAML
	yml: "yaml",
	yaml: "yaml",
	// Regex
	regex: "regex",
	regexp: "regex",
};

const BASENAME_MAP: Readonly<Record<string, string>> = {
	rakefile: "ruby",
	gemfile: "ruby",
	".bashrc": "bash",
	".zshrc": "bash",
	".bash_profile": "bash",
	".zprofile": "bash",
	".profile": "bash",
};

/**
 * Map a file path or language alias to one of the loaded Lumis Tree-sitter
 * grammar IDs, or `null` if unsupported.
 */
export function languageForPathOrName(pathOrLang?: string): string | null {
	if (!pathOrLang) return null;
	const trimmed = pathOrLang.trim().toLowerCase();
	if (!trimmed) return null;

	// Direct language alias / bare extension (e.g. "ts", "typescript", "json", "bash").
	const direct = LANGUAGE_MAP[trimmed];
	if (direct) return direct;

	// Extract basename from path.
	const slashIdx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	const base = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
	if (!base) return null;

	const special = BASENAME_MAP[base];
	if (special) return special;

	const dotIdx = base.lastIndexOf(".");
	if (dotIdx <= 0 || dotIdx === base.length - 1) return null;
	const ext = base.slice(dotIdx + 1);
	return LANGUAGE_MAP[ext] ?? null;
}

// ─── Lazy async Tree-sitter highlighter (@lumis-sh/lumis) ─────────────────────

let highlighter: Highlighter | null = null;
let loadedLangs: ReadonlySet<string> = new Set();
let lumisTerminalFn: ((options?: TerminalOptions) => TerminalFormatter) | null = null;
let mochaTheme: LumisTheme | null = null;
let latteTheme: LumisTheme | null = null;
let initPromise: Promise<void> | null = null;
let initFailed = false;
const readyCallbacks: Array<() => void> = [];

function flushReadyCallbacks(): void {
	const cbs = readyCallbacks.splice(0, readyCallbacks.length);
	for (const cb of cbs) {
		try {
			cb();
		} catch {
			/* ignore callback errors */
		}
	}
}

/**
 * Idempotent lazy initializer for the `@lumis-sh/lumis` Tree-sitter highlighter.
 * Loads all 12 installed WASM grammars and Catppuccin Mocha/Latte themes once
 * in the background. Invokes `onReady` when ready. Never throws.
 */
export function initToolHighlighter(onReady?: () => void): Promise<void> {
	if (highlighter) {
		if (onReady) {
			try {
				onReady();
			} catch {
				/* ignore callback errors */
			}
		}
		return Promise.resolve();
	}
	if (initFailed) return Promise.resolve();
	if (onReady) readyCallbacks.push(onReady);
	if (initPromise) return initPromise;

	initPromise = (async () => {
		try {
			const [
				lumisMod,
				formattersMod,
				mochaMod,
				latteMod,
				typescript,
				javascript,
				bash,
				ruby,
				go,
				python,
				rust,
				json,
				diff,
				markdown,
				yaml,
				regex,
			] = await Promise.all([
				import("@lumis-sh/lumis"),
				import("@lumis-sh/lumis/formatters"),
				import("@lumis-sh/themes/catppuccin_mocha"),
				import("@lumis-sh/themes/catppuccin_latte"),
				import("@lumis-sh/wasm-typescript"),
				import("@lumis-sh/wasm-javascript"),
				import("@lumis-sh/wasm-bash"),
				import("@lumis-sh/wasm-ruby"),
				import("@lumis-sh/wasm-go"),
				import("@lumis-sh/wasm-python"),
				import("@lumis-sh/wasm-rust"),
				import("@lumis-sh/wasm-json"),
				import("@lumis-sh/wasm-diff"),
				import("@lumis-sh/wasm-markdown"),
				import("@lumis-sh/wasm-yaml"),
				import("@lumis-sh/wasm-regex"),
			]);

			const instance = await lumisMod.createHighlighter({
				languages: [
					typescript.default,
					javascript.default,
					bash.default,
					ruby.default,
					go.default,
					python.default,
					rust.default,
					json.default,
					diff.default,
					markdown.default,
					yaml.default,
					regex.default,
				],
			});

			lumisTerminalFn = formattersMod.terminal;
			mochaTheme = mochaMod.default;
			latteTheme = latteMod.default;
			loadedLangs = new Set(instance.languages);
			highlighter = instance;
			flushReadyCallbacks();
		} catch {
			initFailed = true;
			highlighter = null;
			readyCallbacks.length = 0;
		}
	})();

	return initPromise;
}

/** True once the Tree-sitter highlighter and WASM grammars have initialized. */
export function isTreeSitterReady(): boolean {
	return highlighter !== null;
}

/**
 * Syntax-highlight `code` using Tree-sitter (`@lumis-sh/lumis`) if ready and
 * `pathOrLang` maps to a loaded grammar. Returns `string[]` (one entry per
 * line), or `null` so callers can fall back to Pi's built-in `highlightCode`.
 */
export function highlightCodeTreeSitter(
	code: string,
	pathOrLang?: string,
	lightTheme = false,
): string[] | null {
	if (!highlighter || !lumisTerminalFn) return null;
	const lang = languageForPathOrName(pathOrLang);
	if (!lang || !loadedLangs.has(lang)) return null;
	const lumisTheme = lightTheme ? latteTheme : mochaTheme;
	if (!lumisTheme) return null;

	try {
		const rendered = highlighter.highlight(
			code,
			lumisTerminalFn({ language: lang, theme: lumisTheme }),
		);
		return splitAnsiLines(rendered);
	} catch {
		return null;
	}
}

// ─── Bash command highlighter ─────────────────────────────────────────────────

// Catppuccin Mocha / Latte fallback RGB accents when no pi Theme is supplied.
const BASH_FALLBACK_COLORS = {
	dark: {
		cmd: "\x1b[38;2;137;180;250m", // blue
		flag: "\x1b[38;2;249;226;175m", // yellow
		path: "\x1b[38;2;137;220;235m", // sky
		string: "\x1b[38;2;166;227;161m", // green
		operator: "\x1b[38;2;148;226;213m", // teal
		variable: "\x1b[38;2;243;139;168m", // red/pink
		number: "\x1b[38;2;250;179;135m", // peach
	},
	light: {
		cmd: "\x1b[38;2;30;102;245m", // blue
		flag: "\x1b[38;2;223;142;29m", // yellow
		path: "\x1b[38;2;4;165;229m", // sky
		string: "\x1b[38;2;64;160;43m", // green
		operator: "\x1b[38;2;23;146;153m", // teal
		variable: "\x1b[38;2;210;15;57m", // red
		number: "\x1b[38;2;254;100;11m", // peach
	},
} as const;

const CLI_FLAG_RE = /^--?[a-zA-Z0-9][a-zA-Z0-9_-]*(?:=.*)?$/;
const FILE_PATH_RE =
	/^(?:~\/|\.{1,2}\/|\/[a-zA-Z0-9_.*@/+-]|[a-zA-Z0-9_.*-]+(?:\/[a-zA-Z0-9_.*@+-]+)+|[a-zA-Z0-9_*-]+\.[a-zA-Z0-9]{1,6})$/;

function styleBashRole(
	role: keyof typeof BASH_FALLBACK_COLORS.dark,
	text: string,
	theme?: Theme,
	lightTheme = false,
): string {
	if (theme) {
		switch (role) {
			case "cmd":
				return theme.fg("syntaxFunction", text);
			case "flag":
				return theme.fg("warning", text);
			case "path":
				return theme.fg("mdLink", text);
			case "string":
				return theme.fg("syntaxString", text);
			case "operator":
				return theme.fg("syntaxOperator", text);
			case "variable":
				return theme.fg("syntaxVariable", text);
			case "number":
				return theme.fg("syntaxNumber", text);
		}
	}
	const palette = lightTheme ? BASH_FALLBACK_COLORS.light : BASH_FALLBACK_COLORS.dark;
	return `${palette[role]}${text}\x1b[0m`;
}

function styleBashFlag(token: string, theme?: Theme, lightTheme = false): string {
	const eqIdx = token.indexOf("=");
	if (eqIdx > 0) {
		const flagPart = token.slice(0, eqIdx);
		const valPart = token.slice(eqIdx + 1);
		const styledFlag = styleBashRole("flag", flagPart, theme, lightTheme);
		const styledEq = styleBashRole("operator", "=", theme, lightTheme);
		const styledVal =
			valPart.length > 0 && FILE_PATH_RE.test(valPart)
				? styleBashRole("path", valPart, theme, lightTheme)
				: valPart;
		return `${styledFlag}${styledEq}${styledVal}`;
	}
	return styleBashRole("flag", token, theme, lightTheme);
}

/**
 * Post-pass over Lumis's ANSI-highlighted bash output: tree-sitter-bash styles
 * flags and bare file paths identically to quoted strings, so we re-style whole
 * plain-text flag/path tokens cleanly without ever touching ANSI escape codes.
 */
function refineLumisBashAnsi(
	highlighted: string,
	theme?: Theme,
	lightTheme = false,
): string {
	// Tokenize into alternating ANSI SGR sequences and visible text chunks.
	const parts: Array<{ isAnsi: boolean; value: string }> = [];
	let lastIdx = 0;
	ANSI_SGR_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ANSI_SGR_RE.exec(highlighted)) !== null) {
		if (m.index > lastIdx) {
			parts.push({ isAnsi: false, value: highlighted.slice(lastIdx, m.index) });
		}
		parts.push({ isAnsi: true, value: m[0] });
		lastIdx = m.index + m[0].length;
	}
	if (lastIdx < highlighted.length) {
		parts.push({ isAnsi: false, value: highlighted.slice(lastIdx) });
	}

	let out = "";
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part.isAnsi) {
			out += part.value;
			continue;
		}
		const text = part.value;
		// Never re-style quoted strings or whitespace.
		if (
			!text ||
			/^\s+$/.test(text) ||
			text.startsWith('"') ||
			text.startsWith("'") ||
			text.endsWith('"') ||
			text.endsWith("'")
		) {
			out += text;
			continue;
		}
		if (CLI_FLAG_RE.test(text)) {
			out += styleBashFlag(text, theme, lightTheme);
		} else if (FILE_PATH_RE.test(text) && !/^\d+\.\d+$/.test(text)) {
			out += styleBashRole("path", text, theme, lightTheme);
		} else {
			out += text;
		}
	}
	return out;
}

const BASH_FALLBACK_TOKEN_RE =
	/"(?:\\.|[^"\\])*"|'(?:[^']*)'|\$\{[^}]+\}|\$[a-zA-Z_][a-zA-Z0-9_]*|&&|\|\||2>&1|>>|[|;<>]|\s+|[^\s|;<>]+/g;

/** Zero-dep lossless bash command tokenizer used while Tree-sitter is loading. */
function highlightBashFallback(
	cmd: string,
	theme?: Theme,
	lightTheme = false,
): string {
	let out = "";
	let expectCmd = true;
	BASH_FALLBACK_TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = BASH_FALLBACK_TOKEN_RE.exec(cmd)) !== null) {
		const tok = m[0];
		if (/^\s+$/.test(tok)) {
			out += tok;
			continue;
		}
		if (
			tok === "&&" ||
			tok === "||" ||
			tok === "|" ||
			tok === ";"
		) {
			out += styleBashRole("operator", tok, theme, lightTheme);
			expectCmd = true;
			continue;
		}
		if (tok === "2>&1" || tok === ">>" || tok === ">" || tok === "<") {
			out += styleBashRole("operator", tok, theme, lightTheme);
			continue;
		}
		if (tok.startsWith('"') || tok.startsWith("'")) {
			out += styleBashRole("string", tok, theme, lightTheme);
			expectCmd = false;
			continue;
		}
		if (tok.startsWith("$")) {
			out += styleBashRole("variable", tok, theme, lightTheme);
			expectCmd = false;
			continue;
		}
		if (expectCmd) {
			// Skip env var prefix like NODE_ENV=test before the actual command.
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
				const eq = tok.indexOf("=");
				out +=
					styleBashRole("variable", tok.slice(0, eq), theme, lightTheme) +
					styleBashRole("operator", "=", theme, lightTheme) +
					tok.slice(eq + 1);
				continue;
			}
			out += styleBashRole("cmd", tok, theme, lightTheme);
			expectCmd = false;
			continue;
		}
		if (CLI_FLAG_RE.test(tok)) {
			out += styleBashFlag(tok, theme, lightTheme);
		} else if (/^\d+$/.test(tok)) {
			out += styleBashRole("number", tok, theme, lightTheme);
		} else if (FILE_PATH_RE.test(tok) && !/^\d+\.\d+$/.test(tok)) {
			out += styleBashRole("path", tok, theme, lightTheme);
		} else {
			out += tok;
		}
	}
	return out;
}

/**
 * Syntax-highlight a bash command string.
 * Uses `@lumis-sh/lumis` (`bash` grammar) + an ANSI-safe flag/path refinement
 * pass when ready, or a lossless fallback tokenizer before initialization.
 * Preserves exact plain text when ANSI is stripped.
 */
export function highlightBashCommand(
	cmd: string,
	theme?: Theme,
	lightTheme = false,
): string {
	if (!cmd) return "";
	if (cmd.includes("\x1b[")) return cmd;

	if (highlighter && lumisTerminalFn && loadedLangs.has("bash")) {
		const lumisTheme = lightTheme ? latteTheme : mochaTheme;
		if (lumisTheme) {
			try {
				const highlighted = highlighter.highlight(
					cmd,
					lumisTerminalFn({ language: "bash", theme: lumisTheme }),
				);
				if (highlighted) {
					return refineLumisBashAnsi(highlighted, theme, lightTheme);
				}
			} catch {
				/* fall through to lossless fallback */
			}
		}
	}
	return highlightBashFallback(cmd, theme, lightTheme);
}

// ─── grc-style Semantic CLI Output Colouriser ─────────────────────────────────

/**
 * Single-pass non-overlapping left-to-right rule regex for CLI output lines.
 * Order of alternation resolves ambiguity deterministically:
 *  1. fileLoc  — file.ext:line(:col)
 *  2. errBold  — ✖, FAIL, ERROR, error TS\d+
 *  3. err      — ✗, fail [1-9]\d*, ERR!, FAILED, N deletion(s)(-), diffstat ---
 *  4. pass     — ✔, ✓, PASS, pass \d+, fail 0, N insertion(s)(+), diffstat +++
 *  5. warn     — ⚠, WARN(ING), git commit <hash>
 *  6. duration — (12.3ms), (1.2s), duration_ms 320.7
 *  7. code     — 'single-quoted identifier/type'
 *  8. info     — ℹ, tests \d+, N file(s) changed
 */
const CLI_OUTPUT_RE = new RegExp(
	[
		"(?<fileLoc>[a-zA-Z0-9_./-]+\\.[a-zA-Z0-9]{1,5}:\\d+(?::\\d+)?)",
		"(?<errBold>✖|\\b(?:FAIL|ERROR)\\b|\\berror TS\\d+\\b)",
		"(?<err>✗|\\bfail [1-9]\\d*\\b|\\bERR!|\\bFAILED\\b|\\d+ deletions?\\(-\\)|(?<=\\|\\s*\\d+\\s*\\+*)-+|(?<=\\+)-{2,})",
		"(?<pass>[✔✓]|\\bPASS\\b|\\bpass \\d+\\b|\\bfail 0\\b|\\d+ insertions?\\(\\+\\)|(?<=\\|\\s*\\d+\\s*)\\++|\\+{2,})",
		"(?<warn>⚠|\\bWARN(?:ING)?\\b|\\bcommit [0-9a-f]{7,40}\\b)",
		"(?<duration>\\(\\d+(?:\\.\\d+)?\\s*(?:ms|s|µs)\\)|\\bduration_ms\\s+\\d+(?:\\.\\d+)?)",
		"(?<code>'[^'\\n]{1,60}')",
		"(?<info>ℹ|\\btests \\d+\\b|\\b\\d+ files? changed\\b)",
	].join("|"),
	"g",
);

/**
 * Colourise a single CLI output line using semantic `grc`-style rules.
 * - ANSI-passthrough safe: lines already containing `\x1b[` are returned untouched.
 * - Lossless: stripping ANSI from the return value equals `line` verbatim.
 */
export function highlightCliOutputLine(line: string, theme: Theme): string {
	if (!line || line.includes("\x1b[")) return line;

	CLI_OUTPUT_RE.lastIndex = 0;
	let out = "";
	let lastIdx = 0;
	let m: RegExpExecArray | null;

	while ((m = CLI_OUTPUT_RE.exec(line)) !== null) {
		if (m.index > lastIdx) {
			out += line.slice(lastIdx, m.index);
		}
		const text = m[0];
		const g = m.groups!;
		if (g.fileLoc !== undefined) {
			out += theme.fg("mdLink", text);
		} else if (g.errBold !== undefined) {
			out += theme.fg("error", theme.bold(text));
		} else if (g.err !== undefined) {
			out += theme.fg("error", text);
		} else if (g.pass !== undefined) {
			out += theme.fg("success", text);
		} else if (g.warn !== undefined) {
			out += theme.fg("warning", text);
		} else if (g.duration !== undefined) {
			out += theme.fg("dim", text);
		} else if (g.code !== undefined) {
			out += theme.fg("mdCode", text);
		} else if (g.info !== undefined) {
			out += theme.fg("accent", text);
		} else {
			out += text;
		}
		lastIdx = m.index + text.length;
	}

	if (lastIdx === 0) return line;
	if (lastIdx < line.length) out += line.slice(lastIdx);
	return out;
}

/**
 * Colourise multi-line CLI output text line-by-line with `highlightCliOutputLine`.
 */
export function highlightCliOutput(text: string, theme: Theme): string[] {
	return text.split(/\r?\n/).map((line) => highlightCliOutputLine(line, theme));
}

/**
 * Shared utility module imported by split-view.ts. pi auto-discovers every
 * *.ts file in this directory as an extension and requires a default export.
 */
export default function (_pi: ExtensionAPI) {
	/* no-op: shared tool highlighter module, not a standalone extension */
}
