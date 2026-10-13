/** The working line above the editor. */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { parseColor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { breathe } from "./palette.ts";
import { createHarness, at, FRAME_MS, fgAt, framesRunning, hex, message, recordingUi, TOKENS } from "./test-harness.ts";

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

		// A leaked clock subscription from the run before would draw again once the next run sets a UI.
		at(2_000, () => harness.emit("agent_start", {}, ctx));
		const before = calls.filter((c) => c.method === "message").length;
		at(2_100, () => mock.timers.tick(FRAME_MS));
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
		const indicator = calls.find((c) => c.method === "indicator")?.value as { frames: string[]; intervalMs?: number };
		assert.equal(indicator.frames.length, 1, "one frame at a time, so pi runs no timer of its own");
		assert.equal(stripTerminalSequences(indicator.frames[0] ?? ""), "●");
		assert.equal(lastMessage(), "Working  0.0s");

		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "thinking_delta" } });
		at(1_200, () => mock.timers.tick(FRAME_MS));
		assert.equal(lastMessage(), "Thinking  1.2s");

		// Its compact row breathes and names it right above: the line gives way to the run's time alone.
		harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: {} });
		at(1_500, () => mock.timers.tick(FRAME_MS));
		assert.equal(lastMessage(), "1.5s");
		const dot = () => fgAt((calls.filter((c) => c.method === "indicator").at(-1)?.value as { frames: string[] }).frames[0] ?? "", "●");
		assert.equal(dot(), hex(parseColor(TOKENS.dim!)), "the dot holds still while the row breathes");
		at(1_550, () => mock.timers.tick(FRAME_MS));
		assert.equal(dot(), hex(parseColor(TOKENS.dim!)));

		harness.emit("tool_execution_start", { toolCallId: "t2", toolName: "subagent", args: {} });
		at(1_600, () => mock.timers.tick(FRAME_MS));
		assert.equal(lastMessage(), "Working  1.6s", "a tool the renderer doesn't know reads as plain work");

		harness.emit("tool_execution_end", { toolCallId: "t2" });
		harness.emit("tool_execution_end", { toolCallId: "t1" });
		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "text_delta" } });
		at(2_000, () => mock.timers.tick(FRAME_MS));
		assert.equal(lastMessage(), "Writing  2.0s");

		harness.emit("agent_end", { messages: [] }, ctx);
		assert.deepEqual(calls.slice(-2), [
			{ method: "indicator", value: undefined },
			{ method: "message", value: undefined },
		]);
		const settled = calls.length;
		mock.timers.tick(1_000);
		assert.equal(calls.length, settled, "no updates after the run ends");
		assert.equal(framesRunning(), false, "the shared frame clock is stopped");
	} finally {
		mock.timers.reset();
	}
});

test("the dot settles to rest over a few frames when the line gives way, not in one jump", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const { calls, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		const dot = () => fgAt((calls.filter((c) => c.method === "indicator").at(-1)?.value as { frames: string[] }).frames[0] ?? "", "●");
		at(0, () => harness.emit("agent_start", {}, ctx));
		at(600, () => mock.timers.tick(FRAME_MS)); // the top of the breath
		assert.equal(dot(), hex(parseColor(TOKENS.accent!)));
		harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: {} });
		at(633, () => mock.timers.tick(FRAME_MS));
		assert.notEqual(dot(), hex(parseColor(TOKENS.accent!)));
		assert.notEqual(dot(), hex(parseColor(TOKENS.dim!)), "one frame in, it is still on its way down");
		at(900, () => mock.timers.tick(FRAME_MS));
		assert.equal(dot(), hex(parseColor(TOKENS.dim!)));
		harness.emit("agent_end", { messages: [] }, ctx);
	} finally {
		mock.timers.reset();
	}
});

