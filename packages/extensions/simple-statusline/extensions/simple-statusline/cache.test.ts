import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeBreak,
  BREAK_MIN_PREV_PROMPT_TOKENS,
  BREAK_READ_FRACTION,
  buildCacheReport,
  collectTurnStats,
  computeSessionCacheStats,
  diffSnapshots,
  isCacheBreak,
  MIN_VISIBLE_PROMPT_TOKENS,
  snapshotPayload,
  TTL_LONG_MS,
  TTL_SHORT_MS,
  type FingerprintSnapshot,
  type SessionEntryLike,
  type SnapshotPair,
  type TurnCacheStats,
} from "./cache.ts";

function assistantEntry(args: {
  id?: string;
  timestamp?: number;
  input?: number;
  read?: number;
  write?: number;
  usage?: boolean;
}): SessionEntryLike {
  return {
    type: "message",
    id: args.id ?? "e1",
    message: {
      role: "assistant",
      timestamp: args.timestamp ?? 1_000,
      ...(args.usage === false
        ? {}
        : { usage: { input: args.input ?? 0, cacheRead: args.read ?? 0, cacheWrite: args.write ?? 0 } }),
    },
  };
}

function userEntry(): SessionEntryLike {
  return { type: "message", message: { role: "user" } };
}

function turn(args: Partial<TurnCacheStats> & { prompt?: number }): TurnCacheStats {
  const input = args.input ?? 0;
  const read = args.read ?? 0;
  const write = args.write ?? 0;
  const prompt = args.prompt ?? input + read + write;
  return {
    branchIndex: args.branchIndex ?? 0,
    turn: args.turn ?? 0,
    timestamp: args.timestamp ?? 0,
    input,
    read,
    write,
    prompt,
    rate: prompt > 0 ? read / prompt : 0,
  };
}

test("session cache rate is cumulative token-weighted read share of prompt tokens", () => {
  const stats = computeSessionCacheStats([
    userEntry(),
    assistantEntry({ input: 1000, read: 0, write: 9000 }),
    userEntry(),
    assistantEntry({ input: 500, read: 9500, write: 0 }),
  ]);
  // reads 9500 over prompt (1000+9000) + (500+9500) = 20000
  assert.equal(stats.totalPrompt, 20_000);
  assert.equal(stats.sessionRate, 9500 / 20_000);
  assert.equal(stats.turns.length, 2);
  assert.equal(stats.visible, true);
});

test("entries without usage or non-assistant roles are ignored", () => {
  const stats = computeSessionCacheStats([
    userEntry(),
    assistantEntry({ usage: false }),
    { type: "compaction" },
  ]);
  assert.equal(stats.turns.length, 0);
  assert.equal(stats.sessionRate, 0);
  assert.equal(stats.visible, false);
});

test("metric hidden below the minimum prompt-token threshold", () => {
  const stats = computeSessionCacheStats([assistantEntry({ input: 100, read: MIN_VISIBLE_PROMPT_TOKENS - 200 })]);
  assert.ok(stats.totalPrompt < MIN_VISIBLE_PROMPT_TOKENS);
  assert.equal(stats.visible, false);
});

test("metric hidden when the provider reports no cache fields (data-driven gating)", () => {
  const stats = computeSessionCacheStats([assistantEntry({ input: 50_000, read: 0, write: 0 })]);
  assert.equal(stats.visible, false);
});

test("zero-usage (aborted/errored) turns are excluded and never poison break detection", () => {
  // An aborted turn persists zero-initialized usage. It must not register as a
  // turn (no false break flag), and the next real turn's break baseline must be
  // the earlier real turn — so a genuine break right after an abort still flags.
  const stats = computeSessionCacheStats([
    assistantEntry({ id: "a1", timestamp: 1_000, input: 2_000, write: 18_000 }),
    assistantEntry({ id: "aborted", timestamp: 1_500, input: 0, read: 0, write: 0 }),
    assistantEntry({ id: "a2", timestamp: 2_000, input: 20_000, read: 100, write: 0 }),
  ]);
  assert.equal(stats.turns.length, 2, "zero-prompt turn excluded");
  assert.equal(stats.latestBreak, true, "real break still detected across the aborted turn");

  const abortedLatest = computeSessionCacheStats([
    assistantEntry({ id: "a1", timestamp: 1_000, input: 2_000, write: 18_000 }),
    assistantEntry({ id: "aborted", timestamp: 1_500, input: 0, read: 0, write: 0 }),
  ]);
  assert.equal(abortedLatest.latestBreak, false, "aborted turn itself never flags a break");
});

