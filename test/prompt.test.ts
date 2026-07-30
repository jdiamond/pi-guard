import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import { resolveBashAction } from "../src/matching.ts";
import {
	buildApprovalPromptData,
	buildCustomApprovalPromptData,
	buildFileApprovalPromptData,
} from "../src/prompt.ts";
import { getCommandArgs, getCommandName } from "../src/resolve.ts";

function extract(raw: string) {
	return extractAllCommandsFromAST(parseBash(raw), raw);
}

test("buildApprovalPromptData", async (t) => {
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

			const data = buildApprovalPromptData(commands, unauthorized, {
				maxLength: 40,
				argMaxLength: 40,
			});

			assert.equal(data.title, "⚠️ Unapproved Commands");
			assert.deepEqual(data.commands, [
				{
					text: "cd /Users/jdiamond/code/pi-nudge",
					allowed: true,
					joiner: "&&",
				},
				{ text: "npx tsc --noEmit 2>&1", allowed: false },
			]);
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

			const data = buildApprovalPromptData(commands, unauthorized, {
				maxLength: 200,
				argMaxLength: 200,
			});

			assert.deepEqual(data.commands, [
				{ text: "echo ok", allowed: true, joiner: "&&" },
				{ text: "npm test", allowed: false, joiner: "&&" },
				{ text: "npm test", allowed: false },
			]);
		},
	);

	await t.test("shows pipe joiners", () => {
		const commands = extract("cat foo | grep bar | wc -l");
		const unauthorized = commands.filter((cmd) => {
			const name = getCommandName(cmd);
			const args = getCommandArgs(cmd);
			return resolveBashAction(name, args, { cat: "allow" }) !== "allow";
		});

		const data = buildApprovalPromptData(commands, unauthorized);
		assert.deepEqual(data.commands, [
			{ text: "cat foo", allowed: true, joiner: "|" },
			{ text: "grep bar", allowed: false, joiner: "|" },
			{ text: "wc -l", allowed: false },
		]);
	});

	await t.test("shows || joiners", () => {
		const commands = extract("git commit || echo fail");
		const unauthorized = commands.filter((cmd) => {
			const name = getCommandName(cmd);
			const args = getCommandArgs(cmd);
			return resolveBashAction(name, args, {}) !== "allow";
		});

		const data = buildApprovalPromptData(commands, unauthorized);
		assert.deepEqual(data.commands, [
			{ text: "git commit", allowed: false, joiner: "||" },
			{ text: "echo fail", allowed: false },
		]);
	});

	await t.test("shows ; joiners for sequential commands", () => {
		const commands = extract("cd foo; rm bar");
		const unauthorized = commands.filter((cmd) => {
			const name = getCommandName(cmd);
			const args = getCommandArgs(cmd);
			return resolveBashAction(name, args, { cd: "allow" }) !== "allow";
		});

		const data = buildApprovalPromptData(commands, unauthorized);
		assert.deepEqual(data.commands, [
			{ text: "cd foo", allowed: true, joiner: ";" },
			{ text: "rm bar", allowed: false },
		]);
	});

	await t.test("indents commands inside shell expansions", () => {
		// echo $(sort out) — sort is shown as a child of echo
		const commands = extract("echo $(sort out)");
		const unauthorized = commands.filter((cmd) => {
			const _name = getCommandName(cmd);
			const _args = getCommandArgs(cmd);
			return true; // all unauthorized for simplicity
		});

		const data = buildApprovalPromptData(commands, unauthorized);
		assert.deepEqual(data.commands, [
			{ text: "echo $(...)", allowed: false },
			{ text: "sort out", allowed: false, indent: 1 },
		]);
	});

	await t.test("indents nested shell expansions recursively", () => {
		const commands = extract("echo $(echo $(date -u))");
		const data = buildApprovalPromptData(commands, commands);

		assert.deepEqual(data.commands, [
			{ text: "echo $(...)", allowed: false },
			{ text: "echo $(...)", allowed: false, indent: 1 },
			{ text: "date -u", allowed: false, indent: 2 },
		]);
	});

	await t.test("shows joiners inside subshell", () => {
		// echo $(cat foo | grep bar) — pipe inside subshell
		const commands = extract("echo $(cat foo | grep bar)");
		const unauthorized = commands.filter((cmd) => {
			const _name = getCommandName(cmd);
			const _args = getCommandArgs(cmd);
			return true;
		});

		const data = buildApprovalPromptData(commands, unauthorized);
		assert.deepEqual(data.commands, [
			{ text: "echo $(...)", allowed: false },
			{ text: "cat foo", allowed: false, indent: 1, joiner: "|" },
			{ text: "grep bar", allowed: false, indent: 1 },
		]);
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

		const data = buildApprovalPromptData(commands, unauthorized);
		assert.deepEqual(data.commands, [
			{ text: "TOKEN=$(...)", allowed: true, joiner: "&&" },
			{
				text: "curl -s https://auth.example.com/token",
				allowed: false,
				indent: 1,
				joiner: "|",
			},
			{ text: "jq -r .access_token", allowed: false, indent: 1 },
			{
				text: 'curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data',
				allowed: false,
			},
		]);
	});
});

