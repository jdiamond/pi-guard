import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import { resolveBashAction } from "../src/matching.ts";
import { getCommandArgs, getCommandName } from "../src/resolve.ts";
import type { CommandRef } from "../src/types.ts";
import {
	expandWrapperCommands,
	formatWrapperDisplay,
	WRAPPER_COMMANDS,
} from "../src/wrappers.ts";

/** Parse a command string, extract commands, expand wrappers, and summarize. */
function expand(raw: string) {
	const ast = parseBash(raw);
	const commands = extractAllCommandsFromAST(ast, raw);
	const { commands: expanded } = expandWrapperCommands(commands);
	return expanded.map((cmd) => ({
		name: getCommandName(cmd),
		args: getCommandArgs(cmd),
	}));
}

test("expandWrapperCommands", async (t) => {
	await t.test("no wrappers — returns commands unchanged", () => {
		assert.deepEqual(expand("ls -la"), [{ name: "ls", args: ["-la"] }]);
	});

	await t.test("xargs — simple passthrough", () => {
		const result = expand("find . -name '*.ts' | xargs rm");
		assert.deepEqual(result, [
			{ name: "find", args: [".", "-name", "*.ts"] },
			{ name: "xargs", args: ["rm"] },
			{ name: "rm", args: [] },
		]);
	});

	await t.test("xargs — with flags before sub-command", () => {
		const result = expand("find . -name '*.ts' | xargs -0 rm -rf");
		assert.deepEqual(result, [
			{ name: "find", args: [".", "-name", "*.ts"] },
			{ name: "xargs", args: ["-0", "rm", "-rf"] },
			{ name: "rm", args: ["-rf"] },
		]);
	});

	await t.test("xargs — -n flag with value before sub-command", () => {
		const result = expand("cat files.txt | xargs -n 1 rm");
		assert.deepEqual(result, [
			{ name: "cat", args: ["files.txt"] },
			{ name: "xargs", args: ["-n", "1", "rm"] },
			{ name: "rm", args: [] },
		]);
	});

	await t.test("xargs — combined flag -n1 (no space)", () => {
		const result = expand("find . | xargs -n1 rm");
		assert.deepEqual(result, [
			{ name: "find", args: ["."] },
			{ name: "xargs", args: ["-n1", "rm"] },
			{ name: "rm", args: [] },
		]);
	});

	await t.test("xargs — no sub-command after flags", () => {
		// xargs with flags but no command — uses echo by default, nothing to extract
		const result = expand("find . | xargs -0");
		assert.equal(result.length, 2);
		assert.equal(result[0]?.name, "find");
		assert.equal(result[1]?.name, "xargs");
	});

	await t.test("sudo — simple passthrough", () => {
		const result = expand("sudo rm -rf /tmp/thing");
		assert.deepEqual(result, [
			{ name: "sudo", args: ["rm", "-rf", "/tmp/thing"] },
			{ name: "rm", args: ["-rf", "/tmp/thing"] },
		]);
	});

	await t.test("sudo — with -u flag", () => {
		const result = expand("sudo -u root rm -rf /");
		assert.deepEqual(result, [
			{ name: "sudo", args: ["-u", "root", "rm", "-rf", "/"] },
			{ name: "rm", args: ["-rf", "/"] },
		]);
	});

	await t.test("nice — with -n flag", () => {
		const result = expand("nice -n 19 make build");
		assert.deepEqual(result, [
			{ name: "nice", args: ["-n", "19", "make", "build"] },
			{ name: "make", args: ["build"] },
		]);
	});

	await t.test("nohup — simple passthrough", () => {
		const result = expand("nohup make build");
		assert.deepEqual(result, [
			{ name: "nohup", args: ["make", "build"] },
			{ name: "make", args: ["build"] },
		]);
	});

	await t.test("bash -c — parses sub-command string", () => {
		const result = expand("bash -c 'rm -rf /'");
		assert.deepEqual(result, [
			{ name: "bash", args: ["-c", "rm -rf /"] },
			{ name: "rm", args: ["-rf", "/"] },
		]);
	});

	await t.test("bash -c — with multiple commands", () => {
		const result = expand("bash -c 'git pull && make build'");
		assert.deepEqual(result, [
			{ name: "bash", args: ["-c", "git pull && make build"] },
			{ name: "git", args: ["pull"] },
			{ name: "make", args: ["build"] },
		]);
	});

	await t.test("sh -c — parses sub-command string", () => {
		const result = expand("sh -c 'echo hello'");
		assert.deepEqual(result, [
			{ name: "sh", args: ["-c", "echo hello"] },
			{ name: "echo", args: ["hello"] },
		]);
	});

	await t.test(
		"find -exec — extracts sub-command with backslash-semicolon",
		() => {
			const result = expand("find . -name '*.ts' -exec rm {} \\;");
			assert.deepEqual(result, [
				{
					name: "find",
					args: [".", "-name", "*.ts", "-exec", "rm", "{}", ";"],
				},
				{ name: "rm", args: ["{}"] },
			]);
		},
	);

	await t.test("find -exec with + terminator", () => {
		const result = expand("find . -name '*.ts' -exec rm {} +");
		assert.deepEqual(result, [
			{ name: "find", args: [".", "-name", "*.ts", "-exec", "rm", "{}", "+"] },
			{ name: "rm", args: ["{}"] },
		]);
	});

	await t.test("find -ok — extracts sub-command", () => {
		const result = expand("find . -ok rm {} \\;");
		assert.deepEqual(result, [
			{ name: "find", args: [".", "-ok", "rm", "{}", ";"] },
			{ name: "rm", args: ["{}"] },
		]);
	});

	await t.test("find -exec with sub-command flags", () => {
		const result = expand("find . -exec rm -rf {} \\;");
		assert.deepEqual(result, [
			{ name: "find", args: [".", "-exec", "rm", "-rf", "{}", ";"] },
			{ name: "rm", args: ["-rf", "{}"] },
		]);
	});

	await t.test("find -exec with quoted semicolon", () => {
		const result = expand("find . -exec rm {} ';'");
		assert.deepEqual(result, [
			{ name: "find", args: [".", "-exec", "rm", "{}", ";"] },
			{ name: "rm", args: ["{}"] },
		]);
	});

	await t.test("nested wrappers — sudo xargs", () => {
		const result = expand("sudo xargs rm -rf");
		assert.deepEqual(result, [
			{ name: "sudo", args: ["xargs", "rm", "-rf"] },
			{ name: "xargs", args: ["rm", "-rf"] },
			{ name: "rm", args: ["-rf"] },
		]);
	});

	await t.test("nested wrappers — bash -c with sudo", () => {
		const result = expand("bash -c 'sudo rm -rf /'");
		assert.deepEqual(result, [
			{ name: "bash", args: ["-c", "sudo rm -rf /"] },
			{ name: "sudo", args: ["rm", "-rf", "/"] },
			{ name: "rm", args: ["-rf", "/"] },
		]);
	});

	await t.test("non-wrapper command — not expanded", () => {
		assert.deepEqual(expand("git status"), [{ name: "git", args: ["status"] }]);
	});

	await t.test("env — skips var assignments before sub-command", () => {
		const result = expand("env PATH=/usr/bin make build");
		assert.deepEqual(result, [
			{ name: "env", args: ["PATH=/usr/bin", "make", "build"] },
			{ name: "make", args: ["build"] },
		]);
	});

	await t.test("env — with flags and var assignments", () => {
		const result = expand("env -i PATH=/usr/bin make build");
		assert.deepEqual(result, [
			{ name: "env", args: ["-i", "PATH=/usr/bin", "make", "build"] },
			{ name: "make", args: ["build"] },
		]);
	});

	// fd -x/--exec
	await t.test("fd -x — extracts sub-command", () => {
		const result = expand("fd . -e ts -x rm {}");
		assert.deepEqual(result, [
			{ name: "fd", args: [".", "-e", "ts", "-x", "rm", "{}"] },
			{ name: "rm", args: ["{}"] },
		]);
	});

	await t.test("fd --exec — extracts sub-command", () => {
		const result = expand("fd --exec rm {}");
		assert.deepEqual(result, [
			{ name: "fd", args: ["--exec", "rm", "{}"] },
			{ name: "rm", args: ["{}"] },
		]);
	});

	await t.test("fd -X — extracts sub-command", () => {
		const result = expand("fd . -X rm {}");
		assert.deepEqual(result, [
			{ name: "fd", args: [".", "-X", "rm", "{}"] },
			{ name: "rm", args: ["{}"] },
		]);
	});

	await t.test("fd --exec-batch — extracts sub-command", () => {
		const result = expand("fd . --exec-batch rm {}");
		assert.deepEqual(result, [
			{ name: "fd", args: [".", "--exec-batch", "rm", "{}"] },
			{ name: "rm", args: ["{}"] },
		]);
	});

	await t.test("fd without -x/-X — no sub-command extracted", () => {
		const result = expand("fd . -e ts");
		assert.deepEqual(result, [{ name: "fd", args: [".", "-e", "ts"] }]);
	});
});

