import assert from "node:assert/strict";
import test from "node:test";
import { META_DEFAULTS } from "./doctrine.ts";
import { buildFleetCard, formatAge, GLYPHS, renderFleetCard, STALE_GLYPH } from "./fleet.ts";
import { packetDraftFixture, sessionStateFixture } from "./testing.ts";
import type { Packet } from "./types.ts";
import { frame } from "./ui.ts";

const NOW = new Date("2026-07-28T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function pendingPacket(sessionId: string): Packet {
  return {
    ...packetDraftFixture({ sourceSessionId: sessionId }),
    version: 1,
    id: `pkt-${sessionId}`,
    createdAt: minutesAgo(12),
    updatedAt: minutesAgo(12),
    generation: 1,
    status: "pending",
  };
}

test("ages read the way a glance needs them to", () => {
  assert.equal(formatAge(40_000), "40s");
  assert.equal(formatAge(12 * 60_000), "12m");
  assert.equal(formatAge(3 * 3_600_000), "3h");
  assert.equal(formatAge(50 * 3_600_000), "2d");
});

test("each state gets its glyph, its age, and the header carries the badge and counts", () => {
  const card = buildFleetCard({
    fleet: [
      sessionStateFixture({ sessionId: "evals", title: "evals", lastEventAt: minutesAgo(12) }),
      sessionStateFixture({
        sessionId: "pet-clm",
        title: "pet-clm",
        state: "idle",
        stopState: "aborted",
        lastEventAt: minutesAgo(180),
      }),
      sessionStateFixture({
        sessionId: "car412",
        title: "car#412",
        state: "running",
        lastEventAt: new Date(NOW.getTime() - 40_000).toISOString(),
      }),
      sessionStateFixture({
        sessionId: "drilled",
        title: "drilled",
        state: "running",
        drillingPacketId: "pkt-x",
        lastEventAt: minutesAgo(1),
      }),
      sessionStateFixture({ sessionId: "quiet-1", title: "quiet-1", state: "idle", stopState: "idle-done", lastEventAt: minutesAgo(5) }),
      sessionStateFixture({ sessionId: "quiet-2", title: "quiet-2", state: "done", stopState: "idle-done", lastEventAt: minutesAgo(6) }),
    ],
    packets: [pendingPacket("evals")],
    doneToday: 4,
    now: NOW,
    meta: META_DEFAULTS,
  });

  const byLabel = new Map(card.rows.map((row) => [row.label, row]));
  assert.equal(byLabel.get("evals")?.glyph, GLYPHS["needs-ruling"]);
  assert.equal(byLabel.get("evals")?.note, "needs ruling");
  assert.equal(byLabel.get("evals")?.age, "12m");
  assert.equal(byLabel.get("pet-clm")?.glyph, GLYPHS.failed);
  assert.equal(byLabel.get("car#412")?.glyph, GLYPHS.running);
  assert.equal(byLabel.get("car#412")?.age, "40s");
  assert.equal(byLabel.get("drilled")?.glyph, GLYPHS.drilling);

  assert.equal(card.header.startsWith("◆ HQ"), true);
  assert.match(card.header, /1 to rule/);
  assert.equal(card.pendingCount, 1);
  assert.equal(card.idleCount, 2, "quiet sessions are summarized, not listed");
  assert.match(card.summary, /2 idle/);
  assert.match(card.summary, /4 done today/);
  assert.equal(card.collapsed, false);
});

test("a session that stopped reporting is flagged; a recently active one is not", () => {
  const card = buildFleetCard({
    fleet: [
      sessionStateFixture({
        sessionId: "silent",
        title: "silent",
        state: "running",
        lastEventAt: minutesAgo(120),
      }),
      sessionStateFixture({
        sessionId: "breathing",
        title: "breathing",
        state: "running",
        lastEventAt: minutesAgo(1),
      }),
      sessionStateFixture({
        sessionId: "parked",
        title: "parked",
        state: "idle",
        stopState: "idle-done",
        lastEventAt: minutesAgo(600),
      }),
    ],
    packets: [],
    doneToday: 0,
    now: NOW,
    meta: { ...META_DEFAULTS, stalenessMinutes: 30 },
  });

  const byLabel = new Map(card.rows.map((row) => [row.label, row]));
  assert.equal(byLabel.get("silent")?.stale, true);
  assert.equal(byLabel.get("silent")?.glyph, STALE_GLYPH);
  assert.equal(byLabel.get("silent")?.note, "no word");
  assert.equal(byLabel.get("breathing")?.stale, false);
  assert.equal(byLabel.get("breathing")?.glyph, GLYPHS.running);
  assert.equal(
    byLabel.has("parked"),
    false,
    "an idle session is supposed to be quiet, so quietness is not alarming",
  );
});

