import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  accumulateEntry,
  combine,
  COST_RECORD_TYPE,
  createAccumulator,
  deriveChildSessionDir,
  deriveSidecarRoot,
  isAbsence,
  listSidecarSessionFiles,
  MAX_SIDECAR_DEPTH,
  PRICE_TIER_RECORD_TYPE,
  readSessionHeader,
  SessionTreeScanner,
  summarize,
} from "./session-cost.ts";
import { analyzeSessionTree } from "./cost-report.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

let roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-cost-"));
  roots.push(dir);
  return dir;
}

test.afterEach(() => {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  roots = [];
});

function usage(cost: number, tokens = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }) {
  return {
    ...tokens,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

let entrySeq = 0;
function assistant(cost: number, model = "gpt-test", provider = "openai") {
  entrySeq += 1;
  return { type: "message", id: `e${entrySeq}`, message: { role: "assistant", provider, model, usage: usage(cost), timestamp: entrySeq } };
}
function toolResult(cost: number) {
  entrySeq += 1;
  return { type: "message", id: `e${entrySeq}`, message: { role: "toolResult", toolName: "advisor_consult", usage: usage(cost) } };
}
function compaction(cost: number) {
  entrySeq += 1;
  return { type: "compaction", id: `e${entrySeq}`, usage: usage(cost) };
}
function branchSummary(cost: number) {
  entrySeq += 1;
  return { type: "branch_summary", id: `e${entrySeq}`, usage: usage(cost) };
}
// Cost records and tier records are context-excluded custom entries, the shape
// pi.appendEntry() writes: { type: "custom", customType, data }.
function costRecord(cost: number, recordId: string, key = "keepalive") {
  entrySeq += 1;
  return { type: "custom", id: `e${entrySeq}`, customType: COST_RECORD_TYPE, data: { recordId, key, usage: usage(cost) } };
}
function tierRecord(tier: "priority" | "standard", multiplier?: number) {
  entrySeq += 1;
  return {
    type: "custom",
    id: `e${entrySeq}`,
    customType: PRICE_TIER_RECORD_TYPE,
    data: multiplier === undefined ? { tier } : { tier, multiplier },
  };
}

/** Write a session file with a header plus entries. */
function writeSession(path: string, opts: { id: string; parentSession?: string; entries?: unknown[] }): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const header = { type: "session", version: 3, id: opts.id, timestamp: new Date().toISOString(), cwd: "/tmp/project", ...(opts.parentSession ? { parentSession: opts.parentSession } : {}) };
  const lines = [JSON.stringify(header), ...(opts.entries ?? []).map((e) => JSON.stringify(e))];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

// ── Pi's accounting rules (AC-1.2) ───────────────────────────────────────────

test("all four of Pi's usage sources are counted, over every entry", () => {
  const acc = createAccumulator();
  for (const entry of [assistant(1), toolResult(2), compaction(0.5), branchSummary(0.25)]) accumulateEntry(acc, entry);
  const summary = summarize(acc, { kind: "own" });
  assert.equal(summary.cost, 3.75);
  // Pi buckets tool/compaction/branch usage together and assistant usage per model.
  assert.deepEqual(
    summary.models.map((m) => m.key).sort(),
    ["Tools/summaries", "openai/gpt-test"],
  );
});

test("non-billed entries and unknown types contribute nothing", () => {
  const acc = createAccumulator();
  for (const entry of [{ type: "message", id: "u1", message: { role: "user", content: "hi" } }, { type: "message", id: "t1", message: { role: "toolResult", toolName: "read" } }, { type: "session_info", name: "x" }, undefined, null, 7]) {
    accumulateEntry(acc, entry as any);
  }
  assert.equal(summarize(acc, { kind: "own" }).cost, 0);
});

test("responseModel wins over model for the bucket key, as Pi does", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, { type: "message", id: "a1", message: { role: "assistant", provider: "openai", model: "alias", responseModel: "real-model", usage: usage(1) } });
  assert.equal(summarize(acc, { kind: "own" }).models[0]?.key, "openai/real-model");
});

// ── exactly-once counting (INV-G5) ───────────────────────────────────────────

test("re-folding the same entries does not inflate the total", () => {
  const acc = createAccumulator();
  const entries = [assistant(1), toolResult(1)];
  for (const entry of entries) accumulateEntry(acc, entry);
  for (const entry of entries) accumulateEntry(acc, entry);
  assert.equal(summarize(acc, { kind: "own" }).cost, 2);
});

test("a duplicated cost-record id counts once", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, costRecord(0.5, "ping-1"));
  const duplicate = costRecord(0.5, "ping-1");
  accumulateEntry(acc, duplicate);
  assert.equal(summarize(acc, { kind: "own" }).cost, 0.5);
});

test("a child reachable by BOTH the sidecar convention and a parentSession header counts once", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  // Same file, reachable via the sidecar dir; its header also points at the parent id.
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", parentSession: "p1", entries: [assistant(2)] });
  const scanner = new SessionTreeScanner();
  const found = scanner.discover(parent, "p1");
  assert.equal(found.length, 1, "one child, not two");
  const tree = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 2);
});

