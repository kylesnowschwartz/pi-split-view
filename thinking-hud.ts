/**
 * thinking-hud.ts — Two-Tier Thinking Semantic HUD.
 *
 * Tier 1 (synchronous, zero-dep, <0.5ms/line):
 *   Local salience + phrase chunking + discourse pivot cues + risk phrases +
 *   balanced identifier/path preservation.
 *
 * Tier 2 (async, optional):
 *   Fast-AI paragraph refiner using `@earendil-works/pi-ai/compat` `completeSimple`
 *   and `ctx.modelRegistry`. Bounded LRU cache, in-flight deduplication,
 *   concurrency cap (2), 5s timeout, silent fallback to Tier 1 on any failure.
 */

import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ThinkingRole =
	| "plain"
	| "heading"
	| "path"
	| "symbol"
	| "command"
	| "metric"
	| "focus"
	| "action"
	| "pivot"
	| "risk"
	| "question";

export interface ThinkingSpan {
	role: ThinkingRole;
	text: string;
}

export type ThinkingHudPalette = Record<ThinkingRole, (text: string) => string>;

export type AiThinkingRole =
	| "focus"
	| "action"
	| "pivot"
	| "risk"
	| "question"
	| "metric"
	| "path"
	| "symbol"
	| "command";

export interface AiThinkingSpan {
	phrase: string;
	role: AiThinkingRole;
}

interface ClaimedRange {
	start: number;
	end: number;
	role: ThinkingRole;
}

const VALID_AI_ROLES = new Set<string>([
	"focus",
	"action",
	"pivot",
	"risk",
	"question",
	"metric",
	"path",
	"symbol",
	"command",
]);

const STOPWORDS = new Set<string>([
	"a", "an", "the", "and", "or", "but", "if", "so", "as", "at", "by", "for",
	"from", "in", "into", "of", "on", "to", "up", "out", "off", "over", "under",
	"with", "about", "after", "before", "between", "during", "through", "without",
	"is", "am", "are", "was", "were", "be", "been", "being", "have", "has", "had",
	"do", "does", "did", "can", "could", "will", "would", "shall", "should",
	"may", "might", "must", "not", "no", "nor", "yes",
	"i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his",
	"she", "her", "it", "its", "they", "them", "their",
	"this", "that", "these", "those", "here", "there", "where", "when", "why",
	"how", "what", "which", "who", "whom", "whose",
	"all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
	"than", "then", "too", "very", "just", "also", "only", "still", "even",
	"now", "well", "back", "way", "much", "many", "same", "own", "already",
	"really", "quite", "rather", "enough", "around", "while", "since", "until",
	"either", "neither", "whether", "though", "although", "because", "however",
	"get", "gets", "got", "make", "makes", "made", "use", "uses", "used", "using",
	"need", "needs", "want", "wants", "see", "sees", "look", "looks", "think",
	"know", "take", "takes", "give", "gives", "go", "goes", "going", "come",
	"comes", "let", "lets", "put", "puts", "say", "says", "said", "try", "tries",
	"trying", "work", "works", "working", "thing", "things", "something",
	"anything", "nothing", "everything", "maybe", "probably", "like", "new",
	"old", "good", "bad", "one", "two", "three", "part", "case", "point", "time",
	"line", "lines", "file", "files", "code", "text", "value", "values", "state",
]);

const ACTION_VERBS = new Set<string>([
	"save", "saving", "saved",
	"restore", "restoring", "restored",
	"promote", "promoting", "promoted",
	"demote", "demoting",
	"replace", "replacing", "replaced",
	"wrap", "wrapping", "unwrap",
	"mount", "unmount", "remount",
	"render", "rendering", "rerender",
	"invalidate", "invalidating",
	"flush", "flushing",
	"trim", "trimming", "cap", "capping", "clamp", "clamping",
	"merge", "merging", "split", "splitting",
	"parse", "parsing", "normalize", "normalizing", "validate", "validating",
	"serialize", "persist", "persisting", "persisted",
	"cache", "caching", "enqueue", "enqueuing", "debounce", "throttle",
	"abort", "cancel", "clear", "reset", "rebuild", "reconstruct",
	"sync", "swap", "swapping", "toggle", "toggling",
	"expand", "collapse", "focus", "scroll",
	"attach", "detach", "inject", "extract",
	"compute", "score", "filter", "sort", "dedupe", "deduplicate",
	"refactor", "migrate", "patch", "fix", "fixing",
	"guard", "check", "verify", "test", "inspect",
	"read", "write", "edit", "update", "delete", "remove", "add", "create",
	"wire", "bind", "hook", "emit", "dispatch", "handle", "route",
	"preserve", "keep", "drop", "skip", "avoid", "prevent",
	"defer", "schedule", "trigger", "notify", "track", "capture", "pass",
]);

