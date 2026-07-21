import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { PanelistSession, SpawnPanelist, SpawnPanelistOptions } from "./types.ts";

/**
 * Tools a panelist must NOT have, because they are pathological in a headless
 * side-session: `ask_user_question` blocks on a user who isn't there, and
 * `openai_tts_speak` produces audible output the user never asked a panelist
 * for. Everything else — built-ins, extension tools (goal, subagents,
 * advisor, MCP) — stays available: a panelist is deliberately as close to a
 * regular session as possible, and guardrails are prompt-level.
 */
const PANELIST_EXCLUDED_TOOLS = ["ask_user_question", "openai_tts_speak"];

/** Built-in tools to enable (the full coding set, matching a regular session). */
const PANELIST_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Production panelist spawner: an isolated in-process pi SDK session, seeded
 * with the forked history, running the panelist system prompt with no host
 * extensions, skills, prompt templates, or context files (a fork must not
 * re-apply the host session's instruction surfaces). The pattern — minimal
 * DefaultResourceLoader + agent.state.messages seeding — was verified against
 * a live provider before this module was built.
 */
export const spawnPanelistSession: SpawnPanelist = async (
  options: SpawnPanelistOptions,
): Promise<PanelistSession> => {
  const modelRuntime = await ModelRuntime.create();
  const resolved = resolveCliModel({ cliModel: options.spec.model, modelRuntime });
  if (resolved.error || !resolved.model) {
    throw new Error(resolved.error ?? `model not found: ${options.spec.model}`);
  }
  if (resolved.warning) console.warn(`panel: ${resolved.warning}`);
  // A "provider/model:level" ref carries its own thinking level; honor it over
  // the spec's separate field so suffixed refs don't silently run at the wrong
  // effort.
  const thinkingLevel = resolved.thinkingLevel ?? options.spec.thinking;

  // A panelist session is deliberately as close to a regular pi session as
  // possible: full extension/skill/prompt-template discovery and pi's
  // standard system prompt with the panelist instructions APPENDED (never
  // replacing it). This is both a capability decision — panelists can run
  // skills like figure-out, set goals, spawn subagents — and a provider
  // requirement: stripped requests (tiny replaced system prompt, bare
  // question) to frontier models trip anti-distillation screening, verified
  // live on fable. Only themes are skipped (headless — nothing to render).
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    appendSystemPrompt: [options.systemPrompt],
    noThemes: true,
  });
  await loader.reload();

  const sessionManager = options.sessionDir
    ? SessionManager.create(options.cwd, options.sessionDir)
    : SessionManager.create(options.cwd);

  // Persist the seeded fork (a single transcript user message) into the
  // panelist's own session file so it is self-contained: browsable and
  // resumable later.
  for (const message of options.forkMessages) {
    sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
  }

  const { session } = await createAgentSession({
    cwd: options.cwd,
    model: resolved.model,
    thinkingLevel,
    modelRuntime,
    resourceLoader: loader,
    // No `tools` allowlist: an allowlist would silently drop every extension
    // tool (they must be named explicitly). Built-ins are broadened to the
    // full coding set after creation instead.
    excludeTools: PANELIST_EXCLUDED_TOOLS,
    sessionManager,
  });
  // Enable the non-default built-ins (grep/find/ls) alongside whatever tools
  // extensions registered, mirroring a regular session's toolbox.
  const state = session.agent.state as { tools: Array<{ name: string }> };
  const present = new Set(state.tools.map((tool) => tool.name));
  const missingBuiltins = PANELIST_BUILTIN_TOOLS.filter((name) => !present.has(name));
  if (missingBuiltins.length > 0) {
    const { createCodingTools } = await import("@earendil-works/pi-coding-agent");
    const coding = createCodingTools(options.cwd) as Array<{ name: string }>;
    state.tools = [...state.tools, ...coding.filter((tool) => missingBuiltins.includes(tool.name))] as never;
  }
  session.agent.state.messages = [...options.forkMessages];

  return {
    prompt: (text: string) => session.prompt(text),
    abort: () => session.abort(),
    subscribe: (listener) => session.subscribe(listener as Parameters<typeof session.subscribe>[0]),
    get messages() {
      return session.messages;
    },
    get sessionFile() {
      return session.sessionFile;
    },
    dispose: () => session.dispose(),
  };
};