test("expandWrapperCommands — expandedWrappers tracking", async (t) => {
	await t.test("tracks wrappers that were expanded", () => {
		const ast = parseBash("sudo rm -rf /");
		const commands = extractAllCommandsFromAST(ast, "sudo rm -rf /");
		const { commands: expanded, expandedWrappers } =
			expandWrapperCommands(commands);
		assert.equal(expanded.length, 2); // sudo + rm
		assert.equal(expandedWrappers.size, 1); // sudo was expanded
	});

	await t.test("does not track non-wrappers", () => {
		const ast = parseBash("git status");
		const commands = extractAllCommandsFromAST(ast, "git status");
		const { expandedWrappers } = expandWrapperCommands(commands);
		assert.equal(expandedWrappers.size, 0);
	});

	await t.test("tracks multiple wrappers in a pipeline", () => {
		const ast = parseBash("find . | xargs sudo rm");
		const commands = extractAllCommandsFromAST(ast, "find . | xargs sudo rm");
		const { commands: expanded, expandedWrappers } =
			expandWrapperCommands(commands);
		assert.equal(expanded.length, 4); // find, xargs, sudo, rm
		assert.equal(expandedWrappers.size, 2); // xargs + sudo
	});

	await t.test("does not track wrapper with no sub-command", () => {
		const ast = parseBash("xargs");
		const commands = extractAllCommandsFromAST(ast, "xargs");
		const { expandedWrappers } = expandWrapperCommands(commands);
		assert.equal(expandedWrappers.size, 0); // xargs with no cmd = not expanded
	});
});

