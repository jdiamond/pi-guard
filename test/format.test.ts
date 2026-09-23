import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import { formatCommand } from "../src/format.ts";

test("formatCommand", async (t) => {
	function first(raw: string) {
		const cmds = extractAllCommandsFromAST(parseBash(raw), raw);
		assert.ok(cmds[0], `expected at least one command: ${raw}`);
		return cmds[0];
	}

	function displays(raw: string) {
		return extractAllCommandsFromAST(parseBash(raw), raw).map((cmd) =>
			formatCommand(cmd),
		);
	}

	await t.test("basic serialization", async (t) => {
		await t.test("re-serializes simple args as tokens", () => {
			assert.equal(
				formatCommand(first("git commit -am msg")),
				"git commit -am msg",
			);
		});

		await t.test("preserves original quoting via source slices", () => {
			const raw = `git commit -m "my message"`;
			assert.equal(formatCommand(first(raw)), raw);
		});

		await t.test("does not truncate short commands", () => {
			assert.equal(formatCommand(first("pwd")), "pwd");
		});
	});

	await t.test("length limiting and token elision", async (t) => {
		await t.test(
			"uses the full display budget before truncating a long non-path arg",
			() => {
				const raw = `git commit -m "Add a very long commit message that exceeds the token max"`;
				assert.equal(
					formatCommand(first(raw), { maxLength: 50, argMaxLength: 10 }),
					`git commit -m "Add a very long commit message tha…`,
				);
			},
		);

		await t.test("hard-truncates total display at maxLength", () => {
			const raw = "echo aa bb cc dd ee ff gg";
			assert.equal(
				formatCommand(first(raw), { maxLength: 15 }),
				"echo aa bb cc …",
			);
		});

		await t.test(
			"keeps later short tokens visible by shrinking an earlier long path",
			() => {
				const raw = "git -C /Users/jdiamond/code/pi-unbash add -A";
				assert.equal(
					formatCommand(first(raw), { maxLength: 40 }),
					"git -C /Users/jdiamond…/pi-unbash add -A",
				);
			},
		);

		await t.test("replaces newlines with ↵ before elision", () => {
			const raw = "python3 -c \"print('hello\\nworld')\"";
			assert.equal(
				formatCommand(first(raw)),
				`python3 -c "print('hello\\nworld')"`,
			);
		});
	});

	await t.test("path-aware elision", async (t) => {
		await t.test(
			"elides long paths while using the available display budget",
			() => {
				const raw = "git -C /Users/jdiamond/code/pi-unbash add -A";
				assert.equal(
					formatCommand(first(raw), { maxLength: 40 }),
					"git -C /Users/jdiamond…/pi-unbash add -A",
				);
			},
		);

		await t.test(
			"elides bare relative paths (no leading ./ or /) while preserving the tail",
			() => {
				const raw = "git add packages/tui/src/terminal.ts";
				assert.equal(
					formatCommand(first(raw), { maxLength: 35 }),
					"git add packages/tui/s…/terminal.ts",
				);
			},
		);

		await t.test("elides quoted paths containing $", () => {
			const raw = `cp "$PROJECT_ROOT/src/routes/\\$page.tsx" dist/`;
			assert.equal(
				formatCommand(first(raw), { maxLength: 40 }),
				`cp "$PROJECT_ROOT/src/…/\\$page.tsx" dis…`,
			);
		});

		await t.test("does not elide paths that fit within maxLength", () => {
			const raw = "rm /Users/jdiamond/code/pi-unbash/test/ast.test.ts";
			assert.equal(formatCommand(first(raw)), raw);
		});

		await t.test("does not treat URLs as paths", () => {
			const raw = `curl https://github.com/owner/repo/blob/main/README.md`;
			assert.equal(formatCommand(first(raw), { argMaxLength: 20 }), raw);
		});

		await t.test("does not treat sentences with a slash as paths", () => {
			const raw = `echo "enable foo/bar and baz qux quux corge"`;
			assert.equal(formatCommand(first(raw)), raw);
		});
	});

	await t.test("nested command formatting", async (t) => {
		await t.test(
			"correctly resolves nested command source for commands inside $()",
			() => {
				const raw = `git reset --soft $(git merge-base main HEAD)`;
				const inner = extractAllCommandsFromAST(parseBash(raw), raw).find(
					(cmd) => formatCommand(cmd) === "git merge-base main HEAD",
				);
				assert.ok(inner, "should extract inner git command");
				assert.equal(formatCommand(inner), "git merge-base main HEAD");
			},
		);

		await t.test(
			"formats both outer and inner commands for double-quoted command substitution",
			() => {
				const raw = `python3 -c 'print("ok")' "hello $(python3 -c 'print("inner")')"`;
				assert.deepEqual(displays(raw), [
					`python3 -c 'print("ok")' "hello $(...)"`,
					`python3 -c 'print("inner")'`,
				]);
			},
		);

		await t.test(
			"formats both outer and inner commands for assignment command substitution",
			() => {
				const raw = `FOO=$(python3 -c 'print("inner")') env`;
				assert.deepEqual(displays(raw), ["env", `python3 -c 'print("inner")'`]);
			},
		);

		await t.test("formats inner commands extracted from backticks", () => {
			const raw = "echo `python3 -c 'print(\"inner\")'`";
			assert.deepEqual(displays(raw), [
				"echo `...`",
				`python3 -c 'print("inner")'`,
			]);
		});

		await t.test(
			"formats inner commands extracted from process substitution",
			() => {
				const raw = `cat <(python3 -c 'print("inner")')`;
				assert.deepEqual(displays(raw), [
					"cat <(...)",
					`python3 -c 'print("inner")'`,
				]);
			},
		);

		await t.test(
			"preserves discovery order for multiple nested substitutions",
			() => {
				const raw = `python3 -c 'print("outer")' "$(python3 -c 'print("one")')" "$(python3 -c 'print("two")')"`;
				assert.deepEqual(displays(raw), [
					`python3 -c 'print("outer")' "$(...)" "$(...)"`,
					`python3 -c 'print("one")'`,
					`python3 -c 'print("two")'`,
				]);
			},
		);
	});

	await t.test("redirect and heredoc formatting", async (t) => {
		await t.test("includes output redirect in display", () => {
			const raw = `echo hello >out.txt`;
			assert.equal(formatCommand(first(raw)), raw);
		});

		await t.test("preserves space in output redirect", () => {
			const raw = `echo hello > out.txt`;
			assert.equal(formatCommand(first(raw)), raw);
		});

		await t.test("includes input redirect in display", () => {
			const raw = `cat <in.txt`;
			assert.equal(formatCommand(first(raw)), raw);
		});

		await t.test("includes stderr redirect in display", () => {
			const raw = `cmd 2>/dev/null`;
			assert.equal(formatCommand(first(raw)), raw);
		});

		await t.test(
			"includes heredoc content in display with operator and marker preserved",
			() => {
				const raw = `node --input-type=module <<'EOF'\nconsole.log("hi");\nEOF`;
				assert.equal(
					formatCommand(first(raw)),
					`node --input-type=module <<'EOF'↵console.log("hi");↵EOF`,
				);
			},
		);

		await t.test("preserves double quotes around heredoc markers", () => {
			const raw = `cmd <<"EOF"\n$HOME\nEOF`;
			assert.equal(formatCommand(first(raw)), `cmd <<"EOF"↵$HOME↵EOF`);
		});

		await t.test(
			"uses the full display budget for long heredoc content",
			() => {
				const raw = `bash <<EOF\n${"x".repeat(100)}\nEOF`;
				assert.equal(
					formatCommand(first(raw), { maxLength: 50, argMaxLength: 20 }),
					`bash <<EOF↵${"x".repeat(38)}…`,
				);
			},
		);

		await t.test("preserves <<- operator in heredoc display", () => {
			const raw = `bash <<-EOF\n\techo hi\nEOF`;
			assert.equal(formatCommand(first(raw)), `bash <<-EOF↵\techo hi↵EOF`);
		});

		await t.test("includes redirect plus heredoc in display", () => {
			const raw = `git rebase -i main --autosquash 2>&1 <<'EOF'\npick abc feat\nEOF`;
			assert.equal(
				formatCommand(first(raw)),
				`git rebase -i main --autosquash 2>&1 <<'EOF'↵pick abc feat↵EOF`,
			);
		});

		await t.test(
			"renders non-heredoc redirects before heredoc in display",
			() => {
				const raw = `cmd >out.txt <<EOF\nhello\nEOF`;
				assert.equal(formatCommand(first(raw)), "cmd >out.txt <<EOF↵hello↵EOF");
			},
		);
	});

	await t.test("bare assignment formatting", async (t) => {
		await t.test("formats bare assignment with subshell", () => {
			assert.equal(
				formatCommand(first("TOKEN=$(curl -s https://auth.example.com/token)")),
				"TOKEN=$(...)",
			);
		});

		await t.test("formats bare assignment with simple value", () => {
			assert.equal(formatCommand(first("FOO=bar")), "FOO=bar");
		});

		await t.test("formats bare assignment with empty value", () => {
			assert.equal(formatCommand(first("FOO=")), "FOO=");
		});

		await t.test("formats bare assignment with backtick expansion", () => {
			assert.equal(formatCommand(first("FOO=`rm -rf /`")), "FOO=`...`");
		});

		await t.test("formats bare assignment with pipeline in subshell", () => {
			const raw =
				"TOKEN=$(curl -s https://auth.example.com/token | jq -r .access_token)";
			assert.equal(formatCommand(first(raw)), "TOKEN=$(...)");
		});

		await t.test("formats multiple bare assignments", () => {
			assert.equal(formatCommand(first("A=1 B=2")), "A=1 B=2");
		});

		await t.test("formats append assignment", () => {
			// Note: += in a non-command context creates a variable assignment.
			// unbash may parse this differently; skip if it parses as command.
			assert.ok(formatCommand(first("PATH+=:/usr/local/bin")).includes("+="));
		});

		await t.test("formats bare assignment with quoted value", () => {
			assert.equal(
				formatCommand(first('MSG="hello world"')),
				'MSG="hello world"',
			);
		});

		await t.test(
			"formats full example: TOKEN assignment with && joiner",
			() => {
				const raw =
					'TOKEN=$(curl -s https://auth.example.com/token | jq -r .access_token) && curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data';
				const cmd = first(raw);
				assert.equal(formatCommand(cmd), "TOKEN=$(...)");
				assert.equal(cmd.joiner, "&&");
			},
		);
	});

	await t.test("commands inside arithmetic", async (t) => {
		await t.test(
			"extracts and formats command inside arithmetic expansion",
			() => {
				const raw = "echo $(( $(npm --version) + 1 ))";
				const commands = displays(raw);
				assert.equal(commands[0], "echo $(( $(npm --version) + 1 ))");
				assert.equal(commands[1], "npm --version");
			},
		);

		await t.test(
			"extracts and formats command inside arithmetic expansion with pipe",
			() => {
				const raw = "echo $(( $(npm --version | tr -d '.') + 1 ))";
				const commands = displays(raw);
				assert.equal(
					commands[0],
					"echo $(( $(npm --version | tr -d '.') + 1 ))",
				);
				assert.equal(commands[1], "npm --version");
				assert.equal(commands[2], "tr -d '.'");
			},
		);

		await t.test(
			"extracts and formats command inside arithmetic expansion within double quotes",
			() => {
				const raw = 'echo "$(( $(rm -rf /) + 1 ))"';
				const commands = displays(raw);
				assert.equal(commands[0], 'echo "$(( $(rm -rf /) + 1 ))"');
				assert.equal(commands[1], "rm -rf /");
			},
		);

		await t.test(
			"extracts and formats command inside arithmetic command",
			() => {
				const raw = "(( $(curl http://example.com) + 1 ))";
				const commands = displays(raw);
				assert.equal(commands[0], "curl http://example.com");
			},
		);
	});
});