test("re-scanning a tree does not inflate the total", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(1.5)] });
  const scanner = new SessionTreeScanner();
  const first = scanner.scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
  const second = scanner.scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
  assert.equal(first.totalCost, 2.5);
  assert.equal(second.totalCost, 2.5);
});

test("tool-result usage for a child session's work is not double counted", () => {
  // A tool that spawns a child session and ALSO reports usage would be counted twice;
  // the tool result carries the child's session id so the scan can drop one side.
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  writeSession(join(deriveChildSessionDir(parent, "advisor"), "child.jsonl"), { id: "c9", entries: [assistant(3)] });
  const scanner = new SessionTreeScanner();
  const tree = scanner.scanTree({
    ownEntries: [
      { type: "message", id: "tr1", message: { role: "toolResult", toolName: "advisor_consult", usage: usage(3), details: { childSessionId: "c9" } } },
    ],
    sessionFile: parent,
    sessionId: "p1",
  });
  assert.equal(tree.totalCost, 3, "the child session's cost is counted once, not once per surface");
});

// ── discovery across both header forms and depth (AC-1.1) ────────────────────

test("discovery follows the sidecar convention, parentSession as id, and parentSession as path", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "a.jsonl"), { id: "a", entries: [assistant(1)] });
  writeSession(join(root, "by-id.jsonl"), { id: "b", parentSession: "p1", entries: [assistant(2)] });
  writeSession(join(root, "by-path.jsonl"), { id: "c", parentSession: parent, entries: [assistant(4)] });
  const tree = new SessionTreeScanner().scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 7);
  assert.equal(tree.descendants.length, 3);
});

test("grandchildren at depth are counted", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const child = writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(1)] });
  writeSession(join(deriveChildSessionDir(child, "tasks"), "grand.jsonl"), { id: "g1", entries: [assistant(2)] });
  writeSession(join(deriveChildSessionDir(child, "advisor"), "great.jsonl"), { id: "g2", entries: [assistant(4)] });
  const tree = new SessionTreeScanner().scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 7);
});

test("a self-referential or cyclic parent link cannot loop forever", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", parentSession: "p1" });
  const a = writeSession(join(root, "a.jsonl"), { id: "a", parentSession: "p1", entries: [assistant(1)] });
  writeSession(join(root, "b.jsonl"), { id: "b", parentSession: "a", entries: [assistant(1)] });
  // b's header points at a, and a duplicate header id must not re-admit the parent.
  writeSession(join(deriveChildSessionDir(a, "tasks"), "dupe.jsonl"), { id: "p1", entries: [assistant(99)] });
  const tree = new SessionTreeScanner().scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 2, "the duplicate-id file and the self link are both rejected");
});

test("sidecar layout matches the convention pi-subagents already writes", () => {
  const parent = "/s/--proj--/2026-07-28T08-04-15-096Z_019fa7c0.jsonl";
  assert.equal(deriveSidecarRoot(parent), "/s/--proj--/2026-07-28T08-04-15-096Z_019fa7c0");
  assert.equal(deriveChildSessionDir(parent, "tasks"), "/s/--proj--/2026-07-28T08-04-15-096Z_019fa7c0/tasks");
});

// ── caching and growth (AC-1.4) ─────────────────────────────────────────────

test("an unchanged file is not re-read, and a grown file is read only from its previous end", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const child = writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(1)] });
  const scanner = new SessionTreeScanner();

  const first = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(first.totalCost, 1);
  assert.ok(scanner.stats.filesRead >= 1, "first scan reads the child");

  const second = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(second.totalCost, 1);
  assert.equal(scanner.stats.filesRead, 0, "unchanged files are not re-read");

  appendFileSync(child, `${JSON.stringify(assistant(2))}\n`);
  const third = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(third.totalCost, 3, "appended spend is picked up");
  assert.equal(scanner.stats.filesRead, 1, "only the grown file is read");
});

test("a half-written trailing line is folded once the rest arrives", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const child = writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(1)] });
  const scanner = new SessionTreeScanner();
  scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });

  const full = `${JSON.stringify(assistant(5))}\n`;
  appendFileSync(child, full.slice(0, 20));
  const torn = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(torn.totalCost, 1, "a torn line contributes nothing yet");
  appendFileSync(child, full.slice(20));
  const complete = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(complete.totalCost, 6, "the completed line is folded exactly once");
});

test("render-sized trees scan within a bounded time and stay free on repeat", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const dir = deriveChildSessionDir(parent, "tasks");
  for (let i = 0; i < 60; i += 1) {
    const entries = Array.from({ length: 40 }, () => assistant(0.01));
    writeSession(join(dir, `child-${i}.jsonl`), { id: `c${i}`, entries });
  }
  const scanner = new SessionTreeScanner();
  const startCold = process.hrtime.bigint();
  const cold = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  const coldMs = Number(process.hrtime.bigint() - startCold) / 1e6;
  assert.equal(cold.descendants.length, 60);
  assert.ok(Math.abs(cold.totalCost - 24) < 1e-6, `expected 24, got ${cold.totalCost}`);
  assert.ok(coldMs < 2_000, `cold scan of 60 children took ${coldMs.toFixed(0)}ms`);

  const startWarm = process.hrtime.bigint();
  const warm = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  const warmMs = Number(process.hrtime.bigint() - startWarm) / 1e6;
  assert.ok(Math.abs(warm.totalCost - 24) < 1e-6);
  assert.equal(scanner.stats.filesRead, 0, "warm scan reads no file bytes");
  assert.ok(warmMs < 250, `warm scan took ${warmMs.toFixed(0)}ms`);
});

