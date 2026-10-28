// The start sequence: find or create the folder's Herdr workspace, open a tab, start Pi there with
// `herdr agent start`, and deliver the first prompt. It closes nothing: when a step fails, the error
// names what the earlier steps left behind and the command that closes it.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { type AgentView, type Herdr, HerdrError, type PaneView } from "./herdr.ts";

/** Herdr's rule for an agent name. */
export const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** How long Herdr may take to see Pi ready; a Pi with many extensions starts slowly. */
export const START_TIMEOUT_MS = 90_000;
/** How long a started Pi may take to report its session started before the first prompt is typed. */
export const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;

/** How long a stalled first prompt may take to show up in the session file before it is typed again. */
export const LANDED_TIMEOUT_MS = 15_000;

/** The number of entries a session file holds, 0 when it does not exist yet. */
function entryCount(sessionPath: string | undefined): number {
  if (!sessionPath || !existsSync(sessionPath)) return 0;
  return readFileSync(sessionPath, "utf8").split("\n").filter(Boolean).length;
}

/** True once the session file records `prompt` as a user message. */
export function promptLanded(sessionPath: string | undefined, prompt: string): boolean {
  if (!sessionPath || !existsSync(sessionPath)) return false;
  return readFileSync(sessionPath, "utf8")
    .split("\n")
    .some((line) => {
      if (!line.includes('"role":"user"')) return false;
      try {
        const message = JSON.parse(line).message;
        const content = message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part?.text ?? "").join("") : "";
        return message?.role === "user" && text === prompt;
      } catch {
        return false;
      }
    });
}

/**
 * Types the first prompt. A Pi still busy with its own startup can let Herdr's five-second check
 * pass before it starts working, so a stalled prompt counts as delivered once the session file
 * records it, grows at all, or Herdr shows the agent at work or finished since. Only a plain prompt
 * that shows none of that is typed a second time: a slash command may run without leaving a trace,
 * and without a session file there is nothing to check, so those are reported instead of retyped.
 */
async function deliverFirstPrompt(
  herdr: Herdr,
  agent: AgentView,
  prompt: string,
  sessionPath: string | undefined,
  options: { landedTimeoutMs: number; pollMs: number },
): Promise<void> {
  const name = agent.name!;
  const entriesBefore = entryCount(sessionPath);
  try {
    await herdr.prompt(name, prompt);
    return;
  } catch (error) {
    if (!(error instanceof HerdrError && error.code === "agent_prompt_stalled")) throw error;
  }
  const deadline = Date.now() + options.landedTimeoutMs;
  while (Date.now() < deadline) {
    if (promptLanded(sessionPath, prompt) || entryCount(sessionPath) > entriesBefore) return;
    const now = await herdr.getAgent(name);
    if (now && (now.status === "working" || now.status === "blocked" || (now.completionSeq ?? 0) > (agent.completionSeq ?? 0))) return;
    await new Promise((done) => setTimeout(done, options.pollMs));
  }
  if (!sessionPath || prompt.trimStart().startsWith("/")) {
    throw new Error(`Herdr saw no work start within ${Math.round(options.landedTimeoutMs / 1000)} s and the prompt cannot be confirmed; check it with \`herdr agent read ${name} --source visible\` before sending it again`);
  }
  await herdr.prompt(name, prompt);
}