test("once the tool ends, the dot eases back into its breath, and the next run starts breathing", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const { calls, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		const dot = () => fgAt((calls.filter((c) => c.method === "indicator").at(-1)?.value as { frames: string[] }).frames[0] ?? "", "●");
		const accent = hex(parseColor(TOKENS.accent!));
		const dim = hex(parseColor(TOKENS.dim!));
		const fullBreath = (sinceStart: number) => hex(breathe(parseColor(TOKENS.dim!), parseColor(TOKENS.accent!), sinceStart));
		at(0, () => harness.emit("agent_start", {}, ctx));
		harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: {} });
		at(500, () => mock.timers.tick(FRAME_MS));
		at(1_800, () => mock.timers.tick(FRAME_MS));
		assert.equal(dot(), dim);
		harness.emit("tool_execution_end", { toolCallId: "t1" });
		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "thinking_delta" } });
		at(1_833, () => mock.timers.tick(FRAME_MS));
		assert.notEqual(dot(), dim, "one frame after, it is on its way back");
		assert.notEqual(dot(), fullBreath(1_833), "not there in one jump");
		at(1_800 + 240, () => mock.timers.tick(FRAME_MS));
		at(3_000, () => mock.timers.tick(FRAME_MS)); // 2.5 breaths in: the top
		assert.equal(dot(), accent, "breathing again");

		// A run that ends while a tool is live leaves the next run breathing from its first frame.
		harness.emit("tool_execution_start", { toolCallId: "t2", toolName: "bash", args: {} });
		at(3_500, () => mock.timers.tick(FRAME_MS));
		harness.emit("agent_end", { messages: [] }, ctx);
		at(10_000, () => harness.emit("agent_start", {}, ctx));
		at(10_033, () => mock.timers.tick(FRAME_MS));
		assert.equal(dot(), fullBreath(33), "the full breath from the first frame, not easing up from rest");
		harness.emit("agent_end", { messages: [] }, ctx);
	} finally {
		mock.timers.reset();
	}
});

test("with pi's own tool rendering, the line names the running tool", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		harness.commands.get("tool-render")?.handler("default", { ui: { notify() {} } });
		const { calls, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		const lastMessage = () => calls.filter((c) => c.method === "message").at(-1)?.value;
		at(0, () => harness.emit("agent_start", {}, ctx));
		harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: {} });
		at(500, () => mock.timers.tick(FRAME_MS));
		assert.equal(lastMessage(), "Reading  0.5s", "no compact row is there to say it");
		harness.emit("agent_end", { messages: [] }, ctx);
	} finally {
		// The mode persists: restore it even when an assertion fails, so later harnesses start compact.
		createHarness().commands.get("tool-render")?.handler("compact", { ui: { notify() {} } });
		mock.timers.reset();
	}
});

test("the breathing dot changes color on every frame, from the run's start", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const { calls, ui } = recordingUi();
		// Started off the clock's zero, so the breath is timed from the run, not the wall clock.
		at(1_000, () => harness.emit("agent_start", {}, { hasUI: true, ui }));
		const dots = [0, 1, 2, 3].map((frame) => {
			at(1_000 + frame * FRAME_MS, () => frame && mock.timers.tick(FRAME_MS));
			const { frames } = calls.filter((c) => c.method === "indicator").at(-1)?.value as { frames: string[] };
			return fgAt(frames[0] ?? "", "●");
		});
		assert.equal(dots[0], hex(parseColor(TOKENS.dim!)), "a run's breath starts at its low point");
		assert.equal(new Set(dots).size, dots.length, `each frame moves the dot: ${dots.join(" ")}`);
		harness.emit("agent_end", { messages: [] }, { hasUI: true, ui });
	} finally {
		mock.timers.reset();
	}
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
		at(300, () => mock.timers.tick(FRAME_MS));
		const first = rawMessages.at(-1) ?? "";
		at(1_000, () => mock.timers.tick(FRAME_MS));
		const second = rawMessages.at(-1) ?? "";
		const label = (raw: string) => raw.slice(0, raw.lastIndexOf("Thinking") + "Thinking".length + 12);
		assert.equal(stripTerminalSequences(first).split("  ")[0], "Thinking");
		assert.notEqual(label(first), label(second), "the label's colors move");

		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "toolcall_delta" } });
		at(1_100, () => mock.timers.tick(FRAME_MS));
		assert.equal(lastMessage(), "Working  1.1s");

		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "text_delta" } });
		at(1_200, () => mock.timers.tick(FRAME_MS));
		assert.equal(lastMessage(), "Writing  1.2s");
		harness.emit("message_end", { message: { role: "assistant", content: [] } });
		at(1_300, () => mock.timers.tick(FRAME_MS));
		assert.equal(lastMessage(), "Working  1.3s", "a finished reply no longer reads as Writing");
		harness.emit("agent_end", { messages: [] }, ctx);
	} finally {
		mock.timers.reset();
	}
});
