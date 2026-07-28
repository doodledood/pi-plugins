/**
 * HQ's tools.
 *
 * Three audiences, and each tool refuses the wrong one: the seat's tools need an
 * active seat and a UI, the worker tools need the matching worker kind, and
 * nothing here can be used to act on a session a human occupies.
 *
 * The ruling surface deliberately uses pi's built-in select and input dialogs
 * rather than a custom component: recommendation first, alternatives next, a
 * defer row, and a free-text row — the shape the design called for, with no
 * bespoke UI to keep working.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadDoctrine } from "./doctrine.ts";
import { drillContext, startDrill, submitDrillResult, type DrillDeps } from "./drills.ts";
import { buildFleetCard } from "./fleet.ts";
import { planPresentation } from "./queue.ts";
import { applyRuling, recordDive, type RulingRequest } from "./rulings.ts";
import { envKind, isManagedEnv, type Spawner } from "./spawn.ts";
import type { HqStore } from "./store.ts";
import { readTranscriptTail, renderTranscript } from "./transcript.ts";
import {
  applyTriageOutcome,
  describePacket,
  triageContext,
  type PacketDraft,
  type TriageOutcome,
} from "./triage.ts";
import type { Packet } from "./types.ts";

export interface ToolDeps {
  store: HqStore;
  spawner: Spawner;
  now: () => Date;
  /** True while this session is the seat. */
  isSeatActive: () => boolean;
  /** Where a delegated task runs when the caller does not say. */
  defaultCwd: () => string;
  doneToday: () => Promise<number>;
  /** Caps live managed workers, so a runaway seat cannot fill the machine. */
  maxConcurrentWorkers: number;
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }], details: {} };
}

function refuse(body: string) {
  return text(`Refused: ${body}`);
}

const OptionSchema = Type.Object({
  id: Type.String({ description: "Short stable id, e.g. \"merge\" or \"hold\"" }),
  label: Type.String({ description: "What the user would be choosing" }),
  price: Type.String({
    description: "What this option costs, risks, or gives up — required by the packet bar",
  }),
});

const ShadowSchema = Type.Object({
  optionId: Type.Union([Type.String(), Type.Null()], {
    description: "The option you would have chosen, or null if none fits",
  }),
  text: Type.String({ description: "The ruling you would have made" }),
  rationale: Type.String({ description: "Why — one or two sentences" }),
  doctrineCitations: Type.Optional(Type.Array(Type.String())),
});

const PacketDraftSchema = Type.Object({
  domain: Type.String({
    description: "The kind of decision this is, reusing an existing domain where one fits",
  }),
  title: Type.String(),
  question: Type.String({ description: "The decision, in the user's terms" }),
  options: Type.Array(OptionSchema, { description: "At least two priced options" }),
  recommendationId: Type.String({ description: "Which option you recommend" }),
  flipCondition: Type.String({ description: "What evidence would change that recommendation" }),
  blastRadius: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  reversibility: Type.Union([Type.Literal("reversible"), Type.Literal("one-way")]),
  doctrineCitations: Type.Optional(Type.Array(Type.String())),
  shadowRuling: Type.Optional(Type.Union([ShadowSchema, Type.Null()])),
  trivial: Type.Optional(Type.Boolean({ description: "Cheap enough to decide alongside others" })),
  dependsOn: Type.Optional(Type.Array(Type.String({ description: "Packet ids that must be ruled first" }))),
});

