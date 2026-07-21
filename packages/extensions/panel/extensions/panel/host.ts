import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { PanelistSession, SpawnPanelist, SpawnPanelistOptions } from "./types.ts";

/** Tools a panelist gets: full agentic coding set. Guardrails are prompt-level. */
const PANELIST_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

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

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    systemPrompt: options.systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
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
    tools: PANELIST_TOOLS,
    sessionManager,
  });
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
