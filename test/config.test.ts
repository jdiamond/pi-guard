import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildEffectiveRules,
	buildGuardSettings,
	getGuardConfigFromSettings,
	sortRulesKeys,
	validateLoadedGuardConfig,
} from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import type { GuardConfig } from "../src/types.ts";

function guardOf(s: Record<string, unknown>): Record<string, unknown> {
	const g = s.guard;
	assert.ok(g !== null && typeof g === "object" && !Array.isArray(g));
	return g as Record<string, unknown>;
}

test("validateLoadedGuardConfig", async (t) => {
	await t.test("accepts valid config with rules", () => {
		const result = validateLoadedGuardConfig({
			enabled: false,
			rules: { git: "allow", curl: "ask" },
		});
		assert.equal(result.config.enabled, false);
		assert.deepEqual(result.config.rules, { git: "allow", curl: "ask" });
		assert.equal(result.warning, undefined);
	});

	await t.test("accepts valid config with empty rules", () => {
		const result = validateLoadedGuardConfig({ enabled: true, rules: {} });
		assert.equal(result.config.enabled, true);
		assert.deepEqual(result.config.rules, {});
		assert.equal(result.warning, undefined);
	});

	await t.test("accepts valid config with no rules field", () => {
		const result = validateLoadedGuardConfig({ enabled: true });
		assert.equal(result.config.enabled, true);
		assert.deepEqual(result.config.rules, {});
		assert.equal(result.warning, undefined);
	});

	await t.test("accepts single action for all tools", () => {
		const result = validateLoadedGuardConfig({ rules: "allow" });
		assert.equal(result.config.rules, "allow");
		assert.equal(result.warning, undefined);
	});

	await t.test("accepts single tool action", () => {
		const result = validateLoadedGuardConfig({ rules: { bash: "allow" } });
		assert.deepEqual(result.config.rules, { bash: "allow" });
		assert.equal(result.warning, undefined);
	});

	await t.test("accepts pattern-based rules per tool", () => {
		const result = validateLoadedGuardConfig({
			rules: {
				bash: { git: "allow", rm: "deny" },
				read: { "*": "allow" },
			},
		});
		assert.deepEqual(result.config.rules, {
			bash: { git: "allow", rm: "deny" },
			read: { "*": "allow" },
		});
		assert.equal(result.warning, undefined);
	});

	await t.test("accepts custom matchers", () => {
		const result = validateLoadedGuardConfig({
			matchers: {
				webfetch: { param: "url", type: "glob" },
			},
		});
		assert.deepEqual(result.config.matchers, {
			webfetch: { param: "url", type: "glob" },
		});
		assert.equal(result.warning, undefined);
	});

	await t.test("rejects invalid matcher type", () => {
		const result = validateLoadedGuardConfig({
			matchers: {
				webfetch: { param: "url", type: "invalid" as const },
			},
		});
		assert.equal(result.config.matchers?.webfetch, undefined);
		assert.ok(result.warning);
	});

	await t.test("uses safe fallback for invalid top-level shape", () => {
		const result = validateLoadedGuardConfig("bad");
		assert.equal(result.config.enabled, true);
		assert.deepEqual(result.config.rules, {});
		assert.ok(result.warning);
	});

	await t.test("returns safe fallback when rules is invalid", () => {
		const result = validateLoadedGuardConfig({ enabled: false, rules: 42 });
		assert.equal(result.config.enabled, true);
		assert.deepEqual(result.config.rules, {});
		assert.ok(result.warning);
	});

	await t.test("accepts valid profiles", () => {
		const result = validateLoadedGuardConfig({
			profiles: {
				"read-write": {
					edit: { "*": "allow" },
					write: { "*": "allow" },
				},
			},
		});
		assert.deepEqual(result.config.profiles, {
			"read-write": {
				edit: { "*": "allow" },
				write: { "*": "allow" },
			},
		});
		assert.equal(result.warning, undefined);
	});

	await t.test("accepts profile with single action", () => {
		const result = validateLoadedGuardConfig({
			profiles: {
				"deny-all": "deny",
			},
		});
		assert.equal(result.config.profiles?.["deny-all"], "deny");
		assert.equal(result.warning, undefined);
	});

	await t.test("accepts valid shortcuts", () => {
		const result = validateLoadedGuardConfig({
			profiles: {
				"read-write": { edit: { "*": "allow" } },
			},
			shortcuts: {
				rw: "read-write",
				ro: "off",
			},
		});
		assert.deepEqual(result.config.shortcuts, {
			rw: "read-write",
			ro: "off",
		});
		assert.equal(result.warning, undefined);
	});

	await t.test("returns safe fallback for invalid profiles", () => {
		const result = validateLoadedGuardConfig({
			profiles: {
				bad: { edit: { "*": "maybe" } },
			},
		});
		assert.equal(result.config.profiles, undefined);
		assert.ok(result.warning);
	});
});

