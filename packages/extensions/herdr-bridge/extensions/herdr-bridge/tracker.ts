// Turns successive views of Herdr's agents into the wake-ups a session that started some of them
// should get. Pure: the caller polls Herdr, passes the clock in, and delivers what comes out.
import type { AgentStatus, AgentView } from "./herdr.ts";

/** Ten minutes: the cadence at which `/orchestrate` checks in on a live run. */
export const DEFAULT_QUIET_INTERVAL_MS = 10 * 60 * 1000;

/** How a session this one started looked when last seen. */
export interface TrackedSession {
  name: string;
  paneId: string;
  /** The status class last reported for it; `unknown` reports nothing and keeps the previous class. */
  phase: Phase;
  completionSeq?: number;
  /** When it last changed phase or finished a turn, in ms. */
  changedAt: number;
  /** When it was last reported quiet, in ms. */
  quietAt?: number;
}

/** What a started session is doing, as far as its starter cares. */
export type Phase = "working" | "finished" | "blocked";

export type WakeupKind = "finished" | "blocked" | "quiet" | "gone";

export interface Wakeup {
  kind: WakeupKind;
  name: string;
  paneId: string;
  /** Minutes it has stayed working, for a quiet wake-up. */
  quietMinutes?: number;
}

function phaseOf(status: AgentStatus): Phase | undefined {
  switch (status) {
    case "idle":
    case "done":
      return "finished";
    case "blocked":
      return "blocked";
    case "working":
      return "working";
    case "unknown":
      return undefined;
  }
}

/** A session just started: it is working on its first prompt. */
export function track(name: string, paneId: string, now: number, completionSeq?: number): TrackedSession {
  return { name, paneId, phase: "working", completionSeq, changedAt: now };
}

/**
 * Compares the tracked sessions with what Herdr shows now. Returns the sessions still live (a gone
 * one is dropped) and one wake-up per change: a finished turn — even one that finished and started
 * again between two looks, which the completion count shows — a block, an exit, and each quiet
 * interval a session stays working with nothing changing.
 */
export function observe(
  tracked: readonly TrackedSession[],
  agents: readonly AgentView[],
  now: number,
  quietIntervalMs = DEFAULT_QUIET_INTERVAL_MS,
): { tracked: TrackedSession[]; wakeups: Wakeup[] } {
  const byPane = new Map(agents.map((agent) => [agent.paneId, agent]));
  const next: TrackedSession[] = [];
  const wakeups: Wakeup[] = [];
  for (const session of tracked) {
    const agent = byPane.get(session.paneId);
    if (!agent || agent.kind !== "pi") {
      wakeups.push({ kind: "gone", name: session.name, paneId: session.paneId });
      continue;
    }
    const phase = phaseOf(agent.status) ?? session.phase;
    const finishedSince =
      agent.completionSeq !== undefined && session.completionSeq !== undefined && agent.completionSeq > session.completionSeq;
    const updated: TrackedSession = { ...session, completionSeq: agent.completionSeq ?? session.completionSeq };
    if (phase !== session.phase) {
      updated.phase = phase;
      updated.changedAt = now;
      updated.quietAt = undefined;
      if (phase === "finished" || phase === "blocked") wakeups.push({ kind: phase, name: session.name, paneId: session.paneId });
      else if (finishedSince) wakeups.push({ kind: "finished", name: session.name, paneId: session.paneId });
    } else if (finishedSince) {
      // Finished a turn and moved on between two looks: still a finished turn.
      updated.changedAt = now;
      updated.quietAt = undefined;
      wakeups.push({ kind: "finished", name: session.name, paneId: session.paneId });
    } else if (phase === "working") {
      const since = updated.quietAt ?? updated.changedAt;
      if (now - since >= quietIntervalMs) {
        updated.quietAt = now;
        wakeups.push({
          kind: "quiet",
          name: session.name,
          paneId: session.paneId,
          quietMinutes: Math.round((now - updated.changedAt) / 60_000),
        });
      }
    }
    next.push(updated);
  }
  return { tracked: next, wakeups };
}
