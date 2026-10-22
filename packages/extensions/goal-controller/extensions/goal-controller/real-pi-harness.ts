// Real-session test harness: a real Pi 1.4 AgentSession with the real goal-controller
// extension loaded via extensionFactories, a scripted deterministic provider, and a
// controllable fake checker (the only fake: the checker subprocess).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type JsonObject,
} from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { activate } from "./index.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { CheckerRunner, CheckerRunInput } from "./checker.ts";
import type { CheckerVerdict, GoalControllerConfig } from "./types.ts";

process.env.PI_OFFLINE ??= "1";

const PROVIDER = "scripted-goal";
const API = "scripted-goal-api";
export const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const model: Model<any> = {
  id: "det", name: "det", api: API, provider: PROVIDER, baseUrl: "http://127.0.0.1/never",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000, maxTokens: 1_000,
};

export type Reply =
  | { kind: "text"; text: string }
  | { kind: "error"; errorMessage: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> };

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: any) => (b?.type === "text" ? b.text : "")).join("");
}

export class ScriptedChecker implements CheckerRunner {
  inputs: CheckerRunInput[] = [];
  private waiters: Array<{ resolve: (v: CheckerVerdict) => void; reject: (e: Error) => void }> = [];
  private arrivals: Array<() => void> = [];
  constructor(public verdicts: Array<CheckerVerdict | "defer">) {}
  async run(input: CheckerRunInput): Promise<CheckerVerdict> {
    this.inputs.push(input);
    this.arrivals.shift()?.();
    const next = this.verdicts.shift();
    if (!next) throw new Error("no scripted verdict");
    if (next !== "defer") return next;
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
  waitForRun(): Promise<void> {
    return new Promise((r) => this.arrivals.push(r));
  }
  resolveNext(v: CheckerVerdict): void {
    const w = this.waiters.shift();
    if (!w) throw new Error("no deferred checker run");
    w.resolve(v);
  }
}

export const continueVerdict = (reason = "keep going"): CheckerVerdict => ({ decision: "continue", complete: false, reason, nextTurnGuidance: reason });
export const waitingVerdict = (reason = "worker asked user"): CheckerVerdict => ({ decision: "waiting_for_user", complete: false, reason });
export const completeVerdict = (reason = "done"): CheckerVerdict => ({ decision: "complete", complete: true, reason, evidence: ["e"] });

export interface Harness {
  session: AgentSession;
  checker: ScriptedChecker;
  providerCalls: Context[];
  goalState(): any;
  stateEntries(): any[];
  customMessages(): any[];
}

export async function createHarness(opts: {
  replies: (ctx: Context, call: number) => Reply;
  checker: ScriptedChecker;
  config?: Partial<GoalControllerConfig>;
  retry?: { enabled: boolean; maxRetries?: number; baseDelayMs?: number };
}): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), "goal-ws-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-agent-"));
  const sessionManager = SessionManager.inMemory(workspace);
  const settingsManager = SettingsManager.create(workspace, agentDir);
  settingsManager.setProjectTrusted(true);
  const config: GoalControllerConfig = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace, agentDir, settingsManager,
    extensionFactories: [{ name: "goal-controller", factory: (pi) => activate(pi as any, opts.checker, () => ({ config, path: "/tmp/goal-controller-test.json" })) }],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({ type: "api_key", key: "k" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  const registry = new ModelRegistry(modelRuntime);
  const created = await createAgentSession({
    cwd: workspace, agentDir, model, thinkingLevel: "off", tools: ["read", "goal"],
    sessionManager, settingsManager, modelRuntime, resourceLoader,
  });
  const session = created.session;
  await session.bindExtensions({});
  // Applied after session setup: loading resources rereads settings from disk.
  settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, ...(opts.retry ?? {}) } });
  const providerCalls: Context[] = [];
  registry.registerProvider(PROVIDER, {
    api: API,
    streamSimple: (selectedModel: Model<any>, context: Context) => {
      providerCalls.push({ ...context, messages: [...context.messages] });
      const reply = opts.replies(context, providerCalls.length);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const base = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
          role: "assistant", content: [], api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
          usage, stopReason, timestamp: Date.now(),
        });
        if (reply.kind === "error") {
          const out = base("error");
          out.errorMessage = reply.errorMessage;
          stream.push({ type: "error", reason: "error", error: out });
          stream.end(out);
          return;
        }
        if (reply.kind === "tool") {
          const out = base("toolUse");
          const call = { type: "toolCall" as const, id: `call-${providerCalls.length}`, name: reply.name, arguments: reply.args as JsonObject };
          out.content.push(call);
          stream.push({ type: "start", partial: out });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: out });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: out });
          stream.push({ type: "done", reason: "toolUse", message: out });
          stream.end(out);
          return;
        }
        const out = base("stop");
        out.content.push({ type: "text", text: reply.text });
        stream.push({ type: "start", partial: out });
        stream.push({ type: "done", reason: "stop", message: out });
        stream.end(out);
      });
      return stream;
    },
  } as any);
  const branch = () => session.sessionManager.getBranch() as any[];
  const stateEntries = () => branch().filter((e) => e.type === "custom" && e.customType === "goal-controller-state").map((e) => e.data?.goal);
  return {
    session, checker: opts.checker, providerCalls,
    goalState: () => stateEntries().at(-1),
    stateEntries,
    customMessages: () => branch().filter((e) => e.type === "custom_message"),
  };
}

export function lastUserText(ctx: Context): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i] as any;
    if (m.role === "user") return textOf(m.content);
  }
  return "";
}

export async function waitUntil(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
