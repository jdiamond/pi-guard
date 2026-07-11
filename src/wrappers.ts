import { parse as parseBash } from "unbash";
import type { ExtractCtx } from "./extract.ts";
import { createExtractCtx, extractAllCommandsFromAST } from "./extract.ts";
import { formatCommand } from "./format.ts";
import { getCommandArgs, getCommandName } from "./resolve.ts";
import type { CommandRef } from "./types.ts";

/**
 * Describes how a wrapper command embeds a sub-command.
 *
 * - "passthrough": The first non-flag/non-var-assignment argument (and everything
 *   after it) is a sub-command with its own arguments. Flags that consume a value
 *   are listed in `flagArgs` so we can skip past their values.
 *   Examples: xargs, sudo, nice, nohup, env, strace
 *
 * - "flag": A specific flag (e.g. `-c`) takes a string argument that is parsed
 *   as a bash script. The resulting commands are extracted and checked independently.
 *   Examples: bash -c, sh -c, zsh -c
 *
 * - "exec": The sub-command appears after one of `keywords` and runs until
 *   end-of-args (if `terminators` is null) or until a terminator token.
 *   Example: find . -exec rm {} \;  (keywords: ["-exec", "-ok"], terminators: [";", "+"])
 *   Example: fd . -e ts -x rm {}    (keywords: ["-x", "--exec", "-X", "--exec-batch"], terminators: null)
 */
export type WrapperSpec =
	| { type: "passthrough"; flagArgs?: string[]; skipVarAssignments?: boolean }
	| { type: "flag"; flag: string; flagArgs?: string[] }
	| { type: "exec"; keywords: string[]; terminators: string[] | null };

/**
 * Registry of wrapper commands and how to extract sub-commands from them.
 * Key is the command name (as it appears in the AST).
 */
export const WRAPPER_COMMANDS: Record<string, WrapperSpec> = {
	xargs: {
		type: "passthrough",
		// Only flags that consume a separate value argument.
		// Boolean flags (-o, -p, -r, -t, -x) are intentionally omitted.
		flagArgs: [
			"-a",
			"-d",
			"-E",
			"-e",
			"-I",
			"-i",
			"-L",
			"-l",
			"-n",
			"-P",
			"-s",
		],
	},
	sudo: {
		type: "passthrough",
		// Only flags that consume a separate value argument.
		// Boolean flags (-A, -h, -K, -k, -n, -S, -V, -v) are intentionally omitted.
		flagArgs: ["-C", "-D", "-g", "-l", "-p", "-r", "-U", "-u"],
	},
	nice: { type: "passthrough", flagArgs: ["-n"] },
	nohup: { type: "passthrough" },
	env: {
		type: "passthrough",
		// -v is --debug (boolean); only flags that consume a value are listed.
		flagArgs: ["-C", "-S", "-u"],
		skipVarAssignments: true,
	},
	strace: {
		type: "passthrough",
		flagArgs: ["-o", "-O", "-p", "-S", "-e", "-E"],
	},
	bash: {
		type: "flag",
		flag: "-c",
		flagArgs: ["--init-file", "--rcfile", "-D"],
	},
	sh: { type: "flag", flag: "-c" },
	zsh: { type: "flag", flag: "-c" },
	find: {
		type: "exec",
		keywords: ["-exec", "-ok"],
		terminators: [";", "+"],
	},
	fd: {
		type: "exec",
		keywords: ["-x", "--exec", "-X", "--exec-batch"],
		terminators: null,
	},
};

/** Tracks which wrapper commands had sub-commands extracted. Used by
 * formatWrapperDisplay to replace the sub-command portion with `...`. */
export type ExpansionResult = {
	commands: CommandRef[];
	expandedWrappers: Set<CommandRef>;
};

/**
 * Given a list of CommandRefs, expand any wrapper commands by extracting
 * their sub-commands. The original wrapper command is kept — it still needs
 * its own rule check. Sub-commands are recursively expanded for nested wrappers
 * (e.g. `sudo xargs rm`).
 *
 * Degenerate cases (wrapper with no sub-command, e.g. bare `xargs`) are
 * silently ignored — the wrapper itself is still checked against rules.
 */
export function expandWrapperCommands(commands: CommandRef[]): ExpansionResult {
	const expandedWrappers = new Set<CommandRef>();
	// Start group IDs after the highest existing group
	const maxGroupId = commands.reduce(
		(max, cmd) => Math.max(max, cmd.group ?? 0),
		-1,
	);
	const ctx: ExtractCtx = { nextGroupId: maxGroupId + 1 };
	const result = doExpand(commands, expandedWrappers, ctx);
	return { commands: result, expandedWrappers };
}

