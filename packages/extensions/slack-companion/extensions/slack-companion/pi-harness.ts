// A real Pi AgentSession in memory with a scripted provider, the real slack-companion extension,
// a fake pi-mcp-adapter (the fake Slack behind the runtime event, plus an `mcp` proxy and two
// MCP-sourced data tools) and a foreign extension with a tool and a handler. Nothing reaches
// the network or the owner's Slack.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type JsonObject, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RUNTIME_TOOL_CALL_EVENT } from "./backend.ts";
import type { Engine } from "./engine.ts";
import { FakeSlack } from "./fake-slack.ts";
import { activate, type Overrides, type Scheduler } from "./index.ts";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntime } from "./sandbox.ts";

process.env.PI_OFFLINE ??= "1";

export const PROVIDER = "scripted-slack";
const API = "scripted-slack-api";
export const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
export const model: Model<any> = {
  id: "det", name: "det", api: API, provider: PROVIDER, baseUrl: "http://127.0.0.1/never",
  reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000, maxTokens: 1_000,
};

export type Reply = { kind: "text"; text: string } | { kind: "tool"; name: string; args: Record<string, unknown> } | { kind: "error"; message: string };
export type Role = "main" | "helper" | "triage";

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: any) => (b?.type === "text" ? b.text : "")).join("");
}

/** The whole system prompt a provider sees: system messages' text and their sections. */
export function systemText(context: Context): string {
  const parts: string[] = context.systemPrompt ? [context.systemPrompt] : [];
  for (const message of context.messages as any[]) {
    if (message.role !== "system") continue;
    parts.push(textOf(message.content));
    for (const section of Object.values(message.sections ?? {})) if (typeof section === "string") parts.push(section);
  }
  return parts.join("\n");
}

/** The tools a model call offers: Pi sends them as system messages that add and remove tools. */
export function toolsOf(context: Context): string[] {
  const names = new Set((context.tools ?? []).map((t) => t.name));
  for (const m of context.messages as any[]) {
    if (m.role !== "system") continue;
    // A redefinition removes the old declaration and adds the new one in the same message.
    for (const r of m.toolsRemoved ?? []) names.delete(typeof r === "string" ? r : r.name);
    for (const t of m.toolsAdded ?? []) names.add(t.name);
  }
  return [...names];
}

export function roleOf(context: Context): Role {
  const prompt = systemText(context);
  if (prompt.includes("[slack-companion triage]")) return "triage";
  if (prompt.includes("[slack-companion helper]")) return "helper";
  return "main";
}

/** The newest tool results of this context, newest last. */
export function lastToolResults(context: Context): string[] {
  const out: string[] = [];
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const m = context.messages[i] as any;
    if (m.role !== "toolResult") break;
    out.unshift(textOf(m.content));
  }
  return out;
}

export interface Harness {
  session: AgentSession;
  slack: FakeSlack;
  engine: () => Engine;
  /** Every model call the provider received, with the credential it was given. */
  calls: Array<{ role: Role; context: Context; apiKey: string | undefined; model: string; tools: string[] }>;
  workspace: string;
  agentDir: string;
  foreign: { handlerRuns: number; toolRuns: number };
  dataCalls: string[];
  notices: Array<{ level: string; text: string }>;
  sessionFile?: string;
  /** Main's registered tools, as an extension sees them. */
  allTools: () => import("@earendil-works/pi-coding-agent").ToolInfo[];
  events: import("./backend.ts").EventBus;
  /** Components the package opened with ctx.ui.custom (only with the fake UI). */
  opened: Array<{ component: any; options: any; close: () => void }>;
  /** The dock line as the package renders it now (only with the fake UI; empty when it set none). */
  line: (width: number) => string[];
  /** The poll timers the package has started and not stopped, by id (ids rise). */
  runningTimers: () => number[];
  /** The fake home folder the package's secret policy and sandbox are built for. */
  home: string;
  /** Every policy the package gave sandbox-runtime (a recording stand-in; no command runs unsandboxed). */
  sandboxConfigs: SandboxRuntimeConfig[];
  /** Main's model registry, the one the helper's model calls go through. */
  registry: ModelRegistry;
}

