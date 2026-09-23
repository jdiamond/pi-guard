import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseBash } from "unbash";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import {
	findUnauthorizedRedirects,
	hasDeniedRedirect,
} from "../src/handlers.ts";

function commands(raw: string) {
	return extractAllCommandsFromAST(parseBash(raw), raw);
}

test("bash output redirects", async (t) => {
	await t.test("requires write approval for output redirects", () => {
		const refs = commands("cat <<'EOF' > hello.cpp\nhello\nEOF");
		const unauthorized = findUnauthorizedRedirects(
			refs,
			{ "*": "ask" },
			process.cwd(),
		);

		assert.equal(unauthorized.length, 1);
		const first = unauthorized[0];
		assert.ok(first);
		assert.equal(
			hasDeniedRedirect(first, { "*": "ask" }, process.cwd()),
			false,
		);
	});

	await t.test("allows explicitly allowed redirect targets", () => {
		const refs = commands("cat input.txt > hello.cpp");
		const unauthorized = findUnauthorizedRedirects(
			refs,
			{ "*": "ask", "hello.cpp": "allow" },
			process.cwd(),
		);

		assert.equal(unauthorized.length, 0);
	});

	await t.test("allows /dev/null through the default write rule", () => {
		const refs = commands("command 2>/dev/null");
		const unauthorized = findUnauthorizedRedirects(
			refs,
			{ ...DEFAULT_CONFIG.rules.write },
			process.cwd(),
		);

		assert.equal(unauthorized.length, 0);
	});

	await t.test("recognizes append and stderr redirects", () => {
		const refs = commands("echo one >> output.txt; echo two 2> errors.txt");
		const unauthorized = findUnauthorizedRedirects(
			refs,
			{ "*": "ask" },
			process.cwd(),
		);

		assert.equal(unauthorized.length, 2);
	});

	await t.test("recognizes >& with a path as a file write", () => {
		const refs = commands(
			"echo output >& output.txt; echo errors 2>&errors.txt",
		);
		const unauthorized = findUnauthorizedRedirects(
			refs,
			{ "*": "ask" },
			process.cwd(),
		);

		assert.equal(unauthorized.length, 2);
	});

	await t.test(
		"does not treat >& with a file descriptor as a file write",
		() => {
			const refs = commands(
				"echo output >&2; echo output 2>&1; echo output >&3",
			);
			const unauthorized = findUnauthorizedRedirects(
				refs,
				{ "*": "ask" },
				process.cwd(),
			);

			assert.equal(unauthorized.length, 0);
		},
	);

	await t.test("does not treat input redirects or heredocs as writes", () => {
		const refs = commands("cat < input.txt; cat <<'EOF'\nhello\nEOF");
		const unauthorized = findUnauthorizedRedirects(
			refs,
			{ "*": "ask" },
			process.cwd(),
		);

		assert.equal(unauthorized.length, 0);
	});

	await t.test("denied redirect targets are detected", () => {
		const refs = commands("cat data > secrets.pem");
		const first = refs[0];
		assert.ok(first);

		assert.equal(
			hasDeniedRedirect(
				first,
				{ "*": "allow", "**/*.pem": "deny" },
				process.cwd(),
			),
			true,
		);
	});
});
