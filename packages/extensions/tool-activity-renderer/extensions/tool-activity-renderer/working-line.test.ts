/** The working line above the editor. */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createHarness, at, message, recordingUi } from "./test-harness.ts";

test("the working line resets when the session shuts down mid-run, and a second run replaces the first", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const { calls, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		at(0, () => harness.emit("agent_start", {}, ctx));
		at(0, () => harness.emit("agent_start", {}, ctx));
		harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: {} });
		harness.emit("session_shutdown", {}, ctx);
		assert.deepEqual(calls.slice(-2), [
			{ method: "indicator", value: undefined },
			{ method: "message", value: undefined },
		]);
		const settled = calls.length;
		mock.timers.tick(1_000);
		assert.equal(calls.length, settled, "no timer survives the shutdown or the replaced run");

		// A leaked interval would draw again once the next run sets a UI: exactly one draw per frame.
		at(2_000, () => harness.emit("agent_start", {}, ctx));
		const before = calls.filter((c) => c.method === "message").length;
		at(2_100, () => mock.timers.tick(100));
		assert.equal(calls.filter((c) => c.method === "message").length - before, 1, "one timer, one draw per frame");
		harness.emit("agent_end", { messages: [] }, ctx);
	} finally {
		mock.timers.reset();
	}
});

test("the working line names the current activity with elapsed time, then hands the indicator back to pi", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const { calls, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		const lastMessage = () => calls.filter((c) => c.method === "message").at(-1)?.value;

		at(0, () => harness.emit("agent_start", {}, ctx));
		const indicator = calls.find((c) => c.method === "indicator")?.value as { frames: string[]; intervalMs: number };
		assert.equal(indicator.frames.length, 10, "one breath of the dot");
		assert.equal(indicator.intervalMs, 120, "ten frames across a 1.2s breath");
		assert.ok(indicator.frames.every((frame) => stripTerminalSequences(frame) === "●"));
		assert.equal(lastMessage(), "Working  0.0s");

		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "thinking_delta" } });
		at(1_200, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Thinking  1.2s");

		harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: {} });
		at(1_500, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Reading  1.5s");

		harness.emit("tool_execution_start", { toolCallId: "t2", toolName: "subagent", args: {} });
		at(1_600, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Working  1.6s", "a tool the renderer doesn't know reads as plain work");

		harness.emit("tool_execution_end", { toolCallId: "t2" });
		harness.emit("tool_execution_end", { toolCallId: "t1" });
		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "text_delta" } });
		at(2_000, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Writing  2.0s");

		harness.emit("agent_end", { messages: [] }, ctx);
		assert.deepEqual(calls.slice(-2), [
			{ method: "indicator", value: undefined },
			{ method: "message", value: undefined },
		]);
		const settled = calls.length;
		mock.timers.tick(1_000);
		assert.equal(calls.length, settled, "no updates after the run ends");
	} finally {
		mock.timers.reset();
	}
});

test("the breathing dot changes color across its frames", () => {
	const harness = createHarness();
	const { calls, ui } = recordingUi();
	harness.emit("agent_start", {}, { hasUI: true, ui });
	const { frames } = calls.find((c) => c.method === "indicator")?.value as { frames: string[] };
	assert.ok(new Set(frames).size > 1, "frames differ in color");
	harness.emit("agent_end", { messages: [] }, { hasUI: true, ui });
});

test("the working line stays out of the way without a UI", () => {
	const harness = createHarness();
	const { calls, ui } = recordingUi();
	harness.emit("agent_start", {}, { hasUI: false, ui });
	harness.emit("agent_end", { messages: [] }, { hasUI: false, ui });
	assert.deepEqual(calls, []);
});

test("the working line shimmers its label, reads Working for tool-call streaming and between turns", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const { calls, rawMessages, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		const lastMessage = () => calls.filter((c) => c.method === "message").at(-1)?.value;
		at(0, () => harness.emit("agent_start", {}, ctx));
		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "thinking_delta" } });
		at(300, () => mock.timers.tick(100));
		const first = rawMessages.at(-1) ?? "";
		at(1_000, () => mock.timers.tick(100));
		const second = rawMessages.at(-1) ?? "";
		const label = (raw: string) => raw.slice(0, raw.lastIndexOf("Thinking") + "Thinking".length + 12);
		assert.equal(stripTerminalSequences(first).split("  ")[0], "Thinking");
		assert.notEqual(label(first), label(second), "the label's colors move");

		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "toolcall_delta" } });
		at(1_100, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Working  1.1s");

		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "text_delta" } });
		at(1_200, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Writing  1.2s");
		harness.emit("message_end", { message: { role: "assistant", content: [] } });
		at(1_300, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Working  1.3s", "a finished reply no longer reads as Writing");
		harness.emit("agent_end", { messages: [] }, ctx);
	} finally {
		mock.timers.reset();
	}
});
