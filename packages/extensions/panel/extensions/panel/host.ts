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

  // Persist the seeded fork into the panelist's own session file so the
  // transcript is self-contained: browsable and resumable later.
  // SessionManager.appendMessage rejects compactionSummary/branchSummary roles
  // (those are reserved for top-level compaction/branch entries), so summary
  // messages are persisted as custom messages carrying the same text; the
  // in-memory agent state below still keeps the original roles.
  for (const message of options.forkMessages) {
    const role = (message as { role?: string }).role;
    if (role === "compactionSummary" || role === "branchSummary") {
      sessionManager.appendMessage({
        role: "custom",
        customType: "panel-fork-summary",
        content: (message as { summary?: string }).summary ?? "",
        display: false,
        timestamp: (message as { timestamp?: number }).timestamp ?? Date.now(),
      });
      continue;
    }
    sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
  }

  const { session } = await createAgentSession({
    cwd: options.cwd,
    model: resolved.model,
    thinkingLevel: options.spec.thinking,
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
