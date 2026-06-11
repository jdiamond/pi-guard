import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import { resolveBashAction } from "../src/matching.ts";
import {
	buildApprovalPrompt,
	buildCustomApprovalPrompt,
	buildFileApprovalPrompt,
} from "../src/prompt.ts";
import { getCommandArgs, getCommandName } from "../src/resolve.ts";

function extract(raw: string) {
	return extractAllCommandsFromAST(parseBash(raw), raw);
}

test("buildApprovalPrompt", async (t) => {
	await t.test(
		"shows allowed commands for context alongside unapproved ones",
		() => {
			const commands = extract(
				"cd /Users/jdiamond/code/pi-nudge && npx tsc --noEmit 2>&1",
			);
			const unauthorized = commands.filter((cmd) => {
				const name = getCommandName(cmd);
				const args = getCommandArgs(cmd);
				return resolveBashAction(name, args, { cd: "allow" }) !== "allow";
			});

			assert.equal(
				buildApprovalPrompt(commands, unauthorized, {
					maxLength: 40,
					argMaxLength: 40,
				}),
				[
					"⚠️ Unapproved Commands",
					"",
					"✔ cd /Users/jdiamond/code/pi-nudge &&",
					"✖ npx tsc --noEmit 2>&1",
				].join("\n"),
			);
		},
	);

	await t.test(
		"preserves command order and does not deduplicate entries",
		() => {
			const commands = extract("echo ok && npm test && npm test");
			const unauthorized = commands.filter((cmd) => {
				const name = getCommandName(cmd);
				const args = getCommandArgs(cmd);
				return resolveBashAction(name, args, { echo: "allow" }) !== "allow";
			});

			assert.equal(
				buildApprovalPrompt(commands, unauthorized, {
					maxLength: 200,
					argMaxLength: 200,
				}),
				[
					"⚠️ Unapproved Commands",
					"",
					"✔ echo ok &&",
					"✖ npm test &&",
					"✖ npm test",
				].join("\n"),
			);
		},
	);

	await t.test("shows pipe joiners", () => {
		const commands = extract("cat foo | grep bar | wc -l");
		const unauthorized = commands.filter((cmd) => {
			const name = getCommandName(cmd);
			const args = getCommandArgs(cmd);
			return resolveBashAction(name, args, { cat: "allow" }) !== "allow";
		});

		assert.equal(
			buildApprovalPrompt(commands, unauthorized),
			[
				"⚠️ Unapproved Commands",
				"",
				"✔ cat foo |",
				"✖ grep bar |",
				"✖ wc -l",
			].join("\n"),
		);
	});

	await t.test("shows || joiners", () => {
		const commands = extract("git commit || echo fail");
		const unauthorized = commands.filter((cmd) => {
			const name = getCommandName(cmd);
			const args = getCommandArgs(cmd);
			return resolveBashAction(name, args, {}) !== "allow";
		});

		assert.equal(
			buildApprovalPrompt(commands, unauthorized),
			["⚠️ Unapproved Commands", "", "✖ git commit ||", "✖ echo fail"].join(
				"\n",
			),
		);
	});

	await t.test("shows ; joiners for sequential commands", () => {
		const commands = extract("cd foo; rm bar");
		const unauthorized = commands.filter((cmd) => {
			const name = getCommandName(cmd);
			const args = getCommandArgs(cmd);
			return resolveBashAction(name, args, { cd: "allow" }) !== "allow";
		});

		assert.equal(
			buildApprovalPrompt(commands, unauthorized),
			["⚠️ Unapproved Commands", "", "✔ cd foo ;", "✖ rm bar"].join("\n"),
		);
	});

	await t.test("separates groups with blank lines", () => {
		// echo $(sort out) — echo and sort should be in different groups
		const commands = extract("echo $(sort out)");
		const unauthorized = commands.filter((cmd) => {
			const _name = getCommandName(cmd);
			const _args = getCommandArgs(cmd);
			return true; // all unauthorized for simplicity
		});

		assert.equal(
			buildApprovalPrompt(commands, unauthorized),
			["⚠️ Unapproved Commands", "", "✖ echo $(...)", "", "✖ sort out"].join(
				"\n",
			),
		);
	});

	await t.test("shows joiners inside subshell", () => {
		// echo $(cat foo | grep bar) — pipe inside subshell
		const commands = extract("echo $(cat foo | grep bar)");
		const unauthorized = commands.filter((cmd) => {
			const _name = getCommandName(cmd);
			const _args = getCommandArgs(cmd);
			return true;
		});

		assert.equal(
			buildApprovalPrompt(commands, unauthorized),
			[
				"⚠️ Unapproved Commands",
				"",
				"✖ echo $(...)",
				"",
				"✖ cat foo |",
				"✖ grep bar",
			].join("\n"),
		);
	});

	await t.test("shows bare assignment with joiner", () => {
		// TOKEN=$(curl ... | jq ...) && curl ... — assignment appears with ✔
		// (bare assignments are always allowed, not checked against rules)
		const commands = extract(
			'TOKEN=$(curl -s https://auth.example.com/token | jq -r .access_token) && curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data',
		);
		const unauthorized = commands.filter((cmd) => {
			const name = getCommandName(cmd);
			const args = getCommandArgs(cmd);
			// Bare assignment is always allowed — skip it
			if (!cmd.node.name && cmd.node.prefix.length > 0) return false;
			return resolveBashAction(name, args, { "*": "ask" }) !== "allow";
		});

		assert.equal(
			buildApprovalPrompt(commands, unauthorized),
			[
				"⚠️ Unapproved Commands",
				"",
				"✔ TOKEN=$(...) &&",
				"",
				"✖ curl -s https://auth.example.com/token |",
				"✖ jq -r .access_token",
				"",
				'✖ curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data',
			].join("\n"),
		);
	});
});

