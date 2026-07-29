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

import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import {
  type AskAnswer,
  buildAskDialog,
  askDialogKey,
  type AskDialogRow,
  type AskKey,
  initialAskState,
  renderAskDialog,
} from "./ask-ui.ts";
import { loadDoctrine } from "./doctrine.ts";
import {
  drillContext,
  type DrillDeps,
  type PacketPatch,
  startDrill,
  logRuleSkipped,
  submitDrillResult,
} from "./drills.ts";
import { readyDomains } from "./graduation.ts";
import { buildFleetCard } from "./fleet.ts";
import { isPidAlive } from "./io.ts";
import { planPresentation } from "./queue.ts";
import { applyRuling, recordDive, type RulingRequest, createDoctrineProposal } from "./rulings.ts";
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
import { meetsPacketBar, type Packet, ruleGeneralityViolations } from "./types.ts";

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
  /** Read instead of process.env, so a worker tool's audience is injectable. */
  env: NodeJS.ProcessEnv;
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
  defers: Type.Optional(Type.Boolean({
    description:
      "True for an option that declines to decide yet, like \"hold and tell me more first\". Choosing it is not graded against your shadow ruling.",
  })),
});

const BlastSchema = StringEnum(["low", "medium", "high"] as const, {
  description: "How much this decision touches: low, medium, or high",
});
const ReversibilitySchema = StringEnum(["reversible", "one-way"] as const, {
  description: "Whether the decided step can be undone",
});

const ShadowSchema = Type.Object({
  optionId: Type.String({
    description:
      "The option you recommend, restated as the prediction to be graded — the recommendation and the shadow ruling are one decision in two roles",
  }),
  text: Type.String({ description: "The ruling you would have made" }),
  rationale: Type.String({ description: "Why — one or two sentences" }),
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
  blastRadius: BlastSchema,
  reversibility: ReversibilitySchema,
  doctrineCitations: Type.Array(Type.String({
    description:
      "The doctrine lines this decision rests on, copied exactly from inside the brackets. Empty means no rule covered it. This is what decides whether the user's ruling counted as covered by doctrine, so it is not optional.",
  })),
  shadowRuling: ShadowSchema,
  trivial: Type.Optional(Type.Boolean({ description: "Cheap enough to decide alongside others" })),
  dependsOn: Type.Optional(Type.Array(Type.String({ description: "Packet ids that must be ruled first" }))),
});

const DrillPatchSchema = Type.Object({
  question: Type.Optional(Type.String()),
  doctrineCitations: Type.Optional(Type.Array(Type.String())),
  options: Type.Optional(Type.Array(OptionSchema)),
  recommendationId: Type.Optional(Type.String()),
  flipCondition: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  domain: Type.Optional(Type.String()),
  blastRadius: Type.Optional(BlastSchema),
  reversibility: Type.Optional(ReversibilitySchema),
  trivial: Type.Optional(Type.Boolean()),
  shadowRuling: Type.Optional(ShadowSchema),
}, { description: "Only for a completion drill: the packet fields you filled in" });

const TriageOutcomeSchema = Type.Object({
  stopId: Type.String(),
  outcome: StringEnum(["packet", "continue", "close", "respawn"] as const, {
    description: "The one outcome for this stop",
  }),
  packet: Type.Optional(PacketDraftSchema),
  domain: Type.Optional(Type.String()),
  citation: Type.Optional(Type.String({
    description: "The doctrine line that decides it, copied exactly from inside the brackets",
  })),
  instruction: Type.Optional(Type.String({ description: "What the session should do next" })),
  summary: Type.Optional(Type.String()),
  unverified: Type.Optional(Type.String({ description: "What was not checked, for a close" })),
  reason: Type.Optional(Type.String({ description: "What it was doing, for a respawn" })),
  blastRadius: Type.Optional(BlastSchema),
  reversibility: Type.Optional(ReversibilitySchema),
});