// ── failure degradation (INV-G12) ───────────────────────────────────────────

test("a missing sidecar directory yields the parent's own cost, not an error", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const tree = new SessionTreeScanner().scanTree({ ownEntries: [assistant(2)], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 2);
  assert.equal(tree.descendants.length, 0);
  // The common case by far: most sessions spawn nothing, so an absent sidecar directory
  // must stay exact. A `~` here would follow nearly every session that never spawned.
  assert.equal(tree.approximate, false, "nothing is missing when there was never anything there");
  assert.equal(tree.unreadableSessions, 0);
});

test("a sidecar directory that exists but cannot be listed discloses the sessions it hides", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const dir = deriveChildSessionDir(parent, "tasks");
  writeSession(join(dir, "child.jsonl"), { id: "c1", entries: [assistant(9)] });
  chmodSync(dir, 0o000);
  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const tree = new SessionTreeScanner().scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
    // The $9 below this directory is invisible to the walk. Reporting $1 as exact is the
    // failure the disclosure exists to prevent.
    assert.equal(tree.totalCost, 1, "what is readable still totals");
    assert.ok(tree.approximate, "a directory that hides sessions makes the total a floor");
    assert.equal(tree.unreadableSessions, 1, "one hidden part, counted once");
    assert.match(tree.approximateReasons.join(" "), /could not be read/);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("a session directory that cannot be listed discloses the forks it could not look for", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(2)] });
  // Execute but not read: a known path inside still opens, while listing fails. That is
  // the fork search alone failing — forks are siblings of the parent file, found only by
  // enumerating this directory — with the sidecar walk below it untouched.
  chmodSync(root, 0o111);
  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const tree = new SessionTreeScanner().scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
    assert.equal(tree.totalCost, 3, "the sidecar child is still found and counted");
    assert.ok(tree.approximate, "but any fork of this session went unlooked-for");
    assert.equal(tree.unreadableSessions, 1);
    assert.match(tree.approximateReasons.join(" "), /could not be read/);
  } finally {
    chmodSync(root, 0o700);
  }
});

test("an empty sibling file is not mistaken for spend that could not be read", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  // Reported as a gap, this would put a permanent floor marker on an exact total — the
  // disclosure failing in the other direction, and just as misleading.
  writeFileSync(join(root, "empty.jsonl"), "");
  const tree = new SessionTreeScanner().scanTree({ ownEntries: [assistant(2)], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 2);
  assert.equal(tree.approximate, false, "nothing is missing from a file with nothing in it");
  assert.equal(tree.unreadableSessions, 0);
});

test("spend already counted for a child does not vanish when its file stops being readable", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const dir = deriveChildSessionDir(parent, "tasks");
  writeSession(join(dir, "child.jsonl"), { id: "c1", entries: [assistant(9)] });

  const scanner = new SessionTreeScanner();
  const first = scanner.scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
  assert.equal(first.totalCost, 10);

  // Readable but not traversable: the file is still listed, so it is still discovered,
  // and stat-ing it fails. Its $9 was billed and already shown to the user.
  chmodSync(dir, 0o444);
  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const second = scanner.scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
    assert.equal(second.totalCost, 10, "a total the user has seen does not quietly shrink");
    assert.ok(second.approximate, "and the file may have grown out of sight, so it is a floor");
    assert.match(second.approximateReasons.join(" "), /could not be read/);
  } finally {
    chmodSync(dir, 0o700);
  }

  // Restored: same total, counted once, and exact again.
  const third = scanner.scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
  assert.equal(third.totalCost, 10, "no double counting after the file comes back");
  assert.equal(third.approximate, false);
});

