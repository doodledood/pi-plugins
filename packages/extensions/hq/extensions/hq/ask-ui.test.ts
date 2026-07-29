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

  // Progress is one short line that cannot wrap into a phantom decision.
  const midway = renderAskDialog(tabs, state, { theme: PLAIN_THEME, width: 80 }).join("\n");
  assert.match(midway, /decision 2 of 3 · ■ ◉ □ · 1\/3 ruled/);

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
  assert.match(body, /still open: decisions 1, 2/);
  // The summary identifies them by their whole titles, since two can shorten alike.
  assert.match(body, /1\. retry the suite/);
  assert.match(body, /2\. raise the CI timeout/);
  assert.match(body, /all 2 decisions · □ □ · 0\/2 ruled/);
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

test("model-written prose cannot bury the options, and focus reveals it", () => {
  const wordy = "unverified: " + "the residual question needs the owner or a session replay. ".repeat(6);
  const tabs = buildAskDialog([packet({
    flipCondition: "if " + "the same assertion fails on the previous two runs and nothing else changed. ".repeat(4),
    options: [
      { id: "accept", label: "Accept as done", price: wordy },
      { id: "follow-up", label: "There is a follow-up", price: "the session is resumed with your instruction" },
    ],
    recommendationId: "accept",
  })]);

  const lines = renderAskDialog(tabs, { ...initialAskState(), cursor: 1 }, {
    theme: PLAIN_THEME,
    width: 72,
  });
  const body = lines.join("\n");
  assert.match(body, /changes if: [\s\S]*?…/, "a paragraph-long flip condition is capped");
  assert.match(body, /2\. There is a follow-up/, "the options are still on screen");

  // The unfocused long price is capped; focusing it shows the whole thing.
  const cappedAt = lines.findIndex((line) => line.includes("unverified:"));
  assert.ok(lines[cappedAt + 1]?.includes("…") || lines[cappedAt]?.includes("…"));
  const focused = renderAskDialog(tabs, initialAskState(), { theme: PLAIN_THEME, width: 72 })
    .join("\n");
  const focusedLines = renderAskDialog(tabs, initialAskState(), {
    theme: PLAIN_THEME,
    width: 72,
  });
  assert.ok(
    focusedLines.length > lines.length + 3,
    "focusing the row shows the whole price the capped version elided",
  );
  assert.ok(focused.includes("unverified:"));
});

/** A theme that colours with real escape codes, the way pi's does. */
const ANSI_THEME = {
  fg: (color: string, text: string) => `\u001B[38;5;${color.length}m${text}\u001B[0m`,
  bg: (color: string, text: string) => `\u001B[48;5;${color.length}m${text}\u001B[0m`,
  bold: (text: string) => `\u001B[1m${text}\u001B[22m`,
};

test("a wrapped paragraph keeps its colour on every line", () => {
  // Styling first and wrapping after left the colour's opening escape on line one, so
  // continuation lines rendered in the terminal's default colour: a muted paragraph
  // turned white halfway through.
  const tagged = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
    bg: (color: string, text: string) => `<bg:${color}>${text}</>`,
    bold: (text: string) => `<b>${text}</>`,
  };
  const tabs = buildAskDialog([packet({
    question:
      "the integration suite has failed nine nights running and each retry costs eight minutes of CI, so is it worth retrying again or looking at the fixture?",
  })]);
  const lines = renderAskDialog(tabs, initialAskState(), { theme: tagged, width: 56 });

  const wrappedQuestion = lines.filter((line) => line.includes("<text>"));
  assert.ok(wrappedQuestion.length >= 2, "the question wrapped onto more than one line");

  for (const line of lines.filter((line) => line.trim() !== "")) {
    assert.match(
      line,
      /^\s*<[a-z:]+>/,
      `every line must carry its own colour, this one did not: ${line}`,
    );
    assert.ok(line.trimEnd().endsWith("</>"), `unterminated style: ${line}`);
  }
});

test("escape codes never count as width", () => {
  const long = packet({
    title: "finished: the read-only transcript-fidelity investigation is complete",
    options: [
      { id: "accept", label: "Accept as done", price: "unverified: the residual question needs the uniclient owner or a session replay" },
      { id: "follow", label: "There is a follow-up", price: "the session is resumed with your instruction" },
    ],
    recommendationId: "accept",
  });
  const strip = (line: string) => line.replace(/\u001B\[[0-9;]*m/g, "");
  for (const width of [40, 60, 84]) {
    const lines = renderAskDialog(buildAskDialog([long]), initialAskState(), {
      theme: ANSI_THEME,
      width,
    });
    for (const line of lines) {
      assert.ok(
        strip(line).length <= width,
        `"${strip(line)}" (${strip(line).length}) exceeds ${width}`,
      );
    }
  }
});

test("a word longer than the width is broken, not allowed to run over", () => {
  const tabs = buildAskDialog([packet({
    question: `see ${"x".repeat(90)} for the detail`,
  })]);
  const lines = renderAskDialog(tabs, initialAskState(), { theme: PLAIN_THEME, width: 40 });
  for (const line of lines) assert.ok(line.length <= 40, `${line.length} > 40`);
});
