import { formatCommand, truncate } from "./format.ts";
import { getCommandName } from "./resolve.ts";
import type { CommandRef } from "./types.ts";
import { formatWrapperDisplay, WRAPPER_COMMANDS } from "./wrappers.ts";

export interface ApprovalPromptOptions {
	maxLength?: number;
	argMaxLength?: number;
}

export interface ApprovalCommandLine {
	text: string;
	allowed: boolean;
	highlighted?: boolean | undefined;
	indent?: number | undefined;
	joiner?: string | undefined;
}

export interface ApprovalPromptData {
	title: string;
	body?: string;
	commands: ApprovalCommandLine[];
}

export function buildBashApprovalChoices(
	commandNames: string[],
	writeTargets: string[],
): string[] {
	const choices = ["Allow"];
	if (commandNames.length > 0) {
		choices.push(
			`Temporarily allow ${commandNames.join(", ")} (this session only)`,
			`Permanently allow ${commandNames.join(", ")} (save to settings.json)`,
		);
	}
	if (writeTargets.length > 0) {
		choices.push(
			"Temporarily allow these writes (this session only)",
			"Permanently allow these writes (save to settings.json)",
		);
	}
	choices.push("Reject");
	return choices;
}

export function buildApprovalPromptData(
	allCommands: CommandRef[],
	unauthorizedCommands: CommandRef[],
	options?: ApprovalPromptOptions,
	expandedWrappers?: Set<CommandRef>,
): ApprovalPromptData {
	const unauthorizedSet = new Set(unauthorizedCommands);
	const commands: ApprovalCommandLine[] = [];
	const groupParents = new Map<number, number>();
	for (const command of allCommands) {
		if (command.parentGroup !== undefined) {
			groupParents.set(command.group, command.parentGroup);
		}
	}

	const highlightedCommands = findInputSources(
		allCommands,
		unauthorizedCommands,
		groupParents,
	);

	for (const command of allCommands) {
		const allowed = !unauthorizedSet.has(command);
		const display = expandedWrappers?.has(command)
			? formatWrapperDisplay(command)
			: formatCommand(command, options);
		const indent = groupNestingDepth(command.group, groupParents);
		const line: ApprovalCommandLine = { text: display, allowed };
		if (highlightedCommands.has(command)) line.highlighted = true;
		if (indent > 0) line.indent = indent;
		if (command.joiner) line.joiner = command.joiner;
		commands.push(line);
	}

	return { title: "⚠️ Unapproved Commands", commands };
}

function findInputSources(
	allCommands: CommandRef[],
	unauthorizedCommands: CommandRef[],
	groupParents: ReadonlyMap<number, number>,
): Set<CommandRef> {
	const inputSourceGroups = new Set<number>();
	for (const command of allCommands) {
		if (isInputSourceWrapper(command)) inputSourceGroups.add(command.group);
	}

	const highlighted = new Set<CommandRef>();
	for (const command of unauthorizedCommands) {
		const inputSourceGroup = findAncestorGroup(
			command.group,
			inputSourceGroups,
			groupParents,
		);
		if (inputSourceGroup === undefined) continue;
		const wrapperIndex = allCommands.findIndex(
			(candidate) =>
				candidate.group === inputSourceGroup && isInputSourceWrapper(candidate),
		);
		if (wrapperIndex < 1) continue;
		const previous = allCommands[wrapperIndex - 1];
		if (previous?.group === inputSourceGroup && previous.joiner === "|") {
			highlighted.add(previous);
		}
	}
	return highlighted;
}

function isInputSourceWrapper(command: CommandRef): boolean {
	const spec = WRAPPER_COMMANDS[getCommandName(command)];
	return spec?.type === "passthrough" && spec.highlightInputSource === true;
}

function findAncestorGroup(
	group: number,
	ancestors: ReadonlySet<number>,
	groupParents: ReadonlyMap<number, number>,
): number | undefined {
	const visited = new Set<number>();
	let current = group;
	while (!visited.has(current)) {
		if (ancestors.has(current)) return current;
		visited.add(current);
		const parent = groupParents.get(current);
		if (parent === undefined) return undefined;
		current = parent;
	}
	return undefined;
}

function groupNestingDepth(
	group: number,
	groupParents: ReadonlyMap<number, number>,
): number {
	let depth = 0;
	let current = group;
	const visited = new Set<number>();
	while (groupParents.has(current) && !visited.has(current)) {
		visited.add(current);
		depth++;
		const parent = groupParents.get(current);
		if (parent === undefined) break;
		current = parent;
	}
	return depth;
}

/** Build prompt data for file operations (read/edit/write). */
export function buildFileApprovalPromptData(
	tool: string,
	path: string,
): ApprovalPromptData {
	return {
		title: `⚠️ ${tool.charAt(0).toUpperCase() + tool.slice(1)} Permission Required`,
		body: path,
		commands: [],
	};
}

/** Build prompt data for custom tools showing all input parameters. */
export function buildCustomApprovalPromptData(
	tool: string,
	input: Record<string, unknown>,
	options?: { valueMaxLength?: number },
): ApprovalPromptData {
	const valueMaxLength = options?.valueMaxLength ?? 200;
	const params = formatParams(input, valueMaxLength);
	return {
		title: `⚠️ ${tool} Permission Required`,
		body: params ?? "(no parameters)",
		commands: [],
	};
}

function formatParams(
	input: Record<string, unknown>,
	maxLength: number,
): string | undefined {
	let result = "";
	let first = true;
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		const formatted = formatParamValue(value, maxLength);
		if (!first) result += "\n";
		result += `${key}: ${formatted}`;
		first = false;
	}
	return result || undefined;
}

function formatParamValue(value: unknown, maxLength: number): string {
	if (value === null) return "null";
	if (typeof value === "string") return truncate(value, maxLength);
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		const joined = value.map((v) => String(v)).join(", ");
		return truncate(joined, maxLength);
	}
	try {
		return truncate(JSON.stringify(value), maxLength);
	} catch {
		return truncate(String(value), maxLength);
	}
}
