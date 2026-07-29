import assert from "node:assert/strict";
import test from "node:test";
import {
  answeredAll,
  askDialogKey,
  buildAskDialog,
  initialAskState,
  PLAIN_THEME,
  renderAskDialog,
} from "./ask-ui.ts";
import { packetDraftFixture } from "./testing.ts";
import type { Packet } from "./types.ts";

function packet(overrides: Partial<Packet> = {}): Packet {
  return {
    version: 1,
    id: overrides.id ?? "pkt-1",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    generation: 1,
    ...packetDraftFixture(),
    status: "pending",
    ...overrides,
  } as Packet;
}

test("every option is shown with its price, and the recommendation is marked", () => {
  const tabs = buildAskDialog([packet()]);
  const lines = renderAskDialog(tabs, initialAskState(), { theme: PLAIN_THEME, width: 72 });
  const body = lines.join("\n");

  // The price is the thing that makes a packet decidable without opening the session,
  // so it has to be on screen, under the label it belongs to.
  assert.match(body, /1\. Retry the suite ← recommended/);
  assert.match(body, /eight minutes of CI/);
  assert.match(body, /2\. Investigate the flake now/);
  assert.match(body, /an hour of work/);

  // And the stakes, which a labels-only dialog dropped entirely.
  assert.match(body, /blast · /);
  assert.match(body, /changes if:/);

  // The three standing rows are always available.
  assert.match(body, /Ask first/);
  assert.match(body, /In my own words/);
  assert.match(body, /had to open the session/);

  // Nothing is crowded: a blank line separates each priced row from the next.
  assert.ok(lines.filter((line) => line.trim() === "").length >= tabs[0]!.rows.length - 1);
});

test("no line overflows the width it was given", () => {
  const long = packet({
    title: "decide whether the nightly job should keep retrying the flaky integration suite",
    question: "the suite has failed nine nights running and each retry costs eight minutes of CI",
    flipCondition: "if the fixture is fixed, or if the failure stops being the same assertion",
  });
  for (const width of [28, 40, 72, 120]) {
    const lines = renderAskDialog(buildAskDialog([long]), initialAskState(), {
      theme: PLAIN_THEME,
      width,
    });
    for (const line of lines) {
      assert.ok(line.length <= width, `"${line}" (${line.length}) exceeds ${width}`);
    }
  }
});

test("one decision is ruled by choosing it; a digit picks the same row", () => {
  const tabs = buildAskDialog([packet()]);
  const bySelecting = askDialogKey(tabs, { ...initialAskState(), cursor: 1 }, "enter");
  assert.equal(bySelecting.effect.kind, "submit");
  assert.deepEqual(bySelecting.state.answers.get("pkt-1"), { rowIndex: 1 });

  const byDigit = askDialogKey(tabs, initialAskState(), { digit: 2 });
  assert.deepEqual(byDigit.state.answers.get("pkt-1"), { rowIndex: 1 });
});

test("a row that needs words waits for them, and blank words are not an answer", () => {
  const tabs = buildAskDialog([packet()]);
  const wordsRow = tabs[0]!.rows.findIndex((row) => row.kind === "words");

  const typing = askDialogKey(tabs, initialAskState(), { digit: wordsRow + 1 });
  assert.equal(typing.effect.kind, "none", "choosing it does not rule yet");
  assert.match(typing.state.typingFor?.prompt ?? "", /own words/);

  const blank = askDialogKey(tabs, typing.state, { text: "   " });
  assert.equal(blank.state.answers.size, 0, "a blank ruling is words the user never said");
  assert.equal(blank.state.typingFor, undefined);

  const said = askDialogKey(tabs, typing.state, { text: "roll it back and tell the team" });
  assert.equal(said.effect.kind, "submit");
  assert.deepEqual(said.state.answers.get("pkt-1"), {
    rowIndex: wordsRow,
    text: "roll it back and tell the team",
  });

  // The editor can be left without answering.
  const escaped = askDialogKey(tabs, typing.state, "escape");
  assert.equal(escaped.effect.kind, "none", "esc leaves the editor, it does not cancel the ask");
  assert.equal(escaped.state.typingFor, undefined);
});

test("a batch is one dialog: a tab each, and nothing is ruled until they all are", () => {
  const tabs = buildAskDialog([
    packet({ id: "pkt-1", title: "retry the suite" }),
    packet({ id: "pkt-2", title: "raise the CI timeout" }),
    packet({ id: "pkt-3", title: "pin the fixture" }),
  ]);

  let state = initialAskState();
  const first = askDialogKey(tabs, state, "enter");
  assert.equal(first.effect.kind, "none", "one answer does not submit a batch");
  assert.equal(first.state.tab, 1, "it moves to the next open decision");
  state = first.state;

  // The tab bar shows which are done and which are not.
  const midway = renderAskDialog(tabs, state, { theme: PLAIN_THEME, width: 80 }).join("\n");
  assert.match(midway, /■ retry the suite/);
  assert.match(midway, /□ raise the CI tim/);

  state = askDialogKey(tabs, state, "enter").state;
  const last = askDialogKey(tabs, state, "enter");
  assert.equal(last.effect.kind, "none", "the last answer lands on the submit tab");
  assert.equal(last.state.tab, tabs.length);
  assert.equal(answeredAll(tabs, last.state), true);

  const summary = renderAskDialog(tabs, last.state, { theme: PLAIN_THEME, width: 80 }).join("\n");
  assert.match(summary, /3 decisions, ready to rule/);
  assert.match(summary, /enter to rule all of them/);
  assert.equal(askDialogKey(tabs, last.state, "enter").effect.kind, "submit");
});

test("the submit tab refuses while a decision is still open, and names which", () => {
  const tabs = buildAskDialog([
    packet({ id: "pkt-1", title: "retry the suite" }),
    packet({ id: "pkt-2", title: "raise the CI timeout" }),
  ]);
  const state = { ...initialAskState(), tab: 2 };
  assert.equal(askDialogKey(tabs, state, "enter").effect.kind, "none");
  const body = renderAskDialog(tabs, state, { theme: PLAIN_THEME, width: 80 }).join("\n");
  assert.match(body, /still open: retry the suite, raise the CI tim/);
});

test("esc leaves everything pending, from any tab", () => {
  const tabs = buildAskDialog([packet({ id: "pkt-1" }), packet({ id: "pkt-2" })]);
  for (const tab of [0, 1, 2]) {
    const result = askDialogKey(tabs, { ...initialAskState(), tab }, "escape");
    assert.equal(result.effect.kind, "cancel");
  }
});

test("a packet that replaced earlier questions says so where it is decided", () => {
  const tabs = buildAskDialog([packet({ supersedes: ["which branch", "which reviewer"] })]);
  const body = renderAskDialog(tabs, initialAskState(), { theme: PLAIN_THEME, width: 80 }).join("\n");
  assert.match(body, /replaces 2 earlier questions here: which branch; which reviewer/);
});
