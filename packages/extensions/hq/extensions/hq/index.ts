/**
 * HQ: supervise delegated pi sessions as one ordered decision queue.
 *
 * This file is wiring only. In every session it starts the reporter; in a session
 * the user turns into the seat with /hq it adds the chief-of-staff posture, the
 * queue tools, and the fleet card.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type HqConfig } from "./config.ts";
import { loadDoctrine, seedDoctrine, seedProjectDoctrine } from "./doctrine.ts";
import { buildFleetCard, type FleetCardModel } from "./fleet.ts";
import { graduateDomain, revokeDomain } from "./graduation.ts";
import { resolveStateRoot } from "./paths.ts";
import { SEAT_PROMPT } from "./prompts.ts";
import { SessionReporter } from "./reporter.ts";
import { createSpawner, isManagedEnv, type Spawner } from "./spawn.ts";
import { HqStore, pruneState, reopenStalledDrills } from "./store.ts";
import { sweepStops } from "./triage.ts";
import { registerHqTools } from "./tools.ts";
import { FLEET_OVERLAY_OPTIONS, FleetOverlay } from "./ui.ts";

export const SEAT_MESSAGE_TYPE = "hq-seat";

/** How long HQ keeps its own bookkeeping before pruning it on the next seat. */
export const RETENTION_DAYS = 14;

/** A drill silent for this long is assumed dead and its packet is re-queued. */
export const STALLED_DRILL_MINUTES = 30;

export interface HqExtensionOptions {
  stateRoot?: string;
  config?: HqConfig;
  spawner?: Spawner;
  now?: () => Date;
}

