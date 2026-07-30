import type { Command } from "unbash";

/** A concrete command node together with the source string its positions refer to. */
export interface CommandRef {
	node: Command;
	source: string;
	/** Group ID: commands in the same group are connected by operators. */
	group: number;
	/** The parent group when this command was found inside a shell expansion. */
	parentGroup?: number;
	/** The operator connecting this command to the next ("|", "&&", "||", or ";").
	 * Undefined for the last command in a group. */
	joiner?: "|" | "&&" | "||" | ";";
}

/** Matcher types define how to extract and match input from a tool call. */
export type MatcherType = "bash" | "glob" | "exact";

/** Defines how to extract and match input from a tool call. */
export interface Matcher {
	/** Tool parameter to extract (e.g., "command", "path", "url") */
	param: string;
	/** How to match the extracted value */
	type: MatcherType;
}

/** Permission actions. */
export type Action = "allow" | "ask" | "deny";

/** Rules for a single tool - can be a single action or pattern-based rules. */
export type ToolRules = Action | Record<string, Action>;

/** All rules organized by tool name. */
export type Rules = Action | Record<string, ToolRules>;

/** Custom matchers for additional tools. */
export type Matchers = Record<string, Matcher>;

/** Named profile with rule overrides. */
export type Profile = Rules;

/** Full configuration for pi-guard. */
export interface GuardConfig {
	enabled: boolean;
	matchers?: Matchers;
	rules: Rules;
	profiles?: Record<string, Profile>;
	shortcuts?: Record<string, string | undefined>;
}

/** Tool call event shape for type-safe matching. */
export interface ToolCallInput {
	[key: string]: unknown;
}