export type TriageOutcomeParams = Static<typeof TriageOutcomeSchema>;

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
      if (envKind(deps.env) !== "triage") return refuse("this tool belongs to stop triage");
      const context = await triageContext(deps, params.stopId);
      if ("error" in context) return text(context.error);
      return text(
        [
          `Stop: ${context.stop.stopId}`,
          `Session: ${context.stop.sessionId} (${context.stop.kind}) in ${context.project}`,
          `Stop state: ${context.stop.stopState}`,
          ...(context.stop.handedOff
            ? [
              "Handed over: the user was working in this session themselves and handed it to HQ.",
              `What they said to do next: ${context.stop.mandate ?? "(nothing; read the transcript and decide)"}`,
            ]
            : []),
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
    parameters: TriageOutcomeSchema,
    async execute(_id, params) {
      if (envKind(deps.env) !== "triage") return refuse("this tool belongs to stop triage");
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

  // The packet a drill is about is fixed when the drill is spawned, so the run's
  // environment decides it rather than the model. A tier-2 drill is a resumed copy
  // of the source session: it was never told a packet id and must not have to
  // invent one to report what it found.
  const drillPacketId = (supplied?: string): string =>
    deps.env.HQ_PACKET_ID?.trim() || supplied?.trim() || "";

  pi.registerTool({
    name: "hq_drill_context",
    label: "HQ drill context",
    description:
      "The packet being drilled and the tail of the source session's transcript. Read this before answering.",
    parameters: Type.Object({ packetId: Type.String() }),
    async execute(_id, params) {
      if (envKind(deps.env) !== "drill") return refuse("this tool belongs to drill workers");
      const question = deps.env.HQ_DRILL_QUESTION ?? "";
      const tier = deps.env.HQ_DRILL_TIER === "2" ? 2 : 1;
      const context = await drillContext(drillDeps, drillPacketId(params.packetId), question, tier);
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
      packetId: Type.Optional(
        Type.String({ description: "Optional; the run already knows which packet it is about" }),
      ),
      answer: Type.String(),
      quotes: Type.Array(
        Type.Object({
          text: Type.String({ description: "Exact text from the source, not a paraphrase" }),
          attribution: Type.String({ description: "Where it came from" }),
        }),
      ),
      insufficient: Type.Optional(Type.Boolean()),
      patch: Type.Optional(DrillPatchSchema),
    }),
    async execute(_id, params) {
      if (envKind(deps.env) !== "drill") return refuse("this tool belongs to drill workers");
      const patch = params.patch ? toPacketPatch(params.patch) : undefined;
      const outcome = await submitDrillResult(drillDeps, {
        packetId: drillPacketId(params.packetId),
        question: deps.env.HQ_DRILL_QUESTION ?? "",
        tier: deps.env.HQ_DRILL_TIER === "2" ? 2 : 1,
        answer: params.answer,
        quotes: params.quotes,
        ...(params.insufficient ? { insufficient: true } : {}),
        ...(patch ? { patch } : {}),
      });
      if ("error" in outcome) return text(outcome.error);
      if (outcome.kind === "escalated") {
        return text("Reading was not enough; a copy of the session is being asked directly.");
      }
      return text(`Recorded on packet ${outcome.packet.id}; it is back in the queue.`);
    },
  });

  pi.registerTool({
    name: "hq_propose_rule",
    label: "HQ propose a doctrine rule",
    description:
      "Propose the standing rule a ruling implies. Queues it for the user to ratify; it never reaches doctrine on its own. Rules that name the case they came from are refused.",
    parameters: Type.Object({
      packetId: Type.String(),
      ruleText: Type.String({
        description:
          "One plainly written sentence stating what to do in a class of situations. No session, packet, path, branch or identifier names.",
      }),
    }),
    async execute(_id, params) {
      if (envKind(deps.env) !== "rule") return refuse("this tool belongs to rule drafting");
      const overfits = ruleGeneralityViolations(params.ruleText);
      if (overfits.length > 0) {
        // Refused rather than queued: a rule that cannot decide the next case would
        // cost the user a decision to reject, and doctrine is read on every cycle.
        return refuse(
          `That is not yet a rule that could decide another case: ${
            overfits.join("; ")
          }. Rewrite it as the general principle and call this again.`,
        );
      }
      const packet = await deps.store.readPacket(params.packetId);
      if (!packet) return text(`no such packet: ${params.packetId}`);
      const ruling = (await deps.store.listRulings()).findLast(
        (candidate) => candidate.packetId === params.packetId,
      );
      if (!ruling) return text(`no ruling recorded for ${params.packetId} yet`);
      const proposal = await createDoctrineProposal(deps, packet, ruling, params.ruleText);
      return text(
        proposal
          ? `queued ${proposal.id} for the user to ratify`
          : "that ruling needs no rule; nothing was queued",
      );
    },
  });

  pi.registerTool({
    name: "hq_skip_rule",
    label: "HQ skip the rule",
    description:
      "Record that a ruling implies no general rule, so nothing is proposed. Use when the ruling was a one-off rather than a preference about a class of cases.",
    parameters: Type.Object({ packetId: Type.String(), reason: Type.String() }),
    async execute(_id, params) {
      if (envKind(deps.env) !== "rule") return refuse("this tool belongs to rule drafting");
      // Logged where drills are logged: it is the same kind of fact — what a worker
      // was asked, and what it concluded — and it is the only trace that the question
      // was considered at all.
      await logRuleSkipped(deps.store, {
        at: deps.now().toISOString(),
        packetId: params.packetId,
        reason: params.reason,
      });
      return text("noted; no rule proposed");
    },
  });

  pi.registerTool({
    name: "hq_set_title",
    label: "HQ set session title",
    description: "Set the short board label for a session.",
    parameters: Type.Object({ sessionId: Type.String(), title: Type.String() }),
    async execute(_id, params) {
      if (envKind(deps.env) !== "titler") return refuse("this tool belongs to the titler");
      // The titler owns the title and nothing else: a whole-record write here
      // would revert whatever the session published while this ran.
      const patched = await deps.store.patchSessionState(params.sessionId, {
        title: params.title.trim().slice(0, 48),
      });
      if (!patched) return text(`no such session: ${params.sessionId}`);
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
      const denied = seatGuard(deps);
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
      const denied = seatGuard(deps);
      if (denied) return refuse(denied);
      if (!ctx.hasUI) return refuse("there is no interactive surface to ask on");

      const lines: string[] = [];
      const presentable: Packet[] = [];
      for (const packetId of params.packetIds) {
        const packet = await deps.store.readPacket(packetId);
        if (!packet) {
          lines.push(`${packetId}: gone from the queue`);
          continue;
        }
        // Status is store-maintained, but re-checking the bar here means the
        // presentation path defends itself against any writer, including a hand
        // edit of the queue file.
        if (packet.status !== "pending" || !meetsPacketBar(packet)) {
          lines.push(`${packetId}: ${packet.status}, not presentable`);
          continue;
        }
        presentable.push(packet);
      }

      // A batch the plan grouped is one dialog with a tab per decision, which is the
      // whole point of batching: one sitting, not one interruption each.
      if (presentable.length > 0 && typeof ctx.ui.custom === "function") {
        lines.push(...await askDialog(ctx, deps, presentable));
        return text(lines.join("\n"));
      }

      if (presentable.length > 1) {
        const batched = await askBatch(ctx, deps, presentable);
        lines.push(...batched.lines);
        for (const packet of batched.remaining) lines.push(await askOne(ctx, deps, packet));
        return text(lines.join("\n"));
      }

      for (const packet of presentable) lines.push(await askOne(ctx, deps, packet));
      return text(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "hq_fleet",
    label: "HQ fleet",
    description: "The board: every supervised session, its state, and how long since it spoke.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const denied = seatGuard(deps);
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
        // The tool and the card read readiness from the same place, so they cannot
        // disagree about which domains have earned a grant.
        readyToGraduate: readyDomains(await deps.store.readGraduation(), doctrine.meta, deps.now()),
        maxRows: 20,
      });
      return text(
        [
          card.header,
          ...card.rows.map(
            (row) =>
              `${row.glyph} ${row.label} — ${row.note}, ${row.age} ago`,
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
      const denied = seatGuard(deps);
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
      const denied = seatGuard(deps);
      if (denied) return refuse(denied);
      // Counting only "running" would miss a worker that is still booting, so a
      // burst of delegations could walk past the cap; counting anything not done
      // catches those. Liveness is probed so a worker killed without publishing
      // does not hold its slot forever.
      const live = (await deps.store.listFleet()).filter(
        (state) =>
          state.role === "managed" && state.kind === "worker" && state.state !== "done" &&
          isPidAlive(state.pid),
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
    name: "hq_drill",
    label: "HQ drill a packet",
    description:
      "Send a drill to find something out about a packet's source session, without waiting for it. The packet leaves the queue and returns annotated with the answer and verbatim quotes. Use this when a packet is missing something you would otherwise have to open the session for.",
    parameters: Type.Object({
      packetId: Type.String(),
      question: Type.String({ description: "Exactly what should be found out" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const denied = seatGuard(deps);
      if (denied) return refuse(denied);
      if (!params.question.trim()) return refuse("a drill needs a question");
      const result = await applyRuling(
        {
          store: deps.store,
          spawner: deps.spawner,
          now: deps.now,
          startDrill: (target, question) => startDrill(drillDeps, target, question),
        },
        { packetId: params.packetId, form: "defer", question: params.question },
      );
      if ("error" in result) return text(result.error);
      return text(
        `Drilling ${params.packetId}; it leaves the queue and comes back annotated. Carry on with the next packet.`,
      );
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
      const denied = seatGuard(deps);
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
      const denied = seatGuard(deps);
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

function seatGuard(deps: ToolDeps): string | undefined {
  if (isManagedEnv(deps.env)) return "a worker session cannot use the seat's tools";
  if (!deps.isSeatActive()) return "the HQ seat is not active in this session; run /hq first";
  return undefined;
}

const DEFER_LABEL = "Ask first — I want something checked";
const CUSTOM_LABEL = "In my own words…";
const DIVE_LABEL = "I had to open the session to decide";

/**
 * What a row means. Two rows cannot carry a finished ruling because the user has
 * not typed it yet — a deferral needs its question and a custom ruling needs its
 * words — so the row says what it still needs rather than carrying a half-built
 * request.
 */
export type AskIntent =
  | { kind: "ruling"; request: RulingRequest }
  | { kind: "needs-question" }
  | { kind: "needs-words" }
  | { kind: "dive" };

export interface AskRow {
  label: string;
  /**
   * What choosing this row costs, or what it records. The packet bar makes options
   * carry a price; a dialog that shows labels alone hides the very thing that makes
   * the decision possible without opening the session.
   */
  description: string;
  intent: AskIntent;
}

/**
 * The rows of one ask, in the pinned order: the recommendation first, then the
 * alternatives, then defer, then free text, then the dive row.
 *
 * Each row carries the ruling it means, so the choice is resolved by exact row
 * rather than by re-reading the display text. Option labels are model-authored,
 * and one label can be a prefix of another.
 */
export function buildAskRows(packet: Packet): AskRow[] {
  const recommended = packet.options.find((option) => option.id === packet.recommendationId);
  const alternatives = packet.options.filter((option) => option.id !== packet.recommendationId);
  const rows: AskRow[] = [
    ...(recommended
      ? [{
        label: `${recommended.label} (recommended)`,
        description: recommended.price,
        intent: {
          kind: "ruling",
          request: { packetId: packet.id, form: "accept" },
        } satisfies AskIntent,
      }]
      : []),
    ...alternatives.map((option): AskRow => ({
      label: option.label,
      description: option.price,
      intent: {
        kind: "ruling",
        request: { packetId: packet.id, form: "alternative", optionId: option.id },
      },
    })),
    {
      label: DEFER_LABEL,
      description: "The packet stays in the queue; a drill answers your question and brings it back.",
      intent: { kind: "needs-question" },
    },
    {
      label: CUSTOM_LABEL,
      description: "Rule in your own words; they are recorded and carried as written.",
      intent: { kind: "needs-words" },
    },
    {
      label: DIVE_LABEL,
      description: "Records what the packet was missing, then still takes your ruling.",
      intent: { kind: "dive" },
    },
  ];

  // The dialog returns the chosen *string*, so two rows that render identically
  // would be indistinguishable and the first would win. Numbering makes every row
  // unique whatever the model wrote in the labels.
  return rows.map((row, index) => ({ ...row, label: `${index + 1}) ${row.label}` }));
}

/**
 * Narrows a drill's patch to the fields a drill may rewrite, spelling the shadow
 * ruling's "no option fits" as null the way the stored shape does.
 */
function toPacketPatch(
  patch: Static<typeof DrillPatchSchema>,
): PacketPatch {
  const { shadowRuling, ...rest } = patch;
  if (!shadowRuling) return rest;
  return {
    ...rest,
    shadowRuling: {
      text: shadowRuling.text,
      rationale: shadowRuling.rationale,
      // Citations live on the packet; the shadow ruling repeats whatever the
      // patch set, so one record still reads as self-contained.
      doctrineCitations: patch.doctrineCitations ?? [],
      optionId: shadowRuling.optionId ?? null,
    },
  };
}

/** Turns a chosen row into a ruling, asking for the words it still needs. */
async function requestFor(
  ctx: ExtensionContext,
  packetId: string,
  intent: AskIntent,
): Promise<RulingRequest | undefined> {
  switch (intent.kind) {
    case "ruling":
      return intent.request;
    case "needs-question": {
      const question = await ctx.ui.input("What should be checked?", "the question to drill");
      return question?.trim() ? { packetId, form: "defer", question } : undefined;
    }
    case "needs-words": {
      const words = await ctx.ui.input("Your ruling", "what should happen");
      return words?.trim() ? { packetId, form: "custom", text: words } : undefined;
    }
    case "dive":
      return undefined;
  }
}

/**
 * One dialog for however many decisions were grouped: a tab each, nothing applied
 * until the user submits, and Esc leaves every one of them pending. The layout and the
 * keys live in ask-ui.ts so they can be asserted on without a terminal.
 */
async function askDialog(
  ctx: ExtensionContext,
  deps: ToolDeps,
  packets: readonly Packet[],
): Promise<string[]> {
  const tabs = buildAskDialog(packets);
  const collected = await ctx.ui.custom<Map<string, AskAnswer> | null>(
    (tui, theme, _keybindings, done) => {
      let state = initialAskState();
      // Keyed by width as well as invalidated on change: a cache that ignores the
      // width serves lines built for the old one after a resize, which is how a rule
      // ends up a different length from the prose inside it.
      let cached: { width: number; lines: string[] } | undefined;
      const editor = new Editor(tui, theme as unknown as EditorTheme);
      editor.onSubmit = (value: string) => {
        const result = askDialogKey(tabs, state, { text: value });
        state = result.state;
        editor.setText("");
        if (result.effect.kind === "submit") done(state.answers);
        else if (result.effect.kind === "cancel") done(null);
        cached = undefined;
        tui.requestRender();
      };
      const step = (key: AskKey) => {
        const result = askDialogKey(tabs, state, key);
        state = result.state;
        if (result.effect.kind === "submit") done(state.answers);
        else if (result.effect.kind === "cancel") done(null);
        cached = undefined;
        tui.requestRender();
      };
      return {
        render: (width: number) => {
          if (!cached || cached.width !== width) {
            cached = {
              width,
              lines: renderAskDialog(tabs, state, {
                theme,
                width,
                ...(state.typingFor ? { editorLines: editor.render(Math.max(1, width - 2)) } : {}),
              }),
            };
          }
          return cached.lines;
        },
        invalidate: () => {
          cached = undefined;
        },
        handleInput: (data: string) => {
          if (state.typingFor && !matchesKey(data, Key.escape)) {
            editor.handleInput(data);
            cached = undefined;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.up)) return step("up");
          if (matchesKey(data, Key.down)) return step("down");
          if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) return step("right");
          if (matchesKey(data, Key.left)) return step("left");
          if (matchesKey(data, Key.enter)) return step("enter");
          if (matchesKey(data, Key.escape)) return step("escape");
          if (/^[1-9]$/.test(data)) return step({ digit: Number(data) });
        },
      };
    },
  );

  if (!collected) return [`left ${packets.length} packet(s) pending`];

  const lines: string[] = [];
  for (const packet of packets) {
    const tab = tabs.find((candidate) => candidate.packetId === packet.id);
    const answer = collected.get(packet.id);
    const row = tab && answer ? tab.rows[answer.rowIndex] : undefined;
    if (!row) {
      lines.push(`${packet.id}: left pending`);
      continue;
    }
    lines.push(await applyDialogAnswer(deps, packet, row, answer?.text));
  }
  return lines;
}

/** Turns one row of the dialog into the recorded ruling it stands for. */
async function applyDialogAnswer(
  deps: ToolDeps,
  packet: Packet,
  row: AskDialogRow,
  typed: string | undefined,
): Promise<string> {
  const words = typed?.trim() ?? "";
  if (row.kind === "dive") {
    // The dive is the signal worth keeping even though it carries no ruling: it says
    // the packet failed the bar in practice, whatever the user then decided.
    await recordDive(deps.store, {
      packetId: packet.id,
      missing: words || "(not stated)",
      ruling: "(left pending)",
      at: deps.now().toISOString(),
    });
    return `${packet.id}: defect logged, left pending`;
  }

  const request: RulingRequest = row.kind === "defer"
    ? { packetId: packet.id, form: "defer", question: words }
    : row.kind === "words"
    ? { packetId: packet.id, form: "custom", text: words }
    : row.recommended
    ? { packetId: packet.id, form: "accept" }
    : { packetId: packet.id, form: "alternative", optionId: row.optionId ?? "" };

  const result = await applyRuling(
    {
      store: deps.store,
      spawner: deps.spawner,
      now: deps.now,
      startDrill: (target, question) =>
        startDrill({ store: deps.store, spawner: deps.spawner, now: deps.now }, target, question),
    },
    { ...request, presentedGeneration: packet.generation },
  );
  if ("error" in result) return `${packet.id}: ${result.error}`;
  const proposals = result.proposals.length > 0 ? `; ${result.proposals.length} proposal(s) queued` : "";
  return `${packet.id}: ruled (${result.ruling.form}, ${result.ruling.coverage}). ${result.note}${proposals}`;
}

/**
 * One ask covering a whole batch: accept every recommendation at once, or fall
 * through to deciding them one at a time. Anything not settled here comes back as
 * `remaining` for the per-packet path.
 */
async function askBatch(
  ctx: ExtensionContext,
  deps: ToolDeps,
  packets: readonly Packet[],
): Promise<{ lines: string[]; remaining: Packet[] }> {
  const summary = packets
    .map((packet) => {
      const recommended = packet.options.find((option) => option.id === packet.recommendationId);
      return `• ${packet.title} → ${recommended?.label ?? "(no recommendation)"}`;
    })
    .join("\n");
  const acceptAll = `Accept all ${packets.length} recommendations`;
  const oneAtATime = "Decide them one at a time";

  const chosen = await ctx.ui.select(
    `${packets.length} decisions in ${packets[0]?.project ?? "this project"}:\n${summary}`,
    [acceptAll, oneAtATime],
  );
  if (chosen === undefined) {
    return { lines: [`left ${packets.length} packets pending`], remaining: [] };
  }
  if (chosen !== acceptAll) return { lines: [], remaining: [...packets] };

  const lines: string[] = [];
  for (const packet of packets) {
    const result = await applyRuling(
      {
        store: deps.store,
        spawner: deps.spawner,
        now: deps.now,
        startDrill: (target, question) =>
          startDrill({ store: deps.store, spawner: deps.spawner, now: deps.now }, target, question),
      },
      { packetId: packet.id, form: "accept", presentedGeneration: packet.generation },
    );
    lines.push(
      "error" in result
        ? `${packet.id}: ${result.error}`
        : `${packet.id}: ruled (accept, ${result.ruling.coverage}). ${result.note}.`,
    );
  }
  return { lines, remaining: [] };
}

/**
 * What sits above the rows: the decision, then what it costs to get wrong. The bar
 * makes a packet carry its flip condition, blast radius and reversibility, and this is
 * the moment they are worth reading — a plain selector title threw them away.
 */
export function askHeader(packet: Packet): string[] {
  const replaced = packet.supersedes ?? [];
  return [
    packet.title,
    packet.question,
    `${packet.blastRadius} blast · ${packet.reversibility} · changes if: ${packet.flipCondition}`,
    // The earlier ask is gone from the queue, and the user is the one who knows
    // whether what it asked still matters.
    replaced.length > 0
      ? `replaces ${replaced.length} earlier question${
        replaced.length === 1 ? "" : "s"
      } from this session: ${replaced.join("; ")}`
      : "",
  ].filter((line) => line.trim() !== "");
}

/** How the rows read where there is no TUI to draw them in: price on the same line. */
export function askFallbackLines(rows: readonly AskRow[]): string[] {
  return rows.map((row) => `${row.label} — ${row.description}`);
}

/**
 * Puts one ask on screen and returns what the user picked. With a TUI this is pi's own
 * SelectList, so every row shows its price under its label and a long option list
 * scrolls instead of being crushed onto one line each. Without one — an RPC client, a
 * headless seat — the plain selector still carries the price inline.
 */
async function pickRow(
  ctx: ExtensionContext,
  header: readonly string[],
  rows: readonly AskRow[],
): Promise<AskRow | undefined> {
  if (typeof ctx.ui.custom === "function") {
    const picked = await ctx.ui.custom<number>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
      for (const [index, line] of header.entries()) {
        container.addChild(
          new Text(index === 0 ? theme.fg("accent", theme.bold(line)) : theme.fg("muted", line), 1, 0),
        );
      }
      const list = new SelectList(
        rows.map((row, index): SelectItem => ({
          value: String(index),
          label: row.label,
          description: row.description,
        })),
        Math.min(rows.length, 10),
        {
          selectedPrefix: (line: string) => theme.fg("accent", line),
          selectedText: (line: string) => theme.fg("accent", line),
          description: (line: string) => theme.fg("muted", line),
          scrollInfo: (line: string) => theme.fg("dim", line),
          noMatch: (line: string) => theme.fg("warning", line),
        },
      );
      list.onSelect = (item: SelectItem) => done(Number(item.value));
      list.onCancel = () => done(-1);
      container.addChild(list);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ move · enter rule · esc leave it pending"), 1, 0),
      );
      container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
    return picked >= 0 ? rows[picked] : undefined;
  }

  const lines = askFallbackLines(rows);
  const chosen = await ctx.ui.select(header.join("\n"), lines);
  if (chosen === undefined) return undefined;
  const index = lines.indexOf(chosen);
  return index >= 0 ? rows[index] : undefined;
}

/**
 * One ask, presented through pi's own dialogs, ending in a recorded ruling.
 */
async function askOne(ctx: ExtensionContext, deps: ToolDeps, packet: Packet): Promise<string> {
  const rows = buildAskRows(packet);
  const header = askHeader(packet);

  let selected = await pickRow(ctx, header, rows);
  if (!selected) return `${packet.id}: left pending`;

  let dive: { packetId: string; missing: string } | undefined;

  if (selected?.intent.kind === "dive") {
    const missing = await ctx.ui.input(
      "What was missing from the packet?",
      "what you had to go and find out",
    );
    const remaining = rows.filter((row) => row.intent.kind !== "dive");
    const second = await pickRow(ctx, header, remaining);
    if (!second) {
      // The dive itself is the signal worth keeping, even with no ruling behind it.
      await recordDive(deps.store, {
        packetId: packet.id,
        missing: missing?.trim() || "(not stated)",
        ruling: "(left pending)",
        at: deps.now().toISOString(),
      });
      return `${packet.id}: defect logged, left pending`;
    }
    selected = second;
    dive = { packetId: packet.id, missing: missing?.trim() || "(not stated)" };
  }

  if (!selected) return `${packet.id}: could not read that choice; left pending`;

  const request = await requestFor(ctx, packet.id, selected.intent);
  const answered = request ? { ...request, presentedGeneration: packet.generation } : undefined;
  if (!answered) {
    if (dive) await flushDive(deps, dive, "(left pending)");
    return `${packet.id}: left pending${dive ? " (defect logged)" : ""}`;
  }

  const result = await applyRuling(
    {
      store: deps.store,
      spawner: deps.spawner,
      now: deps.now,
      startDrill: (target, question) =>
        startDrill({ store: deps.store, spawner: deps.spawner, now: deps.now }, target, question),
    },
    answered,
  );
  if ("error" in result) {
    if (dive) await flushDive(deps, dive, "(ruling failed)");
    return `${packet.id}: ${result.error}`;
  }

  // The defect is written after the ruling so it can name what the user decided
  // once they had looked — that pairing is the whole value of the log.
  if (dive) await flushDive(deps, dive, result.ruling.text || result.ruling.form);

  const proposals = result.proposals.length > 0
    ? ` Queued ${result.proposals.length} proposal${result.proposals.length === 1 ? "" : "s"}.`
    : "";
  return `${packet.id}: ruled (${result.ruling.form}, ${result.ruling.coverage}). ${result.note}.${proposals}`;
}

async function flushDive(
  deps: ToolDeps,
  dive: { packetId: string; missing: string },
  ruling: string,
): Promise<void> {
  await recordDive(deps.store, {
    packetId: dive.packetId,
    missing: dive.missing,
    ruling,
    at: deps.now().toISOString(),
  });
}

/**
 * Validates the model's outcome submission into the typed union.
 *
 * An omitted blast radius or reversibility fails *closed* — high and one-way —
 * so a continue that forgot to declare its consequences reaches the user rather
 * than sliding under the ceiling.
 */
export function toTriageOutcome(
  params: TriageOutcomeParams,
): { outcome: TriageOutcome } | { error: string } {
  switch (params.outcome) {
    case "packet": {
      if (!params.packet) return { error: "a packet outcome needs the packet" };
      const packet: PacketDraft = {
        ...params.packet,
        shadowRuling: {
          text: params.packet.shadowRuling.text,
          rationale: params.packet.shadowRuling.rationale,
          optionId: params.packet.shadowRuling.optionId,
          // Coverage is decided by the packet's citations; the shadow ruling
          // repeats them so a reader of one record sees what it rested on.
          doctrineCitations: params.packet.doctrineCitations,
        },
      };
      return { outcome: { kind: "packet", packet } };
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
          blastRadius: params.blastRadius ?? "high",
          reversibility: params.reversibility ?? "one-way",
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
