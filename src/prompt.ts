import { formatCommand, truncate } from "./format.ts";
import type { CommandRef } from "./types.ts";
import { formatWrapperDisplay } from "./wrappers.ts";

export interface ApprovalPromptOptions {
	maxLength?: number;
	argMaxLength?: number;
}

export interface ApprovalCommandLine {
	text: string;
	allowed: boolean;
	joiner?: string | undefined;
}

export interface ApprovalPromptData {
	title: string;
	body?: string;
	commands: ApprovalCommandLine[];
}

export function buildApprovalPromptData(
	allCommands: CommandRef[],
	unauthorizedCommands: CommandRef[],
	options?: ApprovalPromptOptions,
	expandedWrappers?: Set<CommandRef>,
): ApprovalPromptData {
	const unauthorizedSet = new Set(unauthorizedCommands);
	const commands: ApprovalCommandLine[] = [];

	let prevGroup: number | undefined;

	for (const command of allCommands) {
		// Insert blank line between groups
		if (prevGroup !== undefined && command.group !== prevGroup) {
			commands.push({ text: "", allowed: true });
		}
		prevGroup = command.group;

		const allowed = !unauthorizedSet.has(command);
		const display = expandedWrappers?.has(command)
			? formatWrapperDisplay(command)
			: formatCommand(command, options);
		const line: ApprovalCommandLine = { text: display, allowed };
		if (command.joiner) line.joiner = command.joiner;
		commands.push(line);
	}

	return { title: "⚠️ Unapproved Commands", commands };
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
