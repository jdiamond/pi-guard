import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { GuardContext } from "./commands.ts";
import { handleGuardCommand, parseGuardArgs } from "./commands.ts";
import {
	buildEffectiveRules,
	loadConfig,
	loadProjectConfig,
} from "./config.ts";
import {
	handleBashTool,
	handleExactTool,
	handleGlobTool,
	handleInteractiveApproval,
} from "./handlers.ts";
import type { Action, Matchers, Rules, ToolCallInput } from "./types.ts";

const block = (reason: string): { block: true; reason: string } => ({
	block: true,
	reason: `[Blocked by pi-guard: ${reason}]`,
});

export { parseGuardArgs };

function getEffectiveRulesForEvent(
	userRules: Rules,
	projectRules: Rules,
	envRules: Rules | undefined,
	context: GuardContext,
): Rules {
	const profiles = context.config.profiles ?? {};
	const profileRules = context.activeProfile
		? profiles[context.activeProfile]
		: undefined;
	return buildEffectiveRules(
		userRules,
		projectRules,
		envRules,
		profileRules,
		context.sessionRules,
	);
}

async function handleToolCall(
	pi: ExtensionAPI,
	tool: string,
	input: ToolCallInput,
	effectiveRules: Rules,
	ctx: ExtensionContext,
	context: GuardContext,
): Promise<{ block: true; reason: string } | undefined> {
	const toolRules =
		typeof effectiveRules === "object" ? effectiveRules[tool] : effectiveRules;

	let action: Action = "ask";
	if (typeof toolRules !== "object") {
		action = toolRules ?? "ask";
	} else {
		return handleMatchedTool(pi, tool, input, toolRules, ctx, context);
	}

	return applyToolAction(pi, tool, input, action, ctx, context.sessionRules);
}

async function handleMatchedTool(
	pi: ExtensionAPI,
	tool: string,
	input: ToolCallInput,
	toolRules: Record<string, Action>,
	ctx: ExtensionContext,
	context: GuardContext,
): Promise<{ block: true; reason: string } | undefined> {
	const matchers: Matchers | undefined = context.config.matchers;
	const matcher = matchers?.[tool];
	if (!matcher) {
		const action = toolRules["*"] ?? "ask";
		return applyToolAction(pi, tool, input, action, ctx, context.sessionRules);
	}

	const value = input[matcher.param];
	if (typeof value !== "string" || value.trim() === "") return;

	switch (matcher.type) {
		case "bash":
			return handleBashTool(
				pi,
				tool,
				value,
				toolRules,
				ctx,
				context.sessionRules,
			);
		case "glob":
			return handleGlobTool(
				pi,
				tool,
				value,
				toolRules,
				ctx,
				context.sessionRules,
			);
		case "exact":
			return handleExactTool(
				pi,
				tool,
				value,
				toolRules,
				ctx,
				context.sessionRules,
				input,
			);
	}
}

async function applyToolAction(
	pi: ExtensionAPI,
	tool: string,
	input: ToolCallInput,
	action: Action,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | undefined> {
	if (action === "allow") return;
	if (action === "deny") return block("Security policy");
	if (!ctx.hasUI) return block("No interactive session available");
	return handleInteractiveApproval(pi, tool, input, ctx, sessionRules);
}

export default function (pi: ExtensionAPI) {
	// Load all static config once at startup
	const loaded = loadConfig();
	const projectResult = loadProjectConfig(process.cwd());

	const userRules: Rules = loaded.config.rules;
	const projectRules: Rules = projectResult?.config.rules ?? {};
	const envRules: Rules | undefined = loaded.envRules;

	// Accumulate any warnings to show once
	const warnings: string[] = [];
	if (loaded.warning) warnings.push(loaded.warning);
	if (projectResult?.warning) warnings.push(projectResult.warning);
	if (warnings.length > 0) {
		console.warn(`[pi-guard] ${warnings.join("; ")}`);
	}

	const context: GuardContext = {
		config: loaded.config,
		activeProfile: undefined,
		sessionRules: {},
	};

	// Register shortcut commands
	const shortcuts = context.config.shortcuts ?? {};
	for (const [shortcut, subcommand] of Object.entries(shortcuts)) {
		if (!subcommand) continue;
		pi.registerCommand(shortcut, {
			description: `pi-guard shortcut: ${subcommand}`,
			handler: async (_args, ctx) => {
				const { action, target } = parseGuardArgs(subcommand);
				const result = handleGuardCommand(action, target, context, ctx.cwd);
				ctx.ui.notify(result.message, result.type);
			},
		});
	}

	// Settings Management Command
	pi.registerCommand("guard", {
		description: "Manage pi-guard security settings",
		handler: async (args, ctx) => {
			const { action, target } = parseGuardArgs(args);
			const result = handleGuardCommand(action, target, context, ctx.cwd);
			ctx.ui.notify(result.message, result.type);
		},
	});

	// The core interception hook
	pi.on("tool_call", async (event, ctx) => {
		if (!context.config.enabled) return;

		const effectiveRules = getEffectiveRulesForEvent(
			userRules,
			projectRules,
			envRules,
			context,
		);

		return handleToolCall(
			pi,
			event.toolName,
			event.input as ToolCallInput,
			effectiveRules,
			ctx,
			context,
		);
	});
}
