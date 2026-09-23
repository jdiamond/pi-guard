import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import { getCommandArgs, getCommandName } from "../src/resolve.ts";

/** Strip source/node for deepEqual assertions that only care about name/args. */
function summarize(raw: string) {
	return extractAllCommandsFromAST(parseBash(raw), raw).map((cmd) => ({
		name: getCommandName(cmd),
		args: getCommandArgs(cmd),
	}));
}

test("extractAllCommandsFromAST", async (t) => {
	await t.test("extracts simple command", () => {
		assert.deepEqual(summarize("ls -la"), [{ name: "ls", args: ["-la"] }]);
	});

	await t.test("extracts multiple commands from AndOr (&&)", () => {
		assert.deepEqual(summarize("git commit -m 'foo' && git push"), [
			{ name: "git", args: ["commit", "-m", "foo"] },
			{ name: "git", args: ["push"] },
		]);
	});

	await t.test("extracts commands from pipes (|)", () => {
		assert.deepEqual(summarize("cat file.txt | grep 'foo' | wc -l"), [
			{ name: "cat", args: ["file.txt"] },
			{ name: "grep", args: ["foo"] },
			{ name: "wc", args: ["-l"] },
		]);
	});

	await t.test("extracts commands from $() subshells", () => {
		assert.deepEqual(summarize("echo $(git status)"), [
			{ name: "echo", args: ["$(git status)"] },
			{ name: "git", args: ["status"] },
		]);
	});

	await t.test("extracts commands from backtick subshells", () => {
		assert.deepEqual(summarize("FOO=`rm -rf /` node app.js"), [
			{ name: "node", args: ["app.js"] },
			{ name: "rm", args: ["-rf", "/"] },
		]);
	});

	await t.test(
		"does not extract phantom commands from quoted heredoc bodies",
		() => {
			const raw = `gh x --body "$(cat <<'EOF'
batch isn't terminating pi's \`echo A\`). The \`echo B\` (end.
EOF
)"`;
			assert.deepEqual(
				summarize(raw).map(({ name }) => name),
				["gh", "cat"],
			);
		},
	);

	await t.test(
		"does not throw while extracting quoted heredocs inside command substitutions",
		() => {
			const raw = `gh x --body "$(cat <<'EOF'
isn't
EOF
)"`;
			assert.doesNotThrow(() => summarize(raw));
		},
	);

	await t.test("extracts from highly nested evil subshells", () => {
		assert.deepEqual(
			summarize(
				"echo $(cat file.txt | grep $(rm -rf /)) && curl http://evil.com",
			),
			[
				{ name: "echo", args: ["$(cat file.txt | grep $(rm -rf /))"] },
				{ name: "cat", args: ["file.txt"] },
				{ name: "grep", args: ["$(rm -rf /)"] },
				{ name: "rm", args: ["-rf", "/"] },
				{ name: "curl", args: ["http://evil.com"] },
			],
		);
	});

	await t.test("extracts commands from subshell grouping", () => {
		assert.deepEqual(summarize("(rm -rf /; echo done)"), [
			{ name: "rm", args: ["-rf", "/"] },
			{ name: "echo", args: ["done"] },
		]);
	});

	await t.test("extracts commands from if/then/else", () => {
		assert.deepEqual(summarize("if true; then rm -rf /; else echo safe; fi"), [
			{ name: "true", args: [] },
			{ name: "rm", args: ["-rf", "/"] },
			{ name: "echo", args: ["safe"] },
		]);
	});

	await t.test("extracts commands from while loop", () => {
		assert.deepEqual(summarize("while true; do curl evil.com; done"), [
			{ name: "true", args: [] },
			{ name: "curl", args: ["evil.com"] },
		]);
	});

	await t.test("extracts commands from for loop", () => {
		assert.deepEqual(summarize("for i in 1 2 3; do echo $i; done"), [
			{ name: "echo", args: ["$i"] },
		]);
	});

	await t.test("extracts commands from case statement", () => {
		assert.deepEqual(summarize("case x in y) echo hi;; z) rm -rf /;; esac"), [
			{ name: "echo", args: ["hi"] },
			{ name: "rm", args: ["-rf", "/"] },
		]);
	});

	await t.test("extracts commands from function definition", () => {
		assert.deepEqual(summarize("foo() { rm -rf /; }"), [
			{ name: "rm", args: ["-rf", "/"] },
		]);
	});

	await t.test("extracts commands from bare assignment with subshell", () => {
		assert.deepEqual(summarize("FOO=$(rm -rf /)"), [
			{ name: "FOO", args: [] },
			{ name: "rm", args: ["-rf", "/"] },
		]);
	});

	await t.test("extracts command with no arguments", () => {
		assert.deepEqual(summarize("pwd"), [{ name: "pwd", args: [] }]);
	});

	await t.test("extracts commands from double-quoted subshells", () => {
		assert.deepEqual(summarize('echo "hello $(rm -rf /)"'), [
			{ name: "echo", args: ["hello $(rm -rf /)"] },
			{ name: "rm", args: ["-rf", "/"] },
		]);
	});

	await t.test("does not extract from single-quoted strings", () => {
		assert.deepEqual(summarize("echo 'hello $(rm -rf /)'"), [
			{ name: "echo", args: ["hello $(rm -rf /)"] },
		]);
	});

	await t.test("extracts commands from unquoted heredoc bodies", () => {
		assert.deepEqual(summarize("cat <<EOF\n$(rm -rf /)\nEOF"), [
			{ name: "cat", args: [] },
			{ name: "rm", args: ["-rf", "/"] },
		]);
	});

	await t.test(
		"extracts backtick commands from unquoted heredoc bodies",
		() => {
			assert.deepEqual(summarize("cat <<EOF\n`rm -rf /`\nEOF"), [
				{ name: "cat", args: [] },
				{ name: "rm", args: ["-rf", "/"] },
			]);
		},
	);

	await t.test("does not treat plain unquoted heredoc text as commands", () => {
		assert.deepEqual(summarize("cat <<EOF\nrm -rf /\nEOF"), [
			{ name: "cat", args: [] },
		]);
	});

	await t.test("does not extract commands from quoted heredoc bodies", () => {
		assert.deepEqual(summarize("cat <<'EOF'\n$(rm -rf /)\nEOF"), [
			{ name: "cat", args: [] },
		]);
	});

	await t.test("extracts commands from arithmetic expansion", () => {
		assert.deepEqual(summarize("echo $(( $(npm --version) + 1 ))"), [
			{ name: "echo", args: ["$(( $(npm --version) + 1 ))"] },
			{ name: "npm", args: ["--version"] },
		]);
	});

	await t.test("extracts commands from arithmetic command", () => {
		assert.deepEqual(summarize("(( $(curl http://example.com) + 1 ))"), [
			{ name: "curl", args: ["http://example.com"] },
		]);
	});

	await t.test(
		"extracts commands from arithmetic expansion inside double quotes",
		() => {
			assert.deepEqual(summarize('echo "$(( $(rm -rf /) + 1 ))"'), [
				{ name: "echo", args: ["$(( $(rm -rf /) + 1 ))"] },
				{ name: "rm", args: ["-rf", "/"] },
			]);
		},
	);
});

