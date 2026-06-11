import { formatCommand, truncate } from "./format.ts";
import type { CommandRef } from "./types.ts";
import { formatWrapperDisplay } from "./wrappers.ts";

export interface ApprovalPromptOptions {
	maxLength?: number;
	argMaxLength?: number;
}

export function buildApprovalPrompt(
	allCommands: CommandRef[],
	unauthorizedCommands: CommandRef[],
	options?: ApprovalPromptOptions,
	expandedWrappers?: Set<CommandRef>,
): string {
	const unauthorizedSet = new Set(unauthorizedCommands);
	const lines: string[] = [];

	let prevGroup: number | undefined;

	for (const command of allCommands) {
		// Insert blank line between groups
		if (prevGroup !== undefined && command.group !== prevGroup) {
			lines.push("");
		}
		prevGroup = command.group;

		const marker = unauthorizedSet.has(command) ? "✖" : "✔";
		const display = expandedWrappers?.has(command)
			? formatWrapperDisplay(command)
			: formatCommand(command, options);
		const line = `${marker} ${display}`;
		lines.push(command.joiner ? `${line} ${command.joiner}` : line);
	}

	return ["⚠️ Unapproved Commands", "", ...lines].join("\n");
}

/** Build prompt for file operations (read/edit/write). */
export function buildFileApprovalPrompt(
	tool: string,
	path: string,
	options?: { maxLength?: number },
): string {
	const maxLength = options?.maxLength ?? 120;
	return `⚠️ ${tool.charAt(0).toUpperCase() + tool.slice(1)} Permission Required\n\n${truncate(path, maxLength)}`;
}

/** Build prompt for custom tools showing all input parameters. */
export function buildCustomApprovalPrompt(
	tool: string,
	input: Record<string, unknown>,
	options?: { maxLength?: number; valueMaxLength?: number },
): string {
	const valueMaxLength = options?.valueMaxLength ?? 200;
	const header = `⚠️ ${tool} Permission Required`;
	const params = formatParams(input, valueMaxLength);
	if (!params) return `${header}\n\n(no parameters)`;
	return [header, "", params].join("\n");
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
