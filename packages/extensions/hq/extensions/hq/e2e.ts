/**
 * End-to-end lifecycle exercise.
 *
 * Run it with `npm run test:e2e --workspace @doodledood/pi-hq`, optionally naming
 * stages: `skeleton`, `drill`, `tiering`, `doctrine`, `grammar`, `graduation`,
 * or `all` (the default).
 *
 * The skeleton, drill and tiering stages spawn real headless pi sessions, so they need a
 * working model and will spend tokens; the rest exercise the substrate with a
 * recording spawner, where the artifact under test is the routing decision rather
 * than the child process. Every stage asserts on files under a temporary state
 * root — nothing here touches the real ~/.pi/hq.
 */

import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDoctrine, seedDoctrine, seedProjectDoctrine } from "./doctrine.ts";
import { startDrill, submitDrillResult, readDrillLog } from "./drills.ts";
import { graduateDomain, revokeDomain } from "./graduation.ts";
import { hqPaths } from "./paths.ts";
import { applyRuling } from "./rulings.ts";
import { createSpawner, EXTENSION_ENV, type SpawnRequest, type Spawner } from "./spawn.ts";
import { HqStore } from "./store.ts";
import { ensureStopRecord, readStopRecord, type StopRecord } from "./stops.ts";
import { readTranscriptTail, renderTranscript } from "./transcript.ts";
import { applyTriageOutcome } from "./triage.ts";
import type { Packet } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(HERE, "index.ts");

const stages: string[] = [];
let failures = 0;

function stage(name: string): void {
  stages.push(name);
  process.stdout.write(`\n=== ${name} ===\n`);
}

function pass(what: string, evidence: string): void {
  process.stdout.write(`  ok   ${what}\n       ${evidence}\n`);
}

function fail(what: string, error: unknown): void {
  failures += 1;
  process.stdout.write(`  FAIL ${what}\n       ${String(error)}\n`);
}

async function check(what: string, body: () => Promise<string> | string): Promise<boolean> {
  try {
    pass(what, await body());
    return true;
  } catch (error) {
    fail(what, error);
    return false;
  }
}

async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 240_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(what, new Error(`timed out after ${timeoutMs}ms`));
  return undefined;
}

/** Every pi session file the children have written into the temp session dir. */
async function sessionFiles(world: World): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dir = join(world.root, "sessions");
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(dir, name));
}

/** Reads a file once it has stopped changing, so a snapshot is not a race. */
async function stableSnapshot(path: string, quietMs = 4_000): Promise<string> {
  let previous = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current === previous && current !== "") return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, quietMs));
  }
  return previous;
}

function recordingSpawner(): { spawner: Spawner; calls: SpawnRequest[] } {
  const calls: SpawnRequest[] = [];
  let counter = 0;
  return {
    calls,
    spawner: async (request) => {
      calls.push(request);
      counter += 1;
      return { runId: `rec-${counter}`, pid: undefined, logPath: "/dev/null", argv: [] };
    },
  };
}

interface World {
  root: string;
  workspace: string;
  store: HqStore;
  real: Spawner;
}

async function makeWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "hq-e2e-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "hq-e2e-work-"));
  const store = new HqStore({ root });
  await store.ensure();
  await seedDoctrine(root);
  await seedProjectDoctrine(root, workspace);
  const real = createSpawner({
    root,
    env: {
      ...process.env,
      HQ_HOME: root,
      [EXTENSION_ENV]: EXTENSION_PATH,
      HQ_NO_TITLER: "1",
      // Children write their sessions under the temporary root too, so a run
      // leaves nothing in the user's real session directory.
      PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    },
  });
  return { root, workspace, store, real };
}

/** A task that cannot be finished without a decision, so it must stop and ask. */
const BLOCKED_TASK = `Read the file notes.md in this directory. It describes two possible names for a
new function. Both are defensible and you have no way to know which the user
prefers. Do not edit any file. State the choice you need made, the two options
with what each costs, which you would pick and why, and what would change your
mind. Then stop and wait — do not pick one and proceed.`;

