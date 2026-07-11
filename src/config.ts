import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type { Action, GuardConfig, Rules, ToolRules } from "./types.ts";

// ── Constants ──

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");

export const SAFE_FALLBACK_CONFIG: GuardConfig = {
	enabled: true,
	matchers: DEFAULT_CONFIG.matchers,
	rules: {},
};

export interface LoadedConfigResult {
	config: GuardConfig;
	warning?: string;
}

// ── TypeBox schemas ──

const ActionSchema = Type.Enum({
	allow: "allow",
	ask: "ask",
	deny: "deny",
} as const);

const ToolRulesSchema = Type.Union([
	ActionSchema,
	Type.Record(Type.String(), ActionSchema),
] as const);

const RulesSchema = Type.Union([
	ActionSchema,
	Type.Record(Type.String(), ToolRulesSchema),
] as const);

const MatcherSchema = Type.Object({
	param: Type.String(),
	type: Type.Enum({
		bash: "bash",
		glob: "glob",
		exact: "exact",
	} as const),
});

const GuardConfigSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	matchers: Type.Optional(Type.Record(Type.String(), MatcherSchema)),
	rules: Type.Optional(RulesSchema),
	profiles: Type.Optional(Type.Record(Type.String(), RulesSchema)),
	shortcuts: Type.Optional(Type.Record(Type.String(), Type.String())),
});

// ── Config validation ──

export function validateLoadedGuardConfig(input: unknown): LoadedConfigResult {
	if (!input || typeof input !== "object") {
		return {
			config: { ...SAFE_FALLBACK_CONFIG },
			warning: "Invalid guard config; using safe fallback.",
		};
	}

	if (!Value.Check(GuardConfigSchema, input)) {
		return {
			config: { ...SAFE_FALLBACK_CONFIG },
			warning: "Invalid guard config; using safe fallback.",
		};
	}

	const cfg = input as Static<typeof GuardConfigSchema>;
	const config: GuardConfig = {
		enabled: cfg.enabled ?? true,
		matchers: cfg.matchers ?? DEFAULT_CONFIG.matchers,
		rules: cfg.rules ?? {},
	};
	if (cfg.profiles) config.profiles = cfg.profiles;
	if (cfg.shortcuts) config.shortcuts = cfg.shortcuts;
	return { config };
}

export function getGuardConfigFromSettings(input: unknown): LoadedConfigResult {
	if (!input || typeof input !== "object") {
		return { config: { ...SAFE_FALLBACK_CONFIG } };
	}

	const settings = input as Record<string, unknown>;

	if (!Object.hasOwn(settings, "guard")) {
		return { config: { ...SAFE_FALLBACK_CONFIG } };
	}

	return validateLoadedGuardConfig(settings.guard);
}

// ── Rule merging ──

/**
 * If any layer is a blanket string action ("allow"/"deny"/"ask"),
 * the last such layer wins and short-circuits all rule merging.
 */
function findBlanketAction(layers: (Rules | undefined)[]): Action | undefined {
	for (let i = layers.length - 1; i >= 0; i--) {
		const layer = layers[i];
		if (typeof layer === "string") return layer;
	}
	return undefined;
}

function isRecordRules(
	rules: Rules | undefined,
): rules is Record<string, ToolRules> {
	return rules != null && typeof rules === "object";
}

function getBaseRules(): Record<string, ToolRules> {
	// DEFAULT_CONFIG.rules is always an object (see defaults.ts), but
	// the type includes `Action` so we narrow it here.
	return { ...(DEFAULT_CONFIG.rules as Record<string, ToolRules>) };
}

/**
 * Merge a single layer's rules into the accumulated result.
 *
 * Uses spread merging so that later layers can add pattern-level
 * entries without replacing the entire tool.  When a prior layer
 * set a bare string action for a tool, the object rules from this
 * layer replace it entirely (rather than spreading the string).
 */
function mergeLayerRules(
	merged: Record<string, ToolRules>,
	layer: Rules | undefined,
): void {
	if (!isRecordRules(layer)) return;

	for (const [tool, rules] of Object.entries(layer)) {
		if (typeof rules === "string") {
			merged[tool] = rules;
		} else {
			const existing = merged[tool];
			const base =
				existing != null && typeof existing === "object" ? existing : {};
			merged[tool] = { ...base, ...rules };
		}
	}
}

/**
 * Build the effective rules by merging all layers in precedence order.
 *
 * Layers (last match wins): default → user → project → env → profile → session.
 * If any layer is a blanket string action, it short-circuits and wins.
 * Otherwise, all object layers are merged from lowest to highest precedence.
 */
