import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parse as parseBash, type Script } from "unbash";
import { ApprovalDialog } from "./components/approval-dialog.ts";
import { extractAllCommandsFromAST } from "./extract.ts";
import {
	resolveBashAction,
	resolveExactAction,
	resolveGlobAction,
} from "./matching.ts";
import {
	type ApprovalPromptData,
	buildApprovalPromptData,
	buildBashApprovalChoices,
	buildCustomApprovalPromptData,
	buildFileApprovalPromptData,
} from "./prompt.ts";
import { getCommandArgs, getCommandName, isBareAssignment } from "./resolve.ts";
import type { Action, CommandRef, ToolCallInput } from "./types.ts";
import { expandWrapperCommands } from "./wrappers.ts";

async function withBlockedUi<T>(
	pi: ExtensionAPI,
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	pi.events.emit("nudge", { body: label });
	pi.events.emit("herdr:blocked", { active: true, label });
	try {
		return await fn();
	} finally {
		pi.events.emit("herdr:blocked", { active: false });
	}
}

function blockedByUserRejection() {
	return {
		block: true as const,
		reason: "[Blocked by pi-guard: User rejected this invocation]",
		terminate: true as const,
	};
}

async function showApprovalDialog(
	ctx: ExtensionContext,
	promptData: ApprovalPromptData,
	choices: string[],
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const dialog = new ApprovalDialog(theme, {
			data: promptData,
			choices,
			onChoice: done,
		});
		return {
			render: (width) => dialog.render(width),
			handleInput: (data) => {
				dialog.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => dialog.invalidate(),
		};
	});
}

export async function handleInteractiveApproval(
	pi: ExtensionAPI,
	tool: string,
	input: ToolCallInput,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
	onSave?: () => Promise<void>,
): Promise<{ block: true; reason: string } | undefined> {
	return handleToolApproval(
		pi,
		tool,
		"ask",
		ctx,
		sessionRules,
		buildCustomApprovalPromptData(tool, input),
		onSave,
	);
}