test("first assistant turn is never a break", () => {
  assert.equal(isCacheBreak(undefined, turn({ input: 50_000, read: 0 })), false);
  const stats = computeSessionCacheStats([assistantEntry({ input: 50_000, read: 0, write: 1 })]);
  assert.equal(stats.latestBreak, false);
});

test("break detection threshold boundaries", () => {
  const prev = turn({ prompt: BREAK_MIN_PREV_PROMPT_TOKENS, read: 0 });
  const exactlyHalf = turn({ read: BREAK_MIN_PREV_PROMPT_TOKENS * BREAK_READ_FRACTION, input: 1 });
  const justBelow = turn({ read: BREAK_MIN_PREV_PROMPT_TOKENS * BREAK_READ_FRACTION - 1, input: 1 });
  assert.equal(isCacheBreak(prev, exactlyHalf), false, "reading exactly the fraction is not a break");
  assert.equal(isCacheBreak(prev, justBelow), true, "reading below the fraction is a break");

  const smallPrev = turn({ prompt: BREAK_MIN_PREV_PROMPT_TOKENS - 1, read: 0 });
  assert.equal(isCacheBreak(smallPrev, turn({ read: 0, input: 1 })), false, "small previous prompt never flags");
});

test("attribution: compaction, model change, and branch nav from entries between turns", () => {
  const prev = turn({ timestamp: 0, prompt: 20_000 });
  const current = turn({ timestamp: 1_000, read: 0, input: 20_000 });
  const causes = attributeBreak({
    entriesBetween: [{ type: "compaction" }, { type: "model_change", modelId: "gpt-x" }, { type: "branch_summary" }],
    prev,
    current,
  });
  assert.deepEqual(
    causes.map((cause) => cause.kind),
    ["compaction", "model_change", "branch_nav"],
  );
  const modelCause = causes[1]!;
  assert.ok(modelCause.kind === "model_change" && modelCause.modelId === "gpt-x");
});

test("attribution: TTL expiry from idle gap, respecting long retention", () => {
  const prev = turn({ timestamp: 0, prompt: 20_000 });
  const current = turn({ timestamp: TTL_SHORT_MS + 1, read: 0, input: 20_000 });
  const shortCauses = attributeBreak({ entriesBetween: [], prev, current });
  assert.equal(shortCauses[0]!.kind, "ttl_expiry");

  const longCauses = attributeBreak({ entriesBetween: [], prev, current, longRetention: true });
  assert.equal(longCauses[0]!.kind, "prefix_change", "gap below long TTL is not expiry under long retention");

  const longGap = turn({ timestamp: TTL_LONG_MS + 1, read: 0, input: 20_000 });
  assert.equal(attributeBreak({ entriesBetween: [], prev, current: longGap, longRetention: true })[0]!.kind, "ttl_expiry");
});

test("attribution falls back to prefix_change with the fingerprint divergence attached", () => {
  const prev = turn({ timestamp: 0, prompt: 20_000 });
  const current = turn({ timestamp: 1, read: 0, input: 20_000 });
  const causes = attributeBreak({ entriesBetween: [], prev, current, divergence: { kind: "message", index: 3 } });
  assert.deepEqual(causes, [{ kind: "prefix_change", divergence: { kind: "message", index: 3 } }]);
});

test("snapshotPayload handles anthropic, completions, responses, and google payload shapes", () => {
  const anthropic = snapshotPayload({ system: "sys", tools: [{ name: "a" }], messages: [{ role: "user" }] });
  assert.ok(anthropic.systemHash && anthropic.toolsHash);
  assert.equal(anthropic.messageHashes.length, 1);
  assert.equal(anthropic.recognized, true);

  const responses = snapshotPayload({ instructions: "sys", input: [{ role: "user" }, { role: "assistant" }] });
  assert.ok(responses.systemHash);
  assert.equal(responses.toolsHash, undefined);
  assert.equal(responses.messageHashes.length, 2);
  assert.equal(responses.recognized, true);

  const google = snapshotPayload({
    model: "gemini",
    contents: [{ role: "user" }, { role: "model" }],
    config: { systemInstruction: "sys", tools: [{ functionDeclarations: [] }] },
  });
  assert.ok(google.systemHash && google.toolsHash);
  assert.equal(google.messageHashes.length, 2);
  assert.equal(google.recognized, true);

  const empty = snapshotPayload(undefined);
  assert.deepEqual(empty.messageHashes, []);
  assert.equal(empty.recognized, false);
});