export function createHqExtension(options: HqExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const root = options.stateRoot ?? resolveStateRoot();
    const config = options.config ?? loadConfig();
    const now = options.now ?? (() => new Date());
    // Substrate failures are reported rather than swallowed: a packet that cannot
    // be parsed would otherwise vanish from the queue with no sign a decision was
    // dropped. In a headless worker there is no UI, so it goes to stderr.
    const problems: string[] = [];
    const report = (message: string, error: unknown): void => {
      const line = `HQ: ${message}: ${error instanceof Error ? error.message : String(error)}`;
      problems.push(line);
      if (problems.length > 20) problems.shift();
      process.stderr.write(`${line}\n`);
      lastProblemAt = now().toISOString();
    };
    let lastProblemAt: string | undefined;
    const store = new HqStore({ root, now, onError: report });
    const spawner = options.spawner ?? createSpawner({ root, onError: report });

    let reporter: SessionReporter | undefined;
    let seatActive = false;
    let seatPromptSent = false;
    let overlayVisible = false;
    let overlayHandle: { hide(): void; setHidden(hidden: boolean): void; unfocus(options?: unknown): void } | undefined;
    let overlayComponent: FleetOverlay | undefined;
    let cardModel: FleetCardModel | undefined;
    let cardTimer: ReturnType<typeof setInterval> | undefined;

    const doneToday = async (): Promise<number> => {
      const today = now().toISOString().slice(0, 10);
      const counts = await store.countToday(today);
      return counts.rulings + counts.audits;
    };

    const refreshCard = async (): Promise<void> => {
      const [fleet, packets, doctrine, done] = await Promise.all([
        store.listFleet(),
        store.listQueue(),
        loadDoctrine(root, undefined, report),
        doneToday(),
      ]);
      // The doctrine file is the only source for the staleness threshold, so the
      // card and the hq_fleet tool cannot disagree about it.
      cardModel = buildFleetCard({
        fleet,
        packets,
        doneToday: done,
        now: now(),
        meta: doctrine.meta,
      });
    };

    registerHqTools(pi, {
      store,
      spawner,
      now,
      isSeatActive: () => seatActive,
      defaultCwd: () => process.cwd(),
      doneToday,
      maxConcurrentWorkers: config.maxConcurrentWorkers,
      env: process.env,
    });

    pi.on("session_start", async (_event, ctx) => {
      reporter = new SessionReporter({
        store,
        spawner,
        ctx,
        now,
        ...(config.titleModel ? { titleModel: config.titleModel } : {}),
      });
      await reporter.start();
      await seedDoctrine(root);
      await seedProjectDoctrine(root, ctx.cwd);
    });

    pi.on("agent_start", async () => {
      await reporter?.onAgentStart();
    });

    pi.on("agent_end", (event) => {
      reporter?.onAgentEnd(event.messages);
    });

    pi.on("agent_settled", async () => {
      await reporter?.onAgentSettled();
      if (seatActive) await refreshCard();
    });

    pi.on("session_shutdown", async () => {
      overlayComponent?.dispose();
      if (cardTimer) clearInterval(cardTimer);
      await reporter?.onShutdown();
    });

    // The seat's posture rides as a hidden message rather than a system-prompt
    // replacement, which keeps the prompt cache stable across turns.
    pi.on("before_agent_start", async () => {
      if (!seatActive || seatPromptSent) return;
      seatPromptSent = true;
      return {
        message: {
          customType: SEAT_MESSAGE_TYPE,
          content: SEAT_PROMPT,
          display: false,
        },
      };
    });

    pi.registerCommand("hq", {
      description: "Take the HQ seat: process the decision queue (/hq off to hand it back)",
      handler: async (args, ctx) => {
        if (isManagedEnv()) {
          ctx.ui.notify("This is a managed worker session; the seat belongs to your own session.", "warning");
          return;
        }
        const argument = args.trim().toLowerCase();
        if (argument === "off") {
          seatActive = false;
          seatPromptSent = false;
          hideOverlay();
          ctx.ui.notify("HQ seat released.", "info");
          return;
        }

        seatActive = true;
        seatPromptSent = false;
        await store.ensure();
        await seedDoctrine(root);
        // Anything whose triage never finished is picked up here, so a crashed
        // worker cannot quietly cost the user a decision.
        const swept = await sweepStops({ store, spawner, now, onError: report });
        // HQ's own bookkeeping is not history the user asked to keep: dead session
        // rows, finished stops and worker logs age out, so the board and the
        // sweeps stay bounded however long HQ has been running.
        const pruned = await pruneState(root, { days: RETENTION_DAYS, now: now() });
        // A drill whose worker died leaves its packet parked; the seat returns it
        // to the queue rather than losing the decision behind it.
        const revived = await reopenStalledDrills(store, {
          minutes: STALLED_DRILL_MINUTES,
          now: now(),
        });
        await refreshCard();
        await showOverlay(ctx);

        const pending = (await store.listPresentable()).length;
        ctx.ui.notify(
          `HQ seat active. ${pending} packet${pending === 1 ? "" : "s"} to rule${
            swept.retried.length > 0 ? `; ${swept.retried.length} stop(s) re-triaged` : ""
          }${
            pruned.sessions + pruned.stops + pruned.logs > 0
              ? `; pruned ${pruned.sessions} session rows, ${pruned.stops} stops, ${pruned.logs} logs`
              : ""
          }${revived.length > 0 ? `; re-queued ${revived.length} stalled drill(s)` : ""}${lastProblemAt ? `; ${problems.length} substrate problem(s) reported` : ""}.`,
          "info",
        );
        for (const problem of problems.slice(-3)) ctx.ui.notify(problem, "warning");
        pi.sendUserMessage(
          pending > 0
            ? "Take the seat: read the queue plan and put the first ask to me."
            : "Take the seat. The queue is empty, so just tell me what the fleet is doing.",
          { deliverAs: "followUp" },
        );
      },
    });

    pi.registerCommand("fleet", {
      description: "Show or hide the HQ fleet card",
      handler: async (_args, ctx) => {
        if (overlayVisible) {
          hideOverlay();
          return;
        }
        await refreshCard();
        await showOverlay(ctx);
      },
    });

    pi.registerCommand("hq_graduate", {
      description:
        "Grant HQ authority to answer a domain from doctrine: /hq_graduate <domain> (user only)",
      handler: async (args, ctx) => {
        const domain = args.trim();
        if (!domain) {
          ctx.ui.notify("Name the domain to graduate, e.g. /hq_graduate ci-flake", "warning");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          `Graduate "${domain}"?`,
          "HQ will answer decisions in this domain from doctrine without asking you, as long as they are reversible and not high-blast. Irreversible and high-blast decisions still come to you. Revoke any time with /hq_revoke.",
        );
        if (!confirmed) return;
        const stats = await graduateDomain(store, domain, now().toISOString());
        ctx.ui.notify(
          `Graduated ${domain} (${stats.agreements} prior agreements). Ask me for the audit sample to see what it answers without you.`,
          "info",
        );
      },
    });

    pi.registerCommand("hq_revoke", {
      description: "Take a domain back: /hq_revoke <domain>",
      handler: async (args, ctx) => {
        const domain = args.trim();
        if (!domain) {
          ctx.ui.notify("Name the domain to revoke.", "warning");
          return;
        }
        await revokeDomain(store, domain);
        ctx.ui.notify(`${domain} comes back to you.`, "info");
      },
    });

    function hideOverlay(): void {
      overlayVisible = false;
      overlayComponent?.dispose();
      overlayComponent = undefined;
      overlayHandle?.hide();
      overlayHandle = undefined;
      if (cardTimer) {
        clearInterval(cardTimer);
        cardTimer = undefined;
      }
    }

    async function showOverlay(ctx: ExtensionCommandContext): Promise<void> {
      if (overlayVisible || !ctx.hasUI || ctx.mode !== "tui") return;
      overlayVisible = true;
      cardTimer = setInterval(() => void refreshCard(), 5_000);
      cardTimer.unref?.();

      void ctx.ui.custom<void>(
        (tui, _theme, _keybindings, done) => {
          overlayComponent = new FleetOverlay({
            getModel: () => cardModel,
            requestRender: () => tui.requestRender(),
          });
          void done;
          return overlayComponent;
        },
        {
          overlay: true,
          overlayOptions: FLEET_OVERLAY_OPTIONS,
          onHandle: (handle) => {
            overlayHandle = handle;
            // The card is a glance, never a seat: it releases input immediately so
            // the editor keeps every keystroke.
            handle.unfocus({ target: null });
          },
        },
      );
    }
  };
}

export default createHqExtension();
