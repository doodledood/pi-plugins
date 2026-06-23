// gpt-fast-toggle.ts — /gpt-fast toggles OpenAI GPT API priority service tier.
// Fast = service_tier: "priority". Deep/not-fast = default service tier.
// This intentionally does not change reasoning/thinking level.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE_PATH = join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent", "gpt-fast-toggle.json");
const STATUS_KEY = "gpt-fast";

type TargetMode = "fast" | "deep";

export default function gptFastToggle(pi: any) {
  pi.on("session_start", (_event: any, ctx: any) => updateStatus(ctx));
  pi.on("model_select", (_event: any, ctx: any) => updateStatus(ctx));

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
