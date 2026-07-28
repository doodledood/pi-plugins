import assert from "node:assert/strict";
import test from "node:test";
import { META_DEFAULTS } from "./doctrine.ts";
import { buildFleetCard } from "./fleet.ts";
import { sessionStateFixture } from "./testing.ts";
import { FLEET_OVERLAY_OPTIONS, FleetOverlay, frame } from "./ui.ts";

function model() {
  return buildFleetCard({
    fleet: [sessionStateFixture({ title: "alpha", state: "running" })],
    packets: [],
    doneToday: 1,
    now: new Date("2026-07-28T12:00:00.000Z"),
    meta: META_DEFAULTS,
  });
}

test("the card sits in the corner and claims a fixed narrow width", () => {
  assert.equal(FLEET_OVERLAY_OPTIONS.anchor, "top-right");
  assert.equal(typeof FLEET_OVERLAY_OPTIONS.width, "number");
});

test("the overlay handles no input at all", () => {
  const overlay = new FleetOverlay({ getModel: model });
  try {
    assert.equal(
      "handleInput" in overlay,
      false,
      "a glance that can take a keystroke can steal the seat",
    );
    assert.equal(typeof overlay.render, "function");
    assert.equal(typeof overlay.invalidate, "function");
  } finally {
    overlay.dispose();
  }
});

test("the overlay renders nothing until there is something to show", () => {
  const empty = new FleetOverlay({ getModel: () => undefined });
  try {
    assert.deepEqual(empty.render(34), []);
  } finally {
    empty.dispose();
  }
});

test("a rendered card is a closed box no wider than its frame", () => {
  const overlay = new FleetOverlay({ getModel: model });
  try {
    const lines = overlay.render(34);
    assert.equal(lines[0]?.startsWith("┌"), true);
    assert.equal(lines.at(-1)?.startsWith("└"), true);
    for (const line of lines) assert.equal(line.length <= 34, true);
  } finally {
    overlay.dispose();
  }
});

test("refreshing stops when the overlay is disposed", () => {
  let renders = 0;
  const overlay = new FleetOverlay({
    getModel: model,
    requestRender: () => {
      renders += 1;
    },
    refreshIntervalMs: 1,
  });
  overlay.dispose();
  const before = renders;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(renders, before, "a disposed card stops asking for renders");
      resolve();
    }, 20);
  });
});

test("the frame clips an overlong body line rather than breaking the box", () => {
  const framed = frame(["x".repeat(200)], 24);
  for (const line of framed) assert.equal(line.length <= 24, true);
  assert.match(framed[1] ?? "", /…/);
});