const CONNECTOR_WORDS = new Set<string>([
	"the", "a", "an", "it", "its", "this", "that", "to", "into", "on", "in",
	"from", "for", "with", "of",
]);

const URL_RE = /https?:\/\/[^\s)>"'`]+/g;
const HEADING_RE = /\*\*[^*\n]+?\*\*/g;
const BACKTICK_RE = /`[^`\n]+`/g;

// Balanced dotted chains, calls, slash-commands, CLI/Pi tools, paths, filenames, technical identifiers, and metrics.
const DOTTED_OR_CALL_RE =
	/(?<![A-Za-z0-9_./~-])(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+|[A-Za-z_$][A-Za-z0-9_$]*(?=\())/g;
const SLASH_CMD_RE =
	/(?<![A-Za-z0-9_./~:-])\/[a-z][a-z0-9-]{1,32}(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])/g;
const TOOL_CMD_RE =
	/(?<![A-Za-z0-9_./~-])(?:bash|read|edit|write|grep|find|ls|rg|tsc|git|npm|Agent|codemode|ask_user|SendMessage)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9_]|\()/g;
// Linear-time path matcher (no nested overlapping quantifiers).
const PATH_RE =
	/(?<![A-Za-z0-9_:@/-])(?:~\/|\.\.?\/|\/[A-Za-z0-9_.-]+\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?(?![A-Za-z0-9_./-])/g;
const BARE_FILE_RE =
	/(?<![A-Za-z0-9_./~-])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|sh|css|html|py|go|rs|sql|txt)(?![A-Za-z0-9_.-])/g;
const TECH_IDENT_RE =
	/(?<![A-Za-z0-9_./~-])(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)(?![A-Za-z0-9_])/g;
// Linear-time quantitative metrics: timings, ratios, percentages, and number+unit counts.
const METRIC_RE =
	/(?<![A-Za-z0-9_./~-])\d+(?:,\d{3})*(?:\.\d+)?(?:\/\d+(?:,\d{3})*(?:\.\d+)?|%|(?:ms|us|µs|ns|s|m|h|fps|hz|khz|mhz|ghz|kb|mb|gb|tb|b|px|em|rem|ch|cols|rows|k|M|x)\b|\s+(?:ms|seconds?|sec|minutes?|min|hours?|hrs?|days?|bytes?|lines?|files?|words?|tokens?|spans?|items?|tests?|passes?|failures?|errors?|warnings?|roles?|panels?|slots?|tabs?|columns?|cols|rows|chars?|characters?|entries?|chunks?|blocks?|languages?|collapsed|expanded|active|pending|queued|cached|remaining|hidden|matched|skipped|passed|failed)\b)(?![A-Za-z0-9_./-])/gi;

// Discourse pivot cues (multi-word before single-word).
const PIVOT_RE =
	/\b(?:A better pattern|Instead of|only if|Rather than|On the other hand|In other words|Wait|Because|However|Actually|Otherwise|Therefore|Unless|First,|Next,|Finally,|Note:)(?![A-Za-z0-9_])/gi;

// Risk / failure / cost phrases (multi-word anchored phrases + single-word risk cues).
const RISK_MULTI_RE =
	/\b(?:permanently mutates|never reopens|hundreds of milliseconds|burn tokens|infinite loop|race condition|memory leak|silently drops|silently fails|breaks silently|never terminates|hangs forever|out of sync|stale state|data loss|still broken|still fails)\b/gi;

const RISK_SINGLE_RE =
	/\b(?:(?:permanently|silently|never|accidentally)\s+)?(?:regression|regressions|ignores|ignored|breaks|broken|fails|failed|failure|bug|bugs|error|errors|conflict|conflicts|stuck|blocker|blockers|missing|crash|crashes|corrupts|corrupted|overflow|timeout|deadlock|clobbers|clobbering|leaks|mutates)\b/gi;

// Hypotheses, speculation, and uncertainty cues.
const QUESTION_RE =
	/\b(?:if we|not sure|might be|could be|may be|maybe|might|probably|possibly|assuming|hypothesis|hypothesize|unclear|unknown|whether|wonder|wondering|suspect|suspecting|likely|unlikely|presumably|perhaps|unsure)(?![A-Za-z0-9_])/gi;

function countWords(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed.split(/\s+/).length;
}

function isRangeFree(mask: Uint8Array, start: number, end: number): boolean {
	if (start < 0 || end > mask.length || start >= end) return false;
	for (let i = start; i < end; i++) {
		if (mask[i] !== 0) return false;
	}
	return true;
}

function claimRange(
	mask: Uint8Array,
	ranges: ClaimedRange[],
	start: number,
	end: number,
	role: ThinkingRole,
): boolean {
	if (!isRangeFree(mask, start, end)) return false;
	for (let i = start; i < end; i++) mask[i] = 1;
	ranges.push({ start, end, role });
	return true;
}

/** Extend `pos` past a balanced parenthesized call argument list like `(true)` or `(a, b(1))`. */
function extendBalancedParens(line: string, pos: number, maxLen = 48): number {
	if (line[pos] !== "(") return pos;
	let depth = 0;
	const limit = Math.min(line.length, pos + maxLen);
	for (let i = pos; i < limit; i++) {
		const ch = line[i];
		if (ch === "\n") return pos;
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return pos;
}

/** Mark URLs with sentinel value 2 in `mask` so later passes don't chop URLs into paths/risks. */
function protectUrls(line: string, mask: Uint8Array): void {
	URL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = URL_RE.exec(line)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		for (let i = start; i < end; i++) {
			if (mask[i] === 0) mask[i] = 2;
		}
	}
}

function claimHeadings(line: string, mask: Uint8Array, ranges: ClaimedRange[]): void {
	HEADING_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = HEADING_RE.exec(line)) !== null) {
		claimRange(mask, ranges, m.index, m.index + m[0].length, "heading");
	}
}

function claimBackticks(line: string, mask: Uint8Array, ranges: ClaimedRange[]): void {
	BACKTICK_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = BACKTICK_RE.exec(line)) !== null) {
		claimRange(mask, ranges, m.index, m.index + m[0].length, "symbol");
	}
}

function claimPaths(
	line: string,
	mask: Uint8Array,
	ranges: ClaimedRange[],
	maxWords?: number,
	usedWordsRef?: { count: number },
): void {
	const tryClaim = (start: number, end: number) => {
		const w = countWords(line.slice(start, end));
		if (maxWords !== undefined && usedWordsRef && usedWordsRef.count + w > maxWords) {
			return;
		}
		if (claimRange(mask, ranges, start, end, "path") && usedWordsRef) {
			usedWordsRef.count += w;
		}
	};

	// 1. Paths (e.g. src/foo/bar.ts, ~/.pi/agent/ui-panels.json)
	PATH_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = PATH_RE.exec(line)) !== null) {
		// Never treat pure numeric ratios like 35/35 as file paths.
		if (/^\d+(?:\/\d+)+$/.test(m[0])) continue;
		tryClaim(m.index, m.index + m[0].length);
	}

	// 2. Bare filenames (e.g. split-view.ts, package.json)
	BARE_FILE_RE.lastIndex = 0;
	while ((m = BARE_FILE_RE.exec(line)) !== null) {
		tryClaim(m.index, m.index + m[0].length);
	}
}

function claimCommands(
	line: string,
	mask: Uint8Array,
	ranges: ClaimedRange[],
	maxToolWords?: number,
	usedWordsRef?: { count: number },
): void {
	// 1. Slash commands (e.g. /split-save, /split-thinking-hud)
	SLASH_CMD_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = SLASH_CMD_RE.exec(line)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		if (claimRange(mask, ranges, start, end, "command") && usedWordsRef) {
			usedWordsRef.count += countWords(m[0]);
		}
	}

	// 2. Standalone Pi/CLI tool names (e.g. bash, rg, tsc, git, Agent, ask_user)
	TOOL_CMD_RE.lastIndex = 0;
	while ((m = TOOL_CMD_RE.exec(line)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		const w = countWords(m[0]);
		if (maxToolWords !== undefined && usedWordsRef && usedWordsRef.count + w > maxToolWords) {
			continue;
		}
		if (claimRange(mask, ranges, start, end, "command") && usedWordsRef) {
			usedWordsRef.count += w;
		}
	}
}

function claimSymbols(
	line: string,
	mask: Uint8Array,
	ranges: ClaimedRange[],
	maxWords?: number,
	usedWordsRef?: { count: number },
): void {
	const tryClaim = (start: number, end: number) => {
		const w = countWords(line.slice(start, end));
		if (maxWords !== undefined && usedWordsRef && usedWordsRef.count + w > maxWords) {
			return;
		}
		if (claimRange(mask, ranges, start, end, "symbol") && usedWordsRef) {
			usedWordsRef.count += w;
		}
	};

	// 1. Dotted expressions & call expressions with balanced parens
	//    (e.g. RichToolsBody.render, comp.setExpanded(true), root.files)
	DOTTED_OR_CALL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = DOTTED_OR_CALL_RE.exec(line)) !== null) {
		const start = m.index;
		let end = start + m[0].length;
		// Extend chained calls/members like a.b(1).c(2)
		while (end < line.length) {
			if (line[end] === "(") {
				const afterParen = extendBalancedParens(line, end);
				if (afterParen === end) break;
				end = afterParen;
			} else if (line[end] === "." && /[A-Za-z_$]/.test(line[end + 1] ?? "")) {
				let j = end + 1;
				while (j < line.length && /[A-Za-z0-9_$]/.test(line[j]!)) j++;
				end = j;
			} else {
				break;
			}
		}
		// Skip bare English word + parens only if it wasn't dotted and paren wasn't balanced
		if (end === start + m[0].length && !m[0].includes(".")) continue;
		tryClaim(start, end);
	}

	// 2. camelCase / PascalCase / snake_case identifiers
	TECH_IDENT_RE.lastIndex = 0;
	while ((m = TECH_IDENT_RE.exec(line)) !== null) {
		tryClaim(m.index, m.index + m[0].length);
	}
}

function claimMetrics(
	line: string,
	mask: Uint8Array,
	ranges: ClaimedRange[],
	maxWords?: number,
	usedWordsRef?: { count: number },
): void {
	METRIC_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = METRIC_RE.exec(line)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		const w = countWords(m[0]);
		if (maxWords !== undefined && usedWordsRef && usedWordsRef.count + w > maxWords) {
			continue;
		}
		if (claimRange(mask, ranges, start, end, "metric") && usedWordsRef) {
			usedWordsRef.count += w;
		}
	}
}

function claimPivots(
	line: string,
	mask: Uint8Array,
	ranges: ClaimedRange[],
	maxWords?: number,
	usedWordsRef?: { count: number },
): void {
	PIVOT_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = PIVOT_RE.exec(line)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		const w = countWords(m[0]);
		if (maxWords !== undefined && usedWordsRef && usedWordsRef.count + w > maxWords) {
			continue;
		}
		if (claimRange(mask, ranges, start, end, "pivot") && usedWordsRef) {
			usedWordsRef.count += w;
		}
	}
}

function claimRisks(
	line: string,
	mask: Uint8Array,
	ranges: ClaimedRange[],
	maxWords: number,
	usedWordsRef: { count: number },
): void {
	for (const re of [RISK_MULTI_RE, RISK_SINGLE_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(line)) !== null) {
			const start = m.index;
			const end = start + m[0].length;
			const w = countWords(m[0]);
			if (usedWordsRef.count + w > maxWords) continue;
			if (claimRange(mask, ranges, start, end, "risk")) {
				usedWordsRef.count += w;
			}
		}
	}
}

function claimQuestions(
	line: string,
	mask: Uint8Array,
	ranges: ClaimedRange[],
	maxWords: number,
	usedWordsRef: { count: number },
): void {
	QUESTION_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = QUESTION_RE.exec(line)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		const w = countWords(m[0]);
		if (usedWordsRef.count + w > maxWords) continue;
		if (claimRange(mask, ranges, start, end, "question")) {
			usedWordsRef.count += w;
		}
	}
}

interface WordToken {
	text: string;
	lower: string;
	start: number;
	end: number;
	score: number;
	isAction: boolean;
}

function scoreWord(word: string, lower: string): { score: number; isAction: boolean } {
	if (word.length <= 1) return { score: 0, isAction: false };
	if (ACTION_VERBS.has(lower)) return { score: 2.6, isAction: true };
	if (STOPWORDS.has(lower)) return { score: 0, isAction: false };

	let score = 0;
	// Hyphenated technical compound (e.g. zero-latency, auto-collapse, per-line)
	if (word.includes("-") && word.length >= 5) score += 2.8;
	// All-caps acronym (HUD, LRU, TUI, ANSI, JSON, API)
	else if (/^[A-Z]{2,6}$/.test(word)) score += 2.6;
	// Contains digits (e.g. 5000ms, 30%, v2)
	else if (/\d/.test(word)) score += 1.6;
	else if (word.length >= 9) score += 2.4;
	else if (word.length >= 6) score += 1.6 + (word.length - 6) * 0.2;
	else if (word.length >= 4) score += 1.1;
	else score += 0.4;

	return { score, isAction: false };
}

interface SalienceCandidate {
	start: number;
	end: number;
	role: "focus" | "action";
	score: number;
	wordCount: number;
}

function claimSalienceChunks(
	line: string,
	mask: Uint8Array,
	ranges: ClaimedRange[],
	budget: number,
	usedWordsRef: { count: number },
): void {
	if (usedWordsRef.count >= budget) return;

	// Collect unclaimed contiguous word spans separated only by single spaces.
	const tokens: WordToken[] = [];
	const tokenRe = /[A-Za-z0-9][A-Za-z0-9'-]*/g;
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(line)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		if (!isRangeFree(mask, start, end)) continue;
		const text = m[0];
		const lower = text.toLowerCase();
		const { score, isAction } = scoreWord(text, lower);
		tokens.push({ text, lower, start, end, score, isAction });
	}

	if (tokens.length === 0) return;

	const candidates: SalienceCandidate[] = [];
	const isAdjacent = (a: WordToken, b: WordToken): boolean => {
		const gap = line.slice(a.end, b.start);
		return gap === " ";
	};

	let i = 0;
	while (i < tokens.length) {
		const tok = tokens[i]!;

		// Action verb + short object phrase (1–3 words, e.g. "restore it", "save prevExpanded")
		if (tok.isAction) {
			let endIdx = i;
			let totalScore = tok.score;
			if (i + 1 < tokens.length && isAdjacent(tokens[i]!, tokens[i + 1]!)) {
				const next = tokens[i + 1]!;
				if (next.lower === "it" || next.lower === "them") {
					endIdx = i + 1;
					totalScore += 1.0;
				} else if (CONNECTOR_WORDS.has(next.lower)) {
					if (
						i + 2 < tokens.length &&
						isAdjacent(next, tokens[i + 2]!) &&
						tokens[i + 2]!.score >= 1.1
					) {
						endIdx = i + 2;
						totalScore += tokens[i + 2]!.score;
					}
				} else if (next.score >= 1.1) {
					endIdx = i + 1;
					totalScore += next.score;
					if (
						i + 2 < tokens.length &&
						isAdjacent(next, tokens[i + 2]!) &&
						tokens[i + 2]!.score >= 1.4 &&
						!tokens[i + 2]!.isAction
					) {
						endIdx = i + 2;
						totalScore += tokens[i + 2]!.score;
					}
				}
			}
			const wordCount = endIdx - i + 1;
			candidates.push({
				start: tok.start,
				end: tokens[endIdx]!.end,
				role: "action",
				score: totalScore + (wordCount > 1 ? 0.8 : 0),
				wordCount,
			});
			i = endIdx + 1;
			continue;
		}

		// Adjacent high-salience content words (1–3 words, e.g. "named slots", "phrase chunking")
		if (tok.score >= 1.1) {
			let endIdx = i;
			let totalScore = tok.score;
			while (
				endIdx + 1 < tokens.length &&
				endIdx - i + 1 < 3 &&
				isAdjacent(tokens[endIdx]!, tokens[endIdx + 1]!) &&
				tokens[endIdx + 1]!.score >= 1.1 &&
				!tokens[endIdx + 1]!.isAction
			) {
				endIdx++;
				totalScore += tokens[endIdx]!.score;
			}
			const wordCount = endIdx - i + 1;
			// Require either multi-word phrase or genuinely high-salience single word
			if (wordCount >= 2 || tok.score >= 2.1) {
				candidates.push({
					start: tok.start,
					end: tokens[endIdx]!.end,
					role: "focus",
					score: totalScore / Math.sqrt(wordCount) + (wordCount >= 2 ? 0.5 : 0),
					wordCount,
				});
			}
			i = endIdx + 1;
			continue;
		}

		i++;
	}

	candidates.sort((a, b) => b.score - a.score || a.start - b.start);

	for (const cand of candidates) {
		if (usedWordsRef.count + cand.wordCount > budget) continue;
		if (claimRange(mask, ranges, cand.start, cand.end, cand.role)) {
			usedWordsRef.count += cand.wordCount;
		}
		if (usedWordsRef.count >= budget) break;
	}
}

function buildLosslessSpans(line: string, ranges: ClaimedRange[]): ThinkingSpan[] {
	if (line.length === 0) return [];
	if (ranges.length === 0) return [{ role: "plain", text: line }];

	ranges.sort((a, b) => a.start - b.start);

	const out: ThinkingSpan[] = [];
	const push = (role: ThinkingRole, text: string) => {
		if (!text) return;
		const prev = out[out.length - 1];
		if (prev && prev.role === role) prev.text += text;
		else out.push({ role, text });
	};

	let cursor = 0;
	for (const r of ranges) {
		if (r.start < cursor) continue;
		if (r.start > cursor) push("plain", line.slice(cursor, r.start));
		push(r.role, line.slice(r.start, r.end));
		cursor = r.end;
	}
	if (cursor < line.length) push("plain", line.slice(cursor));
	return out;
}

/**
 * Tier 1: Synchronous, zero-dependency local semantic analyzer for a single
 * thinking line. Preserves ANSI lines verbatim and guarantees lossless
 * round-trip (`spans.map(s => s.text).join("") === line`).
 */
export function analyzeThinkingLineLocal(line: string): ThinkingSpan[] {
	if (line.length === 0) return [];
	if (line.includes("\x1b[")) return [{ role: "plain", text: line }];

	const mask = new Uint8Array(line.length);
	const ranges: ClaimedRange[] = [];
	const totalWords = countWords(line);
	// Soft density target (~28–30% of words) so lines read like a crisp HUD.
	const maxSalienceBudget =
		totalWords <= 4 ? Math.min(2, totalWords) : Math.max(2, Math.floor(totalWords * 0.28));
	const maxHardBudget =
		totalWords <= 4 ? totalWords : Math.max(3, Math.floor(totalWords * 0.35));

	// Protect URLs from partial chopping.
	protectUrls(line, mask);

	// Priority 1: Markdown headings (**...**)
	claimHeadings(line, mask, ranges);
	// Priority 2: Inline backtick code (`...`) → symbol
	claimBackticks(line, mask, ranges);

	const usedWords = {
		count: ranges.reduce((sum, r) => sum + countWords(line.slice(r.start, r.end)), 0),
	};

	// Priority 3: File paths & bare filenames → path
	claimPaths(line, mask, ranges, undefined, usedWords);
	// Priority 4: Slash commands & standalone Pi/CLI tool names → command
	claimCommands(line, mask, ranges, maxHardBudget, usedWords);
	// Priority 5: Balanced dotted/call expressions & technical identifiers → symbol
	claimSymbols(line, mask, ranges, undefined, usedWords);
	// Priority 6: Quantitative metrics (timings, ratios, percentages, counts) → metric
	claimMetrics(line, mask, ranges, maxHardBudget, usedWords);
	// Priority 7: Discourse pivots → pivot
	claimPivots(line, mask, ranges, maxHardBudget, usedWords);
	// Priority 8: Risk / failure / cost phrases → risk
	claimRisks(line, mask, ranges, maxHardBudget, usedWords);
	// Priority 9: Hypotheses & uncertainty cues → question
	claimQuestions(line, mask, ranges, maxHardBudget, usedWords);
	// Priority 10: Self-information / novelty phrase chunks & action verb+object pairs → focus / action
	claimSalienceChunks(line, mask, ranges, maxSalienceBudget, usedWords);

	return buildLosslessSpans(line, ranges);
}

/**
 * Serialize a structured Tier 1 → Tier 2 refinement payload so the fast AI
 * refines local anchors rather than starting from scratch.
 */
export function buildAiRefinementPayload(
	line: string,
	localSpans: readonly ThinkingSpan[],
): string {
	return JSON.stringify({
		line,
		localDraft: localSpans
			.filter((s) => s.role !== "plain")
			.map((s) => ({ phrase: s.text, role: s.role })),
	});
}

/** Render spans through a role-to-styler palette. */
export function renderThinkingSpans(
	spans: ThinkingSpan[],
	palette: ThinkingHudPalette,
): string {
	let out = "";
	for (const span of spans) {
		if (!span.text) continue;
		out += palette[span.role](span.text);
	}
	return out;
}

function findUnclaimedOccurrence(
	line: string,
	lineLower: string,
	phrase: string,
	mask: Uint8Array,
): { start: number; end: number } | null {
	if (!phrase) return null;

	// Pass 1: exact substring match
	let from = 0;
	while (from <= line.length - phrase.length) {
		const idx = line.indexOf(phrase, from);
		if (idx === -1) break;
		if (isRangeFree(mask, idx, idx + phrase.length)) {
			return { start: idx, end: idx + phrase.length };
		}
		from = idx + 1;
	}

	// Pass 2: case-insensitive fallback
	const phraseLower = phrase.toLowerCase();
	from = 0;
	while (from <= lineLower.length - phraseLower.length) {
		const idx = lineLower.indexOf(phraseLower, from);
		if (idx === -1) break;
		if (isRangeFree(mask, idx, idx + phraseLower.length)) {
			return { start: idx, end: idx + phraseLower.length };
		}
		from = idx + 1;
	}

	return null;
}

/**
 * Overlay Tier 2 AI-extracted spans onto a line, enforcing <=5 words per AI span
 * and <=32% total highlighted word density, then merging non-overlapping local
 * headings, balanced code identifiers, and discourse pivots. Lossless round-trip.
 */
export function applyAiSpansOverLine(
	line: string,
	aiSpans: Array<{ phrase: string; role: AiThinkingRole }>,
): ThinkingSpan[] {
	if (line.length === 0) return [];
	if (line.includes("\x1b[")) return [{ role: "plain", text: line }];

	const mask = new Uint8Array(line.length);
	const ranges: ClaimedRange[] = [];
	const totalWords = countWords(line);
	const maxDensityWords =
		totalWords <= 4 ? Math.min(2, totalWords) : Math.max(2, Math.floor(totalWords * 0.32));

	protectUrls(line, mask);

	// 1. Preserve local markdown headings first so AI phrases never split them.
	claimHeadings(line, mask, ranges);
	const usedWords = {
		count: ranges.reduce((sum, r) => sum + countWords(line.slice(r.start, r.end)), 0),
	};

	// 2. Apply AI spans (exact match, case-insensitive fallback, <=5 words, <=32% density).
	const lineLower = line.toLowerCase();
	let matchedAiCount = 0;
	for (const item of aiSpans) {
		if (!item || typeof item.phrase !== "string" || !VALID_AI_ROLES.has(item.role)) continue;
		const phrase = item.phrase.trim();
		if (!phrase) continue;
		const w = countWords(phrase);
		if (w === 0 || w > 5) continue;
		if (usedWords.count + w > maxDensityWords) continue;

		const hit = findUnclaimedOccurrence(line, lineLower, phrase, mask);
		if (!hit) continue;
		if (claimRange(mask, ranges, hit.start, hit.end, item.role)) {
			usedWords.count += w;
			matchedAiCount++;
		}
	}

	// Fall back cleanly to Tier 1 local salience when AI returned no usable matches.
	if (matchedAiCount === 0) {
		return analyzeThinkingLineLocal(line);
	}

	// 3. Merge in non-overlapping local deterministic anchors (path, command, symbol, pivot).
	claimBackticks(line, mask, ranges);
	claimPaths(line, mask, ranges);
	claimCommands(line, mask, ranges);
	claimSymbols(line, mask, ranges);
	claimPivots(line, mask, ranges);

	return buildLosslessSpans(line, ranges);
}

// ─── Tier 2: Async Fast-AI Paragraph Refiner ─────────────────────────────────

const FAST_MODEL_MATCHERS: readonly ((id: string) => boolean)[] = [
	(id) => id === "gemini-2.5-flash" || id.startsWith("gemini-2.5-flash"),
	(id) => id === "gemini-2.0-flash" || id.startsWith("gemini-2.0-flash"),
	(id) => /^gemini-.*flash/.test(id),
	(id) => /^claude-(?:haiku|.*-haiku)/.test(id),
	(id) => id === "gpt-4o-mini" || id.startsWith("gpt-4o-mini"),
	(id) => id === "gpt-5-mini" || id.startsWith("gpt-5-mini"),
];

/** Select the fastest available model for Tier 2 thinking refinement. */
export function selectFastThinkingModel(models: readonly Model<Api>[]): Model<Api> | null {
	for (const matches of FAST_MODEL_MATCHERS) {
		const found = models.find((m) => matches(m.id.toLowerCase()));
		if (found) return found;
	}
	return null;
}

const AI_REFINER_SYSTEM_PROMPT = [
	"You refine semantic highlight spans for a coding-agent reasoning line.",
	'Input is JSON: {"line":"...","localDraft":[{"phrase":"...","role":"..."}]}.',
	'Return ONLY a compact JSON array: [{"phrase":"...","role":"focus|action|pivot|risk|question|metric|path|symbol|command"}]',
	"Refinement rules:",
	"- Keep accurate path, symbol, command, metric, and pivot anchors from localDraft.",
	"- Merge fragmented local words into crisp 2 to 5 word clause spans for focus, action, risk, and question.",
	"- Fix misclassified roles and drop noisy filler spans.",
	"- Every phrase MUST be an exact verbatim substring of line, 1 to 5 words; return 2 to 6 spans covering <= 30% of words.",
	"- Roles: focus (core concept/subject), action (intended step/fix), pivot (reasoning turn/contrast), risk (bug/failure/blocker/cost), question (hypothesis/uncertainty), metric (count/timing/percent/ratio), path (file path/filename), symbol (identifier/call/code), command (slash command/CLI/tool).",
	"- Output raw JSON array only. No explanation, no markdown code fences.",
].join("\n");

/** Parse and validate a fast-AI JSON response (tolerates markdown fences). */
export function parseAiSpansResponse(raw: string): AiThinkingSpan[] | null {
	let text = raw.trim();
	if (!text) return null;

	// Strip ```json ... ``` or ``` ... ``` fences if emitted.
	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch && fenceMatch[1]) {
		text = fenceMatch[1].trim();
	}

	// Extract the JSON array bounds if surrounded by stray text.
	const firstBracket = text.indexOf("[");
	const lastBracket = text.lastIndexOf("]");
	if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
		return null;
	}
	text = text.slice(firstBracket, lastBracket + 1);

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;

	const out: AiThinkingSpan[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.phrase !== "string" || typeof rec.role !== "string") continue;
		if (!VALID_AI_ROLES.has(rec.role)) continue;
		const phrase = rec.phrase.trim();
		if (!phrase) continue;
		const words = countWords(phrase);
		if (words === 0 || words > 5) continue;
		out.push({ phrase, role: rec.role as AiThinkingRole });
		if (out.length >= 6) break;
	}
	return out;
}

const MAX_CACHE_ENTRIES = 200;
const MAX_CONCURRENCY = 2;
const MAX_PENDING_QUEUE = 12;
const REQUEST_TIMEOUT_MS = 5000;
const MIN_AI_LINE_LENGTH = 45;

interface QueuedRefineJob {
	key: string;
	payload: string;
	ctx: ExtensionContext;
	onRefined: () => void;
}

/**
 * Bounded async Tier 2 refiner. Deduplicates in-flight requests, caps
 * concurrency at 2, times out after 5s, and caches up to 200 lines in LRU order.
 */
export class ThinkingAiRefiner {
	private readonly cache = new Map<string, AiThinkingSpan[]>();
	private readonly inFlight = new Set<string>();
	private readonly queuedKeys = new Set<string>();
	private readonly queue: QueuedRefineJob[] = [];
	private readonly activeControllers = new Set<AbortController>();
	private activeCount = 0;
	private generation = 0;

	private normalizeKey(line: string): string {
		return line.trim();
	}

	private setCached(key: string, spans: AiThinkingSpan[]): void {
		if (this.cache.has(key)) this.cache.delete(key);
		this.cache.set(key, spans);
		while (this.cache.size > MAX_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}

	getCached(line: string): AiThinkingSpan[] | undefined {
		const key = this.normalizeKey(line);
		const hit = this.cache.get(key);
		if (hit === undefined) return undefined;
		// Refresh LRU recency.
		this.cache.delete(key);
		this.cache.set(key, hit);
		return hit;
	}

	enqueue(
		line: string,
		ctx: ExtensionContext | null | undefined,
		onRefined: () => void,
		localSpans?: readonly ThinkingSpan[],
	): void {
		if (!ctx || !ctx.modelRegistry) return;
		if (line.includes("\x1b[")) return;
		const key = this.normalizeKey(line);
		if (key.length < MIN_AI_LINE_LENGTH) return;
		if (this.cache.has(key) || this.inFlight.has(key) || this.queuedKeys.has(key)) return;

		const resolvedLocalSpans = localSpans ?? analyzeThinkingLineLocal(key);
		const payload = buildAiRefinementPayload(key, resolvedLocalSpans);

		if (this.activeCount < MAX_CONCURRENCY) {
			this.startJob({ key, payload, ctx, onRefined });
		} else {
			if (this.queue.length >= MAX_PENDING_QUEUE) {
				const dropped = this.queue.shift();
				if (dropped) this.queuedKeys.delete(dropped.key);
			}
			this.queuedKeys.add(key);
			this.queue.push({ key, payload, ctx, onRefined });
		}
	}

	clear(): void {
		this.generation++;
		this.cache.clear();
		this.inFlight.clear();
		this.queuedKeys.clear();
		this.queue.length = 0;
		for (const ctrl of this.activeControllers) {
			try {
				ctrl.abort();
			} catch {
				/* ignore */
			}
		}
		this.activeControllers.clear();
		this.activeCount = 0;
	}

	private drainQueue(): void {
		while (this.activeCount < MAX_CONCURRENCY && this.queue.length > 0) {
			const next = this.queue.shift();
			if (!next) break;
			this.queuedKeys.delete(next.key);
			if (this.cache.has(next.key) || this.inFlight.has(next.key)) continue;
			this.startJob(next);
		}
	}

	private startJob(job: QueuedRefineJob): void {
		const gen = this.generation;
		this.inFlight.add(job.key);
		this.activeCount++;
		void this.runJob(job, gen).finally(() => {
			this.inFlight.delete(job.key);
			if (this.generation === gen) {
				this.activeCount = Math.max(0, this.activeCount - 1);
				this.drainQueue();
			}
		});
	}

	private async runJob(job: QueuedRefineJob, gen: number): Promise<void> {
		let model: Model<Api> | null = null;
		try {
			const available = job.ctx.modelRegistry.getAvailable();
			model = selectFastThinkingModel(available);
		} catch {
			return;
		}
		if (!model) return;

		let apiKey: string | undefined;
		let headers: ProviderHeaders | undefined;
		try {
			const auth = await job.ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return;
			apiKey = auth.apiKey;
			headers = auth.headers;
		} catch {
			return;
		}
		if (this.generation !== gen) return;

		const controller = new AbortController();
		this.activeControllers.add(controller);
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		try {
			const res = await completeSimple(
				model,
				{
					systemPrompt: AI_REFINER_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: job.payload,
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey,
					headers,
					signal: controller.signal,
					maxTokens: 256,
					temperature: 0,
				},
			);
			if (this.generation !== gen) return;

			let rawText = "";
			for (const block of res.content) {
				if (block.type === "text") rawText += block.text;
			}
			const parsed = parseAiSpansResponse(rawText);
			if (!parsed) return;

			this.setCached(job.key, parsed);
			if (parsed.length > 0) {
				try {
					job.onRefined();
				} catch {
					/* never crash extension on UI refresh failure */
				}
			}
		} catch {
			/* silent fallback: Tier 1 local highlights remain active */
		} finally {
			clearTimeout(timer);
			this.activeControllers.delete(controller);
		}
	}
}

/**
 * Shared utility module imported by split-view.ts. pi auto-discovers every
 * *.ts file in this directory as an extension and requires a default export.
 */
export default function (_pi: ExtensionAPI) {
	/* no-op: shared Thinking HUD module, not a standalone extension */
}