async function runSkeleton(world: World): Promise<{ packet?: Packet; stop?: StopRecord }> {
  stage("skeleton: a delegated stop becomes a packet you rule on");
  await writeFile(
    join(world.workspace, "notes.md"),
    "The new helper could be called `normalizeInput` or `cleanInput`. Pick one.\n",
    "utf8",
  );

  const spawned = await world.real({
    kind: "worker",
    prompt: BLOCKED_TASK,
    cwd: world.workspace,
    wait: true,
  });
  await check("a managed session ran headless", () => `run ${spawned.runId}, exit ${spawned.exitCode}`);

  const state = await waitFor("the session published its state", async () => {
    const fleet = await world.store.listFleet();
    return fleet.find((entry) => entry.role === "managed") ?? undefined;
  }, 30_000);
  if (!state) return {};
  await check("the fleet row is the managed worker", () =>
    `${state.sessionId} ${state.role}/${state.kind} state=${state.state}`);

  const stop = await waitFor("its stop was recorded", async () => {
    const { scanJsonDir } = await import("./io.ts");
    const { parseStopRecord } = await import("./stops.ts");
    const scan = await scanJsonDir(
      hqPaths(world.root).stops,
      parseStopRecord,
      (record) => record.stopId,
    );
    return scan.records.find((entry) => entry.record.sessionId === state.sessionId)?.record;
  }, 60_000);
  if (!stop) return {};
  await check("the stop names the session and its file", () =>
    `${stop.stopId} status=${stop.status} file=${stop.sessionFile ?? "(none)"}`);

  // Triage runs as its own headless session, spawned by the worker's reporter.
  const packet = await waitFor("triage produced a bar-meeting packet", async () => {
    const queue = await world.store.listQueue();
    return queue.find((candidate) => candidate.sourceSessionId === state.sessionId);
  }, 240_000);
  if (!packet) return { stop };

  await check("the packet carries the whole bar", () => {
    assert.ok(packet.question.trim().length > 10, "question");
    assert.ok(packet.options.length >= 2, "two or more options");
    for (const option of packet.options) assert.ok(option.price.trim().length > 3, "priced option");
    assert.ok(
      packet.options.some((option) => option.id === packet.recommendationId),
      "recommendation names an option",
    );
    assert.ok(packet.flipCondition.trim().length > 10, "flip condition");
    assert.ok(["low", "medium", "high"].includes(packet.blastRadius), "blast radius");
    assert.equal(packet.status, "pending");
    return `${packet.id} (${packet.domain}) — ${packet.question.slice(0, 80)}`;
  });

  await check("triage recorded a shadow ruling to be graded", () => {
    assert.ok(packet.shadowRuling, "shadow ruling present");
    return `${packet.shadowRuling?.optionId ?? "(custom)"}: ${packet.shadowRuling?.rationale.slice(0, 70)}`;
  });

  // The scripted user accepts the recommendation.
  const ruled = await applyRuling({ store: world.store, spawner: world.real }, {
    packetId: packet.id,
    form: "accept",
  });
  if ("error" in ruled) {
    fail("the ruling was recorded", ruled.error);
    return { packet, stop };
  }
  await check("the ruling is recorded with its coverage bucket", async () => {
    const rulings = await world.store.listRulings();
    const recorded = rulings.find((entry) => entry.packetId === packet.id);
    assert.ok(recorded, "ruling in the log");
    return `${recorded?.form}/${recorded?.coverage} shadowAgreed=${String(recorded?.shadowAgreed)}`;
  });
  await check("the ruling was carried into a continuation", () => {
    assert.equal(ruled.ruling.routing.action, "resume");
    assert.ok(ruled.ruling.routing.spawnedSessionId, "a continuation was spawned");
    return `${ruled.ruling.routing.note}`;
  });

  const continued = await waitFor("the continuation session appeared on the board", async () => {
    const fleet = await world.store.listFleet();
    return fleet.find((entry) => entry.kind === "continuation") ?? undefined;
  }, 120_000);
  if (continued) {
    await check("the continuation carries the packet it answered", () =>
      `${continued.sessionId} packet=${continued.packetId ?? "(none)"}`);
  }

  return { packet, stop };
}

