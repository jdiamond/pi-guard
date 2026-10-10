import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import { resolveBashAction } from "../src/matching.ts";
import {
	buildApprovalPromptData,
	buildBashApprovalChoices,
	buildCustomApprovalPromptData,
	buildFileApprovalPromptData,
} from "../src/prompt.ts";
import { getCommandArgs, getCommandName } from "../src/resolve.ts";
import { expandWrapperCommands } from "../src/wrappers.ts";

function extract(raw: string) {
	return extractAllCommandsFromAST(parseBash(raw), raw);
}

function summarizeApprovalLines(
	data: ReturnType<typeof buildApprovalPromptData>,
) {
	return data.commands.map((line) => [
		line.type ?? "command",
		line.indent ?? 0,
		line.allowed,
		line.text,
		line.joiner,
	]);
}

test("buildBashApprovalChoices", async (t) => {
	await t.test(
		"shows command and write options when both need approval",
		() => {
			assert.deepEqual(buildBashApprovalChoices(["touch"], ["output.txt"]), [
				"Allow",
				"Temporarily allow touch (this session only)",
				"Permanently allow touch (save to settings.json)",
				"Temporarily allow these writes (this session only)",
				"Permanently allow these writes (save to settings.json)",
				"Reject",
			]);
		},
	);

	await t.test("omits resolved capability options", () => {
		assert.deepEqual(buildBashApprovalChoices([], ["output.txt"]), [
			"Allow",
			"Temporarily allow these writes (this session only)",
			"Permanently allow these writes (save to settings.json)",
			"Reject",
		]);
		assert.deepEqual(buildBashApprovalChoices(["touch"], []), [
			"Allow",
			"Temporarily allow touch (this session only)",
			"Permanently allow touch (save to settings.json)",
			"Reject",
		]);
	});
});

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

	await t.test(
		"shows loop, substitution, pipeline, and group boundaries",
		() => {
			const raw =
				'for stack in prod-jp prod-eu; do output=$(pulumi stack output --stack "$stack" | jq -r ".serviceUrl"); (cd "infra/$stack" && ./scripts/check-health.sh "$output"); done';
			const commands = extract(raw);
			const unauthorized = commands.filter((command) =>
				["pulumi", "./scripts/check-health.sh"].includes(
					getCommandName(command),
				),
			);

			assert.deepEqual(
				summarizeApprovalLines(buildApprovalPromptData(commands, unauthorized)),
				[
					["context", 0, true, "for stack in prod-jp prod-eu; do", undefined],
					["command", 1, true, "output=$(...)", ";"],
					["command", 2, false, 'pulumi stack output --stack "$stack"', "|"],
					["command", 2, true, 'jq -r ".serviceUrl"', undefined],
					["context", 1, true, "(", undefined],
					["command", 2, true, 'cd "infra/$stack"', "&&"],
					[
						"command",
						2,
						false,
						'./scripts/check-health.sh "$output"',
						undefined,
					],
					["context", 1, true, ")", undefined],
					["context", 0, true, "done", undefined],
				],
			);
		},
	);

	await t.test("shows if/elif/else branches around command statuses", () => {
		const commands = extract(
			"if check-a; then run-a; elif check-b; then run-b; else run-c; fi",
		);
		assert.deepEqual(
			summarizeApprovalLines(buildApprovalPromptData(commands, commands)),
			[
				["context", 0, true, "if", undefined],
				["command", 1, false, "check-a", undefined],
				["context", 0, true, "then", undefined],
				["command", 1, false, "run-a", undefined],
				["context", 0, true, "elif", undefined],
				["command", 1, false, "check-b", undefined],
				["context", 0, true, "then", undefined],
				["command", 1, false, "run-b", undefined],
				["context", 0, true, "else", undefined],
				["command", 1, false, "run-c", undefined],
				["context", 0, true, "fi", undefined],
			],
		);
	});

	await t.test("shows loop conditions and boundaries", () => {
		for (const [raw, keyword, condition, body] of [
			["while check; do run; done", "while", "check", "run"],
			["until ready; do wait; done", "until", "ready", "wait"],
		] as const) {
			const commands = extract(raw);
			assert.deepEqual(
				summarizeApprovalLines(buildApprovalPromptData(commands, commands)),
				[
					["context", 0, true, keyword, undefined],
					["command", 1, false, condition, undefined],
					["context", 0, true, "do", undefined],
					["command", 1, false, body, undefined],
					["context", 0, true, "done", undefined],
				],
			);
		}
	});

	await t.test("shows test-only conditions and brace-group boundaries", () => {
		const commands = extract("if [[ -f config ]]; then { cat config; }; fi");
		assert.deepEqual(
			summarizeApprovalLines(buildApprovalPromptData(commands, commands)),
			[
				["context", 0, true, "if [[ -f config ]]; then", undefined],
				["context", 1, true, "{", undefined],
				["command", 2, false, "cat config", undefined],
				["context", 1, true, "}", undefined],
				["context", 0, true, "fi", undefined],
			],
		);
	});

	await t.test("keeps expanded wrapper commands inside loop context", () => {
		const expanded = expandWrapperCommands(
			extract("for item in a; do xargs rm; echo after; done"),
		);
		const unauthorized = expanded.commands.filter(
			(command) => getCommandName(command) === "rm",
		);
		assert.deepEqual(
			summarizeApprovalLines(
				buildApprovalPromptData(
					expanded.commands,
					unauthorized,
					undefined,
					expanded.expandedWrappers,
				),
			),
			[
				["context", 0, true, "for item in a; do", undefined],
				["command", 1, true, "xargs ...", ";"],
				["command", 2, false, "rm", undefined],
				["command", 1, true, "echo after", undefined],
				["context", 0, true, "done", undefined],
			],
		);
	});

	await t.test(
		"keeps process-substitution commands nested in loop context",
		() => {
			const commands = extract(
				"for x in a; do diff <(sort $x) <(sort ref); done",
			);
			assert.deepEqual(
				summarizeApprovalLines(buildApprovalPromptData(commands, commands)),
				[
					["context", 0, true, "for x in a; do", undefined],
					["command", 1, false, "diff <(...) <(...)", undefined],
					["command", 2, false, "sort $x", undefined],
					["command", 2, false, "sort ref", undefined],
					["context", 0, true, "done", undefined],
				],
			);
		},
	);

	await t.test("elides loop-input command substitutions in the header", () => {
		const commands = extract("for x in $(seq 1 2); do echo $x; done");
		assert.deepEqual(
			summarizeApprovalLines(buildApprovalPromptData(commands, commands)),
			[
				["context", 0, true, "for x in $(...); do", undefined],
				["command", 2, false, "seq 1 2", undefined],
				["command", 1, false, "echo $x", undefined],
				["context", 0, true, "done", undefined],
			],
		);
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

	await t.test("indents commands executed by nested wrappers", () => {
		const raw =
			"kubectl get pods -o name | xargs -n1 sh -c 'echo pod; kubectl logs pod | grep error'";
		const { commands, expandedWrappers } = expandWrapperCommands(extract(raw));
		const unauthorized = commands.filter((cmd) => getCommandName(cmd) === "sh");

		const data = buildApprovalPromptData(
			commands,
			unauthorized,
			undefined,
			expandedWrappers,
		);

		assert.deepEqual(data.commands, [
			{
				text: "kubectl get pods -o name",
				allowed: true,
				highlighted: true,
				joiner: "|",
			},
			{ text: "xargs -n1 ...", allowed: true },
			{ text: "sh -c ...", allowed: false, indent: 1 },
			{ text: "echo pod", allowed: true, indent: 2, joiner: ";" },
			{ text: "kubectl logs pod", allowed: true, indent: 2, joiner: "|" },
			{ text: "grep error", allowed: true, indent: 2 },
		]);
	});

	await t.test(
		"highlights stdin source for unauthorized xargs commands",
		() => {
			const raw = "echo payload | xargs rm";
			const commands = expandWrapperCommands(extract(raw));
			const unauthorized = commands.commands.filter((cmd) => {
				const name = getCommandName(cmd);
				const args = getCommandArgs(cmd);
				return (
					resolveBashAction(name, args, {
						echo: "allow",
						xargs: "allow",
						rm: "ask",
					}) !== "allow"
				);
			});

			const data = buildApprovalPromptData(
				commands.commands,
				unauthorized,
				undefined,
				commands.expandedWrappers,
			);

			assert.deepEqual(data.commands, [
				{ text: "echo payload", allowed: true, highlighted: true, joiner: "|" },
				{ text: "xargs ...", allowed: true },
				{ text: "rm", allowed: false, indent: 1 },
			]);
		},
	);

	await t.test(
		"does not show synthetic quotes around extracted wrapper commands",
		async (t) => {
			for (const [raw, wrapperText] of [
				["xargs cargo check", "xargs ..."],
				["timeout 30 cargo check", "timeout 30 ..."],
			] as const) {
				await t.test(raw, () => {
					const expanded = expandWrapperCommands(extract(raw));
					const unauthorized = expanded.commands.filter(
						(cmd) => getCommandName(cmd) === "cargo",
					);
					const data = buildApprovalPromptData(
						expanded.commands,
						unauthorized,
						undefined,
						expanded.expandedWrappers,
					);

					assert.deepEqual(data.commands, [
						{ text: wrapperText, allowed: true },
						{ text: "cargo check", allowed: false, indent: 1 },
					]);
				});
			}
		},
	);

	await t.test("preserves necessary quotes in extracted arguments", () => {
		const raw = "xargs echo 'hello world'";
		const expanded = expandWrapperCommands(extract(raw));
		const data = buildApprovalPromptData(
			expanded.commands,
			[],
			undefined,
			expanded.expandedWrappers,
		);

		assert.deepEqual(data.commands, [
			{ text: "xargs ...", allowed: true },
			{ text: "echo 'hello world'", allowed: true, indent: 1 },
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