/** Waits until Herdr reports the agent idle or done, and returns it. */
async function settle(herdr: Herdr, name: string, timeoutMs: number, pollMs: number): Promise<AgentView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let agent: AgentView | undefined;
    try {
      agent = await herdr.getAgent(name);
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_not_found") throw new Error("Pi exited before it was ready for its first prompt");
      throw error;
    }
    if (agent && agent.kind === "pi" && (agent.status === "idle" || agent.status === "done")) return agent;
    if (Date.now() >= deadline) {
      const hint = agent?.status === "unknown" ? "; Herdr cannot read its state, so check that Herdr's Pi integration is installed (`herdr integration install pi`)" : "";
      throw new Error(`Pi did not report its session started within ${Math.round(timeoutMs / 1000)} s (Herdr shows it ${agent?.status ?? "missing"})${hint}`);
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

export interface StartRequest {
  folder: string;
  name?: string;
  prompt: string;
}

export interface StartedSession {
  name: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  folder: string;
  sessionPath?: string;
  completionSeq?: number;
}

export interface StartOptions {
  /** The folder a relative `folder` is resolved against. */
  cwd: string;
  /** Environment the new tab gets, such as the agent directory this session runs with. */
  env: Record<string, string>;
  readyTimeoutMs?: number;
  landedTimeoutMs?: number;
  /** How often the start sequence re-checks a pane, an agent or a session file while it waits. */
  pollMs?: number;
}

/** The folder as a real directory path, or an error saying what is wrong with it. */
export function resolveFolder(folder: string, cwd: string): string {
  const absolute = isAbsolute(folder) ? folder : resolve(cwd, folder);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new Error(`folder ${absolute} does not exist; pass an existing folder`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`${absolute} is a file, not a folder`);
  return real;
}

/** A name for the new session: the one asked for, checked, or one made from the folder's name. */
export function chooseName(requested: string | undefined, folder: string, taken: ReadonlySet<string>): string {
  if (requested !== undefined) {
    if (!NAME_PATTERN.test(requested)) {
      throw new Error(`name "${requested}" is not a valid Herdr agent name: use 1–32 lowercase letters, digits, - or _, starting with a letter`);
    }
    if (taken.has(requested)) throw new Error(`a live Herdr agent is already named "${requested}"; pick another name`);
    return requested;
  }
  const stem = (basename(folder).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "") || "pi").slice(0, 28);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function sameFolder(cwd: string | undefined, folder: string): boolean {
  if (!cwd) return false;
  try {
    return realpathSync(cwd) === folder;
  } catch {
    return false;
  }
}

/** A workspace already holding a pane in `folder`, if Herdr has one. */
async function workspaceFor(herdr: Herdr, folder: string): Promise<string | undefined> {
  return (await herdr.listPanes()).find((pane) => sameFolder(pane.cwd, folder))?.workspaceId;
}

function leftBehind(pane: PaneView, createdWorkspace: boolean): string {
  return createdWorkspace
    ? `It left workspace ${pane.workspaceId} open; close it with \`herdr workspace close ${pane.workspaceId}\`.`
    : `It left tab ${pane.tabId} (pane ${pane.paneId}) open; close it with \`herdr pane close ${pane.paneId}\`.`;
}

function describe(error: unknown): string {
  if (error instanceof HerdrError && error.code === "agent_not_ready") {
    return "Pi started but stopped at a startup prompt before it was ready for input";
  }
  return error instanceof Error ? error.message : String(error);
}

export async function startSession(herdr: Herdr, request: StartRequest, options: StartOptions): Promise<StartedSession> {
  if (!request.prompt.trim()) throw new Error("prompt is empty; give the new session its first message");
  const folder = resolveFolder(request.folder, options.cwd);
  const agents = await herdr.listAgents();
  const name = chooseName(request.name, folder, new Set(agents.flatMap((agent) => (agent.name ? [agent.name] : []))));

  const existing = await workspaceFor(herdr, folder);
  const pane = existing
    ? await herdr.createTab(existing, folder, name, options.env)
    : await herdr.createWorkspace(folder, basename(folder) || folder, options.env);
  const createdWorkspace = existing === undefined;
  const pollMs = options.pollMs ?? READY_POLL_MS;

  let started: AgentView;
  try {
    started = await herdr.startPi(name, pane.paneId, { timeoutMs: START_TIMEOUT_MS, retryMs: pollMs });
  } catch (error) {
    throw new Error(`Pi did not come up in the new pane: ${describe(error)}. ${leftBehind(pane, createdWorkspace)}`);
  }
  let baseline: AgentView | undefined;
  try {
    // Herdr reports a fresh Pi ready before its extensions finish loading; its integration reports
    // idle once the session has started, which is when typed input lands.
    baseline = await settle(herdr, name, options.readyTimeoutMs ?? READY_TIMEOUT_MS, pollMs);
    await deliverFirstPrompt(herdr, baseline, request.prompt, started.sessionPath ?? baseline.sessionPath, {
      landedTimeoutMs: options.landedTimeoutMs ?? LANDED_TIMEOUT_MS,
      pollMs,
    });
  } catch (error) {
    throw new Error(`Pi started as "${name}" but its first prompt was not delivered: ${describe(error)}. ${leftBehind(pane, createdWorkspace)}`);
  }
  return {
    name,
    paneId: started.paneId,
    tabId: started.tabId,
    workspaceId: started.workspaceId,
    folder,
    sessionPath: started.sessionPath ?? baseline?.sessionPath,
    completionSeq: baseline?.completionSeq ?? started.completionSeq,
  };
}