test("a child that cannot be stat-ed on the very first scan discloses the spend it may hide", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const dir = deriveChildSessionDir(parent, "tasks");
  writeSession(join(dir, "child.jsonl"), { id: "c1", entries: [assistant(9)] });
  // Listable but not traversable: the child is discovered, and nothing about it can be
  // read. Nothing was folded before, so there is no cached total to fall back on — the
  // whole $9 is invisible, which is exactly when a confident-looking figure does harm.
  chmodSync(dir, 0o444);
  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const tree = new SessionTreeScanner().scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
    assert.equal(tree.totalCost, 1);
    assert.ok(tree.approximate, "a child that could not be read at all is still a gap");
    assert.equal(tree.unreadableSessions, 1, "one unreadable child, counted once");
    assert.match(tree.approximateReasons.join(" "), /could not be read/);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("a deleted child leaves the tree, rather than lingering as spend nothing can confirm", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const child = join(deriveChildSessionDir(parent, "tasks"), "child.jsonl");
  writeSession(child, { id: "c1", entries: [assistant(9)] });

  const scanner = new SessionTreeScanner();
  assert.equal(scanner.scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" }).totalCost, 10);

  // Deleting the file removes it from the tree the scan describes, which is what the
  // README's retention section has always said. Nothing is hidden — the path is gone, not
  // unreadable — so the smaller figure is exact rather than a floor.
  rmSync(child);
  const after = scanner.scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
  assert.equal(after.totalCost, 1);
  assert.equal(after.descendants.length, 0);
  assert.equal(after.approximate, false);
  assert.equal(after.unreadableSessions, 0);
});

test("an unreadable parent header read from disk is one gap, not two", () => {
  // Without own entries the parent is scanned as well, and that read reports the same
  // failure. Counting the header read too would inflate the number of missing parts.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: [assistant(4)] });
  chmodSync(parent, 0o000);
  try {
    const tree = new SessionTreeScanner().scanTree({ sessionFile: parent, sessionId: "p1" });
    assert.equal(tree.unreadableSessions, 1, "one unreadable file, one gap");
    assert.ok(tree.approximate);
  } finally {
    chmodSync(parent, 0o600);
  }
});

test("corrupt entries in different sessions add up across the tree", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: [assistant(1)] });
  appendFileSync(parent, "{not json\n");
  const child = join(deriveChildSessionDir(parent, "tasks"), "child.jsonl");
  writeSession(child, { id: "c1", entries: [assistant(2)] });
  appendFileSync(child, "{also not json\n");

  // One from the parent's own file, one from a child: the tree total has to sum both, not
  // report whichever it looked at last.
  const tree = new SessionTreeScanner().scanTree({ sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 3);
  assert.equal(tree.corruptEntries, 2);
  assert.match(tree.approximateReasons.join(" "), /2 session entries could not be parsed/);
});

test("absence and unreadability are told apart by error code, not by guesswork", () => {
  // The permission-based tests above stage this through the filesystem, and skip when the
  // process can read anything (root). This pins the decision itself, so the classification
  // every disclosure depends on is covered even where mode bits do not bite.
  for (const code of ["ENOENT", "ENOTDIR"]) {
    assert.equal(isAbsence(Object.assign(new Error(code), { code })), true, `${code} means nothing is there`);
  }
  for (const code of ["EACCES", "EPERM", "EIO", "ELOOP", "ENAMETOOLONG", "EMFILE"]) {
    assert.equal(isAbsence(Object.assign(new Error(code), { code })), false, `${code} means something is there, unread`);
  }
  // A thrown value with no usable code cannot claim absence — the safe read is a gap.
  assert.equal(isAbsence(new SyntaxError("Unexpected token")), false);
  assert.equal(isAbsence({ code: 13 }), false, "a numeric errno is not one of the names");
  assert.equal(isAbsence(undefined), false);
  assert.equal(isAbsence("ENOENT"), false, "a bare string is not a filesystem error");
});

test("a corrupt line in the parent's own file is disclosed too, not just in children", () => {
  // The live footer folds the parent from memory, but post-hoc analysis reads it from
  // disk, where the same torn line can appear.
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: [assistant(2)] });
  appendFileSync(parent, "{\"type\":\"mess\n");
  const tree = new SessionTreeScanner().scanTree({ sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 2);
  assert.equal(tree.corruptEntries, 1);
  assert.ok(tree.approximate);
});

test("an in-memory parent with no session file still reports its own cost", () => {
  const tree = new SessionTreeScanner().scanTree({ ownEntries: [assistant(1.25)] });
  assert.equal(tree.totalCost, 1.25);
});

test("an unreadable child is skipped, the rest still totals, and the gap is disclosed", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const dir = deriveChildSessionDir(parent, "tasks");
  writeSession(join(dir, "ok.jsonl"), { id: "ok", entries: [assistant(1)] });
  const locked = writeSession(join(dir, "locked.jsonl"), { id: "locked", entries: [assistant(9)] });
  chmodSync(locked, 0o000);
  try {
    // Running as root defeats the permission bit, so the scenario cannot be staged.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const tree = new SessionTreeScanner().scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
    assert.equal(tree.totalCost, 1, "readable spend still totals");
    // The missing $9 must not hide behind a confident-looking number.
    assert.ok(tree.approximate, "an unreadable file makes the total a floor, not an exact figure");
    assert.equal(tree.unreadableSessions, 1);
    assert.match(tree.approximateReasons.join(" "), /could not be read/);
  } finally {
    chmodSync(locked, 0o600);
  }
});

test("a corrupt line is skipped without losing the rest of the file, and the skip is disclosed", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const child = join(deriveChildSessionDir(parent, "tasks"), "child.jsonl");
  writeSession(child, { id: "c1", entries: [assistant(1)] });
  appendFileSync(child, "{not json\n");
  appendFileSync(child, `${JSON.stringify(assistant(2))}\n`);
  const tree = new SessionTreeScanner().scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 3, "entries on both sides of the bad line still fold");
  // Whatever that line was billed is gone from the total: pi writes one entry per append,
  // so a torn write merges with the next entry and takes its cost down too.
  assert.ok(tree.approximate, "a line that could not be parsed makes the total a floor");
  assert.equal(tree.corruptEntries, 1);
  assert.match(tree.approximateReasons.join(" "), /1 session entry could not be parsed, so that spend is missing/);
  // Distinct from an unreadable file: nothing here was unreachable, one entry was unreadable.
  assert.equal(tree.unreadableSessions, 0);

  // Two of them read as two, in the same wording.
  appendFileSync(child, "{also not json\n");
  const again = new SessionTreeScanner().scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(again.corruptEntries, 2);
  assert.match(again.approximateReasons.join(" "), /2 session entries could not be parsed, so that spend is missing/);
});