test("the card collapses to one line when nothing is running or waiting", () => {
  const card = buildFleetCard({
    fleet: [
      sessionStateFixture({ sessionId: "a", state: "idle", stopState: "idle-done" }),
      sessionStateFixture({ sessionId: "b", state: "done", stopState: "idle-done" }),
    ],
    packets: [],
    doneToday: 3,
    now: NOW,
    meta: META_DEFAULTS,
  });
  assert.equal(card.collapsed, true);
  const lines = renderFleetCard(card, 34);
  assert.equal(lines.length, 2, "header plus one summary line");
  assert.match(lines[1] ?? "", /2 idle/);
});

test("an attended session is shown as the user's own and never as work", () => {
  const card = buildFleetCard({
    fleet: [
      sessionStateFixture({ sessionId: "mine", title: "mine", role: "attended", state: "running" }),
    ],
    packets: [],
    doneToday: 0,
    now: NOW,
    meta: META_DEFAULTS,
  });
  assert.equal(card.rows[0]?.attended, true);
  assert.equal(card.rows[0]?.note, "you");
});

test("rendered lines never exceed the frame, and the frame is the drawn card", () => {
  const card = buildFleetCard({
    fleet: [
      sessionStateFixture({
        sessionId: "long",
        title: "a very long session label that would overflow the card",
        state: "running",
      }),
    ],
    packets: [],
    doneToday: 0,
    now: NOW,
    meta: META_DEFAULTS,
  });
  const width = 34;
  const framed = frame(renderFleetCard(card, width), width);
  assert.equal(framed[0]?.startsWith("┌─ fleet "), true);
  assert.equal(framed.at(-1)?.startsWith("└"), true);
  for (const line of framed) assert.equal(line.length <= width, true, `overlong line: ${line}`);
});

test("the card shows no transcript text", () => {
  const card = buildFleetCard({
    fleet: [
      sessionStateFixture({
        sessionId: "a",
        title: "titled",
        preview: "SECRET-PREVIEW-TEXT that belongs in the session",
        state: "running",
      }),
    ],
    packets: [],
    doneToday: 0,
    now: NOW,
    meta: META_DEFAULTS,
  });
  const rendered = renderFleetCard(card, 40).join("\n");
  assert.equal(rendered.includes("SECRET-PREVIEW-TEXT"), false);
});

test("a long label is not truncated to the shortest one, and the age is in the drawn line", () => {
  const card = buildFleetCard({
    fleet: [
      sessionStateFixture({ sessionId: "a", title: "hq", state: "running", lastEventAt: minutesAgo(2) }),
      sessionStateFixture({
        sessionId: "b",
        title: "pi-plugins-panel",
        state: "running",
        lastEventAt: minutesAgo(3),
      }),
    ],
    packets: [],
    doneToday: 0,
    now: NOW,
    meta: META_DEFAULTS,
  });
  const lines = renderFleetCard(card, 40);
  const panelLine = lines.find((line) => line.includes("pi-plugins"));
  assert.ok(panelLine, "the longer label is rendered");
  assert.equal(panelLine?.includes("pi-plugins-panel"), true, "and it is not clipped to the short one");
  for (const row of card.rows) {
    const line = lines.find((candidate) => candidate.includes(row.label.slice(0, 6)));
    assert.match(line ?? "", new RegExp(`${row.age}\\s*$`), "each row line ends with its age");
  }
});

test("the summary carries the idle and done glyphs, not just the words", () => {
  const card = buildFleetCard({
    fleet: [
      sessionStateFixture({ sessionId: "idle-1", state: "idle", stopState: "idle-done" }),
      sessionStateFixture({ sessionId: "done-1", state: "done", stopState: "idle-done" }),
    ],
    packets: [],
    doneToday: 2,
    now: NOW,
    meta: META_DEFAULTS,
  });
  assert.equal(card.summary.includes(GLYPHS.idle), true);
  assert.equal(card.summary.includes(GLYPHS.done), true);
});