test("WRAPPER_COMMANDS registry", async (t) => {
	await t.test("covers expected commands", () => {
		const expected = [
			"xargs",
			"sudo",
			"nice",
			"nohup",
			"env",
			"strace",
			"bash",
			"sh",
			"zsh",
			"find",
			"fd",
		];
		for (const cmd of expected) {
			assert.ok(
				cmd in WRAPPER_COMMANDS,
				`${cmd} should be in WRAPPER_COMMANDS`,
			);
		}
	});

	await t.test("passthrough specs have correct type", () => {
		const passthroughCommands = [
			"xargs",
			"sudo",
			"nice",
			"nohup",
			"env",
			"strace",
		];
		for (const cmd of passthroughCommands) {
			assert.equal(
				WRAPPER_COMMANDS[cmd]?.type,
				"passthrough",
				`${cmd} should be passthrough`,
			);
		}
	});

	await t.test("flag specs have correct type", () => {
		const flagCommands = ["bash", "sh", "zsh"];
		for (const cmd of flagCommands) {
			assert.equal(
				WRAPPER_COMMANDS[cmd]?.type,
				"flag",
				`${cmd} should be flag type`,
			);
		}
	});

	await t.test("exec spec has correct type", () => {
		assert.equal(WRAPPER_COMMANDS.find?.type, "exec");
	});

	await t.test("fd has exec type with unterminated keywords", () => {
		assert.equal(WRAPPER_COMMANDS.fd?.type, "exec");
		const spec = WRAPPER_COMMANDS.fd as {
			type: string;
			keywords: string[];
			terminators: null;
		};
		assert.deepEqual(spec.keywords, ["-x", "--exec", "-X", "--exec-batch"]);
		assert.equal(spec.terminators, null);
	});

	await t.test("env has skipVarAssignments", () => {
		assert.equal(
			(WRAPPER_COMMANDS.env as { type: string; skipVarAssignments: boolean })
				.skipVarAssignments,
			true,
		);
	});
});

/** Find a command by name; throws if not found. */
function findCmd(raw: string, name: string): CommandRef {
	const ast = parseBash(raw);
	const cmds = extractAllCommandsFromAST(ast, raw);
	const cmd = cmds.find((c) => getCommandName(c) === name);
	assert.ok(cmd, `expected to find ${name} in: ${raw}`);
	return cmd;
}

test("formatWrapperDisplay", async (t) => {
	await t.test("xargs — replaces sub-command with ...", () => {
		assert.equal(
			formatWrapperDisplay(
				findCmd("find . -name '*.ts' | xargs rm -rf", "xargs"),
			),
			"xargs ...",
		);
	});

	await t.test("xargs with flags — preserves flags before ...", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("find . | xargs -0 rm -rf", "xargs")),
			"xargs -0 ...",
		);
	});

	await t.test("xargs -n1 — handles combined flag with value", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("find . | xargs -n1 rm", "xargs")),
			"xargs -n1 ...",
		);
	});

	await t.test("sudo — replaces sub-command with ...", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("sudo rm -rf /", "sudo")),
			"sudo ...",
		);
	});

	await t.test("sudo -u root rm — preserves flag with value", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("sudo -u root rm -rf /", "sudo")),
			"sudo -u root ...",
		);
	});

	await t.test("bash -c — replaces script with ...", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("bash -c 'rm -rf /'", "bash")),
			"bash -c ...",
		);
	});

	await t.test("find -exec — replaces sub-command with ...", () => {
		assert.equal(
			formatWrapperDisplay(
				findCmd("find . -name '*.ts' -exec rm {} \\;", "find"),
			),
			"find . -name *.ts -exec ...",
		);
	});

	await t.test("env — preserves var assignments before ...", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("env PATH=/usr/bin make build", "env")),
			"env PATH=/usr/bin ...",
		);
	});

	await t.test("non-wrapper command — falls through to formatCommand", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("git status", "git")),
			"git status",
		);
	});

	await t.test("fd -x — replaces sub-command with ...", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("fd . -e ts -x rm {}", "fd")),
			"fd . -e ts -x ...",
		);
	});

	await t.test("fd --exec — replaces sub-command with ...", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("fd --exec rm {}", "fd")),
			"fd --exec ...",
		);
	});

	await t.test("fd -X — replaces sub-command with ...", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("fd . -X rm {}", "fd")),
			"fd . -X ...",
		);
	});

	await t.test("fd --exec-batch — replaces sub-command with ...", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("fd . --exec-batch rm {}", "fd")),
			"fd . --exec-batch ...",
		);
	});

	await t.test("fd without exec — falls through to formatCommand", () => {
		assert.equal(
			formatWrapperDisplay(findCmd("fd . -e ts", "fd")),
			"fd . -e ts",
		);
	});
});

