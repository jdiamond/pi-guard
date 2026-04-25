import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import {
	globMatch,
	isSubsequence,
	resolveBashAction,
	resolveExactAction,
	resolveGlobAction,
} from "../src/matching.ts";
import { getCommandArgs, getCommandName } from "../src/resolve.ts";

function _cmd(name: string, args: string[]) {
	const raw = [name, ...args].join(" ");
	const commands = extractAllCommandsFromAST(parseBash(raw), raw);
	return {
		// biome-ignore lint/style/noNonNullAssertion: test helper, known to produce at least one command
		name: getCommandName(commands[0]!),
		// biome-ignore lint/style/noNonNullAssertion: test helper, known to produce at least one command
		args: getCommandArgs(commands[0]!),
	};
}

test("isSubsequence", async (t) => {
	await t.test("matches when all needles appear in order", () => {
		assert.equal(isSubsequence(["git", "status"], ["git", "status"]), true);
		assert.equal(
			isSubsequence(["git", "status"], ["git", "status", "--short"]),
			true,
		);
		assert.equal(
			isSubsequence(["git", "status"], ["git", "-v", "status"]),
			true,
		);
	});

	await t.test("does not match when needles are out of order", () => {
		assert.equal(isSubsequence(["status", "git"], ["git", "status"]), false);
	});

	await t.test("does not match when needle is missing", () => {
		assert.equal(isSubsequence(["git", "push"], ["git", "status"]), false);
	});

	await t.test("empty needle matches anything", () => {
		assert.equal(isSubsequence([], ["git", "status"]), true);
		assert.equal(isSubsequence([], []), true);
	});
});

test("globMatch", async (t) => {
	await t.test("matches exact strings", () => {
		assert.equal(globMatch("foo", "foo"), true);
		assert.equal(globMatch("foo", "bar"), false);
	});

	await t.test("* matches anything except /", () => {
		assert.equal(globMatch("*.ts", "test.ts"), true);
		assert.equal(globMatch("*.ts", "src/test.ts"), false);
		assert.equal(globMatch("*.env", ".env"), true);
		assert.equal(globMatch("test/*", "test/foo.ts"), true);
		assert.equal(globMatch("test/*", "test/sub/foo.ts"), false);
	});

	await t.test("** matches anything including /", () => {
		// minimatch correctly handles ** matching zero directories
		assert.equal(globMatch("**/*.ts", "test.ts"), true);
		assert.equal(globMatch("**/*.ts", "src/test.ts"), true);
		assert.equal(globMatch("**/*.ts", "src/sub/test.ts"), true);
		assert.equal(globMatch("**/*.key", ".ssh/.hidden/priv.key"), true);
	});

	await t.test("? matches single character", () => {
		assert.equal(globMatch("test?.ts", "test1.ts"), true);
		assert.equal(globMatch("test?.ts", "test.ts"), false);
		assert.equal(globMatch("test?.ts", "test12.ts"), false);
	});

	await t.test("~ expands to home directory", () => {
		const home = process.env.HOME ?? "";
		assert.equal(globMatch("~/*.ts", `${home}/test.ts`), true);
		assert.equal(globMatch("~/*.ts", "/home/other/test.ts"), false);
	});

	await t.test("handles special regex characters", () => {
		// Glob patterns use [abc] for character classes, matching chars in brackets
		assert.equal(globMatch("file[0].txt", "file0.txt"), true);
		assert.equal(globMatch("file[0].txt", "file[0].txt"), false); // Literal brackets aren't matched
		assert.equal(
			globMatch(
				"node_modules/.package-lock.json",
				"node_modules/.package-lock.json",
			),
			true,
		);
	});
});

