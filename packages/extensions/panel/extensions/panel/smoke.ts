// Live smoke (AC-5.1): a real /panel run against real providers with CHEAP
// models at low effort — never the xhigh default lineup (PG-5).
//
//   PANEL_SMOKE_MODELS="anthropic/claude-haiku-4-5:off,openai/gpt-4.1-mini:off" npm run smoke
//
// Drives the real command layer (runPanelCommand) with a scripted UI context
// and the production spawner, then feeds the injected messages to one more
// cheap "main model" session to prove consumption end to end.
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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

const workDir = mkdtempSync(join(tmpdir(), "panel-smoke-"));
const sessionDir = join(workDir, "sessions");
const configPath = join(workDir, "panel.json");
writeFileSync(configPath, JSON.stringify({ panelists: specs, timeoutMs: 180_000 }));

const question = "In one short sentence: what cat name did the user like earlier in this conversation, and is it a good name?";

const sent: Array<{ customType: string; content: string; display: boolean }> = [];
const entries: Array<{ customType: string; data: unknown }> = [];
const pi = {
  sendMessage: (message: { customType: string; content: string; display: boolean }) => sent.push(message),
  appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
} as unknown as ExtensionAPI;

const ctx = {
  hasUI: false,
  signal: undefined,
  cwd: workDir,
  ui: {
    notify: (text: string, level?: string) => console.log(`[notify:${level ?? "info"}] ${text}`),
    setEditorText: () => {},
    setWidget: () => {},
    custom: async () => null,
  },
  sessionManager: {
    buildContextEntries: () => [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "We are naming a cat. I like 'Mochi'." }], timestamp: Date.now() - 20_000 } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Noted: the candidate name is Mochi." }],
          stopReason: "stop",
          timestamp: Date.now() - 10_000,
          model: "seed",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        },
      },
    ],
  },
} as unknown as ExtensionCommandContext;

const main = async () => {
  console.log(`panel smoke: ${specs.map((s) => `${s.model}:${s.thinking}`).join(", ")}`);
  const startedAt = Date.now();
  await runPanelCommand(pi, ctx, question, { spawn: spawnPanelistSession, sessionDir, configPath }, { setActiveRun: () => {} });
  console.log(`panel finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);

  const failures: string[] = [];
  const answers = sent.filter((m) => m.customType === "panel-answer");
  if (sent[0]?.customType !== "panel-question") failures.push("first injected message is not the panel question");
  if (answers.length !== specs.length) failures.push(`expected ${specs.length} answer messages, got ${answers.length}`);
  for (const answer of answers) {
    console.log(`\n--- injected ---\n${answer.content.slice(0, 400)}\n`);
    if (!/Independent opinion from panelist/.test(answer.content)) failures.push("answer missing attribution framing");
    if (!/mochi/i.test(answer.content)) failures.push("a panelist answer does not mention the seeded fork content (Mochi)");
  }
  const meta = entries.find((e) => e.customType === "panel-meta")?.data as
    | { panelists?: Array<{ sessionFile?: string; ok?: boolean }> }
    | undefined;
  for (const p of meta?.panelists ?? []) {
    if (!p.ok) failures.push("a panelist did not complete ok");
    if (!p.sessionFile || !existsSync(p.sessionFile)) failures.push(`panelist session file missing: ${p.sessionFile}`);
    else console.log(`session file ok: ${p.sessionFile}`);
  }

  // Consumption: a cheap "main model" session seeded with the injected messages must use them.
  const consumer = await spawnPanelistSession({
    spec: specs[0] as PanelistSpec,
    systemPrompt: "You are the main assistant. Panel opinions appear in the conversation as context messages.",
    forkMessages: sent.map((m) => ({
      role: "custom",
      customType: m.customType,
      content: m.content,
      display: m.display,
      timestamp: Date.now(),
    })) as never,
    cwd: workDir,
    sessionDir,
  });
  await consumer.prompt("Based only on the panel opinions above, what cat name did they discuss? One word.");
  const reply = JSON.stringify(consumer.messages.at(-1));
  consumer.dispose();
  console.log(`\nmain-model consumption reply: ${reply.slice(0, 300)}`);
  if (!/mochi/i.test(reply)) failures.push("main-model reply did not consume the panel answers");

  if (failures.length > 0) {
    console.error(`\nSMOKE FAIL:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nSMOKE PASS");
  process.exit(0);
};

main().catch((error) => {
  console.error("SMOKE FAIL (unhandled)", error);
  process.exit(1);
});