test("snapshotPayload retains only fixed-size hashes, never payload content", () => {
  const SECRET = "TOP-SECRET-CONTENT";
  const snapshot = snapshotPayload({ system: SECRET, tools: [{ name: SECRET }], messages: [{ content: SECRET }] });
  assert.match(snapshot.systemHash!, /^[0-9a-f]{16}$/);
  assert.match(snapshot.toolsHash!, /^[0-9a-f]{16}$/);
  assert.equal(snapshot.messageHashes.length, 1);
  for (const hash of snapshot.messageHashes) assert.match(hash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(snapshot).includes(SECRET), "raw content must never be retained in the snapshot");
});

test("messageTimestamp falls back to the entry ISO timestamp, then 0", () => {
  const iso = "2026-07-06T10:00:00.000Z";
  const stats = collectTurnStats([
    { type: "message", timestamp: iso, message: { role: "assistant", usage: { input: 1 } } },
    { type: "message", message: { role: "assistant", usage: { input: 1 } } },
  ]);
  assert.equal(stats[0]!.timestamp, Date.parse(iso));
  assert.equal(stats[1]!.timestamp, 0);
});

test("moving anthropic cache_control markers and content-shape churn do not change fingerprints", () => {
  // Anthropic attaches cache_control to the LAST user message/tool of every
  // request (and may restructure string content into a text-block array), so
  // consecutive requests differ at the marker's host even when nothing real
  // changed. Canonicalization must make such pairs diff as a clean prefix.
  const prev = snapshotPayload({
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "a" }, { name: "b", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
  });
  const curr = snapshotPayload({
    system: [{ type: "text", text: "sys" }],
    tools: [{ name: "a" }, { name: "b" }],
    messages: [
      { role: "user", content: "hi" }, // marker moved on; string vs block form
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
      { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] },
    ],
  });
  assert.deepEqual(diffSnapshots(prev, curr), { kind: "none" });
});

test("bedrock toolConfig changes are fingerprinted as tool-set divergence", () => {
  const prev = snapshotPayload({
    system: "s",
    messages: [{ role: "user", content: [{ text: "hi" }] }],
    toolConfig: { tools: [{ toolSpec: { name: "a" } }] },
  });
  const curr = snapshotPayload({
    system: "s",
    messages: [{ role: "user", content: [{ text: "hi" }] }],
    toolConfig: { tools: [{ toolSpec: { name: "a" } }, { toolSpec: { name: "b" } }] },
  });
  assert.ok(prev.toolsHash && curr.toolsHash, "bedrock toolConfig is hashed");
  assert.deepEqual(diffSnapshots(prev, curr), { kind: "tools" });
});

test("bedrock cachePoint content blocks are ignored in fingerprints", () => {
  const prev = snapshotPayload({
    system: "s",
    messages: [{ role: "user", content: [{ text: "hi" }, { cachePoint: { type: "default" } }] }],
  });
  const curr = snapshotPayload({
    system: "s",
    messages: [
      { role: "user", content: [{ text: "hi" }] },
      { role: "user", content: [{ text: "more" }, { cachePoint: { type: "default" } }] },
    ],
  });
  assert.deepEqual(diffSnapshots(prev, curr), { kind: "none" });
});

test("unrecognized payload shapes never diff as identical", () => {
  const unknownA = snapshotPayload({ some: "proprietary", shape: 1 });
  const unknownB = snapshotPayload({ some: "proprietary", shape: 2 });
  assert.equal(unknownA.recognized, false);
  assert.deepEqual(diffSnapshots(unknownA, unknownB), { kind: "unrecognized_payload" });

  const known = snapshotPayload({ system: "sys", messages: [] });
  assert.deepEqual(diffSnapshots(unknownA, known), { kind: "unrecognized_payload" });
});

test("diffSnapshots names the first divergence", () => {
  const base = snapshotPayload({ system: "sys", tools: ["t"], messages: [{ a: 1 }, { b: 2 }] });
  const grown = snapshotPayload({ system: "sys", tools: ["t"], messages: [{ a: 1 }, { b: 2 }, { c: 3 }] });
  assert.deepEqual(diffSnapshots(base, grown), { kind: "none" }, "prefix-extension is not a divergence");

  assert.deepEqual(diffSnapshots(base, snapshotPayload({ system: "other", tools: ["t"], messages: [{ a: 1 }, { b: 2 }] })), {
    kind: "system_prompt",
  });
  assert.deepEqual(diffSnapshots(base, snapshotPayload({ system: "sys", tools: ["u"], messages: [{ a: 1 }, { b: 2 }] })), {
    kind: "tools",
  });
  assert.deepEqual(
    diffSnapshots(base, snapshotPayload({ system: "sys", tools: ["t"], messages: [{ a: 1 }, { b: 999 }, { c: 3 }] })),
    { kind: "message", index: 1 },
  );
  assert.deepEqual(diffSnapshots(base, snapshotPayload({ system: "sys", tools: ["t"], messages: [{ a: 1 }] })), {
    kind: "history_shrunk",
    from: 2,
    to: 1,
  });
});