test("a corrupt line keeps the total marked on every later scan, since its spend never returns", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const child = join(deriveChildSessionDir(parent, "tasks"), "child.jsonl");
  writeSession(child, { id: "c1", entries: [assistant(1)] });
  appendFileSync(child, "{not json\n");

  const scanner = new SessionTreeScanner();
  const first = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(first.corruptEntries, 1);

  // The bad line's bytes are behind the cached offset now, so nothing re-reads them. A
  // per-scan counter would have forgotten the gap here and gone back to reading exact.
  const second = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(scanner.stats.filesRead, 0, "the unchanged file is not re-read");
  assert.ok(second.approximate, "the gap outlives the read that found it");
  assert.equal(second.corruptEntries, 1, "and is not counted again per scan");

  // A later good append still folds, and does not disturb the latched count.
  appendFileSync(child, `${JSON.stringify(assistant(2))}\n`);
  const third = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(third.totalCost, 3);
  assert.equal(third.corruptEntries, 1);
});

test("blank lines and header lines are not mistaken for corruption", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const child = join(deriveChildSessionDir(parent, "tasks"), "child.jsonl");
  writeSession(child, { id: "c1", entries: [assistant(1)] });
  appendFileSync(child, "\n   \n");
  appendFileSync(child, `${JSON.stringify(assistant(2))}\n`);
  const tree = new SessionTreeScanner().scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 3);
  assert.equal(tree.corruptEntries, 0);
  assert.equal(tree.approximate, false, "ordinary whitespace is not a missing entry");
});

test("a header-less or unreadable file yields no header rather than throwing", () => {
  const root = tempRoot();
  // The three ways a candidate is not a session of this tree: readable and not a header, an
  // unparseable first line, and nothing at that path at all. None of them is a failed read
  // of a session's spend, so none of them marks a total.
  const notASession = join(root, "other.jsonl");
  writeFileSync(notASession, `${JSON.stringify({ type: "message", id: "x" })}\n`);
  assert.equal(readSessionHeader(notASession), undefined);
  const torn = join(root, "torn.jsonl");
  writeFileSync(torn, '{"type":"sess\n');
  assert.equal(readSessionHeader(torn), undefined);
  assert.equal(readSessionHeader(join(root, "missing.jsonl")), undefined);
});

test("priority-tier turns are marked approximate when no multiplier is configured", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, tierRecord("priority"));
  accumulateEntry(acc, assistant(1));
  const tree = combine(summarize(acc, { kind: "own" }), []);
  assert.equal(tree.totalCost, 1);
  assert.ok(tree.approximate, "an uncorrected priority premium makes the total approximate");
  assert.equal(tree.uncorrectedPriorityCost, 1);
  assert.match(tree.approximateReasons.join(" "), /priority-tier/);
});

test("a configured multiplier prices priority turns exactly, and the marker clears", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, tierRecord("priority"), { priorityMultiplier: 2 });
  accumulateEntry(acc, assistant(1), { priorityMultiplier: 2 });
  const tree = combine(summarize(acc, { kind: "own" }), []);
  assert.equal(tree.totalCost, 2);
  assert.equal(tree.approximate, false);
});

test("toggling the tier mid-session prices each turn by the tier in force", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, assistant(1), { priorityMultiplier: 3 });
  accumulateEntry(acc, tierRecord("priority"), { priorityMultiplier: 3 });
  accumulateEntry(acc, assistant(1), { priorityMultiplier: 3 });
  accumulateEntry(acc, tierRecord("standard"), { priorityMultiplier: 3 });
  accumulateEntry(acc, assistant(1), { priorityMultiplier: 3 });
  assert.equal(summarize(acc, { kind: "own" }).cost, 1 + 3 + 1);
});

test("everything billed in a priority window takes the premium, not just assistant turns", () => {
  // pi issues compaction, branch-summary, and tool-nested calls through the same
  // provider path, so they are billed at whatever tier is in force.
  const acc = createAccumulator();
  accumulateEntry(acc, tierRecord("priority"), { priorityMultiplier: 2 });
  for (const entry of [assistant(1), toolResult(1), compaction(1), branchSummary(1)]) {
    accumulateEntry(acc, entry, { priorityMultiplier: 2 });
  }
  assert.equal(summarize(acc, { kind: "own" }).cost, 8, "all four sources doubled");
});

test("a keepalive cost record is not swept into a priority window it never joined", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, tierRecord("priority"), { priorityMultiplier: 2 });
  accumulateEntry(acc, costRecord(1, "ping-1"), { priorityMultiplier: 2 });
  assert.equal(summarize(acc, { kind: "own" }).cost, 1, "a separate paid call keeps its own price");
});