async function runDrill(world: World, packet: Packet | undefined): Promise<void> {
  stage("drill: a deferred question comes back answered, with quotes");
  if (!packet?.sourceSessionFile) {
    fail("a drill needs a real source session", new Error("the skeleton stage produced none"));
    return;
  }

  const { packet: fresh } = await world.store.createPacket({
    sourceSessionId: packet.sourceSessionId,
    sourceSessionFile: packet.sourceSessionFile,
    project: world.workspace,
    domain: packet.domain,
    title: "drill subject",
    question: "Which name should the helper take?",
    options: packet.options,
    recommendationId: packet.recommendationId,
    flipCondition: "if the codebase already uses one of the two names, follow it",
    blastRadius: "low",
    reversibility: "reversible",
    dependsOn: [],
    doctrineCitations: [],
    shadowRuling: packet.shadowRuling,
    annotations: [],
    trivial: true,
    proposal: null,
  });

  // A resumed continuation legitimately appends to the source session, so wait
  // until the file has settled before snapshotting it. What is being tested is
  // that the *drill* leaves it alone, not that nothing ever writes to it.
  const before = await stableSnapshot(packet.sourceSessionFile);
  const question = "Quote exactly what the source session said the two candidate names were.";
  await startDrill({ store: world.store, spawner: world.real }, fresh, question);

  const annotated = await waitFor("the drill returned the packet annotated", async () => {
    const current = await world.store.readPacket(fresh.id);
    return current && current.annotations.length > 0 ? current : undefined;
  }, 240_000);
  if (!annotated) return;

  await check("the annotation carries an answer and a verbatim quote", () => {
    const annotation = annotated.annotations[0];
    assert.ok(annotation, "annotation present");
    assert.ok(annotation.answer.trim().length > 0, "answer");
    assert.ok(annotation.quotes.length > 0, "at least one quote");
    return `tier ${annotation.tier}: ${annotation.answer.slice(0, 70)} | "${annotation.quotes[0]?.text.slice(0, 50)}"`;
  });
  await check("the packet is back in the queue", () => {
    assert.equal(annotated.status, "pending");
    return `${annotated.id} pending again`;
  });
  await check("the drill ran in its own session, not the source one", async () => {
    // Internal workers are plumbing and publish no fleet row, so the evidence is
    // the session file the drill child wrote: a new one, not the source's.
    const drillFile = await waitFor("the drill wrote its own session file", async () => {
      for (const file of await sessionFiles(world)) {
        if (file === packet.sourceSessionFile) continue;
        const text = await readFile(file, "utf8").catch(() => "");
        // The drill kickoff is distinctive: no other worker is told to drill.
        if (text.includes("## This drill")) return file;
      }
      return undefined;
    }, 60_000);
    assert.ok(drillFile);
    assert.notEqual(drillFile, packet.sourceSessionFile);
    return `${drillFile} (source ${packet.sourceSessionFile})`;
  });
  await check("nothing the drill did rewrote the source session's history", async () => {
    // The source session may still grow on its own — a continuation resumes the
    // same file — so the claim under test is that its existing history is intact
    // and append-only, never rewritten or truncated by a drill.
    const after = await readFile(packet.sourceSessionFile ?? "", "utf8");
    assert.equal(after.startsWith(before), true, "the pre-drill history is unchanged");
    return after.length === before.length
      ? `${before.length} bytes, untouched`
      : `${before.length} bytes intact, ${after.length - before.length} appended by the session's own continuation`;
  });
  await check("the drill log shows which tier answered", async () => {
    const log = await readDrillLog(world.store);
    return log.map((entry) => `${entry.tier}:${entry.action}`).join(" → ");
  });
  await check("drilling is no longer shown on the origin row", async () => {
    const state = await world.store.readSessionState(packet.sourceSessionId);
    assert.deepEqual(state?.drillingPacketIds, []);
    return "origin row clear";
  });
}

/**
 * Tiering: the ordering claim behind the two drill tiers — reading is tried
 * first, and a copy is opened only when reading genuinely cannot answer.
 *
 * Unit tests can only prove the plumbing honours whichever tier the worker
 * reports. Whether a real drill worker *chooses* reading when the answer is
 * sitting in the transcript is a behavioural claim, so it is asserted here with
 * two fixtures against one real source session: a question whose answer is in
 * the transcript verbatim, and one that depends on reasoning the session never
 * wrote down.
 */
const TIERING_SEED_PROMPT =
  `Name the new string-trimming helper. The two candidates on the table are exactly: normalizeInput or cleanInput. Choose one. Reply with the chosen name alone, on one line, with no explanation and no mention of the other candidate. Do not create or edit any file.`;

const VERBATIM_QUESTION =
  "Quote, word for word, the sentence in the source session that named the two candidate helper names.";

const REASONING_QUESTION =
  "The session replied with the chosen name alone. What made it reject the other candidate? I want the reasoning behind the choice, not the choice itself.";

interface WatchedCall {
  request: SpawnRequest;
  argv: string[];
}