test("buildCacheReport: per-turn rows, break attribution, and fingerprint coverage note", () => {
  const branch: SessionEntryLike[] = [
    userEntry(),
    assistantEntry({ id: "a1", timestamp: 1_000, input: 2_000, write: 18_000 }),
    { type: "compaction" },
    assistantEntry({ id: "a2", timestamp: 2_000, input: 5_000, read: 1_000, write: 4_000 }),
  ];
  const before: FingerprintSnapshot = snapshotPayload({ system: "s", messages: [{ a: 1 }] });
  const after: FingerprintSnapshot = snapshotPayload({ system: "s2", messages: [{ a: 1 }] });
  const snapshots = new Map<number, SnapshotPair>([[2_000, { prev: before, curr: after }]]);

  const report = buildCacheReport({ branch, snapshots });
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0]!.isBreak, false);
  assert.equal(report.rows[1]!.isBreak, true);
  // compaction wins as the entry-correlated cause
  assert.equal(report.rows[1]!.causes[0]!.kind, "compaction");
  assert.equal(report.rows[1]!.fingerprinted, true);

  const text = report.lines.map((line) => line.text).join("\n");
  assert.match(text, /Session cache rate: \d+%/);
  assert.match(text, /#1/);
  assert.match(text, /#2/);
  assert.match(text, /BREAK/);
  assert.match(text, /compaction rewrote the context/);
  assert.match(text, /fingerprints cover 1\/2 turns/i);
  // Tone travels with the data: break rows are warnings, cause lines are muted.
  assert.equal(report.lines.find((line) => /BREAK/.test(line.text))?.tone, "warning");
  assert.equal(report.lines.find((line) => /compaction rewrote/.test(line.text))?.tone, "muted");
});

test("buildCacheReport labels turns without snapshots as entry-correlation only", () => {
  const branch: SessionEntryLike[] = [
    assistantEntry({ id: "a1", timestamp: 1_000, input: 2_000, write: 18_000 }),
    assistantEntry({ id: "a2", timestamp: 2_000, input: 20_000, read: 100, write: 0 }),
  ];
  const report = buildCacheReport({ branch });
  assert.equal(report.rows[1]!.isBreak, true);
  assert.equal(report.rows[1]!.fingerprinted, false);
  const text = report.lines.map((line) => line.text).join("\n");
  assert.match(text, /no fingerprint retained for this turn/);
});

test("buildCacheReport labels the first in-process request as having no diff baseline", () => {
  const branch: SessionEntryLike[] = [
    assistantEntry({ id: "a1", timestamp: 1_000, input: 2_000, write: 18_000 }),
    assistantEntry({ id: "a2", timestamp: 2_000, input: 20_000, read: 100, write: 0 }),
  ];
  // The breaking turn was observed in-process, but it was the first request seen
  // (prev === undefined), so there is nothing to diff against yet.
  const snapshots = new Map<number, SnapshotPair>([
    [2_000, { curr: snapshotPayload({ system: "s", messages: [{ a: 1 }] }) }],
  ]);
  const report = buildCacheReport({ branch, snapshots });
  assert.equal(report.rows[1]!.isBreak, true);
  assert.equal(report.rows[1]!.fingerprinted, false, "no baseline means no diffable fingerprint");
  const text = report.lines.map((line) => line.text).join("\n");
  assert.match(text, /first request observed in this process — no earlier request to diff against/);
  assert.doesNotMatch(text, /no fingerprint retained for this turn/);
});

test("buildCacheReport labels unrecognized payload pairs instead of claiming an identical prefix", () => {
  const branch: SessionEntryLike[] = [
    assistantEntry({ id: "a1", timestamp: 1_000, input: 2_000, write: 18_000 }),
    assistantEntry({ id: "a2", timestamp: 2_000, input: 20_000, read: 100, write: 0 }),
  ];
  const snapshots = new Map<number, SnapshotPair>([
    [2_000, { prev: snapshotPayload({ unknown: 1 }), curr: snapshotPayload({ unknown: 2 }) }],
  ]);
  const report = buildCacheReport({ branch, snapshots });
  const text = report.lines.map((line) => line.text).join("\n");
  assert.match(text, /request shape not recognized for fingerprinting/);
  assert.doesNotMatch(text, /prefix looks identical/);
});

test("buildCacheReport on an empty branch", () => {
  const report = buildCacheReport({ branch: [] });
  assert.equal(report.rows.length, 0);
  assert.match(report.lines[0]!.text, /No assistant turns/);
});
