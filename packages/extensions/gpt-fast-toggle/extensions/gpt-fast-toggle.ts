// gpt-fast-toggle.ts — /gpt-fast toggles OpenAI GPT API priority service tier.
// Fast = service_tier: "priority". Deep/not-fast = default service tier.
// This intentionally does not change reasoning/thinking level.
//
// Priority is billed above the standard rate, and pi prices a turn from its static
// per-model rates, so a session that ran in fast mode costs more than any cost
// surface can tell from the usage alone. The tier in force is therefore recorded in
// the session as a context-excluded custom entry whenever it changes (and once at
// session start), so a later scan can tell which turns paid the premium.
// The premium itself is a configured multiplier: `priorityMultiplier` in the state
// file below. Without it, cost surfaces mark the total approximate rather than low.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE_PATH = join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent", "gpt-fast-toggle.json");
const STATUS_KEY = "gpt-fast";
/** Custom-entry type read by cost surfaces to price priority-tier turns. */
export const PRICE_TIER_RECORD_TYPE = "pi-price-tier";

type TargetMode = "fast" | "deep";
type BillingTier = "standard" | "priority";

export default function gptFastToggle(pi: any) {
  // Tier actually recorded in this session, so repeats are not appended per event.
  let recordedTier: BillingTier | undefined;

  const recordTier = (ctx: any, tier: BillingTier) => {
    if (tier === recordedTier) return;
    recordedTier = tier;
    try {
      pi.appendEntry(PRICE_TIER_RECORD_TYPE, { tier });
    } catch {
      // Session may be ephemeral or shutting down; the toggle itself still works.
    }
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    updateStatus(ctx);
    recordedTier = undefined;
    recordTier(ctx, effectiveTier(ctx.model));
  });
  pi.on("model_select", (_event: any, ctx: any) => {
    updateStatus(ctx);
    // Switching off an OpenAI GPT model ends priority billing even with fast mode on.
    recordTier(ctx, effectiveTier(ctx.model));
  });

  pi.on("before_provider_request", (event: any, ctx: any) => {
    if (readSavedMode() !== "fast") return undefined;
    if (!supportsPriorityServiceTier(ctx.model)) return undefined;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;

    return {
      ...event.payload,
      service_tier: "priority",
    };
  });

  pi.registerCommand("gpt-fast", {
    description:
      "Toggle OpenAI GPT fast mode via service_tier=priority. Args: on/fast/enable or off/deep/disable. Empty toggles priority mode.",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "toggle", "fast", "deep"];
      const matches = options.filter((value) => value.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const target = parseTargetMode(args, readSavedMode() ?? "deep");
      if (!target) {
        ctx.ui.notify('Usage: /gpt-fast [on|off|toggle|fast|deep]', "warning");
        return;
      }
      await applyGptMode(ctx, target);
      recordTier(ctx, effectiveTier(ctx.model));
    },
  });
}

async function applyGptMode(ctx: any, mode: TargetMode): Promise<void> {
  const model = ctx.model;
  if (!supportsPriorityServiceTier(model)) {
    ctx.ui.notify(
      "GPT fast mode only applies to direct OpenAI GPT API models. Use /model to switch to openai/gpt-* first.",
      "warning",
    );
    return;
  }

  saveMode(mode);
  updateStatus(ctx);

  ctx.ui.notify(
    mode === "fast"
      ? `GPT fast mode enabled: ${model.provider}/${model.id} · service_tier=priority · thinking unchanged`
      : `GPT fast mode disabled: ${model.provider}/${model.id} · default service tier · thinking unchanged`,
    "info",
  );
}

function parseTargetMode(args: string | undefined, currentMode: TargetMode): TargetMode | undefined {
  const value = (args ?? "").trim().toLowerCase();
  if (value === "" || value === "toggle") return currentMode === "fast" ? "deep" : "fast";
  if (["on", "fast", "enable", "enabled", "true", "1"].includes(value)) return "fast";
  if (["off", "not-fast", "notfast", "slow", "deep", "disable", "disabled", "false", "0"].includes(value)) {
    return "deep";
  }
  return undefined;
}

function updateStatus(ctx: any): void {
  if (!supportsPriorityServiceTier(ctx.model)) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, readSavedMode() === "fast" ? "GPT priority" : undefined);
}

function readSavedMode(): TargetMode | undefined {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return parsed?.mode === "fast" || parsed?.mode === "deep" ? parsed.mode : undefined;
  } catch {
    return undefined;
  }
}

function saveMode(mode: TargetMode): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ mode }, null, 2)}\n`);
}

function supportsPriorityServiceTier(model: any): boolean {
  if (!model?.provider || !model?.id) return false;
  return model.provider === "openai" && /^gpt-/i.test(model.id);
}

/** The tier turns are actually billed at: priority only when fast mode applies to this model. */
export function effectiveTier(model: any, mode: TargetMode | undefined = readSavedMode()): BillingTier {
  return mode === "fast" && supportsPriorityServiceTier(model) ? "priority" : "standard";
}