/** Wraps the real spawner so every child's request and argv can be asserted on. */
function watchingSpawner(inner: Spawner): { spawner: Spawner; calls: WatchedCall[] } {
  const calls: WatchedCall[] = [];
  return {
    calls,
    spawner: async (request) => {
      const result = await inner(request);
      calls.push({ request, argv: result.argv });
      return result;
    },
  };
}

/**
 * Runs one real, unmanaged pi session to act as the drill's source. Unmanaged on
 * purpose: this stage is about drill tiering, so the session must not drag
 * triage in behind it.
 */
async function seedTieringSession(
  world: World,
): Promise<{ sessionId: string; sessionFile: string } | undefined> {
  const sessionFile = join(world.workspace, "tiering-source.jsonl");
  const env = { ...process.env };
  for (const key of ["HQ_MANAGED", "HQ_KIND", "HQ_HOME", "HQ_ORIGIN_SESSION_ID", "HQ_PACKET_ID"]) {
    delete env[key];
  }
  const bin = process.env.HQ_PI_BIN?.trim() || "pi";
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = nodeSpawn(bin, ["--session", sessionFile, "--print", TIERING_SEED_PROMPT], {
      cwd: world.workspace,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });

  const header = (await readFile(sessionFile, "utf8").catch(() => "")).split("\n")[0] ?? "";
  const sessionId = (() => {
    try {
      const parsed = JSON.parse(header) as { type?: string; id?: string };
      return parsed.type === "session" && typeof parsed.id === "string" ? parsed.id : undefined;
    } catch {
      return undefined;
    }
  })();
  if (!sessionId) {
    fail("a real source session was recorded", new Error(`no session header in ${sessionFile}`));
    return undefined;
  }

  const transcript = renderTranscript(await readTranscriptTail(sessionFile, { maxMessages: 40 }));
  await check("the source session holds the answer to the verbatim question", () => {
    assert.match(transcript, /normalizeInput or cleanInput/, "both candidates appear verbatim");
    return `exit ${exitCode}, session ${sessionId}, ${transcript.length} chars of transcript`;
  });
  await check("the source session never wrote down why it rejected the other name", () => {
    // Only the seeded prompt may mention the loser; if the reply argued about it,
    // the reasoning fixture would be answerable by reading and prove nothing.
    const assistantText = (assistantBlocks(transcript)).join("\n");
    assert.equal(/because|rather than|clearer|ambiguous/i.test(assistantText), false, assistantText.slice(0, 200));
    return assistantText.trim().slice(0, 80) || "(no assistant text)";
  });

  await world.store.publishSessionState({
    version: 1,
    sessionId,
    sessionFile,
    pid: process.pid,
    runtimeId: "e2e-tiering",
    role: "managed",
    kind: "worker",
    project: world.workspace,
    title: "tiering source",
    state: "idle",
    stopState: "stopped-with-question",
    preview: "chose a helper name",
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    drillingPacketIds: [],
    originSessionId: null,
    packetId: null,
  });

  return { sessionId, sessionFile };
}