export function buildEffectiveRules(
	userRules: Rules,
	projectRules: Rules,
	envRules: Rules | undefined,
	profileRules: Rules | undefined,
	sessionRules: Rules,
): Rules {
	const layers = [
		userRules,
		projectRules,
		envRules,
		profileRules,
		sessionRules,
	];

	const blanket = findBlanketAction(layers);
	if (blanket !== undefined) return blanket;

	const merged = getBaseRules();
	for (const layer of layers) {
		mergeLayerRules(merged, layer);
	}

	return merged;
}

// ── Config loading ──

/** Load project-level guard config from .pi/settings.json in the given directory. */
function loadProjectConfig(
	cwd: string,
): { config: GuardConfig; warning?: string } | null {
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	if (!fs.existsSync(projectSettingsPath)) {
		return null;
	}
	try {
		const data = fs.readFileSync(projectSettingsPath, "utf-8");
		const parsed = JSON.parse(data);
		return getGuardConfigFromSettings(parsed);
	} catch {
		return {
			config: { ...SAFE_FALLBACK_CONFIG },
			warning:
				"Failed to parse project .pi/settings.json; using safe fallback.",
		};
	}
}

/** Load environment rules from PI_GUARD env var. */
function loadEnvRules(): Rules | undefined {
	const env = process.env.PI_GUARD;
	if (!env) return undefined;

	try {
		const parsed = JSON.parse(env);
		if (
			typeof parsed === "string" &&
			(parsed === "allow" || parsed === "ask" || parsed === "deny")
		) {
			return parsed;
		}
		if (typeof parsed === "object" && parsed !== null) {
			const result = validateLoadedGuardConfig({ rules: parsed });
			if (result.config.rules) {
				return result.config.rules;
			}
		}
	} catch {
		// Silently ignore invalid env var
	}

	return undefined;
}

export function loadConfig() {
	const envRules = loadEnvRules();

	if (fs.existsSync(SETTINGS_PATH)) {
		try {
			const data = fs.readFileSync(SETTINGS_PATH, "utf-8");
			const parsed = JSON.parse(data);
			const result = getGuardConfigFromSettings(parsed);
			return { ...result, envRules };
		} catch {
			return {
				config: { ...SAFE_FALLBACK_CONFIG },
				warning:
					"Failed to parse settings.json; using safe fallback (enabled=true, rules={}).",
				envRules,
			};
		}
	}

	return { config: { ...SAFE_FALLBACK_CONFIG }, envRules };
}

/**
 * Sort rules deterministically before persisting.
 *
 * User-edited settings.json should stay readable and produce stable diffs,
 * similar to how npm sorts package.json dependencies on install. Sorting
 * also makes it easy to scan the file by hand.
 */
export function sortRulesKeys(rules: Rules): Rules {
	if (typeof rules === "string") return rules;

	const sorted: Record<string, ToolRules> = {};
	for (const tool of Object.keys(rules).sort()) {
		const toolRules = rules[tool];
		if (toolRules === undefined) continue;
		if (typeof toolRules === "object" && toolRules !== null) {
			const patterns: Record<string, Action> = {};
			for (const pattern of Object.keys(toolRules).sort()) {
				const action = toolRules[pattern];
				if (action === undefined) continue;
				patterns[pattern] = action;
			}
			sorted[tool] = patterns;
		} else {
			sorted[tool] = toolRules;
		}
	}
	return sorted;
}

export function buildGuardSettings(
	config: GuardConfig,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	const customMatchers = config.matchers
		? Object.fromEntries(
				Object.entries(config.matchers).filter(([key, m]) => {
					const d =
						DEFAULT_CONFIG.matchers[
							key as keyof typeof DEFAULT_CONFIG.matchers
						];
					return !d || m.param !== d.param || m.type !== d.type;
				}),
			)
		: undefined;

	return {
		...existing,
		guard: {
			enabled: config.enabled,
			...(customMatchers &&
				Object.keys(customMatchers).length > 0 && {
					matchers: customMatchers,
				}),
			rules: sortRulesKeys(config.rules),
			...(config.profiles &&
				Object.keys(config.profiles).length > 0 && {
					profiles: config.profiles,
				}),
			...(config.shortcuts &&
				Object.keys(config.shortcuts).length > 0 && {
					shortcuts: config.shortcuts,
				}),
		},
	};
}

export async function saveConfig(config: GuardConfig) {
	try {
		await fsPromises.mkdir(AGENT_DIR, { recursive: true });

		let settings: Record<string, unknown> = {};
		try {
			const data = await fsPromises.readFile(SETTINGS_PATH, "utf-8");
			settings = JSON.parse(data);
		} catch {
			// File does not exist yet or cannot be read; start with empty settings.
		}

		settings = buildGuardSettings(config, settings);

		await fsPromises.writeFile(
			SETTINGS_PATH,
			JSON.stringify(settings, null, 2),
			"utf-8",
		);
	} catch (e) {
		console.error("Failed to save guard config to settings.json", e);
	}
}

export { DEFAULT_CONFIG, loadProjectConfig };