test("extractAllCommandsFromAST — joiners", async (t) => {
	function summarizeJoiners(raw: string) {
		return extractAllCommandsFromAST(parseBash(raw), raw).map((cmd) => ({
			name: getCommandName(cmd),
			joiner: cmd.joiner,
		}));
	}

	await t.test("no joiner on simple command", () => {
		assert.deepEqual(summarizeJoiners("ls -la"), [
			{ name: "ls", joiner: undefined },
		]);
	});

	await t.test("assigns && joiner", () => {
		assert.deepEqual(summarizeJoiners("git commit && git push"), [
			{ name: "git", joiner: "&&" },
			{ name: "git", joiner: undefined },
		]);
	});

	await t.test("assigns || joiner", () => {
		assert.deepEqual(summarizeJoiners("git commit || echo fail"), [
			{ name: "git", joiner: "||" },
			{ name: "echo", joiner: undefined },
		]);
	});

	await t.test("assigns | joiner for pipeline", () => {
		assert.deepEqual(summarizeJoiners("cat file.txt | grep foo | wc -l"), [
			{ name: "cat", joiner: "|" },
			{ name: "grep", joiner: "|" },
			{ name: "wc", joiner: undefined },
		]);
	});

	await t.test("assigns ; joiner for sequential commands", () => {
		assert.deepEqual(summarizeJoiners("cd foo; rm bar"), [
			{ name: "cd", joiner: ";" },
			{ name: "rm", joiner: undefined },
		]);
	});

	await t.test("assigns joiners for mixed pipeline and &&", () => {
		// cat foo | grep bar && sort out
		// Pipeline(cat, grep) with |, AndOr(pipeline, sort) with &&
		// cat gets |, grep gets &&, sort gets nothing
		assert.deepEqual(summarizeJoiners("cat foo | grep bar && sort out"), [
			{ name: "cat", joiner: "|" },
			{ name: "grep", joiner: "&&" },
			{ name: "sort", joiner: undefined },
		]);
	});

	await t.test("no joiners inside subshell expansion", () => {
		// The outer echo has no joiner (it's standalone).
		// The inner git has no joiner (it's standalone within the expansion).
		// But they should be in different groups.
		const cmds = extractAllCommandsFromAST(
			parseBash("echo $(git status)"),
			"echo $(git status)",
		);
		assert.deepEqual(
			cmds.map((c) => ({ name: getCommandName(c), joiner: c.joiner })),
			[
				{ name: "echo", joiner: undefined },
				{ name: "git", joiner: undefined },
			],
		);
	});

	await t.test("joiners inside subshell expansion", () => {
		// echo $(cat foo | grep bar) — echo has no joiner (standalone),
		// cat has | within the expansion (inner group)
		const cmds = extractAllCommandsFromAST(
			parseBash("echo $(cat foo | grep bar)"),
			"echo $(cat foo | grep bar)",
		);
		assert.deepEqual(
			cmds.map((c) => ({ name: getCommandName(c), joiner: c.joiner })),
			[
				{ name: "echo", joiner: undefined },
				{ name: "cat", joiner: "|" },
				{ name: "grep", joiner: undefined },
			],
		);
	});

	await t.test("pipe joiner lands on outer command", () => {
		// echo $(curl ...) | grep foo — pipe is between echo and grep,
		// not on curl which is inside the expansion
		const cmds = extractAllCommandsFromAST(
			parseBash("echo $(curl -s https://evil.com) | grep foo"),
			"echo $(curl -s https://evil.com) | grep foo",
		);
		assert.deepEqual(
			cmds.map((c) => ({
				name: getCommandName(c),
				group: c.group,
				joiner: c.joiner,
			})),
			[
				{ name: "echo", group: 0, joiner: "|" },
				{ name: "curl", group: 1, joiner: undefined },
				{ name: "grep", group: 0, joiner: undefined },
			],
		);
	});

	await t.test("assigns joiner to bare assignment", () => {
		// TOKEN=$(...) && curl ... — && should land on the assignment line
		// Discovery order: assignment (group 0), inner commands (group 1), outer curl (group 0)
		const cmds = extractAllCommandsFromAST(
			parseBash(
				'TOKEN=$(curl -s https://auth.example.com/token | jq -r .access_token) && curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data',
			),
			'TOKEN=$(curl -s https://auth.example.com/token | jq -r .access_token) && curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data',
		);
		assert.deepEqual(
			cmds.map((c) => ({
				name: getCommandName(c),
				group: c.group,
				joiner: c.joiner,
			})),
			[
				{ name: "TOKEN", group: 0, joiner: "&&" },
				{ name: "curl", group: 1, joiner: "|" },
				{ name: "jq", group: 1, joiner: undefined },
				{ name: "curl", group: 0, joiner: undefined },
			],
		);
	});

	await t.test("bare assignment without subshell", () => {
		// FOO=bar has no sub-commands, just the assignment
		const cmds = extractAllCommandsFromAST(parseBash("FOO=bar"), "FOO=bar");
		assert.deepEqual(
			cmds.map((c) => ({
				name: getCommandName(c),
				group: c.group,
			})),
			[{ name: "FOO", group: 0 }],
		);
	});
});

