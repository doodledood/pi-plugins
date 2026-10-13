import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { FRAME_MS, framesRunning, onFrame, resetFrames } from "./palette.ts";

beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
afterEach(() => {
	resetFrames();
	mock.restoreAll();
	mock.timers.reset();
});

test("draws at least 25 frames a second, so breathing and sweeping read as motion, not steps", () => {
	assert.ok(1000 / FRAME_MS >= 25, `${(1000 / FRAME_MS).toFixed(1)} frames a second`);
});

test("everything live advances on one clock", () => {
	const timers = mock.method(globalThis, "setInterval");
	onFrame(() => {});
	onFrame(() => {});
	onFrame(() => {});
	assert.equal(timers.mock.callCount(), 1, "one timer for every subscriber");
});

test("every subscriber draws once per frame, together", () => {
	const drawn: string[] = [];
	onFrame(() => drawn.push("row"));
	onFrame(() => drawn.push("working line"));
	mock.timers.tick(FRAME_MS);
	assert.deepEqual(drawn, ["row", "working line"]);
	mock.timers.tick(FRAME_MS);
	assert.deepEqual(drawn, ["row", "working line", "row", "working line"]);
});

test("the clock stops when the last subscriber leaves, and starts again for the next", () => {
	let draws = 0;
	const stopA = onFrame(() => draws++);
	const stopB = onFrame(() => draws++);
	stopA();
	assert.equal(framesRunning(), true);
	stopB();
	assert.equal(framesRunning(), false, "nothing ticks at rest");
	mock.timers.tick(FRAME_MS * 3);
	assert.equal(draws, 0);
	onFrame(() => draws++);
	mock.timers.tick(FRAME_MS);
	assert.equal(draws, 1);
});

test("a subscriber may stop itself or another mid-frame; the rest still draw", () => {
	const drawn: string[] = [];
	const stopSelf: () => void = onFrame(() => {
		drawn.push("self");
		stopSelf();
	});
	let stopLater = () => {};
	onFrame(() => {
		drawn.push("stopper");
		stopLater();
	});
	stopLater = onFrame(() => drawn.push("stopped"));
	onFrame(() => drawn.push("last"));
	mock.timers.tick(FRAME_MS);
	assert.deepEqual(drawn, ["self", "stopper", "last"]);
	mock.timers.tick(FRAME_MS);
	assert.deepEqual(drawn, ["self", "stopper", "last", "stopper", "last"]);
});
