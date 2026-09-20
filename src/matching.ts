import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import type { Action } from "./types.ts";

/**
 * Check if a single needle token matches a haystack token.
 * Tokens containing `*` or `?` are matched as globs; otherwise exact match.
 */
function tokenMatches(needle: string, haystack: string): boolean {
	if (needle.includes("*") || needle.includes("?")) {
		return globMatch(needle, haystack);
	}
	return needle === haystack;
}

/**
 * Check if `needle` tokens appear in order within `haystack`.
 * Used for bash command matching where rule tokens must appear in order,
 * but extra flags or positional args anywhere in the sequence are permitted.
 * Tokens containing `*` or `?` are matched as globs against haystack tokens.
 */
export function isSubsequence(needle: string[], haystack: string[]): boolean {
	let ni = 0;
	for (const token of haystack) {
		if (ni >= needle.length) break;
		const pattern = needle[ni];
		if (pattern !== undefined && tokenMatches(pattern, token)) ni++;
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
 * When cwd is given, each rule is matched against several forms of the
 * input: normalized, cwd-relative, absolute, and the canonical path with
 * symlinks resolved by the OS (when the path exists).
 *
 * Returns undefined if no rule matches.
 */
export function resolveGlobAction(
	input: string,
	rules: Record<string, Action>,
	cwd?: string,
): Action | undefined {
	let result: Action | undefined;
	const inputs = [path.normalize(input)];
	if (cwd) {
		const absolute = path.resolve(cwd, input);
		inputs.push(path.normalize(path.relative(cwd, absolute) || "."));
		inputs.push(absolute);
		try {
			// Apply the OS resolver to the un-normalized join so ".." after a
			// symlink resolves the way the kernel's open() does. The native
			// resolver is required: the default JS implementation collapses
			// ".." lexically and can disagree with the kernel.
			const joined = path.isAbsolute(input) ? input : cwd + path.sep + input;
			inputs.push(fs.realpathSync.native(joined));
		} catch {
			// Path does not exist yet (e.g. a write target); lexical candidates stand.
		}
	}

	for (const [pattern, action] of Object.entries(rules)) {
		if (pattern === "*") {
			result = action;
			continue;
		}

		if (inputs.some((candidate) => globMatch(pattern, candidate))) {
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