test("extractAllCommandsFromAST — groups", async (t) => {
	function summarizeGroups(raw: string) {
		return extractAllCommandsFromAST(parseBash(raw), raw).map((cmd) => ({
			name: getCommandName(cmd),
			group: cmd.group,
		}));
	}

	await t.test("single command gets group 0", () => {
		assert.deepEqual(summarizeGroups("ls -la"), [{ name: "ls", group: 0 }]);
	});

	await t.test("pipeline commands share a group", () => {
		assert.deepEqual(summarizeGroups("cat foo | grep bar"), [
			{ name: "cat", group: 0 },
			{ name: "grep", group: 0 },
		]);
	});

	await t.test("&& commands share a group", () => {
		assert.deepEqual(summarizeGroups("git commit && git push"), [
			{ name: "git", group: 0 },
			{ name: "git", group: 0 },
		]);
	});

	await t.test("; separated commands share a group", () => {
		assert.deepEqual(summarizeGroups("cd foo; rm bar"), [
			{ name: "cd", group: 0 },
			{ name: "rm", group: 0 },
		]);
	});

	await t.test("subshell expansion gets different group", () => {
		const groups = summarizeGroups("echo $(git status)");
		assert.equal(groups.length, 2);
		assert.equal(groups[0]?.name, "echo");
		assert.equal(groups[1]?.name, "git");
		assert.notEqual(groups[0]?.group, groups[1]?.group);
	});

	await t.test("nested pipeline inside subshell gets its own group", () => {
		const groups = summarizeGroups("echo $(cat foo | grep bar)");
		assert.equal(groups.length, 3);
		const echoGroup = groups.find((g) => g.name === "echo")?.group;
		const catGroup = groups.find((g) => g.name === "cat")?.group;
		const grepGroup = groups.find((g) => g.name === "grep")?.group;
		assert.equal(catGroup, grepGroup); // same group (pipeline)
		assert.notEqual(echoGroup, catGroup); // different from outer
	});

	await t.test("mixed pipeline and && share group", () => {
		assert.deepEqual(summarizeGroups("cat foo | grep bar && sort out"), [
			{ name: "cat", group: 0 },
			{ name: "grep", group: 0 },
			{ name: "sort", group: 0 },
		]);
	});

	await t.test("bare assignment shares group with joined commands", () => {
		// FOO=$(cmd) && bar — assignment and bar are group 0,
		// inner cmd is group 1. Discovery order: assignment, inner cmd, bar.
		assert.deepEqual(summarizeGroups("FOO=$(cmd) && bar"), [
			{ name: "FOO", group: 0 },
			{ name: "cmd", group: 1 },
			{ name: "bar", group: 0 },
		]);
	});
});