test("resolveBashAction", async (t) => {
	await t.test("allows base command when in rules", () => {
		const rules = { git: "allow" as const };
		assert.equal(resolveBashAction("git", ["status"], rules), "allow");
		assert.equal(
			resolveBashAction("git", ["commit", "-m", "msg"], rules),
			"allow",
		);
		assert.equal(resolveBashAction("git", [], rules), "allow");
	});

	await t.test("allows specific subcommand", () => {
		assert.equal(
			resolveBashAction("git", ["status"], { "git status": "allow" }),
			"allow",
		);
	});

	await t.test("allows subcommand with extra trailing args", () => {
		assert.equal(
			resolveBashAction("git", ["status", "--short"], {
				"git status": "allow",
			}),
			"allow",
		);
		assert.equal(
			resolveBashAction("jira", ["issue", "view", "XXX-123"], {
				"jira issue view": "allow",
			}),
			"allow",
		);
	});

	await t.test("allows subcommand with extra flags interspersed", () => {
		assert.equal(
			resolveBashAction("git", ["branch", "-v", "--show-current"], {
				"git branch --show-current": "allow",
			}),
			"allow",
		);
	});

	await t.test(
		"returns undefined for other subcommands when only specific one is allowed",
		() => {
			const rules = { "git status": "allow" as const };
			assert.equal(
				resolveBashAction("git", ["commit", "-m", "msg"], rules),
				undefined,
			);
			assert.equal(resolveBashAction("git", [], rules), undefined);
		},
	);

	await t.test("returns undefined when required tokens are missing", () => {
		assert.equal(
			resolveBashAction("git", ["branch", "-D", "main"], {
				"git branch --show-current": "allow",
			}),
			undefined,
		);
	});

	await t.test("returns undefined for unknown commands", () => {
		assert.equal(
			resolveBashAction("curl", ["evil.com"], { ls: "allow", cat: "allow" }),
			undefined,
		);
	});

	await t.test(
		"last match wins — base rule after subcommand rule overrides it",
		() => {
			const rules = { "git status": "ask" as const, git: "allow" as const };
			assert.equal(resolveBashAction("git", ["status"], rules), "allow");
		},
	);

	await t.test(
		"last match wins — subcommand rule after base rule overrides it",
		() => {
			const rules = { git: "allow" as const, "git status": "ask" as const };
			assert.equal(resolveBashAction("git", ["status"], rules), "ask");
		},
	);

	await t.test("* matches any command", () => {
		assert.equal(
			resolveBashAction("curl", ["evil.com"], { "*": "allow" }),
			"allow",
		);
		assert.equal(
			resolveBashAction("rm", ["-rf", "/"], { "*": "allow" }),
			"allow",
		);
	});

	await t.test("* is overridden by later specific rule", () => {
		const rules = { "*": "allow" as const, curl: "ask" as const };
		assert.equal(resolveBashAction("curl", ["evil.com"], rules), "ask");
		assert.equal(resolveBashAction("ls", [], rules), "allow");
	});

	await t.test("specific rule is overridden by later *", () => {
		const rules = { curl: "ask" as const, "*": "allow" as const };
		assert.equal(resolveBashAction("curl", ["evil.com"], rules), "allow");
	});

	await t.test("returns undefined when no rule matches", () => {
		assert.equal(resolveBashAction("curl", ["evil.com"], {}), undefined);
	});

	await t.test("multiple subcommands can be allowed independently", () => {
		const rules = {
			"git status": "allow" as const,
			"git log": "allow" as const,
		};
		assert.equal(resolveBashAction("git", ["status"], rules), "allow");
		assert.equal(
			resolveBashAction("git", ["log", "--oneline"], rules),
			"allow",
		);
		assert.equal(resolveBashAction("git", ["push"], rules), undefined);
	});

	await t.test("multi-level subcommand matching", () => {
		const rules = {
			"jira issue view": "allow" as const,
			"jira issue list": "allow" as const,
		};
		assert.equal(
			resolveBashAction("jira", ["issue", "view", "PROJ-123"], rules),
			"allow",
		);
		assert.equal(
			resolveBashAction("jira", ["issue", "list", "--project", "PROJ"], rules),
			"allow",
		);
		assert.equal(
			resolveBashAction("jira", ["issue", "create"], rules),
			undefined,
		);
		assert.equal(
			resolveBashAction("jira", ["project", "list"], rules),
			undefined,
		);
	});

	await t.test("allows dangerous command only with required flag", () => {
		const rules = { "terraform apply --dry-run": "allow" as const };
		assert.equal(
			resolveBashAction("terraform", ["apply", "--dry-run"], rules),
			"allow",
		);
		assert.equal(
			resolveBashAction("terraform", ["apply", "-v", "--dry-run"], rules),
			"allow",
		);
		assert.equal(resolveBashAction("terraform", ["apply"], rules), undefined);
		assert.equal(
			resolveBashAction("terraform", ["apply", "--force"], rules),
			undefined,
		);
	});

	await t.test("deny action", () => {
		const rules = { rm: "deny" as const };
		assert.equal(resolveBashAction("rm", ["-rf", "/"], rules), "deny");
		assert.equal(resolveBashAction("rm", [], rules), "deny");
	});

	await t.test("deny overrides allow when later in rules", () => {
		const rules = { git: "allow" as const, "git push": "deny" as const };
		assert.equal(resolveBashAction("git", ["status"], rules), "allow");
		assert.equal(resolveBashAction("git", ["push"], rules), "deny");
	});
});

