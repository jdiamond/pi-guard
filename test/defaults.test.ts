import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { resolveBashAction } from "../src/matching.ts";

test("default bash rules allow file-test commands", () => {
	const rules = DEFAULT_CONFIG.rules.bash;

	assert.equal(resolveBashAction("[", ["-f", "file", "]"], rules), "allow");
	assert.equal(resolveBashAction("test", ["-d", "directory"], rules), "allow");
});

test("default bash rules allow loop-control builtins", () => {
	const rules = DEFAULT_CONFIG.rules.bash;

	assert.equal(resolveBashAction("break", [], rules), "allow");
	assert.equal(resolveBashAction("continue", [], rules), "allow");
});