function doExpand(
	commands: CommandRef[],
	expandedWrappers: Set<CommandRef>,
	ctx: ExtractCtx,
): CommandRef[] {
	const result: CommandRef[] = [...commands];

	for (const cmd of commands) {
		const name = getCommandName(cmd);
		const spec = WRAPPER_COMMANDS[name];
		if (!spec) continue;

		const subCommands = extractSubCommands(cmd, spec, ctx);
		if (subCommands.length > 0) {
			expandedWrappers.add(cmd);
			result.push(...doExpand(subCommands, expandedWrappers, ctx));
		}
	}

	return result;
}

/**
 * Extract sub-commands from a wrapper command based on its spec.
 */
function extractSubCommands(
	cmd: CommandRef,
	spec: WrapperSpec,
	ctx: ExtractCtx,
): CommandRef[] {
	switch (spec.type) {
		case "passthrough":
			return extractPassthrough(
				cmd,
				spec.flagArgs,
				spec.skipVarAssignments ?? false,
				ctx,
			);
		case "flag":
			return extractFlag(cmd, spec.flag, spec.flagArgs, ctx);
		case "exec":
			return extractExec(cmd, spec.keywords, spec.terminators, ctx);
	}
}

/**
 * Scan past a passthrough wrapper's own flags to find where the sub-command starts.
 * Returns the index of the first sub-command argument, or args.length if none found.
 *
 * Handles:
 * 1. Combined short flags with value: -n1 (xargs style)
 * 2. Flags with separate values: -n 1, -u root
 * 3. Long flags with values: --rcfile=file, --rcfile file
 * 4. NAME=VALUE var assignments (for env and similar)
 */
function scanPassthroughBoundary(
	args: string[],
	flagArgs?: string[],
	skipVarAssignments = false,
): number {
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === undefined) break;

		if (skipVarAssignments && isVarAssignment(arg)) {
			i++;
			continue;
		}

		if (!arg.startsWith("-")) break;

		const span = flagSpan(arg, i, args, flagArgs);
		if (
			span === 2 &&
			skipVarAssignments &&
			isVarAssignment(args[i + 1] ?? "")
		) {
			i++;
		} else {
			i += span;
		}
	}
	return i;
}

/**
 * For passthrough wrappers: skip the wrapper's own flags (and optionally
 * NAME=VALUE var assignments), then parse the remaining arguments as a
 * command string.
 *
 * Example: `xargs -0 rm -rf /some/dir` → parse `rm -rf /some/dir`
 */
function extractPassthrough(
	cmd: CommandRef,
	flagArgs?: string[],
	skipVarAssignments = false,
	ctx?: ExtractCtx,
): CommandRef[] {
	const args = getCommandArgs(cmd);
	const i = scanPassthroughBoundary(args, flagArgs, skipVarAssignments);
	if (i >= args.length) return [];
	return parseSubCommandString(args.slice(i).join(" "), ctx);
}

/**
 * For flag-based wrappers: find the target flag and parse its string
 * argument as a bash script.
 *
 * Example: `bash -c 'rm -rf /'` → parse `rm -rf /`
 */
function extractFlag(
	cmd: CommandRef,
	targetFlag: string,
	flagArgs?: string[],
	ctx?: ExtractCtx,
): CommandRef[] {
	const args = getCommandArgs(cmd);

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		if (arg === targetFlag) {
			const scriptArg = args[i + 1];
			return scriptArg ? parseSubCommandString(scriptArg, ctx) : [];
		}

		if (arg?.startsWith("-")) {
			i += flagSpan(arg, i, args, flagArgs);
			continue;
		}

		// Non-flag arg before our target flag — positional argument.
		// For bash, `bash script.sh` is non-wrapped usage; stop looking.
		i++;
	}

	return [];
}

/**
 * For exec-style wrappers (find): extract command(s) between -exec/-ok
 * and their terminators (`;`, `\;`, or `+`).
 *
 * Example: `find . -name '*.ts' -exec rm {} \;` → parse `rm {}`
 */
/** Collect arguments between an exec keyword and its terminator. */
function collectExecCommand(
	args: string[],
	startIdx: number,
	terminators: string[] | null,
): { parts: string[]; nextIdx: number } {
	const parts: string[] = [];
	let i = startIdx;
	while (i < args.length) {
		const part = args[i];
		if (part === undefined) break;
		if (terminators?.includes(part)) return { parts, nextIdx: i + 1 };
		parts.push(part);
		i++;
	}
	return { parts, nextIdx: i };
}

