import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { handleBashTool } from "../src/handlers.ts";

test("handleBashTool", async (t) => {
	await t.test("treats returned parse errors as parse failure", async () => {
		let confirmationBody: string | undefined;
		const pi = {
			events: { emit: () => undefined },
		} as unknown as ExtensionAPI;
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				confirm: async (_title: string, body: string) => {
					confirmationBody = body;
					return false;
				},
				custom: async () => "Reject",
			},
		} as unknown as ExtensionContext;

		const result = await handleBashTool(
			pi,
			"bash",
			'echo "unterminated',
			{},
			{},
			ctx,
			{},
		);

		assert.deepEqual(result, {
			block: true,
			reason: "[Blocked by pi-guard: User rejected this invocation]",
			terminate: true,
		});
		assert.equal(confirmationBody, "\nAllow anyway?");
	});
});