test("real tokens priced at zero are surfaced as unpriced, not silently free", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, { type: "message", id: "z1", message: { role: "assistant", provider: "openai", model: "mystery-alias", usage: usage(0) } });
  const tree = combine(summarize(acc, { kind: "own" }), []);
  assert.deepEqual(tree.unpricedModels, ["openai/mystery-alias"]);
  assert.ok(tree.approximate);
  assert.match(tree.approximateReasons.join(" "), /no price resolved for openai\/mystery-alias/);
  assert.match(tree.approximateReasons.join(" "), /unpriced, or genuinely free/, "the reason does not assert a bug that may just be a free model");
});

test("a zero-token, zero-cost entry is not reported as unpriced", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, { type: "message", id: "z2", message: { role: "assistant", provider: "openai", model: "aborted", usage: usage(0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) } });
  assert.equal(combine(summarize(acc, { kind: "own" }), []).approximate, false);
});

test("changing the configured premium re-prices an already-scanned tree", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [tierRecord("priority"), assistant(1)] });
  const scanner = new SessionTreeScanner();
  assert.equal(scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" }).totalCost, 1);
  scanner.setPrice({ priorityMultiplier: 2 });
  assert.equal(scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" }).totalCost, 2);
});

// ── non-session cost records (D6) ───────────────────────────────────────────

test("cost records from a non-session call are counted and bucketed by their key", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, costRecord(0.25, "ping-1", "keepalive"));
  accumulateEntry(acc, costRecord(0.1, "tts-1", "speech"));
  const summary = summarize(acc, { kind: "own" });
  assert.equal(summary.cost, 0.35);
  assert.deepEqual(summary.models.map((m) => m.key).sort(), ["keepalive", "speech"]);
});

test("a cost record with no usage contributes nothing", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, { type: "custom", id: "r1", customType: COST_RECORD_TYPE, data: { recordId: "x", key: "keepalive" } });
  assert.equal(summarize(acc, { kind: "own" }).cost, 0);
});

// ── post-hoc analysis (D7) ──────────────────────────────────────────────────

test("analyzeSessionTree totals a tree on disk without a live session", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: [assistant(1), toolResult(0.5)] });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(2)] });
  writeSession(join(deriveChildSessionDir(parent, "advisor"), "advice.jsonl"), { id: "c2", entries: [assistant(0.75)] });
  const tree = analyzeSessionTree(parent);
  assert.equal(tree.totalCost, 4.25);
  assert.equal(tree.own.cost, 1.5);
  assert.deepEqual(tree.descendants.map((d) => d.kind).sort(), ["advisor", "tasks"]);
});

test("a session tree on disk can be analyzed from a fresh process, long after the session ended", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: [assistant(1)] });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(2.5)] });

  const moduleUrl = pathToFileURL(join(import.meta.dirname, "cost-report.ts")).href;
  const script = `
    const { analyzeSessionTree, renderCostReport } = await import(${JSON.stringify(moduleUrl)});
    const tree = analyzeSessionTree(${JSON.stringify(parent)});
    process.stdout.write(JSON.stringify({ total: tree.totalCost, children: tree.descendants.length, report: renderCostReport(tree) }));
  `;
  const scriptPath = join(root, "analyze.mts");
  writeFileSync(scriptPath, script);
  const local = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
  const bin = existsSync(local) ? local : join(import.meta.dirname, "..", "..", "..", "..", "..", "node_modules", ".bin", "tsx");
  const out = execFileSync(bin, [scriptPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out);
  assert.equal(parsed.total, 3.5, "a fresh process reproduces the whole-tree total");
  assert.equal(parsed.children, 1);
  assert.match(parsed.report, /Session tree lifetime cost/);
  assert.match(parsed.report, /Not included/);
});

// ── forked history is not billed twice ───────────────────────────────────────

test("a fork that copied the parent's history counts only what it added", () => {
  const root = tempRoot();
  const parentTurns = [assistant(1), assistant(2)];
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: parentTurns });
  // BTW asides and pi's own /fork copy the parent's entries verbatim, ids and all.
  writeSession(join(deriveChildSessionDir(parent, "btw"), "aside.jsonl"), {
    id: "b1",
    parentSession: parent,
    entries: [...parentTurns, assistant(0.5)],
  });

  const tree = new SessionTreeScanner().scanTree({ ownEntries: parentTurns, sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 3.5, "parent 3 + the aside's own 0.5, not the copied history again");
  assert.equal(tree.own.cost, 3);
  assert.equal(tree.descendants[0]?.cost, 0.5);
});

test("two asides copying the same history each add only their own turns", () => {
  const root = tempRoot();
  const parentTurns = [assistant(1)];
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: parentTurns });
  const dir = deriveChildSessionDir(parent, "btw");
  writeSession(join(dir, "a.jsonl"), { id: "b1", parentSession: parent, entries: [...parentTurns, assistant(0.25)] });
  writeSession(join(dir, "b.jsonl"), { id: "b2", parentSession: parent, entries: [...parentTurns, assistant(0.75)] });

  const tree = new SessionTreeScanner().scanTree({ ownEntries: parentTurns, sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 2, "1 + 0.25 + 0.75");
});

test("independent children are fully counted — suppression is not over-eager", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: [assistant(1)] });
  writeSession(join(deriveChildSessionDir(parent, "advisor"), "a.jsonl"), { id: "a1", entries: [assistant(2), toolResult(0.5)] });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "t.jsonl"), { id: "t1", entries: [assistant(3)] });

  const tree = new SessionTreeScanner().scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 6.5);
});

