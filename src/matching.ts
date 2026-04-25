import { minimatch } from "minimatch";
import type { Action } from "./types.ts";

/**
 * Check if `needle` tokens appear in order within `haystack`.
 * Used for bash command matching where rule tokens must appear in order,
 * but extra flags or positional args anywhere in the sequence are permitted.
 */
export function isSubsequence(needle: string[], haystack: string[]): boolean {
	let ni = 0;
	for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
		if (haystack[hi] === needle[ni]) ni++;
	}
	return ni === needle.length;
}

/**
 * Match a glob pattern against a string using minimatch.
 * - `*` matches anything except `/`
 * - `**` matches anything including `/`
 * - `?` matches single character
 * - `~` at start expands to home directory
 */
export function globMatch(pattern: string, input: string): boolean {
	// Expand ~ at the start
	if (pattern.startsWith("~")) {
		const home = process.env.HOME ?? "";
		pattern = home + pattern.slice(1);
	}
	if (input.startsWith("~")) {
		const home = process.env.HOME ?? "";
		input = home + input.slice(1);
	}

	return minimatch(input, pattern, { dot: true });
}

/**
 * Resolve the action for a bash command against a rules map.
 *
 * Rules are evaluated in insertion order; last match wins.
 * The special pattern "*" matches any command.
 *
 * Matching uses subsequence logic:
 * - "git" → matches all git commands (base command match)
 * - "git status" → matches `git status`, `git status --short`, etc.
 * - "git branch --show-current" → matches `git branch --show-current`,
 *   `git branch -v --show-current`, etc.
 *
 * Returns undefined if no rule matches.
 */
export function resolveBashAction(
	commandName: string,
	commandArgs: string[],
	rules: Record<string, Action>,
): Action | undefined {
	let result: Action | undefined;

	for (const [pattern, action] of Object.entries(rules)) {
		if (pattern === "*") {
			result = action;
			continue;
		}

		const [patternName, ...patternArgs] = pattern.split(" ");

		if (patternName !== commandName) continue;

		if (patternArgs.length === 0 || isSubsequence(patternArgs, commandArgs)) {
			result = action;
		}
	}

	return result;
}

/**
 * Resolve the action for a glob-based tool (read, edit, write) against a rules map.
 *
 * Rules are evaluated in insertion order; last match wins.
 * The special pattern "*" matches any path.
 *
 * Returns undefined if no rule matches.
 */
export function resolveGlobAction(
	input: string,
	rules: Record<string, Action>,
): Action | undefined {
	let result: Action | undefined;

	for (const [pattern, action] of Object.entries(rules)) {
		if (pattern === "*") {
			result = action;
			continue;
		}

		if (globMatch(pattern, input)) {
			result = action;
		}
	}

	return result;
}

/**
 * Resolve the action for an exact-match tool against a rules map.
 *
 * Rules are evaluated in insertion order; last match wins.
 * The special pattern "*" matches any value.
 *
 * Returns undefined if no rule matches.
 */
export function resolveExactAction(
	input: string,
	rules: Record<string, Action>,
): Action | undefined {
	let result: Action | undefined;

	for (const [pattern, action] of Object.entries(rules)) {
		if (pattern === "*") {
			result = action;
			continue;
		}

		if (pattern === input) {
			result = action;
		}
	}

	return result;
}
