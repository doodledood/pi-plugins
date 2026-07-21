// Live cancel smoke: start a real panel with cheap models, cancel
// mid-flight, and verify both panelist sessions abort promptly and the
// original question is restored as unsent editor text.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runPanelCommand } from "./index.ts";
import { spawnPanelistSession } from "./host.ts";
import { isThinkingLevel, type PanelistSpec } from "./types.ts";

const rawModels = process.env.PANEL_SMOKE_MODELS ?? "anthropic/claude-haiku-4-5:off,openai/gpt-4.1-mini:off";
const specs: PanelistSpec[] = rawModels.split(",").map((raw) => {
  const [model, thinking] = [raw.slice(0, raw.lastIndexOf(":")), raw.slice(raw.lastIndexOf(":") + 1)];
  if (!model || !isThinkingLevel(thinking)) throw new Error(`bad PANEL_SMOKE_MODELS entry: ${raw}`);
  return { model, thinking };
});
const CANCEL_AFTER_MS = 3_000;
const ABORT_DEADLINE_MS = 15_000;

const workDir = mkdtempSync(join(tmpdir(), "panel-smoke-cancel-"));
const configPath = join(workDir, "panel.json");
writeFileSync(configPath, JSON.stringify({ panelists: specs, timeoutMs: 180_000 }));

const question = "Write a very long, detailed 2000-word essay about cats (this run is cancelled mid-flight on purpose).";
const sent: unknown[] = [];
const editorTexts: string[] = [];
const statuses: string[][] = [];
let lastStates: ReadonlyArray<{ status: string; error?: string; spec: { model: string } }> = [];

const pi = {
  sendMessage: (message: unknown) => sent.push(message),
  appendEntry: () => {},
} as unknown as ExtensionAPI;

const controller = new AbortController();
const ctx = {
  hasUI: false,
  signal: controller.signal,
  cwd: workDir,
  ui: {
    notify: (text: string) => console.log(`[notify] ${text}`),
    setEditorText: (text: string) => editorTexts.push(text),
    setWidget: () => {},
    custom: async () => null,
  },
  sessionManager: { buildContextEntries: () => [] },
} as unknown as ExtensionCommandContext;

const main = async () => {
  console.log(`cancel smoke: ${specs.map((s) => `${s.model}:${s.thinking}`).join(", ")}; cancelling after ${CANCEL_AFTER_MS}ms`);
  const run = runPanelCommand(
    pi,
    ctx,
    question,
    { spawn: spawnPanelistSession, sessionDir: join(workDir, "sessions"), configPath },
    {
      setActiveRun: (active) => {
        if (active) {
          statuses.push(active.states.map((s) => s.status));
          lastStates = active.states;
        }
      },
    },
  );
  setTimeout(() => {
    console.log("aborting…");
    controller.abort();
  }, CANCEL_AFTER_MS);
  const deadline = setTimeout(() => {
    console.error(`SMOKE FAIL: abort did not complete within ${ABORT_DEADLINE_MS}ms of cancellation`);
    process.exit(1);
  }, CANCEL_AFTER_MS + ABORT_DEADLINE_MS);
  await run;
  clearTimeout(deadline);

  const failures: string[] = [];
  for (const s of lastStates) console.log(`final: ${s.spec.model} status=${s.status} error=${s.error ?? "-"}`);
  const finalStatuses = statuses.at(-1) ?? [];
  if (!finalStatuses.every((s) => s === "cancelled")) {
    failures.push(`expected all panelists cancelled, got: ${finalStatuses.join(", ")}`);
  }
  if (editorTexts.at(-1) !== `/panel ${question}`) {
    failures.push(`editor text not restored; got: ${editorTexts.join(" | ") || "(none)"}`);
  } else {
    console.log("editor restore ok: original question returned as unsent editor text");
  }
  if (sent.length > 0) failures.push("messages were injected into context despite cancellation");

  if (failures.length > 0) {
    console.error(`SMOKE FAIL:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("SMOKE PASS");
  process.exit(0);
};

main().catch((error) => {
  console.error("SMOKE FAIL (unhandled)", error);
  process.exit(1);
});