test("an entry id that collides across sessions is still counted when it is a different turn", () => {
  const root = tempRoot();
  // pi entry ids are 8 hex chars, so collisions across a large tree are plausible;
  // the timestamp is what distinguishes a genuine collision from a copied entry.
  const parentEntry = { type: "message", id: "dupe1234", timestamp: "2026-07-28T10:00:00.000Z", message: { role: "assistant", provider: "openai", model: "m", usage: usage(1) } };
  const childEntry = { type: "message", id: "dupe1234", timestamp: "2026-07-28T11:30:00.000Z", message: { role: "assistant", provider: "openai", model: "m", usage: usage(2) } };
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: [parentEntry] });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [childEntry] });

  const tree = new SessionTreeScanner().scanTree({ ownEntries: [parentEntry], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 3, "distinct turns that happen to share an id both count");
});

test("post-hoc analysis suppresses copied fork history the same way", () => {
  const root = tempRoot();
  const parentTurns = [assistant(1), assistant(1)];
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1", entries: parentTurns });
  writeSession(join(deriveChildSessionDir(parent, "btw"), "aside.jsonl"), { id: "b1", parentSession: parent, entries: [...parentTurns, assistant(0.5)] });
  assert.equal(analyzeSessionTree(parent).totalCost, 2.5);
});

// ── each discovery route stands on its own, and the overlap is deduped ────────

test("the sidecar route alone finds a child that carries no parent link", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(2)] });
  const found = new SessionTreeScanner().discover(parent, "p1");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.header?.parentSession, undefined, "no header link — location is the only signal");
});

test("the header route alone finds a sibling outside the sidecar directory", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  writeSession(join(root, "fork.jsonl"), { id: "f1", parentSession: "p1", entries: [assistant(2)] });
  const found = new SessionTreeScanner().discover(parent, "p1");
  assert.equal(found.length, 1);
  assert.ok(!found[0]?.path.includes("parent/"), "not under the sidecar dir — the header is the only signal");
});

test("a child both routes reach is admitted exactly once", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  // Real children carry both signals: a panelist sits in the sidecar dir AND names the
  // parent id; a BTW aside sits there AND names the parent file path.
  const byId = writeSession(join(deriveChildSessionDir(parent, "panel"), "by-id.jsonl"), { id: "c1", parentSession: "p1", entries: [assistant(2)] });
  const byPath = writeSession(join(deriveChildSessionDir(parent, "btw"), "by-path.jsonl"), { id: "c2", parentSession: parent, entries: [assistant(3)] });

  // Both premises stated rather than assumed: each file really is reachable by the
  // sidecar route (its location) and by the header route (its parent link).
  for (const [path, link] of [[byId, "p1"], [byPath, parent]] as const) {
    assert.ok(path.startsWith(deriveSidecarRoot(parent)), `${path} is under the sidecar root`);
    assert.equal(readSessionHeader(path)?.parentSession, link, `${path} also links to the parent by header`);
  }

  const scanner = new SessionTreeScanner();
  const found = scanner.discover(parent, "p1");
  assert.equal(found.length, 2, "two children, each admitted once despite two routes reaching each");
  assert.deepEqual(found.map((f) => f.header?.id).sort(), ["c1", "c2"]);
  assert.equal(scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" }).totalCost, 5, "each counted once, not twice");
});

test("a grandchild reachable from both its parent and the root is admitted once", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  const child = writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(1)] });
  writeSession(join(deriveChildSessionDir(child, "tasks"), "grand.jsonl"), { id: "g1", parentSession: "c1", entries: [assistant(2)] });
  const scanner = new SessionTreeScanner();
  assert.equal(scanner.discover(parent, "p1").length, 2);
  assert.equal(scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" }).totalCost, 3);
});

test("a tool result restating a child session is suppressed at any depth, not just the root", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  // The child ran a grandchild session and its tool result also reports that usage.
  const child = writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), {
    id: "c1",
    entries: [
      assistant(1),
      { type: "message", id: "tr-child", timestamp: "2026-07-28T10:00:00.000Z", message: { role: "toolResult", toolName: "advisor_consult", usage: usage(3), details: { childSessionId: "g1" } } },
    ],
  });
  writeSession(join(deriveChildSessionDir(child, "advisor"), "grand.jsonl"), { id: "g1", entries: [assistant(3)] });

  const scanner = new SessionTreeScanner();
  const tree = scanner.scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 4, "child's own 1 + the grandchild's 3 counted once, from its own session");
  assert.equal(analyzeSessionTree(parent).totalCost, 4, "post-hoc analysis agrees");
});

test("a paid call that could not be priced marks the total approximate, even at zero tokens", () => {
  // Speech is billed per character with no rate configured: the record is honest that
  // it carries no price, so the total must read as a floor rather than as exact.
  const acc = createAccumulator();
  accumulateEntry(acc, {
    type: "custom",
    id: "tts1",
    customType: COST_RECORD_TYPE,
    data: { recordId: "tts-1", key: "openai/gpt-4o-mini-tts (speech)", characters: 500_000, priced: false, usage: usage(0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) },
  });
  const tree = combine(summarize(acc, { kind: "own" }), []);
  assert.ok(tree.approximate, "an unpriced paid call is not silently free");
  assert.deepEqual(tree.unpricedModels, ["openai/gpt-4o-mini-tts (speech)"]);
});

