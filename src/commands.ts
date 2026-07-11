import { DEFAULT_CONFIG, loadProjectConfig, saveConfig } from "./config.ts";
import type { Action, GuardConfig, Rules } from "./types.ts";

export interface GuardContext {
	config: GuardConfig;
	activeProfile: string | undefined;
	sessionRules: Record<string, Record<string, Action>>;
}

export function parseGuardArgs(args: string): {
	action: string;
	target: string;
} {
	const trimmed = args.trim();
	if (!trimmed) return { action: "", target: "" };

	const [action = "", ...targetParts] = trimmed.split(/\s+/);
	const target = targetParts.join(" ").trim();

	return { action, target };
}

function handleProfileCommand(
	context: GuardContext,
	target: string | undefined,
): { message: string; type: "info" | "warning" } {
	const profiles = context.config.profiles ?? {};
	const profileNames = Object.keys(profiles);

	if (!target) {
		if (context.activeProfile) {
			return {
				message: `Active profile: ${context.activeProfile}\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}\n\nUse /guard profile <name> to activate\nUse /guard profile off to deactivate`,
				type: "info" as const,
			};
		} else {
			return {
				message: `No profile active\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}\n\nUse /guard profile <name> to activate`,
				type: "info" as const,
			};
		}
	}

	if (target === "off") {
		context.activeProfile = undefined;
		return { message: "Profile deactivated", type: "info" as const };
	}

	if (!(target in profiles)) {
		return {
			message: `Unknown profile: ${target}\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}`,
			type: "warning" as const,
		};
	}

	context.activeProfile = target;
	return { message: `Profile activated: ${target}`, type: "info" as const };
}

async function handleToggleCommand(context: GuardContext): Promise<string> {
	context.config.enabled = !context.config.enabled;
	await saveConfig(context.config);
	return `pi-guard is now ${context.config.enabled ? "ENABLED" : "DISABLED"}`;
}

async function handleEnableCommand(context: GuardContext): Promise<string> {
	context.config.enabled = true;
	await saveConfig(context.config);
	return "pi-guard is now ENABLED";
}

async function handleDisableCommand(context: GuardContext): Promise<string> {
	context.config.enabled = false;
	await saveConfig(context.config);
	return "pi-guard is now DISABLED";
}

function formatLayer(
	label: string,
	rules: Rules | undefined,
	emptyMessage = "(no rules)",
): string {
	if (!rules) {
		return `${label}:\n  ${emptyMessage}\n\n`;
	}

	if (typeof rules === "string") {
		return `${label}:\n  ${rules}\n\n`;
	}

	const entries = Object.entries(rules);
	if (entries.length === 0) {
		return `${label}:\n  ${emptyMessage}\n\n`;
	}

	let output = `${label}:\n`;
	for (const [tool, toolRules] of entries) {
		if (typeof toolRules === "string") {
			output += `  ${tool}: ${toolRules}\n`;
		} else {
			output += `  ${tool}:\n`;
			for (const [pattern, action] of Object.entries(toolRules)) {
				output += `    ${pattern}: ${action}\n`;
			}
		}
	}
	return `${output}\n`;
}

function buildListOutput(context: GuardContext, cwd: string): string {
	const enabled = context.config.enabled ? "ENABLED" : "DISABLED";
	let output = `pi-guard: ${enabled}\n`;
	if (context.activeProfile) {
		output += `Profile: ${context.activeProfile}\n`;
	}
	output += "\n";

	// Load project config
	const projectResult = loadProjectConfig(cwd);
	const projectRules = projectResult?.config.rules ?? {};

	// Parse env rules
	let envRules: Rules | undefined;
	if (process.env.PI_GUARD) {
		try {
			envRules = JSON.parse(process.env.PI_GUARD);
		} catch {
			// Invalid JSON in env var
		}
	}

	// Get profile rules
	const profiles = context.config.profiles ?? {};
	const profileRules = context.activeProfile
		? profiles[context.activeProfile]
		: undefined;

	// Show layers in precedence order: default → user → project → env → profile → session
	output += formatLayer("default", DEFAULT_CONFIG.rules);
	output += formatLayer("user", context.config.rules);
	output += formatLayer(
		"project",
		projectRules,
		projectResult ? undefined : "(no .pi/settings.json)",
	);
	output += formatLayer(
		"environment",
		envRules,
		process.env.PI_GUARD ? "(invalid)" : "(not set)",
	);

	if (context.activeProfile) {
		output += formatLayer(`profile (${context.activeProfile})`, profileRules);
	}

	const sessionRules =
		Object.keys(context.sessionRules).length > 0
			? (context.sessionRules as unknown as Rules)
			: undefined;
	output += formatLayer("session", sessionRules as Rules | undefined);

	return output;
}

export async function handleGuardCommand(
	action: string,
	target: string | undefined,
	context: GuardContext,
	cwd: string,
): Promise<{ message: string; type: "info" | "warning" }> {
	if (action === "toggle") {
		return { message: await handleToggleCommand(context), type: "info" };
	}

	if (action === "enable") {
		return { message: await handleEnableCommand(context), type: "info" };
	}

	if (action === "disable") {
		return { message: await handleDisableCommand(context), type: "info" };
	}

	if (action === "profile") {
		return handleProfileCommand(context, target);
	}

	if (action === "list") {
		return { message: buildListOutput(context, cwd), type: "info" };
	}

	return {
		message: "Usage: /guard <toggle|enable|disable|profile|list>",
		type: "warning",
	};
}