/** The assistant blocks of a rendered transcript, which is what the reply says. */
function assistantBlocks(rendered: string): string[] {
  return rendered
    .split(/\n\n(?=### )/)
    .filter((block) => block.startsWith("### assistant"))
    .map((block) => block.split("\n").slice(1).join("\n"));
}

async function tieringPacket(
  world: World,
  source: { sessionId: string; sessionFile: string },
  title: string,
): Promise<Packet> {
  const { packet } = await world.store.createPacket({
    sourceSessionId: source.sessionId,
    sourceSessionFile: source.sessionFile,
    project: world.workspace,
    domain: "naming",
    title,
    question: "Which name should the helper take?",
    options: [
      { id: "normalize", label: "normalizeInput", price: "longer, but says what it does" },
      { id: "clean", label: "cleanInput", price: "shorter, but vague about what cleaning means" },
    ],
    recommendationId: "normalize",
    flipCondition: "if the codebase already uses one of the two names, follow it",
    blastRadius: "low",
    reversibility: "reversible",
    dependsOn: [],
    doctrineCitations: [],
    shadowRuling: null,
    annotations: [],
    trivial: true,
    proposal: null,
  });
  return packet;
}

async function runTiering(world: World): Promise<void> {
  stage("tiering: reading is tried before the session is resurrected");
  const source = await seedTieringSession(world);
  if (!source) return;

  const sourceBefore = await stableSnapshot(source.sessionFile);
  const { spawner, calls } = watchingSpawner(world.real);
  const deps = { store: world.store, spawner };

  // Fixture one: the answer is in the transcript, word for word.
  const readable = await tieringPacket(world, source, "tiering: answerable by reading");
  await startDrill(deps, readable, VERBATIM_QUESTION);
  const readAnswered = await waitFor("the verbatim question came back answered", async () => {
    const current = await world.store.readPacket(readable.id);
    return current && current.annotations.length > 0 ? current : undefined;
  }, 300_000);
  if (readAnswered) {
    await check("reading answered it, at tier 1", () => {
      const annotation = readAnswered.annotations[0];
      assert.ok(annotation, "annotation present");
      assert.equal(annotation.tier, 1, "answered by reading");
      return `tier ${annotation.tier}: ${annotation.answer.slice(0, 90)}`;
    });
    await check("the answer is the right one, quoted from the source", () => {
      const annotation = readAnswered.annotations[0]!;
      const said = `${annotation.answer}\n${annotation.quotes.map((quote) => quote.text).join("\n")}`;
      assert.match(said, /normalizeInput/, "names the first candidate");
      assert.match(said, /cleanInput/, "names the second candidate");
      assert.ok(annotation.quotes.length > 0, "at least one quote");
      const inSource = annotation.quotes.some((quote) =>
        sourceBefore.includes(quote.text.trim().replace(/\s+/g, " ").slice(0, 40))
        || sourceBefore.includes(quote.text.trim().slice(0, 40))
      );
      assert.equal(inSource, true, "a quote appears in the source session file verbatim");
      return `"${annotation.quotes[0]?.text.slice(0, 90)}"`;
    });
    await check("no copy was opened and no session was resumed for that run", async () => {
      const log = await readDrillLog(world.store);
      const mine = log.filter((entry) => entry.packetId === readable.id);
      assert.deepEqual(mine.map((entry) => entry.action), ["read", "answered"]);
      assert.equal(mine.every((entry) => entry.tier === 1), true, "tier 1 throughout");
      const spawns = calls.filter((call) => call.request.packetId === readable.id);
      assert.equal(spawns.length, 1, "one child for one drill");
      for (const spawn of spawns) {
        assert.equal(spawn.request.forkSessionFile, undefined, "no fork");
        assert.equal(spawn.request.resumeSessionFile, undefined, "no resume");
        assert.equal(spawn.argv.includes("--fork"), false, spawn.argv.join(" "));
        assert.equal(spawn.argv.includes("--session"), false, spawn.argv.join(" "));
      }
      return `${mine.map((entry) => `${entry.tier}:${entry.action}`).join(" → ")}; argv had no --fork/--session`;
    });
  }

  // Fixture two: the answer depends on reasoning the session never wrote down.
  const opaque = await tieringPacket(world, source, "tiering: needs the session itself");
  await startDrill(deps, opaque, REASONING_QUESTION);
  const escalated = await waitFor("the reasoning question escalated to the copy", async () => {
    const log = await readDrillLog(world.store);
    return log.find((entry) => entry.packetId === opaque.id && entry.action === "fork");
  }, 300_000);
  if (escalated) {
    await check("the escalation is tier 2, and the parent never forked anything itself", () => {
      assert.equal(escalated.tier, 2);
      // The fork is spawned from inside the tier-1 drill child when it reports
      // insufficient, so the parent's own children must all still be plain reads.
      for (const call of calls) {
        assert.equal(call.request.forkSessionFile, undefined, "parent opened no copy");
        assert.equal(call.request.resumeSessionFile, undefined, "parent resumed nothing");
      }
      return `${escalated.tier}:${escalated.action} run=${escalated.runId}`;
    });
    await check("the tier-2 session is a copy of the source, not the source itself", async () => {
      // The fork writes a new session file carrying the source's history; the copy
      // is plumbing, so it publishes no fleet row to look it up by.
      const copy = await waitFor("a forked copy of the source appeared", async () => {
        for (const file of await sessionFiles(world)) {
          if (file === source.sessionFile) continue;
          const text = await readFile(file, "utf8").catch(() => "");
          if (text.includes("normalizeInput or cleanInput") && text.includes("resumed as a copy")) {
            return file;
          }
        }
        return undefined;
      }, 180_000);
      assert.ok(copy, "a distinct forked session file exists");
      assert.notEqual(copy, source.sessionFile);
      return `${copy} (source ${source.sessionFile})`;
    });
    await check("reading was tried first, not skipped", async () => {
      const log = await readDrillLog(world.store);
      const mine = log.filter((entry) => entry.packetId === opaque.id);
      assert.equal(mine[0]?.action, "read", "the first step was a read");
      assert.equal(mine[0]?.tier, 1);
      return mine.map((entry) => `${entry.tier}:${entry.action}`).join(" → ");
    });
    const finished = await waitFor("the copy answered and the packet came back", async () => {
      const current = await world.store.readPacket(opaque.id);
      return current && current.annotations.length > 0 ? current : undefined;
    }, 300_000);
    if (finished) {
      await check("the copy's answer is annotated at tier 2", () => {
        const annotation = finished.annotations.at(-1)!;
        assert.equal(annotation.tier, 2);
        return `tier ${annotation.tier}: ${annotation.answer.slice(0, 90)}`;
      });
    }
  }

  await check("neither run rewrote the source session", async () => {
    const after = await readFile(source.sessionFile, "utf8");
    assert.equal(after.startsWith(sourceBefore), true, "the pre-drill history is unchanged");
    return after.length === sourceBefore.length
      ? `${sourceBefore.length} bytes, untouched`
      : `${sourceBefore.length} bytes intact, ${after.length - sourceBefore.length} appended elsewhere`;
  });
}

async function seedStop(world: World, stopId: string, sessionFile: string | null): Promise<StopRecord> {
  const stop: StopRecord = {
    version: 1,
    stopId,
    sessionId: `sess-${stopId}`,
    sessionFile,
    project: world.workspace,
    kind: "worker",
    stopState: "stopped-with-question",
    preview: "needs a decision",
    createdAt: new Date().toISOString(),
    status: "claimed",
    claimedByPid: process.pid,
    claimedAt: new Date().toISOString(),
    outcome: null,
    packetId: null,
  };
  await ensureStopRecord(world.root, stop);
  return stop;
}

function draft(domain: string) {
  return {
    domain,
    title: "retry the flaky suite",
    question: "The suite failed on a known flaky test. Retry it, or investigate now?",
    options: [
      { id: "retry", label: "Retry the suite", price: "eight minutes of CI, no code change" },
      { id: "investigate", label: "Investigate now", price: "an hour of work, delays the branch" },
    ],
    recommendationId: "retry",
    flipCondition: "if the same test failed on the previous two runs, it is not flaky",
    blastRadius: "low" as const,
    reversibility: "reversible" as const,
    trivial: true,
    shadowRuling: {
      optionId: "retry",
      text: "retry the suite",
      rationale: "a first failure on a known flaky test is usually noise",
      doctrineCitations: [],
    },
  };
}

async function runDoctrine(world: World): Promise<void> {
  stage("doctrine: a ruling becomes a rule the next packet cites");
  const { spawner, calls } = recordingSpawner();
  const deps = { store: world.store, spawner };

  const first = await seedStop(world, "doc-1", `${world.root}/doc-1.jsonl`);
  const firstOutcome = await applyTriageOutcome(deps, first.stopId, {
    kind: "packet",
    packet: draft("ci-flake"),
  });
  if ("error" in firstOutcome || !firstOutcome.packetId) {
    fail("the first packet was queued", firstOutcome);
    return;
  }

  const ruled = await applyRuling(deps, { packetId: firstOutcome.packetId, form: "accept" });
  if ("error" in ruled) {
    fail("the first ruling was recorded", ruled.error);
    return;
  }
  await check("an uncovered ruling proposed a rule", () => {
    assert.equal(ruled.ruling.coverage, "uncovered");
    const proposal = ruled.proposals.find((candidate) => candidate.proposal?.kind === "new-rule");
    assert.ok(proposal, "a new-rule proposal was queued");
    return `${proposal?.id}: ${proposal?.proposal?.ruleText.slice(0, 60)}`;
  });

  const proposal = ruled.proposals.find((candidate) => candidate.proposal?.kind === "new-rule");
  if (!proposal) return;
  const ratified = await applyRuling(deps, { packetId: proposal.id, form: "accept" });
  if ("error" in ratified) {
    fail("the proposal was ratified", ratified.error);
    return;
  }
  await check("the ratified rule is in the doctrine file", async () => {
    const doctrine = await loadDoctrine(world.root, world.workspace);
    const rule = doctrine.rules.find((candidate) => candidate.text.includes("ci-flake"));
    assert.ok(rule, "the rule is readable and citable");
    return `${rule?.citation}: ${rule?.text.slice(0, 60)}`;
  });

  // The same situation again: triage can now cite the ratified rule.
  const doctrine = await loadDoctrine(world.root, world.workspace);
  const citation = doctrine.rules.find((rule) => rule.text.includes("ci-flake"))?.citation ?? "";
  const second = await seedStop(world, "doc-2", `${world.root}/doc-2.jsonl`);
  const secondOutcome = await applyTriageOutcome(deps, second.stopId, {
    kind: "packet",
    packet: { ...draft("ci-flake"), doctrineCitations: [citation] },
  });
  if ("error" in secondOutcome || !secondOutcome.packetId) {
    fail("the second packet was queued", secondOutcome);
    return;
  }
  await check("the next equivalent packet cites the ratified rule", async () => {
    const packet = await world.store.readPacket(secondOutcome.packetId ?? "");
    assert.deepEqual(packet?.doctrineCitations, [citation]);
    return `${packet?.id} cites ${citation}`;
  });
  const agreed = await applyRuling(deps, { packetId: secondOutcome.packetId, form: "accept" });
  if ("error" in agreed) return;
  await check("agreeing with a cited rule is recorded as evidence, not a new proposal", () => {
    assert.equal(agreed.ruling.coverage, "covered-agreed");
    assert.deepEqual(agreed.proposals, []);
    return "covered-agreed, no proposal";
  });
  void calls;
}

async function runGrammar(world: World): Promise<void> {
  stage("grammar: every way of ruling works and is routed");
  const { spawner, calls } = recordingSpawner();
  const deps = {
    store: world.store,
    spawner,
    startDrill: (packet: Packet, question: string) =>
      startDrill({ store: world.store, spawner }, packet, question),
  };

  const made: Packet[] = [];
  for (let index = 0; index < 4; index += 1) {
    const stop = await seedStop(world, `gram-${index}`, `${world.root}/fake-${index}.jsonl`);
    const outcome = await applyTriageOutcome(deps, stop.stopId, {
      kind: "packet",
      packet: draft("grammar"),
    });
    if ("error" in outcome || !outcome.packetId) {
      fail("seeded a packet", outcome);
      return;
    }
    const packet = await world.store.readPacket(outcome.packetId);
    if (packet) made.push(packet);
  }
  if (made.length < 4) return;

  const forms = [
    { form: "accept" as const },
    { form: "alternative" as const, optionId: "investigate" },
    { form: "custom" as const, text: "Skip it and open an issue for the flake." },
    { form: "defer" as const, question: "What did the failure log actually say?" },
  ];

  for (const [index, request] of forms.entries()) {
    const packet = made[index];
    if (!packet) continue;
    const result = await applyRuling(deps, { packetId: packet.id, ...request });
    if ("error" in result) {
      fail(`ruling by ${request.form}`, result.error);
      continue;
    }
    await check(`ruling by ${request.form} is recorded and routed`, () =>
      `${result.ruling.form} → ${result.ruling.routing.action} (${result.note})`);
  }

  await check("the deferred packet is the only one still in the queue", async () => {
    const queue = await world.store.listQueue();
    const ids = queue.filter((packet) => made.some((seeded) => seeded.id === packet.id));
    assert.equal(ids.length, 1, `expected one, saw ${ids.map((packet) => packet.status).join(",")}`);
    assert.equal(ids[0]?.status, "drilling");
    return `${ids[0]?.id} is drilling`;
  });
  await check("three rulings were carried to their sessions", () => {
    const resumes = calls.filter((call) => call.kind === "continuation");
    assert.equal(resumes.length, 3);
    return resumes.map((call) => call.resumeSessionFile ?? "?").join(", ");
  });
}

async function runGraduation(world: World): Promise<void> {
  stage("graduation: a granted domain stops reaching the desk, and revoking restores it");
  const { spawner } = recordingSpawner();
  const deps = { store: world.store, spawner, random: () => 0.01 };
  const doctrine = await loadDoctrine(world.root, world.workspace);
  const citation = doctrine.rules.find((rule) => rule.decides)?.citation ?? "";

  const before = await seedStop(world, "grad-1", `${world.root}/grad-1.jsonl`);
  const escalated = await applyTriageOutcome(deps, before.stopId, {
    kind: "continue",
    domain: "grad-domain",
    citation,
    instruction: "retry the suite once",
    summary: "retry a flaky suite",
    blastRadius: "low",
    reversibility: "reversible",
  });
  if ("error" in escalated) {
    fail("an ungraduated domain escalates", escalated.error);
    return;
  }
  await check("before graduation, the decision is the user's", () => {
    assert.equal(escalated.applied, "packet");
    assert.equal(escalated.escalationReason, "domain-not-graduated");
    return "escalated: domain-not-graduated";
  });

  await graduateDomain(world.store, "grad-domain", new Date().toISOString());
  const after = await seedStop(world, "grad-2", `${world.root}/grad-2.jsonl`);
  const answered = await applyTriageOutcome(deps, after.stopId, {
    kind: "continue",
    domain: "grad-domain",
    citation,
    instruction: "retry the suite once",
    summary: "retry a flaky suite",
    blastRadius: "low",
    reversibility: "reversible",
  });
  if ("error" in answered) {
    fail("a graduated domain is answered from doctrine", answered.error);
    return;
  }
  await check("after graduation, doctrine answers it and the audit records the rule", async () => {
    assert.equal(answered.applied, "continue");
    const audit = await world.store.readAuditLines();
    const last = audit.at(-1);
    assert.equal(last?.domain, "grad-domain");
    assert.equal(last?.ruleCitation, citation);
    return `audit: ${last?.action} ${last?.ruleCitation} sampled=${String(last?.sampledForReview)}`;
  });

  const ceiling = await seedStop(world, "grad-3", `${world.root}/grad-3.jsonl`);
  const stopped = await applyTriageOutcome(deps, ceiling.stopId, {
    kind: "continue",
    domain: "grad-domain",
    citation,
    instruction: "publish the release",
    summary: "publish a release",
    blastRadius: "high",
    reversibility: "one-way",
  });
  if ("error" in stopped) return;
  await check("an irreversible decision still reaches the user inside that domain", () => {
    assert.equal(stopped.applied, "packet");
    assert.equal(stopped.escalationReason, "blast-reversibility-ceiling");
    return "escalated: blast-reversibility-ceiling";
  });

  const ephemeral = await seedStop(world, "grad-5", null);
  const nowhere = await applyTriageOutcome(deps, ephemeral.stopId, {
    kind: "continue",
    domain: "grad-domain",
    citation,
    instruction: "retry the suite once",
    summary: "retry a flaky suite",
    blastRadius: "low",
    reversibility: "reversible",
  });
  if ("error" in nowhere) return;
  await check("a doctrine answer with nowhere to carry it still reaches the user", () => {
    assert.equal(nowhere.applied, "packet");
    assert.equal(nowhere.escalationReason, "no-session-file");
    return "escalated: no-session-file";
  });

  await revokeDomain(world.store, "grad-domain");
  const revoked = await seedStop(world, "grad-4", `${world.root}/grad-4.jsonl`);
  const backToUser = await applyTriageOutcome(deps, revoked.stopId, {
    kind: "continue",
    domain: "grad-domain",
    citation,
    instruction: "retry the suite once",
    summary: "retry a flaky suite",
    blastRadius: "low",
    reversibility: "reversible",
  });
  if ("error" in backToUser) return;
  await check("after revoking, the decision comes back to the user", () => {
    assert.equal(backToUser.applied, "packet");
    assert.equal(backToUser.escalationReason, "domain-not-graduated");
    return "escalated again";
  });
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
  const wanted = requested.length === 0 || requested.includes("all")
    ? ["skeleton", "drill", "tiering", "doctrine", "grammar", "graduation"]
    : requested;

  const world = await makeWorld();
  process.stdout.write(`HQ end-to-end run\n  state root: ${world.root}\n  workspace:  ${world.workspace}\n`);

  try {
    let packet: Packet | undefined;
    if (wanted.includes("skeleton")) {
      const result = await runSkeleton(world);
      packet = result.packet;
    }
    if (wanted.includes("drill")) await runDrill(world, packet);
    if (wanted.includes("tiering")) await runTiering(world);
    if (wanted.includes("doctrine")) await runDoctrine(world);
    if (wanted.includes("grammar")) await runGrammar(world);
    if (wanted.includes("graduation")) await runGraduation(world);
  } finally {
    process.stdout.write(`\nstages: ${stages.join(", ")}\n`);
    if (failures === 0) {
      process.stdout.write("all stages passed\n");
      await rm(world.root, { recursive: true, force: true });
      await rm(world.workspace, { recursive: true, force: true });
    } else {
      process.stdout.write(
        `${failures} check(s) failed — state kept for inspection at ${world.root}\n`,
      );
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

await main();
