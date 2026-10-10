import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { handleBashTool, handleInteractiveApproval } from "../src/handlers.ts";

function createApprovalHarness(signal?: AbortSignal) {
	let openDialogs = 0;
	let maxOpenDialogs = 0;
	const finishDialogs: Array<(choice: string | undefined) => void> = [];
	const events: Array<{ name: string; payload: unknown }> = [];
	const custom = (
		factory: (
			tui: never,
			theme: never,
			keybindings: never,
			done: (choice: string | undefined) => void,
		) => unknown,
	) =>
		new Promise<string | undefined>((resolve) => {
			openDialogs++;
			maxOpenDialogs = Math.max(maxOpenDialogs, openDialogs);
			const done = (choice: string | undefined) => {
				openDialogs--;
				resolve(choice);
			};
			finishDialogs.push(done);
			factory({} as never, {} as never, {} as never, done);
		});
	const pi = {
		events: {
			emit: (name: string, payload: unknown) => events.push({ name, payload }),
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		signal,
		ui: { custom },
	} as unknown as ExtensionContext;
	return {
		ctx,
		pi,
		finishDialogs,
		get openDialogs() {
			return openDialogs;
		},
		get maxOpenDialogs() {
			return maxOpenDialogs;
		},
		events,
	};
}

const flushMicrotasks = () =>
	new Promise<void>((resolve) => setImmediate(resolve));

test("serializes interactive approval dialogs", async () => {
	const harness = createApprovalHarness();
	const first = handleInteractiveApproval(
		harness.pi,
		"write",
		{ path: "/tmp/first.txt" },
		harness.ctx,
		{},
	);
	const second = handleInteractiveApproval(
		harness.pi,
		"write",
		{ path: "/tmp/second.txt" },
		harness.ctx,
		{},
	);

	await flushMicrotasks();
	assert.equal(harness.openDialogs, 1);
	const finishFirst = harness.finishDialogs[0];
	assert.ok(finishFirst);
	finishFirst("Allow");
	assert.equal(await first, undefined);

	await flushMicrotasks();
	assert.equal(harness.openDialogs, 1);
	const finishSecond = harness.finishDialogs[1];
	assert.ok(finishSecond);
	finishSecond("Allow");
	assert.equal(await second, undefined);
	assert.equal(harness.openDialogs, 0);
	assert.equal(harness.maxOpenDialogs, 1);
	assert.deepEqual(
		harness.events
			.filter((event) => event.name === "herdr:blocked")
			.map((event) => (event.payload as { active: boolean }).active),
		[true, false, true, false],
	);
});

test("aborting an approval dismisses it and clears blocked status", async () => {
	const controller = new AbortController();
	const harness = createApprovalHarness(controller.signal);
	const approval = handleInteractiveApproval(
		harness.pi,
		"write",
		{ path: "/tmp/aborted.txt" },
		harness.ctx,
		{},
	);
	const queuedApproval = handleInteractiveApproval(
		harness.pi,
		"write",
		{ path: "/tmp/also-aborted.txt" },
		harness.ctx,
		{},
	);

	await flushMicrotasks();
	assert.equal(harness.openDialogs, 1);
	controller.abort();

	const rejected = {
		block: true,
		reason: "[Blocked by pi-guard: User rejected this invocation]",
		terminate: true,
	};
	assert.deepEqual(await approval, rejected);
	assert.deepEqual(await queuedApproval, rejected);
	assert.equal(harness.finishDialogs.length, 1);
	assert.equal(harness.openDialogs, 0);
	assert.deepEqual(
		harness.events
			.filter((event) => event.name === "herdr:blocked")
			.map((event) => (event.payload as { active: boolean }).active),
		[true, false],
	);
});

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