test("getGuardConfigFromSettings", async (t) => {
	await t.test("uses default config when the guard key is missing", () => {
		const result = getGuardConfigFromSettings({ other: true });
		assert.equal(result.config.enabled, true);
		assert.equal(result.warning, undefined);
	});

	await t.test("validates a falsey guard value", () => {
		const result = getGuardConfigFromSettings({ guard: null });
		assert.equal(result.config.enabled, true);
		assert.ok(result.warning);
	});
});

test("buildGuardSettings", async (t) => {
	await t.test("omits matchers when only defaults are present", () => {
		const result = buildGuardSettings(
			{
				enabled: true,
				matchers: DEFAULT_CONFIG.matchers,
				rules: { git_status: "allow" },
			},
			{},
		);
		assert.equal(guardOf(result).enabled, true);
		assert.equal(guardOf(result).matchers, undefined);
		assert.deepEqual(guardOf(result).rules, { git_status: "allow" });
	});

	await t.test(
		"preserves only non-default matchers when custom ones exist",
		() => {
			const result = buildGuardSettings(
				{
					enabled: true,
					matchers: {
						...DEFAULT_CONFIG.matchers,
						my_tool: { param: "input", type: "exact" },
					},
					rules: {},
				},
				{},
			);
			assert.deepEqual(guardOf(result).matchers, {
				my_tool: { param: "input", type: "exact" },
			});
		},
	);

	await t.test(
		"preserves only non-default matchers with no defaults present",
		() => {
			const result = buildGuardSettings(
				{
					enabled: true,
					matchers: {
						my_tool: { param: "input", type: "exact" },
					},
					rules: {},
				},
				{},
			);
			assert.deepEqual(guardOf(result).matchers, {
				my_tool: { param: "input", type: "exact" },
			});
		},
	);

	await t.test("writes an overridden default matcher", () => {
		const result = buildGuardSettings(
			{
				enabled: true,
				matchers: {
					...DEFAULT_CONFIG.matchers,
					bash: { param: "rawCommand", type: "bash" },
				},
				rules: {},
			},
			{},
		);
		assert.deepEqual(guardOf(result).matchers, {
			bash: { param: "rawCommand", type: "bash" },
		});
	});

	await t.test("preserves existing non-guard keys", () => {
		const result = buildGuardSettings(
			{
				enabled: true,
				matchers: DEFAULT_CONFIG.matchers,
				rules: {},
			},
			{ theme: "dark", window: { width: 100 } },
		);
		assert.equal(result.theme, "dark");
		assert.deepEqual(result.window, { width: 100 });
		assert.deepEqual(guardOf(result).rules, {});
	});

	await t.test("writes profiles when present", () => {
		const result = buildGuardSettings(
			{
				enabled: true,
				matchers: DEFAULT_CONFIG.matchers,
				rules: {},
				profiles: { strict: { bash: "deny" } },
			},
			{},
		);
		assert.deepEqual(guardOf(result).profiles, { strict: { bash: "deny" } });
	});

	await t.test("writes shortcuts when present", () => {
		const result = buildGuardSettings(
			{
				enabled: true,
				matchers: DEFAULT_CONFIG.matchers,
				rules: {},
				shortcuts: { off: "disable" },
			},
			{},
		);
		assert.deepEqual(guardOf(result).shortcuts, { off: "disable" });
	});

	await t.test("omits matchers when config has no matchers field", () => {
		const result = buildGuardSettings(
			{
				enabled: true,
				rules: {},
			},
			{},
		);
		assert.equal(guardOf(result).matchers, undefined);
	});
});