test("buildFileApprovalPromptData", async (t) => {
	await t.test("formats read prompts", () => {
		const data = buildFileApprovalPromptData("read", "/path/to/file.ts");
		assert.equal(data.title, "⚠️ Read Permission Required");
		assert.equal(data.body, "/path/to/file.ts");
		assert.deepEqual(data.commands, []);
	});

	await t.test("formats edit prompts", () => {
		const data = buildFileApprovalPromptData("edit", "/path/to/file.ts");
		assert.equal(data.title, "⚠️ Edit Permission Required");
		assert.equal(data.body, "/path/to/file.ts");
	});

	await t.test("formats write prompts", () => {
		const data = buildFileApprovalPromptData("write", "/path/to/file.ts");
		assert.equal(data.title, "⚠️ Write Permission Required");
		assert.equal(data.body, "/path/to/file.ts");
	});

	await t.test("preserves long paths", () => {
		const longPath = "/".repeat(150);
		const data = buildFileApprovalPromptData("read", longPath);
		assert.equal(data.body, longPath);
	});
});

test("buildCustomApprovalPromptData", async (t) => {
	await t.test("formats custom tool prompts with all params", () => {
		const data = buildCustomApprovalPromptData("webfetch", {
			url: "https://example.com",
		});
		assert.equal(data.title, "⚠️ webfetch Permission Required");
		assert.equal(data.body, "url: https://example.com");
	});

	await t.test("shows multiple parameters", () => {
		const data = buildCustomApprovalPromptData("my_tool", {
			number: 1,
			body: "hello world",
		});
		assert.equal(data.body, "number: 1\nbody: hello world");
	});

	await t.test("skips undefined parameters", () => {
		const data = buildCustomApprovalPromptData("my_tool", {
			number: 1,
			workingDir: undefined,
		});
		assert.equal(data.body, "number: 1");
	});

	await t.test("formats arrays", () => {
		const data = buildCustomApprovalPromptData("my_tool", {
			files: ["a.ts", "b.ts"],
		});
		assert.equal(data.body, "files: a.ts, b.ts");
	});

	await t.test("formats booleans", () => {
		const data = buildCustomApprovalPromptData("my_tool", {
			draft: true,
		});
		assert.equal(data.body, "draft: true");
	});

	await t.test("truncates long values", () => {
		const longBody = "a".repeat(150);
		const data = buildCustomApprovalPromptData(
			"webfetch",
			{
				body: longBody,
			},
			{
				valueMaxLength: 20,
			},
		);
		assert.ok(data.body?.includes("…"));
		assert.ok(data.body && data.body.length < 100);
	});

	await t.test("shows null values", () => {
		const data = buildCustomApprovalPromptData("my_tool", {
			value: null,
		});
		assert.equal(data.body, "value: null");
	});

	await t.test("shows placeholder when all params are undefined", () => {
		const data = buildCustomApprovalPromptData("my_tool", {
			a: undefined,
			b: undefined,
		});
		assert.equal(data.body, "(no parameters)");
	});
});