export async function handleBashTool(
	pi: ExtensionAPI,
	tool: string,
	rawCmd: string,
	toolRules: Record<string, Action>,
	writeRules: Record<string, Action>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
	onSaveBashRules?: (patterns: string[]) => Promise<void>,
	onSaveWriteRules?: (patterns: string[]) => Promise<void>,
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
	const unauthorizedRedirects = findUnauthorizedRedirects(
		allCommands,
		writeRules,
		ctx.cwd,
	);
	const unauthorized = Array.from(
		new Set([...unauthorizedCommands, ...unauthorizedRedirects]),
	);
	if (unauthorized.length === 0) return;

	for (const cmd of unauthorizedRedirects) {
		if (hasDeniedRedirect(cmd, writeRules, ctx.cwd)) {
			return {
				block: true,
				reason: "[Blocked by pi-guard: Security policy]",
			};
		}
	}

	if (!ctx.hasUI) return handleNonInteractiveBash(unauthorized, toolRules);

	return handleInteractiveBash(
		pi,
		tool,
		allCommands,
		unauthorizedCommands,
		unauthorizedRedirects,
		toolRules,
		writeRules,
		expandedWrappers,
		ctx,
		sessionRules,
		onSaveBashRules,
		onSaveWriteRules,
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

	const confirmed = await withBlockedUi(pi, "Unparseable command", () =>
		ctx.ui.confirm("⚠️ Could Not Parse Command Safely", "\nAllow anyway?"),
	);

	if (!confirmed) {
		return blockedByUserRejection();
	}

	// Returning undefined means the user allowed the command and it should run.
}

export function findUnauthorizedRedirects(
	allCommands: CommandRef[],
	writeRules: Record<string, Action>,
	cwd: string,
): CommandRef[] {
	return allCommands.filter((cmd) =>
		cmd.node.redirects.some(
			(redirect) =>
				isOutputRedirect(
					redirect.operator,
					redirect.target?.value ?? redirect.target?.text,
				) &&
				redirect.target &&
				resolveGlobAction(
					redirect.target.value ?? redirect.target.text,
					writeRules,
					cwd,
				) !== "allow",
		),
	);
}

export function hasDeniedRedirect(
	cmd: CommandRef,
	writeRules: Record<string, Action>,
	cwd: string,
): boolean {
	return cmd.node.redirects.some(
		(redirect) =>
			isOutputRedirect(
				redirect.operator,
				redirect.target?.value ?? redirect.target?.text,
			) &&
			redirect.target &&
			resolveGlobAction(
				redirect.target.value ?? redirect.target.text,
				writeRules,
				cwd,
			) === "deny",
	);
}

export function isOutputRedirect(
	operator: string,
	target: string | undefined,
): boolean {
	if ([">", ">>", ">|", "&>", "&>>"].includes(operator)) return true;
	if (operator !== ">&") return false;

	// >&N duplicates stdout to file descriptor N; >&- closes it.
	return target !== undefined && target !== "-" && !/^\d+$/.test(target);
}

function getOutputRedirectTargets(commands: CommandRef[]): string[] {
	return Array.from(
		new Set(
			commands.flatMap((cmd) =>
				cmd.node.redirects.flatMap((redirect) => {
					const target = redirect.target?.value ?? redirect.target?.text;
					return isOutputRedirect(redirect.operator, target) && target
						? [target]
						: [];
				}),
			),
		),
	);
}

function applyAllowRules(rules: Record<string, Action>, patterns: string[]) {
	for (const pattern of patterns) rules[pattern] = "allow";
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
	unauthorizedRedirects: CommandRef[],
	toolRules: Record<string, Action>,
	writeRules: Record<string, Action>,
	expandedWrappers: Set<CommandRef>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
	onSaveBashRules?: (patterns: string[]) => Promise<void>,
	onSaveWriteRules?: (patterns: string[]) => Promise<void>,
): Promise<{ block: true; reason: string } | undefined> {
	return withBlockedUi(pi, "Command approval", () =>
		runApprovalLoop(
			allCommands,
			tool,
			unauthorizedCommands,
			unauthorizedRedirects,
			toolRules,
			writeRules,
			expandedWrappers,
			ctx,
			sessionRules,
			onSaveBashRules,
			onSaveWriteRules,
		),
	);
}

/**
 * Keep asking until all command and redirect permissions are resolved, or the
 * user explicitly allows this invocation once.
 */
async function runApprovalLoop(
	allCommands: CommandRef[],
	tool: string,
	unauthorizedCommands: CommandRef[],
	unauthorizedRedirects: CommandRef[],
	toolRules: Record<string, Action>,
	writeRules: Record<string, Action>,
	expandedWrappers: Set<CommandRef>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
	onSaveBashRules?: (patterns: string[]) => Promise<void>,
	onSaveWriteRules?: (patterns: string[]) => Promise<void>,
): Promise<{ block: true; reason: string } | undefined> {
	while (true) {
		unauthorizedCommands = findUnauthorizedCommands(allCommands, toolRules);
		unauthorizedRedirects = findUnauthorizedRedirects(
			allCommands,
			writeRules,
			ctx.cwd,
		);
		if (
			unauthorizedCommands.length === 0 &&
			unauthorizedRedirects.length === 0
		) {
			return;
		}
		const unauthorized = Array.from(
			new Set([...unauthorizedCommands, ...unauthorizedRedirects]),
		);
		const commandNames = Array.from(
			new Set(unauthorizedCommands.map(getCommandName)),
		);
		const writeTargets = getOutputRedirectTargets(unauthorizedRedirects);
		const choices = buildBashApprovalChoices(commandNames, writeTargets);
		const commandLabels = commandNames.length > 0 ? choices.slice(1, 3) : [];
		const writeStart = 1 + commandLabels.length;
		const writeLabels = writeTargets.length
			? choices.slice(writeStart, writeStart + 2)
			: [];
		const promptData = buildApprovalPromptData(
			allCommands,
			unauthorized,
			undefined,
			expandedWrappers,
		);
		const choice = await showApprovalDialog(ctx, promptData, choices);

		if (
			await handleCommandChoice(
				choice,
				commandLabels,
				unauthorizedCommands,
				ctx,
				tool,
				toolRules,
				sessionRules,
				onSaveBashRules,
			)
		) {
			continue;
		}
		if (
			await handleWriteChoice(
				choice,
				writeLabels,
				writeTargets,
				ctx,
				writeRules,
				sessionRules,
				onSaveWriteRules,
			)
		) {
			continue;
		}
		if (choice !== "Allow") return blockedByUserRejection();
		return;
	}
}

async function handleCommandChoice(
	choice: string | undefined,
	labels: string[],
	commands: CommandRef[],
	ctx: ExtensionContext,
	tool: string,
	toolRules: Record<string, Action>,
	sessionRules: Record<string, Record<string, Action>>,
	onSave?: (patterns: string[]) => Promise<void>,
): Promise<boolean> {
	if (labels.length === 0 || (choice !== labels[0] && choice !== labels[1])) {
		return false;
	}
	const patterns = await openCommandEditor(
		commands,
		ctx,
		choice === labels[0]
			? "Edit commands to allow for this session (one per line)"
			: "Edit commands to always allow (one per line)",
	);
	if (patterns === undefined) return true;
	applyAllowRules(toolRules, patterns);
	if (choice === labels[0]) {
		sessionRules[tool] = sessionRules[tool] ?? {};
		applyAllowRules(sessionRules[tool], patterns);
	} else if (onSave) {
		await onSave(patterns);
	}
	return true;
}

async function handleWriteChoice(
	choice: string | undefined,
	labels: string[],
	targets: string[],
	ctx: ExtensionContext,
	writeRules: Record<string, Action>,
	sessionRules: Record<string, Record<string, Action>>,
	onSave?: (patterns: string[]) => Promise<void>,
): Promise<boolean> {
	if (labels.length === 0 || (choice !== labels[0] && choice !== labels[1])) {
		return false;
	}
	const patterns = await openWriteEditor(
		targets,
		ctx,
		choice === labels[0]
			? "Edit writes to allow for this session (one per line)"
			: "Edit writes to always allow (one per line)",
	);
	if (patterns === undefined) return true;
	applyAllowRules(writeRules, patterns);
	if (choice === labels[0]) {
		sessionRules.write = sessionRules.write ?? {};
		applyAllowRules(sessionRules.write, patterns);
	} else if (onSave) {
		await onSave(patterns);
	}
	return true;
}

async function openCommandEditor(
	unauthorizedCommands: CommandRef[],
	ctx: ExtensionContext,
	title: string,
): Promise<string[] | undefined> {
	const prefillLines = Array.from(
		new Set(
			unauthorizedCommands.map((cmd) => {
				const name = getCommandName(cmd);
				const args = getCommandArgs(cmd);
				return args.length > 0 ? `${name} ${args.join(" ")}` : name;
			}),
		),
	).join("\n");

	const result = await ctx.ui.editor(title, prefillLines);

	if (result === undefined) return undefined;

	return parseEditorLines(result);
}

async function openWriteEditor(
	targets: string[],
	ctx: ExtensionContext,
	title: string,
): Promise<string[] | undefined> {
	const result = await ctx.ui.editor(title, targets.join("\n"));
	return result === undefined ? undefined : parseEditorLines(result);
}

function parseEditorLines(result: string): string[] {
	return Array.from(
		new Set(
			result
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
		),
	);
}

async function handleToolApproval(
	pi: ExtensionAPI,
	tool: string,
	action: Action | undefined,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
	promptData: ApprovalPromptData,
	onSave?: () => Promise<void>,
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
	const temporaryAllowLabel = `Temporarily allow ${tool} (this session only)`;
	const permanentAllowLabel = `Permanently allow ${tool} (save to settings.json)`;
	const choices = ["Allow", temporaryAllowLabel];
	if (onSave) choices.push(permanentAllowLabel);
	choices.push("Reject");
	const choice = await withBlockedUi(pi, `${tool} approval`, () =>
		showApprovalDialog(ctx, promptData, choices),
	);
	if (choice === temporaryAllowLabel) {
		sessionRules[tool] = { ...sessionRules[tool], "*": "allow" };
		return;
	}
	if (choice === permanentAllowLabel && onSave) {
		await onSave();
		return;
	}
	if (choice !== "Allow") {
		return blockedByUserRejection();
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
		resolveGlobAction(path, toolRules, ctx.cwd),
		ctx,
		sessionRules,
		buildFileApprovalPromptData(tool, path),
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
		buildCustomApprovalPromptData(tool, input),
	);
}
