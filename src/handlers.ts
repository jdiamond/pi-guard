import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parse as parseBash, type Script } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import {
	resolveBashAction,
	resolveExactAction,
	resolveGlobAction,
} from "./matching.ts";
import {
	buildApprovalPrompt,
	buildCustomApprovalPrompt,
	buildFileApprovalPrompt,
} from "./prompt.ts";
import { getCommandArgs, getCommandName, isBareAssignment } from "./resolve.ts";
import type { Action, CommandRef, ToolCallInput } from "./types.ts";
import { expandWrapperCommands } from "./wrappers.ts";

export async function handleInteractiveApproval(
	pi: ExtensionAPI,
	tool: string,
	input: ToolCallInput,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | undefined> {
	return handleToolApproval(
		pi,
		tool,
		"ask",
		ctx,
		sessionRules,
		buildCustomApprovalPrompt(tool, input),
	);
}

export async function handleBashTool(
	pi: ExtensionAPI,
	tool: string,
	rawCmd: string,
	toolRules: Record<string, Action>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | undefined> {
	let ast: Script | undefined;
	try {
		ast = parseBash(rawCmd);
	} catch {
		return handleBashParseFailure(pi, ctx);
	}

	const { commands: allCommands, expandedWrappers } = expandWrapperCommands(
		extractAllCommandsFromAST(ast, rawCmd),
	);
	if (allCommands.length === 0) return;

	const unauthorizedCommands = findUnauthorizedCommands(allCommands, toolRules);
	if (unauthorizedCommands.length === 0) return;

	if (!ctx.hasUI)
		return handleNonInteractiveBash(unauthorizedCommands, toolRules);

	return handleInteractiveBash(
		pi,
		tool,
		allCommands,
		unauthorizedCommands,
		expandedWrappers,
		ctx,
		sessionRules,
	);
}

async function handleBashParseFailure(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	if (!ctx.hasUI) {
		return {
			block: true,
			reason: `[Blocked by pi-guard: Failed to parse command safely]`,
		};
	}

	pi.events.emit("nudge", { body: "Command needs approval" });
	pi.events.emit("herdr:blocked", { active: true, label: "Unparseable command" });
	const confirmed = await ctx.ui.confirm(
		"⚠️ Could Not Parse Command Safely",
		"\nAllow anyway?",
	);
	pi.events.emit("herdr:blocked", { active: false });

	if (!confirmed) {
		return {
			block: true,
			reason: `[Blocked by pi-guard: User rejected this invocation]`,
		};
	}
}

function findUnauthorizedCommands(
	allCommands: CommandRef[],
	toolRules: Record<string, Action>,
): CommandRef[] {
	const unauthorized: CommandRef[] = [];
	for (const cmd of allCommands) {
		if (isBareAssignment(cmd)) continue;
		const name = getCommandName(cmd);
		const args = getCommandArgs(cmd);
		if (resolveBashAction(name, args, toolRules) !== "allow") {
			unauthorized.push(cmd);
		}
	}
	return unauthorized;
}

function handleNonInteractiveBash(
	unauthorizedCommands: CommandRef[],
	toolRules: Record<string, Action>,
): { block: true; reason: string } | undefined {
	const firstCmd = unauthorizedCommands[0];
	if (!firstCmd) return;
	const name = getCommandName(firstCmd);
	const args = getCommandArgs(firstCmd);
	const action = resolveBashAction(name, args, toolRules);

	if (action === "deny") {
		return { block: true, reason: `[Blocked by pi-guard: Security policy]` };
	}
	return {
		block: true,
		reason: `[Blocked by pi-guard: No interactive session available]`,
	};
}

async function handleInteractiveBash(
	pi: ExtensionAPI,
	tool: string,
	allCommands: CommandRef[],
	unauthorizedCommands: CommandRef[],
	expandedWrappers: Set<CommandRef>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | undefined> {
	const uniqueBaseNames = Array.from(
		new Set(unauthorizedCommands.map(getCommandName)),
	);
	const alwaysLabel = `Always allow ${uniqueBaseNames.join(", ")} (this session)`;

	pi.events.emit("nudge", { body: "Command needs approval" });
	pi.events.emit("herdr:blocked", { active: true, label: "Command approval" });
	const choice = await ctx.ui.select(
		buildApprovalPrompt(
			allCommands,
			unauthorizedCommands,
			undefined,
			expandedWrappers,
		),
		["Allow", alwaysLabel, "Reject"],
	);
	pi.events.emit("herdr:blocked", { active: false });

	if (choice === alwaysLabel) {
		sessionRules[tool] = sessionRules[tool] ?? {};
		for (const name of uniqueBaseNames) {
			sessionRules[tool][name] = "allow";
		}
		return;
	}

	if (choice !== "Allow") {
		return {
			block: true,
			reason: `[Blocked by pi-guard: User rejected this invocation]`,
		};
	}
}

async function handleToolApproval(
	pi: ExtensionAPI,
	tool: string,
	action: Action | undefined,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
	prompt: string,
): Promise<{ block: true; reason: string } | undefined> {
	if (action === "allow") return;
	if (action === "deny") {
		return { block: true, reason: "[Blocked by pi-guard: Security policy]" };
	}
	if (!ctx.hasUI) {
		return {
			block: true,
			reason: "[Blocked by pi-guard: No interactive session available]",
		};
	}
	const alwaysLabel = `Always allow ${tool} (this session)`;
	pi.events.emit("nudge", { body: `${tool} needs approval` });
	pi.events.emit("herdr:blocked", { active: true, label: `${tool} approval` });
	const choice = await ctx.ui.select(prompt, ["Allow", alwaysLabel, "Reject"]);
	pi.events.emit("herdr:blocked", { active: false });
	if (choice === alwaysLabel) {
		sessionRules[tool] = { ...sessionRules[tool], "*": "allow" };
		return;
	}
	if (choice !== "Allow") {
		return {
			block: true,
			reason: "[Blocked by pi-guard: User rejected this invocation]",
		};
	}
}

export async function handleGlobTool(
	pi: ExtensionAPI,
	tool: string,
	path: string,
	toolRules: Record<string, Action>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | undefined> {
	return handleToolApproval(
		pi,
		tool,
		resolveGlobAction(path, toolRules),
		ctx,
		sessionRules,
		buildFileApprovalPrompt(tool, path),
	);
}

export async function handleExactTool(
	pi: ExtensionAPI,
	tool: string,
	value: string,
	toolRules: Record<string, Action>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
	input: ToolCallInput,
): Promise<{ block: true; reason: string } | undefined> {
	return handleToolApproval(
		pi,
		tool,
		resolveExactAction(value, toolRules),
		ctx,
		sessionRules,
		buildCustomApprovalPrompt(tool, input),
	);
}
