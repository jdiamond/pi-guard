import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

// Import only after isolating config reads and command-triggered saves.
const home = mkdtempSync(join(tmpdir(), "pi-guard-status-"));
const oldHome = process.env.HOME;
process.env.HOME = home;
const { default: guard } = await import("../src/index.ts");
after(() => {
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
	rmSync(home, { recursive: true, force: true });
});

function setup(enabled = true, hasUI = true) {
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			guard: {
				enabled,
				profiles: { "read-write": { write: "allow", edit: "allow" } },
				shortcuts: {
					rw: "profile read-write",
					ro: "profile off",
					yolo: "disable",
					safe: "enable",
				},
			},
		}),
	);
	const statuses = new Map<string, string>();
	let statusCalls = 0;
	type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => unknown;
	const commands = new Map<string, Handler>();
	const events = new Map<string, EventHandler>();
	guard({
		registerCommand(name: string, options: { handler: Handler }) {
			commands.set(name, options.handler);
		},
		on(name: string, handler: EventHandler) {
			events.set(name, handler);
		},
	} as unknown as ExtensionAPI);
	const ctx = {
		hasUI,
		cwd: home,
		ui: {
			notify() {},
			setStatus(key: string, text: string | undefined) {
				statusCalls++;
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		statuses,
		statusCalls: () => statusCalls,
		async command(args: string, name = "guard") {
			const handler = commands.get(name);
			assert.ok(handler);
			await handler(args, ctx);
		},
		async event(name: string) {
			const handler = events.get(name);
			assert.ok(handler);
			await handler({}, ctx);
		},
	};
}

test("publishes on/off on startup and clears only its status on shutdown", async () => {
	for (const enabled of [true, false]) {
		const app = setup(enabled);
		assert.equal(app.statusCalls(), 0);
		await app.event("session_start");
		assert.equal(
			app.statuses.get("pi-guard"),
			enabled ? "guard: on" : "guard: off",
		);
		app.statuses.set("another-extension", "keep");
		await app.event("session_shutdown");
		assert.equal(app.statuses.has("pi-guard"), false);
		assert.equal(app.statuses.get("another-extension"), "keep");
	}
});

test("guard commands refresh profiles and enable/disable/toggle state", async () => {
	const app = setup();
	for (const [command, expected] of [
		["profile read-write", "guard: read-write"],
		["profile missing", "guard: read-write"],
		["profile", "guard: read-write"],
		["disable", "guard: off"],
		["enable", "guard: read-write"],
		["toggle", "guard: off"],
		["toggle", "guard: read-write"],
		["profile off", "guard: on"],
	]) {
		assert.ok(command);
		await app.command(command);
		assert.equal(app.statuses.get("pi-guard"), expected);
	}
});

test("shortcut commands refresh status, including profiles selected while disabled", async () => {
	const app = setup(false);
	for (const [shortcut, expected] of [
		["rw", "guard: off"],
		["safe", "guard: read-write"],
		["ro", "guard: on"],
		["yolo", "guard: off"],
	]) {
		assert.ok(shortcut);
		await app.command("", shortcut);
		assert.equal(app.statuses.get("pi-guard"), expected);
	}
});

test("non-interactive sessions never publish status", async () => {
	const app = setup(true, false);
	await app.event("session_start");
	await app.command("profile read-write");
	await app.command("", "ro");
	await app.event("session_shutdown");
	assert.equal(app.statusCalls(), 0);
});