test("sortRulesKeys", async (t) => {
	await t.test("sorts top-level tool names alphabetically", () => {
		const result = sortRulesKeys({
			z_tool: "allow",
			a_tool: "ask",
			m_tool: "deny",
		});
		assert.deepEqual(result, {
			a_tool: "ask",
			m_tool: "deny",
			z_tool: "allow",
		});
	});

	await t.test("sorts nested bash patterns alphabetically", () => {
		const result = sortRulesKeys({
			bash: {
				"z command": "allow",
				"a command": "ask",
				"m command": "deny",
			},
		});
		assert.deepEqual(result, {
			bash: {
				"a command": "ask",
				"m command": "deny",
				"z command": "allow",
			},
		});
	});

	await t.test("preserves blanket string action", () => {
		assert.equal(sortRulesKeys("allow"), "allow");
		assert.equal(sortRulesKeys("deny"), "deny");
	});

	await t.test("sorts mix of string and object tool rules", () => {
		const result = sortRulesKeys({
			bash: {
				"npm test": "allow",
				"git status": "allow",
			},
			git_status: "allow",
			a_tool: "ask",
		});
		assert.deepEqual(result, {
			a_tool: "ask",
			bash: {
				"git status": "allow",
				"npm test": "allow",
			},
			git_status: "allow",
		});
	});

	await t.test("is called by buildGuardSettings", () => {
		const config: GuardConfig = {
			enabled: true,
			rules: {
				bash: {
					"z command": "allow",
					"a command": "ask",
				},
				git_status: "allow",
				a_tool: "deny",
			},
		};
		const result = buildGuardSettings(config, {});
		const rules = guardOf(result).rules;
		assert.ok(rules !== null && typeof rules === "object");
		const r = rules as Record<string, unknown>;
		const keys = Object.keys(r);
		assert.deepEqual(keys, ["a_tool", "bash", "git_status"]);
	});
});

test("buildEffectiveRules", async (t) => {
	await t.test("defaults alone when all layers are empty", () => {
		const result = buildEffectiveRules({}, {}, undefined, undefined, {});
		assert.deepEqual(result, DEFAULT_CONFIG.rules);
	});

	await t.test("user rules are merged with defaults", () => {
		const result = buildEffectiveRules(
			{ mytool: "allow" },
			{},
			undefined,
			undefined,
			{},
		);
		if (typeof result === "object") {
			assert.equal(result.mytool, "allow");
			// Defaults are preserved - guaranteed to be object by defaults.ts
			assert.ok(typeof DEFAULT_CONFIG.rules === "object");
			assert.deepEqual(result.bash, DEFAULT_CONFIG.rules.bash);
		}
	});

	await t.test("project rules override user rules", () => {
		const result = buildEffectiveRules(
			{ npm: "ask" },
			{ npm: "allow" },
			undefined,
			undefined,
			{},
		);
		if (typeof result === "object") {
			assert.equal(result.npm, "allow");
		}
	});

	await t.test("session rules override all other layers", () => {
		const result = buildEffectiveRules(
			{},
			{ npm: "ask" },
			undefined,
			undefined,
			{ npm: "allow" },
		);
		if (typeof result === "object") {
			assert.equal(result.npm, "allow");
		}
	});

	await t.test("session rules override env rules", () => {
		const result = buildEffectiveRules({}, {}, { npm: "ask" }, undefined, {
			npm: "deny",
		});
		if (typeof result === "object") {
			assert.equal(result.npm, "deny");
		}
	});

	await t.test("single action session rules win over all", () => {
		const result = buildEffectiveRules(
			{ bash: { "*": "ask" } },
			{},
			undefined,
			undefined,
			"deny",
		);
		assert.equal(result, "deny");
	});

	await t.test("single action env rules override user rules", () => {
		const result = buildEffectiveRules(
			{ bash: { "*": "ask" } },
			{},
			"allow",
			undefined,
			{},
		);
		assert.equal(result, "allow");
	});

	await t.test("profile rules are merged with other layers", () => {
		const result = buildEffectiveRules(
			{ edit: { "*": "allow" } },
			{},
			undefined,
			{ edit: { "*": "ask" } },
			{},
		);
		if (typeof result === "object") {
			assert.deepEqual(result.edit, { "*": "ask" });
		}
	});

	await t.test("session rules override profile rules", () => {
		const result = buildEffectiveRules(
			{},
			{},
			undefined,
			{ edit: { "*": "allow" } },
			{ edit: { "*": "ask" } },
		);
		if (typeof result === "object") {
			assert.deepEqual(result.edit, { "*": "ask" });
		}
	});

	await t.test("profile rules override env rules", () => {
		const result = buildEffectiveRules(
			{},
			{},
			{ edit: { "*": "allow" } },
			{ edit: { "*": "ask" } },
			{},
		);
		if (typeof result === "object") {
			assert.deepEqual(result.edit, { "*": "ask" });
		}
	});

	await t.test(
		"higher layer object rules replace lower layer string action for the same tool",
		() => {
			// Regression: spreading a string action (e.g. { ..."deny", ...rules })
			// would inject character-index garbage keys (0→d, 1→e, etc.).
			const result = buildEffectiveRules(
				{ bash: "deny" },
				{ bash: { "git push": "allow" } },
				undefined,
				undefined,
				{},
			);
			assert.ok(typeof result === "object");
			if (typeof result === "object") {
				const bash = result.bash;
				assert.ok(typeof bash === "object");
				if (typeof bash === "object") {
					assert.deepEqual(bash, { "git push": "allow" });
				}
			}
		},
	);
});