test("a priced call reports its cost with no approximation marker", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, {
    type: "custom",
    id: "tts2",
    customType: COST_RECORD_TYPE,
    data: { recordId: "tts-2", key: "openai/gpt-4o-mini-tts (speech)", characters: 500_000, priced: true, usage: usage(6, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) },
  });
  const tree = combine(summarize(acc, { kind: "own" }), []);
  assert.equal(tree.totalCost, 6);
  assert.equal(tree.approximate, false);
});

// ── plugin-agnostic pricing (INV-G19) ───────────────────────────────────────

test("a tier record's own premium prices its turns, with no configuration passed in", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, tierRecord("priority", 2));
  accumulateEntry(acc, assistant(1));
  const tree = combine(summarize(acc, { kind: "own" }), []);
  assert.equal(tree.totalCost, 2, "priced from the record alone");
  assert.equal(tree.approximate, false);
});

test("a declared premium wins over one supplied by the caller", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, tierRecord("priority", 3), { priorityMultiplier: 10 });
  accumulateEntry(acc, assistant(1), { priorityMultiplier: 10 });
  assert.equal(summarize(acc, { kind: "own" }).cost, 3, "the producer knows its own billing, the caller is only a fallback");
});

test("a tier record that declares no premium leaves the total a marked floor", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, tierRecord("priority"));
  accumulateEntry(acc, assistant(1));
  const tree = combine(summarize(acc, { kind: "own" }), []);
  assert.equal(tree.totalCost, 1);
  assert.ok(tree.approximate);
  assert.match(tree.approximateReasons.join(" "), /nothing declared the premium/);
});

test("dropping a premium back to undefined stops applying the old one", () => {
  const acc = createAccumulator();
  accumulateEntry(acc, tierRecord("priority", 2));
  accumulateEntry(acc, assistant(1));
  accumulateEntry(acc, tierRecord("priority"));
  accumulateEntry(acc, assistant(1));
  assert.equal(summarize(acc, { kind: "own" }).cost, 3, "2 then 1, not 2 then 2");
});

test("a tree with no records from any other extension still totals correctly", () => {
  // The whole point of the agnostic contract: with nothing else installed there are no
  // tier records and no cost records, and the tree total is still exact.
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  writeSession(join(deriveChildSessionDir(parent, "tasks"), "child.jsonl"), { id: "c1", entries: [assistant(2), toolResult(0.5)] });
  const tree = new SessionTreeScanner().scanTree({ ownEntries: [assistant(1)], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 3.5);
  assert.equal(tree.approximate, false);
  assert.deepEqual(tree.unpricedModels, []);
});

test("sessions nested past the walk's depth bound are reported, not silently dropped", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  // Build deeper than a deliberately tiny bound to stage the cliff.
  let current = parent;
  for (let i = 0; i < 3; i += 1) {
    current = writeSession(join(deriveChildSessionDir(current, "tasks"), `c${i}.jsonl`), { id: `c${i}`, entries: [assistant(1)] });
  }

  const shallow = listSidecarSessionFiles(deriveSidecarRoot(parent), 2);
  assert.equal(shallow.truncated, true, "the walk knows it stopped early");
  assert.ok(shallow.files.length < 3, "and really did miss sessions");

  // At the shipped bound nothing is missed, so nothing is reported.
  const full = listSidecarSessionFiles(deriveSidecarRoot(parent));
  assert.equal(full.truncated, false);
  assert.equal(full.files.length, 3);

  const tree = new SessionTreeScanner().scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.equal(tree.totalCost, 3);
  assert.equal(tree.approximate, false, "a tree within the bound is exact");
});

test("a tree deeper than the bound reports the gap instead of reading exact", () => {
  const root = tempRoot();
  const parent = writeSession(join(root, "parent.jsonl"), { id: "p1" });
  let current = parent;
  for (let i = 0; i < 3; i += 1) {
    current = writeSession(join(deriveChildSessionDir(current, "tasks"), `c${i}.jsonl`), { id: `c${i}`, entries: [assistant(1)] });
  }

  // Same disclosure path an unreadable file takes: spend is missing, so the figure is
  // a floor and says why — never a confident number over an incomplete walk.
  const tree = new SessionTreeScanner({}, 2).scanTree({ ownEntries: [], sessionFile: parent, sessionId: "p1" });
  assert.ok(tree.totalCost < 3, `expected a partial total, got ${tree.totalCost}`);
  assert.ok(tree.approximate, "a truncated walk cannot report an exact total");
  assert.equal(tree.unreadableSessions, 1);
  assert.match(tree.approximateReasons.join(" "), /could not be read/);
});

test("the depth bound allows far deeper nesting than any real session tree", () => {
  // Each generation costs two directory levels, so the bound must be comfortably even
  // and large; a cap of 8 would have silently stopped at four generations.
  assert.ok(MAX_SIDECAR_DEPTH >= 24, `bound is ${MAX_SIDECAR_DEPTH}`);
});