test("wrapper expansion + rule resolution", async (t) => {
	/**
	 * Integration test: parse a command, expand wrappers, and resolve
	 * each expanded command against rules. Returns which command names
	 * are unauthorized (action !== "allow").
	 */
	function resolveUnauthorized(
		rawCmd: string,
		rules: Record<string, "allow" | "ask" | "deny">,
	): string[] {
		const ast = parseBash(rawCmd);
		const { commands } = expandWrapperCommands(
			extractAllCommandsFromAST(ast, rawCmd),
		);
		const unauthorized: string[] = [];
		for (const cmd of commands) {
			const name = getCommandName(cmd);
			const args = getCommandArgs(cmd);
			const action = resolveBashAction(name, args, rules);
			if (action !== "allow") {
				unauthorized.push(name);
			}
		}
		return unauthorized;
	}

	await t.test("xargs rm — rm is unauthorized when xargs is allowed", () => {
		const rules = {
			"*": "ask",
			find: "allow",
			xargs: "allow",
			rm: "ask",
		} as const;
		const unauthorized = resolveUnauthorized(
			"find . -name '*.ts' | xargs rm",
			rules,
		);
		assert.deepEqual(unauthorized, ["rm"]);
	});

	await t.test("xargs rm — both allowed when rm is allowed", () => {
		const rules = {
			"*": "ask",
			find: "allow",
			xargs: "allow",
			rm: "allow",
		} as const;
		const unauthorized = resolveUnauthorized(
			"find . -name '*.ts' | xargs rm",
			rules,
		);
		assert.deepEqual(unauthorized, []);
	});

	await t.test("sudo rm — sudo is ask and rm is ask", () => {
		const rules = { "*": "ask" } as const;
		const unauthorized = resolveUnauthorized("sudo rm -rf /", rules);
		assert.deepEqual(unauthorized, ["sudo", "rm"]);
	});

	await t.test("bash -c 'rm -rf /' — bash is allowed, rm is not", () => {
		const rules = { "*": "ask", bash: "allow" } as const;
		const unauthorized = resolveUnauthorized("bash -c 'rm -rf /'", rules);
		assert.deepEqual(unauthorized, ["rm"]);
	});

	await t.test("find -exec rm {} \\; — find allowed, rm is not", () => {
		const rules = { "*": "ask", find: "allow" } as const;
		const unauthorized = resolveUnauthorized("find . -exec rm {} \\;", rules);
		assert.deepEqual(unauthorized, ["rm"]);
	});

	await t.test("fd -x rm {} — fd allowed, rm is not", () => {
		const rules = { "*": "ask", fd: "allow" } as const;
		const unauthorized = resolveUnauthorized("fd . -x rm {}", rules);
		assert.deepEqual(unauthorized, ["rm"]);
	});

	await t.test("nested: sudo xargs rm — checks all three levels", () => {
		const rules = { "*": "ask", xargs: "allow" } as const;
		const unauthorized = resolveUnauthorized("sudo xargs rm", rules);
		assert.deepEqual(unauthorized, ["sudo", "rm"]);
	});

	await t.test(
		"nested: bash -c 'sudo rm' — checks through bash and sudo",
		() => {
			const rules = { "*": "ask", bash: "allow" } as const;
			const unauthorized = resolveUnauthorized("bash -c 'sudo rm'", rules);
			assert.deepEqual(unauthorized, ["sudo", "rm"]);
		},
	);

	await t.test("no wrapper — regular command rules still work", () => {
		const rules = { "*": "ask", ls: "allow" } as const;
		const unauthorized = resolveUnauthorized("ls -la", rules);
		assert.deepEqual(unauthorized, []);
	});
});