test("resolveGlobAction", async (t) => {
	await t.test("returns undefined when no rule matches", () => {
		assert.equal(resolveGlobAction("/some/path", {}), undefined);
	});

	await t.test("* matches any path", () => {
		assert.equal(resolveGlobAction("/some/path", { "*": "allow" }), "allow");
	});

	await t.test("matches patterns without path separator", () => {
		// *.ts matches "file.ts" but not "src/file.ts"
		assert.equal(resolveGlobAction("index.ts", { "*.ts": "allow" }), "allow");
		assert.equal(
			resolveGlobAction("src/index.ts", { "*.ts": "allow" }),
			undefined,
		);
	});

	await t.test("matches patterns with **", () => {
		assert.equal(
			resolveGlobAction("/src/index.ts", { "**/*.ts": "allow" }),
			"allow",
		);
		assert.equal(
			resolveGlobAction("/src/sub/index.ts", { "**/*.ts": "allow" }),
			"allow",
		);
	});

	await t.test("last match wins", () => {
		const rules = { "*.ts": "allow" as const };
		assert.equal(resolveGlobAction("index.ts", rules), "allow");
	});

	await t.test("deny action", () => {
		// Note: * doesn't match leading dot, so use *.env for regular files, .env for dotfile
		assert.equal(resolveGlobAction("config.env", { "*.env": "deny" }), "deny");
		assert.equal(resolveGlobAction(".env", { ".env": "deny" }), "deny");
	});

	await t.test("deny overrides allow", () => {
		const rules = { "*": "allow" as const, "*.pem": "deny" as const };
		assert.equal(resolveGlobAction("config.ts", rules), "allow");
		assert.equal(resolveGlobAction("key.pem", rules), "deny");
	});
});

test("resolveExactAction", async (t) => {
	await t.test("returns undefined when no rule matches", () => {
		assert.equal(resolveExactAction("build", {}), undefined);
	});

	await t.test("* matches any value", () => {
		assert.equal(resolveExactAction("build", { "*": "allow" }), "allow");
		assert.equal(resolveExactAction("anything", { "*": "deny" }), "deny");
	});

	await t.test("matches exact value", () => {
		assert.equal(resolveExactAction("build", { build: "allow" }), "allow");
		assert.equal(resolveExactAction("test", { build: "allow" }), undefined);
	});

	await t.test("last match wins", () => {
		const rules = { build: "allow" as const };
		assert.equal(resolveExactAction("build", rules), "allow");
	});

	await t.test("deny action", () => {
		assert.equal(resolveExactAction("deploy", { deploy: "deny" }), "deny");
	});
});
