/**
 * Test scaffolding: temporary state roots, a fake pi host, a recording spawner,
 * and packet fixtures.
 *
 * Every test overrides the state root, so no test can touch the real ~/.pi/hq.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnRequest, SpawnResult, Spawner } from "./spawn.ts";
import { HqStore } from "./store.ts";
import type { Packet, SessionState } from "./types.ts";
import type { PacketDraft as TriagePacketDraft } from "./triage.ts";

export async function makeRoot(label = "hq"): Promise<string> {
  return mkdtemp(join(tmpdir(), `${label}-`));
}

export async function dropRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export interface RecordingSpawner {
  spawner: Spawner;
  calls: SpawnRequest[];
}

export function recordingSpawner(): RecordingSpawner {
  const calls: SpawnRequest[] = [];
  let counter = 0;
  const spawner: Spawner = async (request) => {
    calls.push(request);
    counter += 1;
    const result: SpawnResult = {
      runId: `run-${counter}`,
      pid: 10_000 + counter,
      logPath: `/dev/null`,
      argv: [],
    };
    return result;
  };
  return { spawner, calls };
}

export function makeStore(root: string, now: () => Date = () => new Date()): HqStore {
  return new HqStore({ root, now });
}

/** A clock that advances a fixed step per read, so ids and ages are predictable. */
export function fixedClock(startIso = "2026-07-28T12:00:00.000Z", stepMs = 1000): () => Date {
  let tick = 0;
  return () => new Date(Date.parse(startIso) + stepMs * tick++);
}

export function sessionStateFixture(overrides: Partial<SessionState> = {}): SessionState {
  return {
    version: 1,
    sessionId: "sess-a",
    sessionFile: "/tmp/sess-a.jsonl",
    pid: process.pid,
    runtimeId: "rt-1",
    role: "managed",
    kind: "worker",
    project: "/work/alpha",
    title: "alpha work",
    state: "running",
    stopState: "working",
    preview: "working on it",
    startedAt: "2026-07-28T11:00:00.000Z",
    lastEventAt: "2026-07-28T11:59:00.000Z",
    drillingPacketIds: [],
    originSessionId: null,
    packetId: null,
    ...overrides,
  };
}

/** A packet draft that clears the bar; override one field to make it fail. */
export function packetDraftFixture(
  overrides: Partial<Omit<Packet, "version" | "id" | "createdAt" | "updatedAt" | "generation" | "status">> = {},
): Omit<Packet, "version" | "id" | "createdAt" | "updatedAt" | "generation" | "status"> {
  return {
    sourceSessionId: "sess-a",
    sourceSessionFile: "/tmp/sess-a.jsonl",
    project: "/work/alpha",
    domain: "ci-flake",
    title: "retry the flaky integration test",
    question: "The integration suite failed on a known flaky test. Retry it, or investigate now?",
    options: [
      { id: "retry", label: "Retry the suite", price: "eight minutes of CI, no code change" },
      {
        id: "investigate",
        label: "Investigate the flake now",
        price: "an hour of work, delays the branch",
      },
    ],
    recommendationId: "retry",
    flipCondition: "if the same test failed on the previous two runs, it is not flaky",
    blastRadius: "low",
    reversibility: "reversible",
    dependsOn: [],
    doctrineCitations: [],
    shadowRuling: {
      optionId: "retry",
      text: "retry the suite",
      rationale: "a first failure on a known flaky test is usually noise",
      doctrineCitations: [],
    },
    annotations: [],
    trivial: true,
    proposal: null,
    ...overrides,
  };
}

export function triageDraftFixture(overrides: Partial<TriagePacketDraft> = {}): TriagePacketDraft {
  const base = packetDraftFixture();
  return {
    domain: base.domain,
    title: base.title,
    question: base.question,
    options: base.options,
    recommendationId: base.recommendationId,
    flipCondition: base.flipCondition,
    blastRadius: base.blastRadius,
    reversibility: base.reversibility,
    doctrineCitations: base.doctrineCitations,
    shadowRuling: base.shadowRuling,
    trivial: base.trivial,
    dependsOn: [],
    ...overrides,
  };
}

/** Writes a minimal pi session file so transcript reading has something real. */
export async function writeSessionFile(
  path: string,
  messages: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<void> {
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "0000-session",
      timestamp: "2026-07-28T11:00:00.000Z",
      cwd: "/work/alpha",
    }),
  ];
  messages.forEach((message, index) => {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `e${index}`,
        parentId: index === 0 ? null : `e${index - 1}`,
        timestamp: `2026-07-28T11:0${index}:00.000Z`,
        message: { role: message.role, content: [{ type: "text", text: message.text }] },
      }),
    );
  });
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}