function extractExec(
	cmd: CommandRef,
	keywords: string[],
	terminators: string[] | null,
	ctx?: ExtractCtx,
): CommandRef[] {
	const args = getCommandArgs(cmd);
	const results: CommandRef[] = [];

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === undefined) break;
		if (keywords.includes(arg)) {
			const { parts, nextIdx } = collectExecCommand(args, i + 1, terminators);
			i = nextIdx;
			if (parts.length > 0) {
				results.push(...parseSubCommandString(parts.join(" "), ctx));
			}
			continue;
		}
		i++;
	}

	return results;
}

/**
 * Parse a command string and extract all top-level commands from it.
 * Uses the provided context for group ID allocation, or creates a fresh one.
 */
function parseSubCommandString(str: string, ctx?: ExtractCtx): CommandRef[] {
	try {
		const ast = parseBash(str);
		return extractAllCommandsFromAST(ast, str, ctx ?? createExtractCtx());
	} catch {
		// If we can't parse the sub-command string, we can't check it.
		// Return empty — the caller will still check the wrapper command
		// itself against rules.
		return [];
	}
}

/**
 * Check whether a flag consumes a value argument.
 *
 * Handles both long and short forms:
 * - `-n` matches flagArgs entry `-n` or `n`
 * - `--rcfile` matches flagArgs entry `--rcfile` or `rcfile`
 */
function takesValue(flag: string, flagArgs?: string[]): boolean {
	if (!flagArgs) return false;

	const stripped = flag.replace(/^-+/, "");
	return flagArgs.some((fa) => fa.replace(/^-+/, "") === stripped);
}

/** Check whether an argument is a NAME=VALUE variable assignment. */
function isVarAssignment(arg: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg);
}

/**
 * Returns how many argument positions the flag at args[i] consumes.
 * Returns 2 when the flag takes a separate value argument and the
 * next arg does not itself look like a flag.
 */
function flagSpan(
	arg: string,
	i: number,
	args: string[],
	flagArgs?: string[],
): number {
	if (arg.includes("=")) return 1;
	// Combined short flag with value: -n1
	if (
		arg.length > 2 &&
		!arg.startsWith("--") &&
		takesValue(arg.slice(0, 2), flagArgs)
	)
		return 1;
	if (takesValue(arg, flagArgs) && i + 1 < args.length) {
		const next = args[i + 1];
		if (next && !next.startsWith("-")) return 2;
	}
	return 1;
}

/**
 * Format a wrapper command for display, replacing the sub-command portion
 * with `...` to avoid duplicating the same command name in the prompt.
 *
 * Example: `xargs -0 rm -rf /dir` → `xargs -0 ...`
 * Example: `bash -c 'rm -rf /'` → `bash -c ...`
 * Example: `find . -exec rm {} \;` → `find . -exec ...`
 */
export function formatWrapperDisplay(cmd: CommandRef): string {
	const name = getCommandName(cmd);
	const args = getCommandArgs(cmd);
	const spec = WRAPPER_COMMANDS[name];
	if (!spec) return formatCommand(cmd);

	switch (spec.type) {
		case "passthrough":
			return formatPassthroughDisplay(name, args, spec);
		case "flag":
			return formatFlagDisplay(name, args, spec);
		case "exec":
			return formatExecDisplay(name, args, spec.keywords);
	}
}

function formatPassthroughDisplay(
	name: string,
	args: string[],
	spec: { flagArgs?: string[]; skipVarAssignments?: boolean },
): string {
	const i = scanPassthroughBoundary(
		args,
		spec.flagArgs,
		spec.skipVarAssignments,
	);
	return [name, ...args.slice(0, i), "..."].join(" ");
}

function formatFlagDisplay(
	name: string,
	args: string[],
	spec: { flag: string; flagArgs?: string[] },
): string {
	const parts: string[] = [name];

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		if (arg === spec.flag) {
			parts.push(arg, "...");
			return parts.join(" ");
		}

		if (arg?.startsWith("-")) {
			const span = flagSpan(arg, i, args, spec.flagArgs);
			for (let j = 0; j < span; j++) parts.push(args[i + j] ?? "");
			i += span;
			continue;
		}

		// Non-flag arg before target flag — positional arg
		parts.push(arg ?? "");
		i++;
	}

	// Never found the target flag — no sub-command to elide
	return parts.join(" ");
}

function formatExecDisplay(
	name: string,
	args: string[],
	keywords: string[],
): string {
	const displayParts: string[] = [name];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) break;
		if (keywords.includes(arg)) {
			displayParts.push(arg);
			displayParts.push("...");
			return displayParts.join(" ");
		}
		displayParts.push(arg);
	}

	// No keyword found — just return as-is
	return displayParts.join(" ");
}
