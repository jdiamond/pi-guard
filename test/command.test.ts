import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuardContext } from "../src/commands.ts";
import { handleGuardCommand } from "../src/commands.ts";
import { parseGuardArgs } from "../src/index.ts";

test("profile environment propagation", async (t) => {
	await t.test("publishes the active profile name", async () => {
		let published: string | undefined;
		const context: GuardContext = {
			config: {
				enabled: true,
				rules: {},
				profiles: { strict: { bash: "deny" } },
			},
			activeProfile: undefined,
			sessionRules: {},
			setActiveProfile: (profile) => {
				published = profile;
			},
		};

		const result = await handleGuardCommand(
			"profile",
			"strict",
			context,
			process.cwd(),
		);

		assert.equal(published, "strict");
		assert.equal(context.activeProfile, "strict");
		assert.equal(result.type, "info");
	});

	await t.test("clears the published profile name", async () => {
		let published: string | undefined = "strict";
		const context: GuardContext = {
			config: {
				enabled: true,
				rules: {},
				profiles: { strict: { bash: "deny" } },
			},
			activeProfile: "strict",
			sessionRules: {},
			setActiveProfile: (profile) => {
				published = profile;
			},
		};

		await handleGuardCommand("profile", "off", context, process.cwd());

		assert.equal(published, undefined);
		assert.equal(context.activeProfile, undefined);
	});
});

test("parseGuardArgs", async (t) => {
	await t.test("parses single-token target", () => {
		assert.deepEqual(parseGuardArgs("allow git"), {
			action: "allow",
			target: "git",
		});
	});

	await t.test("parses multi-token target", () => {
		assert.deepEqual(parseGuardArgs("allow git status"), {
			action: "allow",
			target: "git status",
		});
	});

	await t.test("parses tool with pattern", () => {
		assert.deepEqual(parseGuardArgs("allow bash git *"), {
			action: "allow",
			target: "bash git *",
		});
		assert.deepEqual(parseGuardArgs("deny bash rm *"), {
			action: "deny",
			target: "bash rm *",
		});
	});

	await t.test("collapses extra whitespace", () => {
		assert.deepEqual(
			parseGuardArgs("  deny   git   branch   --show-current  "),
			{
				action: "deny",
				target: "git branch --show-current",
			},
		);
	});

	await t.test("returns empty target when action has no argument", () => {
		assert.deepEqual(parseGuardArgs("toggle"), {
			action: "toggle",
			target: "",
		});
	});

	await t.test("parses list action with no target", () => {
		assert.deepEqual(parseGuardArgs("list"), { action: "list", target: "" });
	});

	await t.test("returns empty action/target for empty input", () => {
		assert.deepEqual(parseGuardArgs("   "), { action: "", target: "" });
	});

	await t.test("handles glob patterns in target", () => {
		assert.deepEqual(parseGuardArgs("allow read *.ts"), {
			action: "allow",
			target: "read *.ts",
		});
		assert.deepEqual(parseGuardArgs("deny write ~/.ssh/*"), {
			action: "deny",
			target: "write ~/.ssh/*",
		});
	});
});
