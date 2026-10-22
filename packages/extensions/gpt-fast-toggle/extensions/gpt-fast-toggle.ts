// gpt-fast-toggle.ts — /gpt-fast toggles OpenAI GPT API priority service tier.
// Fast = service_tier: "priority". Deep/not-fast = default service tier.
// This intentionally does not change reasoning/thinking level.
//
// Priority is billed above the standard rate. pi-ai prices each turn from the
// service tier the provider reports billing it at, so a priority turn's recorded
// cost already carries the premium and nothing here needs to record the tier.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "gpt-fast";

/** Resolved per call through Pi's own agent-directory resolver, so it is the directory Pi uses. */
function statePath(): string {
  return join(getAgentDir(), "gpt-fast-toggle.json");
}

type TargetMode = "fast" | "deep";
type BillingTier = "standard" | "priority";

export default function gptFastToggle(pi: any) {
  pi.on("session_start", (_event: any, ctx: any) => updateStatus(ctx));
  pi.on("model_select", (_event: any, ctx: any) => updateStatus(ctx));

  // The mode is read per request, so a toggle made in another pi process applies at once.
  pi.on("before_provider_request", (event: any, ctx: any) => {
    if (effectiveTier(ctx.model, readSavedMode()) !== "priority") return undefined;
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

export function readSavedMode(): TargetMode | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
    return parsed?.mode === "fast" || parsed?.mode === "deep" ? (parsed.mode as TargetMode) : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the mode without disturbing other keys in the file. */
function saveMode(mode: TargetMode): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable: start from an empty object rather than failing the toggle.
  }
  writeFileSync(path, `${JSON.stringify({ ...existing, mode }, null, 2)}\n`);
}

function supportsPriorityServiceTier(model: any): boolean {
  if (!model?.provider || !model?.id) return false;
  return model.provider === "openai" && /^gpt-/i.test(model.id);
}

/** The tier turns are actually billed at: priority only when fast mode applies to this model. */
export function effectiveTier(model: any, mode: TargetMode | undefined = readSavedMode()): BillingTier {
  return mode === "fast" && supportsPriorityServiceTier(model) ? "priority" : "standard";
}