test("buildFileApprovalPrompt", async (t) => {
	await t.test("formats read prompts", () => {
		const prompt = buildFileApprovalPrompt("read", "/path/to/file.ts");
		assert.equal(prompt, "⚠️ Read Permission Required\n\n/path/to/file.ts");
	});

	await t.test("formats edit prompts", () => {
		const prompt = buildFileApprovalPrompt("edit", "/path/to/file.ts");
		assert.equal(prompt, "⚠️ Edit Permission Required\n\n/path/to/file.ts");
	});

	await t.test("formats write prompts", () => {
		const prompt = buildFileApprovalPrompt("write", "/path/to/file.ts");
		assert.equal(prompt, "⚠️ Write Permission Required\n\n/path/to/file.ts");
	});

	await t.test("truncates long paths", () => {
		const longPath = "/".repeat(150);
		const prompt = buildFileApprovalPrompt("read", longPath, { maxLength: 50 });
		assert.ok(prompt.includes("…"));
		assert.ok(prompt.length < 200); // Should be truncated
	});
});

test("buildCustomApprovalPrompt", async (t) => {
	await t.test("formats custom tool prompts with all params", () => {
		const prompt = buildCustomApprovalPrompt("webfetch", {
			url: "https://example.com",
		});
		assert.equal(
			prompt,
			"⚠️ webfetch Permission Required\n\nurl: https://example.com",
		);
	});

	await t.test("shows multiple parameters", () => {
		const prompt = buildCustomApprovalPrompt("my_tool", {
			number: 1,
			body: "hello world",
		});
		assert.equal(
			prompt,
			"⚠️ my_tool Permission Required\n\nnumber: 1\nbody: hello world",
		);
	});

	await t.test("skips undefined parameters", () => {
		const prompt = buildCustomApprovalPrompt("my_tool", {
			number: 1,
			workingDir: undefined,
		});
		assert.equal(prompt, "⚠️ my_tool Permission Required\n\nnumber: 1");
	});

	await t.test("formats arrays", () => {
		const prompt = buildCustomApprovalPrompt("my_tool", {
			files: ["a.ts", "b.ts"],
		});
		assert.equal(prompt, "⚠️ my_tool Permission Required\n\nfiles: a.ts, b.ts");
	});

	await t.test("formats booleans", () => {
		const prompt = buildCustomApprovalPrompt("my_tool", {
			draft: true,
		});
		assert.equal(prompt, "⚠️ my_tool Permission Required\n\ndraft: true");
	});

	await t.test("truncates long values", () => {
		const longBody = "a".repeat(150);
		const prompt = buildCustomApprovalPrompt(
			"webfetch",
			{
				body: longBody,
			},
			{
				valueMaxLength: 20,
			},
		);
		assert.ok(prompt.includes("…"));
		assert.ok(prompt.length < 100);
	});

	await t.test("shows null values", () => {
		const prompt = buildCustomApprovalPrompt("my_tool", {
			value: null,
		});
		assert.equal(prompt, "⚠️ my_tool Permission Required\n\nvalue: null");
	});

	await t.test("shows placeholder when all params are undefined", () => {
		const prompt = buildCustomApprovalPrompt("my_tool", {
			a: undefined,
			b: undefined,
		});
		assert.equal(prompt, "⚠️ my_tool Permission Required\n\n(no parameters)");
	});
});