export function registerHqTools(pi: ExtensionAPI, deps: ToolDeps): void {
  const drillDeps: DrillDeps = { store: deps.store, spawner: deps.spawner, now: deps.now };

  // ---- triage worker ----------------------------------------------------

  pi.registerTool({
    name: "hq_stop_context",
    label: "HQ stop context",
    description:
      "Everything known about a stop: the stop record, the tail of the source session's transcript, the doctrine that applies, and which domains are graduated.",
    parameters: Type.Object({ stopId: Type.String() }),
    async execute(_id, params) {
      if (envKind() !== "triage") return refuse("this tool belongs to stop triage");
      const context = await triageContext(deps, params.stopId);
      if ("error" in context) return text(context.error);
      return text(
        [
          `Stop: ${context.stop.stopId}`,
          `Session: ${context.stop.sessionId} (${context.stop.kind}) in ${context.project}`,
          `Stop state: ${context.stop.stopState}`,
          `Known domains: ${context.knownDomains.join(", ") || "(none yet)"}`,
          `Graduated domains: ${context.graduatedDomains.join(", ") || "(none)"}`,
          "",
          "## Doctrine",
          context.doctrine,
          "",
          "## Transcript tail",
          context.transcript,
        ].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "hq_triage_outcome",
    label: "HQ triage outcome",
    description:
      "Submit the one outcome for a stop: continue (doctrine decides it and the domain is graduated), packet (the user must rule), close (finished), or respawn (died mid-task).",
    parameters: Type.Object({
      stopId: Type.String(),
      outcome: Type.Union([
        Type.Literal("packet"),
        Type.Literal("continue"),
        Type.Literal("close"),
        Type.Literal("respawn"),
      ]),
      packet: Type.Optional(PacketDraftSchema),
      domain: Type.Optional(Type.String()),
      citation: Type.Optional(Type.String({ description: "The doctrine line that decides it" })),
      instruction: Type.Optional(Type.String({ description: "What the session should do next" })),
      summary: Type.Optional(Type.String()),
      unverified: Type.Optional(Type.String({ description: "What was not checked, for a close" })),
      reason: Type.Optional(Type.String({ description: "What it was doing, for a respawn" })),
      blastRadius: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      ),
      reversibility: Type.Optional(
        Type.Union([Type.Literal("reversible"), Type.Literal("one-way")]),
      ),
    }),
    async execute(_id, params) {
      if (envKind() !== "triage") return refuse("this tool belongs to stop triage");
      const outcome = toTriageOutcome(params);
      if ("error" in outcome) return text(outcome.error);
      const result = await applyTriageOutcome(deps, params.stopId, outcome.outcome);
      if ("error" in result) return text(result.error);
      return text(
        [
          `Applied: ${result.applied}`,
          result.packetId ? `Packet: ${result.packetId}` : "",
          result.escalationReason
            ? `Escalated instead of ${params.outcome}: ${result.escalationReason}`
            : "",
          result.note,
        ].filter(Boolean).join("\n"),
      );
    },
  });

  // ---- drill worker -----------------------------------------------------

  pi.registerTool({
    name: "hq_drill_context",
    label: "HQ drill context",
    description:
      "The packet being drilled and the tail of the source session's transcript. Read this before answering.",
    parameters: Type.Object({ packetId: Type.String() }),
    async execute(_id, params) {
      if (envKind() !== "drill") return refuse("this tool belongs to drill workers");
      const question = process.env.HQ_DRILL_QUESTION ?? "";
      const tier = process.env.HQ_DRILL_TIER === "2" ? 2 : 1;
      const context = await drillContext(drillDeps, params.packetId, question, tier);
      if ("error" in context) return text(context.error);
      return text(
        [
          `Question: ${context.question}`,
          `Tier: ${context.tier} (${context.tier === 1 ? "reading" : "asking a copy of the session"})`,
          "",
          "## Packet",
          describePacket(context.packet),
          "",
          "## Transcript tail",
          context.rendered,
        ].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "hq_drill_result",
    label: "HQ drill result",
    description:
      "Submit the drill's answer with verbatim quotes. Set insufficient when reading cannot answer it and the session itself must be asked.",
    parameters: Type.Object({
      packetId: Type.String(),
      answer: Type.String(),
      quotes: Type.Array(
        Type.Object({
          text: Type.String({ description: "Exact text from the source, not a paraphrase" }),
          attribution: Type.String({ description: "Where it came from" }),
        }),
      ),
      insufficient: Type.Optional(Type.Boolean()),
      patch: Type.Optional(
        Type.Object({
          question: Type.Optional(Type.String()),
          options: Type.Optional(Type.Array(OptionSchema)),
          recommendationId: Type.Optional(Type.String()),
          flipCondition: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          domain: Type.Optional(Type.String()),
          blastRadius: Type.Optional(
            Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
          ),
          reversibility: Type.Optional(
            Type.Union([Type.Literal("reversible"), Type.Literal("one-way")]),
          ),
          trivial: Type.Optional(Type.Boolean()),
        }, { description: "Only for a completion drill: the packet fields you filled in" }),
      ),
    }),
    async execute(_id, params) {
      if (envKind() !== "drill") return refuse("this tool belongs to drill workers");
      const outcome = await submitDrillResult(drillDeps, {
        packetId: params.packetId,
        question: process.env.HQ_DRILL_QUESTION ?? "",
        tier: process.env.HQ_DRILL_TIER === "2" ? 2 : 1,
        answer: params.answer,
        quotes: params.quotes,
        ...(params.insufficient ? { insufficient: true } : {}),
        ...(params.patch ? { patch: params.patch as never } : {}),
      });
      if ("error" in outcome) return text(outcome.error);
      if (outcome.kind === "escalated") {
        return text("Reading was not enough; a copy of the session is being asked directly.");
      }
      return text(`Recorded on packet ${outcome.packet.id}; it is back in the queue.`);
    },
  });

  pi.registerTool({
    name: "hq_set_title",
    label: "HQ set session title",
    description: "Set the short board label for a session.",
    parameters: Type.Object({ sessionId: Type.String(), title: Type.String() }),
    async execute(_id, params) {
      if (envKind() !== "titler") return refuse("this tool belongs to the titler");
      const state = await deps.store.readSessionState(params.sessionId);
      if (!state) return text(`no such session: ${params.sessionId}`);
      await deps.store.publishSessionState({ ...state, title: params.title.trim().slice(0, 48) });
      return text("Title set.");
    },
  });

  // ---- the seat ---------------------------------------------------------

  pi.registerTool({
    name: "hq_queue_plan",
    label: "HQ queue plan",
    description:
      "The queue, ordered and batched for presentation. Read this at the start of every cycle: the queue lives on disk and changes while you work.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const denied = seatGuard(ctx, deps);
      if (denied) return refuse(denied);
      const presentable = await deps.store.listPresentable();
      const all = await deps.store.listQueue();
      const doctrine = await loadDoctrine(deps.store.root, deps.defaultCwd());
      const plan = planPresentation(presentable, doctrine.meta);
      const held = all.filter((packet) => packet.status !== "pending");

      if (plan.batches.length === 0 && held.length === 0) {
        return text("The queue is empty.");
      }
      return text(
        [
          ...plan.batches.map((batch, index) =>
            [
              `## Ask ${index + 1} — ${batch.reason}`,
              ...batch.packets.map((packet) => `${packet.id}: ${describePacket(packet)}`),
            ].join("\n")
          ),
          held.length > 0
            ? `\n## Not presentable\n${held.map((packet) => `${packet.id}: ${packet.status}`).join("\n")}`
            : "",
        ].filter(Boolean).join("\n\n"),
      );
    },
  });

  pi.registerTool({
    name: "hq_ask",
    label: "HQ ask for a ruling",
    description:
      "Put one ask to the user — a single packet, or a batch the plan grouped — and record what they decide. The recommendation is offered first; the user can pick an alternative, rule in their own words, or defer with a question.",
    parameters: Type.Object({
      packetIds: Type.Array(Type.String(), { description: "Packet ids from the plan, in order" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const denied = seatGuard(ctx, deps);
      if (denied) return refuse(denied);
      if (!ctx.hasUI) return refuse("there is no interactive surface to ask on");

      const lines: string[] = [];
      for (const packetId of params.packetIds) {
        const packet = await deps.store.readPacket(packetId);
        if (!packet) {
          lines.push(`${packetId}: gone from the queue`);
          continue;
        }
        if (packet.status !== "pending") {
          lines.push(`${packetId}: ${packet.status}, not presentable`);
          continue;
        }
        const outcome = await askOne(ctx, deps, packet);
        lines.push(outcome);
      }
      return text(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "hq_fleet",
    label: "HQ fleet",
    description: "The board: every supervised session, its state, and how long since it spoke.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const denied = seatGuard(ctx, deps);
      if (denied) return refuse(denied);
      const [fleet, packets, doctrine, doneToday] = await Promise.all([
        deps.store.listFleet(),
        deps.store.listQueue(),
        loadDoctrine(deps.store.root, deps.defaultCwd()),
        deps.doneToday(),
      ]);
      const card = buildFleetCard({
        fleet,
        packets,
        doneToday,
        now: deps.now(),
        meta: doctrine.meta,
        maxRows: 20,
      });
      return text(
        [
          card.header,
          ...card.rows.map(
            (row) =>
              `${row.glyph} ${row.label} — ${row.note}, ${row.age} ago${row.attended ? " (attended)" : ""}`,
          ),
          card.summary,
        ].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "hq_source_read",
    label: "HQ read a session",
    description:
      "The tail of a supervised session's transcript, for answering a question about it with verbatim quotes. Read-only.",
    parameters: Type.Object({
      sessionId: Type.String(),
      maxMessages: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const denied = seatGuard(ctx, deps);
      if (denied) return refuse(denied);
      const state = await deps.store.readSessionState(params.sessionId);
      if (!state) return text(`no such session: ${params.sessionId}`);
      const tail = await readTranscriptTail(state.sessionFile, {
        maxMessages: params.maxMessages ?? 20,
      });
      return text(renderTranscript(tail));
    },
  });

  pi.registerTool({
    name: "hq_delegate",
    label: "HQ delegate",
    description:
      "Hand a task to a new headless worker session. It runs on its own and its stop comes back through the queue.",
    parameters: Type.Object({
      task: Type.String({ description: "The task, written as you would write it to a colleague" }),
      cwd: Type.Optional(Type.String({ description: "Project directory; defaults to this one" })),
      model: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const denied = seatGuard(ctx, deps);
      if (denied) return refuse(denied);
      const live = (await deps.store.listFleet()).filter(
        (state) => state.role === "managed" && state.kind === "worker" && state.state === "running",
      );
      if (live.length >= deps.maxConcurrentWorkers) {
        return refuse(
          `${live.length} workers are already running (cap ${deps.maxConcurrentWorkers}); wait for one to stop or raise maxConcurrentWorkers`,
        );
      }
      const spawned = await deps.spawner({
        kind: "worker",
        prompt: params.task,
        cwd: params.cwd ?? deps.defaultCwd(),
        ...(params.model ? { model: params.model } : {}),
        ...(params.name ? { name: params.name } : {}),
      });
      return text(`Delegated as ${spawned.runId}. Its stop will come back through the queue.`);
    },
  });

  pi.registerTool({
    name: "hq_defect",
    label: "HQ log a packet defect",
    description:
      "Record that the user had to open a session to decide, and what the packet was missing. This is how the packet format improves.",
    parameters: Type.Object({
      packetId: Type.String(),
      missing: Type.String({ description: "What the packet should have carried" }),
      ruling: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const denied = seatGuard(ctx, deps);
      if (denied) return refuse(denied);
      await recordDive(deps.store, {
        packetId: params.packetId,
        missing: params.missing,
        ruling: params.ruling ?? "",
        at: deps.now().toISOString(),
      });
      return text("Logged as a packet-format defect.");
    },
  });

  pi.registerTool({
    name: "hq_audit",
    label: "HQ audit sample",
    description:
      "Decisions HQ answered from doctrine without the user, with the sampled ones marked for review.",
    parameters: Type.Object({ limit: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const denied = seatGuard(ctx, deps);
      if (denied) return refuse(denied);
      const records = await deps.store.readAuditLines();
      const limit = params.limit ?? 20;
      const recent = records.slice(-limit);
      if (recent.length === 0) return text("Nothing has been answered from doctrine yet.");
      return text(
        recent.map((record) =>
          `${record.at} ${record.domain} ${record.action}${record.sampledForReview ? " [review]" : ""}: ${record.summary} (${record.ruleCitation})`
        ).join("\n"),
      );
    },
  });
}

function seatGuard(ctx: ExtensionContext, deps: ToolDeps): string | undefined {
  if (isManagedEnv()) return "a worker session cannot use the seat's tools";
  if (!deps.isSeatActive()) return "the HQ seat is not active in this session; run /hq first";
  void ctx;
  return undefined;
}

const DEFER_LABEL = "Ask first — I want something checked";
const CUSTOM_LABEL = "In my own words…";
const DIVE_LABEL = "I had to open the session to decide";

/**
 * One ask, presented through pi's own dialogs. The order is the contract: the
 * recommendation is first, then alternatives, then defer, then free text.
 */
async function askOne(ctx: ExtensionContext, deps: ToolDeps, packet: Packet): Promise<string> {
  const recommended = packet.options.find((option) => option.id === packet.recommendationId);
  const alternatives = packet.options.filter((option) => option.id !== packet.recommendationId);
  const labels = [
    ...(recommended ? [`${recommended.label} (recommended) — ${recommended.price}`] : []),
    ...alternatives.map((option) => `${option.label} — ${option.price}`),
    DEFER_LABEL,
    CUSTOM_LABEL,
    DIVE_LABEL,
  ];

  const title = `${packet.title} — ${packet.question}`;
  const chosen = await ctx.ui.select(title, labels);
  if (chosen === undefined) return `${packet.id}: left pending`;

  let request: RulingRequest | undefined;
  if (chosen === DIVE_LABEL) {
    const missing = await ctx.ui.input(
      "What was missing from the packet?",
      "what you had to go and find out",
    );
    await recordDive(deps.store, {
      packetId: packet.id,
      missing: missing ?? "(not stated)",
      ruling: "",
      at: deps.now().toISOString(),
    });
    const second = await ctx.ui.select(title, labels.filter((label) => label !== DIVE_LABEL));
    if (second === undefined) return `${packet.id}: defect logged, left pending`;
    request = requestFromLabel(packet, second, undefined);
    if (request?.form === "defer") {
      const question = await ctx.ui.input("What should be checked?", "the question to drill");
      if (!question?.trim()) return `${packet.id}: defect logged, left pending`;
      request = { ...request, question };
    }
    if (request?.form === "custom") {
      const words = await ctx.ui.input("Your ruling", "what should happen");
      if (!words?.trim()) return `${packet.id}: defect logged, left pending`;
      request = { ...request, text: words };
    }
  } else if (chosen === DEFER_LABEL) {
    const question = await ctx.ui.input("What should be checked?", "the question to drill");
    if (!question?.trim()) return `${packet.id}: left pending`;
    request = { packetId: packet.id, form: "defer", question };
  } else if (chosen === CUSTOM_LABEL) {
    const words = await ctx.ui.input("Your ruling", "what should happen");
    if (!words?.trim()) return `${packet.id}: left pending`;
    request = { packetId: packet.id, form: "custom", text: words };
  } else {
    request = requestFromLabel(packet, chosen, undefined);
  }

  if (!request) return `${packet.id}: could not read that choice; left pending`;

  const result = await applyRuling(
    {
      store: deps.store,
      spawner: deps.spawner,
      now: deps.now,
      startDrill: (target, question) =>
        startDrill({ store: deps.store, spawner: deps.spawner, now: deps.now }, target, question),
    },
    request,
  );
  if ("error" in result) return `${packet.id}: ${result.error}`;
  const proposals = result.proposals.length > 0
    ? ` Queued ${result.proposals.length} proposal${result.proposals.length === 1 ? "" : "s"}.`
    : "";
  return `${packet.id}: ruled (${result.ruling.form}, ${result.ruling.coverage}). ${result.note}.${proposals}`;
}

function requestFromLabel(
  packet: Packet,
  label: string,
  text?: string,
): RulingRequest | undefined {
  if (label === DEFER_LABEL) return { packetId: packet.id, form: "defer" };
  if (label === CUSTOM_LABEL) {
    return { packetId: packet.id, form: "custom", ...(text ? { text } : {}) };
  }
  const recommended = packet.options.find((option) => option.id === packet.recommendationId);
  if (recommended && label.startsWith(recommended.label)) {
    return { packetId: packet.id, form: "accept" };
  }
  const alternative = packet.options.find((option) => label.startsWith(option.label));
  if (alternative) {
    return { packetId: packet.id, form: "alternative", optionId: alternative.id };
  }
  return undefined;
}

/** Validates the model's outcome submission into the typed union. */
export function toTriageOutcome(
  params: {
    outcome: "packet" | "continue" | "close" | "respawn";
    packet?: unknown;
    domain?: string;
    citation?: string;
    instruction?: string;
    summary?: string;
    unverified?: string;
    reason?: string;
    blastRadius?: "low" | "medium" | "high";
    reversibility?: "reversible" | "one-way";
  },
): { outcome: TriageOutcome } | { error: string } {
  switch (params.outcome) {
    case "packet": {
      if (!params.packet) return { error: "a packet outcome needs the packet" };
      return { outcome: { kind: "packet", packet: params.packet as PacketDraft } };
    }
    case "continue": {
      if (!params.domain || !params.citation || !params.instruction) {
        return {
          error:
            "a continue needs the domain, the doctrine citation that decides it, and the instruction",
        };
      }
      return {
        outcome: {
          kind: "continue",
          domain: params.domain,
          citation: params.citation,
          instruction: params.instruction,
          summary: params.summary ?? params.instruction,
          blastRadius: params.blastRadius ?? "low",
          reversibility: params.reversibility ?? "reversible",
        },
      };
    }
    case "close": {
      if (!params.domain || !params.summary) {
        return { error: "a close needs the domain and a summary of what shipped" };
      }
      return {
        outcome: {
          kind: "close",
          domain: params.domain,
          summary: params.summary,
          ...(params.unverified ? { unverified: params.unverified } : {}),
          ...(params.citation ? { citation: params.citation } : {}),
        },
      };
    }
    case "respawn": {
      if (!params.domain || !params.reason || !params.instruction) {
        return { error: "a respawn needs the domain, what it was doing, and the next step" };
      }
      return {
        outcome: {
          kind: "respawn",
          domain: params.domain,
          reason: params.reason,
          instruction: params.instruction,
        },
      };
    }
  }
}