export interface HarnessOptions {
  replies: (context: Context, role: Role, call: number) => Reply;
  enabled?: boolean;
  persistSession?: boolean;
  config?: Record<string, unknown>;
  /** Reopen an earlier harness's session: same Slack, folders and session file. */
  reopen?: Harness;
  /** Leave the fake pi-mcp-adapter out, as in a setup without it. */
  noAdapter?: boolean;
  /** Raw text of pi-mcp-adapter's tool cache, to test a broken one. */
  mcpCacheText?: string;
  /** Data tool calls wait for this before answering (to keep main's turn busy). */
  dataGate?: Promise<void>;
  /** Bind a fake UI so commands that open the panel run; it records what they open. */
  ui?: { rows: number };
  /** Raw config file text, to test a broken file. */
  rawConfig?: string;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const workspace = options.reopen?.workspace ?? mkdtempSync(join(tmpdir(), "slack-ws-"));
  const agentDir = options.reopen?.agentDir ?? mkdtempSync(join(tmpdir(), "slack-agent-"));
  writeFileSync(join(workspace, "notes.md"), "The judge treats the KB as king.\n");
  mkdirSync(join(agentDir, "slack-companion"), { recursive: true });
  // The adapter's metadata cache: each server's tools with the annotations their server declares.
  writeFileSync(join(agentDir, "mcp-cache.json"), options.mcpCacheText ?? JSON.stringify({ version: 1, servers: {
    slack: { tools: [
      { name: "slack_send_message", description: "send", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
      { name: "slack_read_thread", description: "read thread", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "slack_read_channel", description: "read channel", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "slack_read_user_profile", description: "profile", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ] },
    data: { tools: [
      { name: "data_lookup", description: "look data up", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
      { name: "data_write", description: "write data", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ] },
    "chrome-devtools": { tools: [
      { name: "list_network_requests", description: "list the browser's network requests", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ] },
  } }));
  writeFileSync(join(agentDir, "slack-companion.json"), options.rawConfig ?? JSON.stringify({ enabled: options.enabled ?? true, ...(options.config ?? {}) }));
  const slack = options.reopen?.slack ?? new FakeSlack();
  const foreign = { handlerRuns: 0, toolRuns: 0 };
  const dataCalls: string[] = [];
  const notices: Array<{ level: string; text: string }> = [];
  let engine: Engine | undefined;

  const fakeAdapter = (pi: ExtensionAPI) => {
    slack.attach(pi.events as any);
    // Read-only and writing MCP data tools, answered through the same runtime event.
    pi.events.on(RUNTIME_TOOL_CALL_EVENT, (request: any) => {
      if (request.result !== undefined || !String(request.tool).startsWith("data_")) return;
      dataCalls.push(request.tool);
      request.result = (options.dataGate ?? Promise.resolve()).then(() => ({ ok: true, result: { content: [{ type: "text", text: `rows for ${JSON.stringify(request.args)}` }] } }));
    });
    for (const proxy of ["mcp", "mcp__slack"]) {
      pi.registerTool(defineTool({ name: proxy, label: proxy, description: "MCP gateway proxy", parameters: Type.Object({ tool: Type.String(), args: Type.Optional(Type.Any()) }), async execute(_id, params: any) {
        const tool = String(params.tool).replace(/^mcp__slack__/, "");
        const request: any = { version: 1, tool, args: typeof params.args === "string" ? JSON.parse(params.args) : params.args };
        pi.events.emit(RUNTIME_TOOL_CALL_EVENT, request);
        const outcome = await request.result;
        if (!outcome.ok) throw outcome.error;
        return outcome.result;
      } }));
    }
    for (const [name, readOnlyHint] of [["data_lookup", true], ["data_write", false]] as const) {
      // As the adapter's direct tools do: the call goes through its runtime event.
      pi.registerTool({ ...defineTool({ name, label: name, description: `${name} tool`, parameters: Type.Object({ q: Type.String() }), async execute(_id, params) {
        const request: any = { version: 1, tool: name, args: params };
        pi.events.emit(RUNTIME_TOOL_CALL_EVENT, request);
        const outcome = await request.result;
        if (!outcome.ok) throw outcome.error;
        return outcome.result;
      } }), annotations: { readOnlyHint } } as any);
    }
    // The send tool by its own name (direct) and by its deferred name, as the adapter registers them.
    for (const name of ["slack_send_message", "mcp__slack__slack_send_message"]) {
      pi.registerTool(defineTool({ name, label: "slack send", description: "send", parameters: Type.Object({ channel_id: Type.String(), message: Type.String(), thread_ts: Type.Optional(Type.String()) }), async execute(_id, params) {
        const request: any = { version: 1, tool: "slack_send_message", args: params };
        pi.events.emit(RUNTIME_TOOL_CALL_EVENT, request);
        const outcome = await request.result;
        if (!outcome.ok) throw outcome.error;
        return outcome.result;
      } }));
    }
  };
  let piRef: ExtensionAPI | undefined;
  const foreignExtension = (pi: ExtensionAPI) => {
    piRef = pi;
    pi.on("before_agent_start", () => { foreign.handlerRuns += 1; });
    pi.registerTool(defineTool({ name: "foreign_tool", label: "foreign", description: "foreign", parameters: Type.Object({}), async execute() { foreign.toolRuns += 1; return { content: [{ type: "text", text: "foreign" }], details: {} }; } }));
  };
  const home = options.reopen?.home ?? mkdtempSync(join(tmpdir(), "slack-home-"));
  // Poll timers the package started and has not stopped; they never fire: tests drive polls.
  const timers = new Set<number>();
  let nextTimer = 0;
  const scheduler: Scheduler = { start: () => { nextTimer += 1; timers.add(nextTimer); return nextTimer; }, stop: (handle) => { timers.delete(handle as number); } };
  const sandboxConfigs: SandboxRuntimeConfig[] = [];
  // Records the policy production code builds; every command it wraps fails, so nothing runs unconfined.
  const sandboxRuntime: SandboxRuntime = {
    isSupportedPlatform: () => true,
    initialize: async (config) => { sandboxConfigs.push(config); },
    updateConfig: (config) => { sandboxConfigs.push(config); },
    wrapWithSandbox: async () => "echo 'the test sandbox runs nothing' >&2; exit 1",
  };
  const overrides: Overrides = {
    agentDir,
    home,
    scheduler,
    now: () => slack.nowMs(),
    sandboxRuntime,
    onEngine: (e) => { engine = e; },
    onNotify: (level, text) => notices.push({ level, text }),
  };

  const sessionManager = options.reopen?.sessionFile
    ? SessionManager.open(options.reopen.sessionFile, dirname(options.reopen.sessionFile), workspace)
    : options.persistSession ? SessionManager.create(workspace, mkdtempSync(join(tmpdir(), "slack-sessions-"))) : SessionManager.inMemory(workspace);
  const settingsManager = SettingsManager.create(workspace, agentDir);
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace, agentDir, settingsManager,
    extensionFactories: [
      ...(options.noAdapter ? [] : [{ name: "pi-mcp-adapter", factory: fakeAdapter }]),
      { name: "foreign-extension", factory: foreignExtension },
      { name: "slack-companion", factory: (pi) => activate(pi, overrides) },
    ],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({ type: "api_key", key: "k" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  const registry = new ModelRegistry(modelRuntime);
  const calls: Harness["calls"] = [];
  registry.registerProvider(PROVIDER, {
    api: API,
    baseUrl: model.baseUrl,
    // The session's model and a cheaper one, so the triage call's model choice is observable.
    models: [
      { id: model.id, name: model.name, reasoning: false, input: ["text"], cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens },
      { id: "cheap", name: "cheap", reasoning: false, input: ["text"], cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000 },
    ],
    streamSimple: (selected: Model<any>, context: Context, streamOptions?: SimpleStreamOptions) => {
      const role = roleOf(context);
      calls.push({ role, context: { ...context, messages: [...context.messages] }, apiKey: streamOptions?.apiKey, model: `${selected.provider}/${selected.id}`, tools: toolsOf(context) });
      const reply = options.replies(context, role, calls.filter((c) => c.role === role).length);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const out: AssistantMessage = {
          role: "assistant", content: [], api: selected.api, provider: selected.provider, model: selected.id,
          usage, stopReason: reply.kind === "tool" ? "toolUse" : reply.kind === "error" ? "error" : "stop", timestamp: Date.now(),
        };
        if (reply.kind === "error") {
          out.errorMessage = reply.message;
          stream.push({ type: "start", partial: out });
          stream.push({ type: "error", reason: "error", error: out });
        } else if (reply.kind === "tool") {
          const call = { type: "toolCall" as const, id: `call-${calls.length}`, name: reply.name, arguments: reply.args as JsonObject };
          out.content.push(call);
          stream.push({ type: "start", partial: out });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: out });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: out });
          stream.push({ type: "done", reason: "toolUse", message: out });
        } else {
          out.content.push({ type: "text", text: reply.text });
          stream.push({ type: "start", partial: out });
          stream.push({ type: "done", reason: "stop", message: out });
        }
        stream.end(out);
      });
      return stream;
    },
  } as any);
  const { session } = await createAgentSession({
    cwd: workspace, agentDir, model, thinkingLevel: "off",
    tools: ["read", "mcp", "mcp__slack", "slack_send_message", "mcp__slack__slack_send_message", "data_lookup", "data_write", "foreign_tool", "slack_watch"],
    sessionManager, settingsManager, modelRuntime, resourceLoader,
  });
  const opened: Harness["opened"] = [];
  const widgets = new Map<string, { render: (width: number) => string[] } | undefined>();
  if (options.ui) {
    const rows = options.ui.rows;
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const tui = { terminal: { rows, columns: 120 }, requestRender() {} };
    // Every method a test does not need is a no-op; custom() records what it opens and keeps it open.
    const uiContext = new Proxy({
      custom: (factory: any, opts: any) => new Promise<void>((resolve) => {
        const component = factory(tui, theme, {}, () => resolve());
        opened.push({ component, options: opts, close: () => resolve() });
      }),
      notify: (text: string, level: string) => notices.push({ level, text }),
      setWidget: (key: string, factory: any) => {
        widgets.set(key, factory ? factory(tui, theme) : undefined);
      },
    } as Record<string, unknown>, { get: (target, prop) => (prop in target ? target[prop as string] : () => undefined) });
    await session.bindExtensions({ uiContext: uiContext as any });
  } else {
    await session.bindExtensions({});
  }
  const harness: Harness = {
    session, slack, calls, workspace, agentDir, home, sandboxConfigs, opened, line: (width) => widgets.get("slack-companion")?.render(width) ?? [], runningTimers: () => [...timers], foreign, dataCalls, notices,
    allTools: () => piRef!.getAllTools(),
    registry,
    events: piRef!.events,
    engine: () => {
      if (!engine) throw new Error("slack-companion did not start");
      return engine;
    },
  };
  const file = session.sessionManager.getSessionFile();
  if (file) harness.sessionFile = file;
  return harness;
}

export async function waitUntil(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
