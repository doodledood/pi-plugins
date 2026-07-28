import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  PanelistResult,
  PanelistSession,
  PanelistSpec,
  PanelistState,
  SpawnPanelist,
  SpawnPanelistOptions,
} from "./types.ts";

const TRANSCRIPT_TAIL_LINES = 400;
const ABORT_GRACE_MS = 5_000;

export interface RunPanelOptions {
  specs: PanelistSpec[];
  question: string;
  forkMessages: AgentMessage[];
  systemPrompt: string;
  cwd: string;
  sessionDir?: string;
  /** Parent session id recorded in each panelist's header, linking spend to the parent. */
  parentSession?: string;
  timeoutMs: number;
  spawn: SpawnPanelist;
  signal?: AbortSignal;
  /** Called on every state change; drives the widget and overlay. */
  onUpdate?: (states: readonly PanelistState[]) => void;
}

/**
 * Run all panelists in parallel over the same forked history. Each panelist is
 * an isolated session: one failing, timing out, or overflowing its context
 * window surfaces as that panelist's error and never sinks the others.
 * Aborting the provided signal aborts every in-flight session, bounded by a
 * grace period.
 */
export async function runPanel(options: RunPanelOptions): Promise<PanelistResult[]> {
  const states: PanelistState[] = options.specs.map((spec, id) => ({
    id,
    spec,
    status: "pending",
    activity: "starting",
    transcript: [],
    tokens: 0,
    cost: undefined,
    startedAt: Date.now(),
  }));
  const notify = () => options.onUpdate?.(states);
  notify();

  const results = await Promise.all(
    options.specs.map((spec, id) => runPanelist(spec, states[id] as PanelistState, options, notify)),
  );
  notify();
  return results;
}

async function runPanelist(
  spec: PanelistSpec,
  state: PanelistState,
  options: RunPanelOptions,
  notify: () => void,
): Promise<PanelistResult> {
  const startedAt = Date.now();
  const finish = (partial: Omit<PanelistResult, "spec" | "elapsedMs" | "tokens" | "cost">): PanelistResult => {
    state.endedAt = Date.now();
    notify();
    return {
      spec,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      tokens: state.tokens,
      cost: state.cost,
      sessionFile: state.sessionFile,
      ...partial,
    };
  };

  if (options.signal?.aborted) {
    state.status = "cancelled";
    state.activity = "cancelled";
    return finish({ ok: false, cancelled: true, error: "cancelled before start" });
  }

  let session: PanelistSession;
  try {
    session = await options.spawn({
      spec,
      systemPrompt: options.systemPrompt,
      forkMessages: options.forkMessages,
      cwd: options.cwd,
      sessionDir: options.sessionDir,
      ...(options.parentSession ? { parentSession: options.parentSession } : {}),
    });
  } catch (error) {
    state.status = "error";
    state.error = errorText(error);
    state.activity = "failed to start";
    return finish({ ok: false, error: state.error });
  }

  // The user may have cancelled while spawn was in flight; a listener attached
  // now would never fire for an already-aborted signal, so re-check explicitly.
  if (options.signal?.aborted) {
    await session.abort();
    await disposeWithGrace(session);
    state.status = "cancelled";
    state.activity = "cancelled";
    return finish({ ok: false, cancelled: true, error: "cancelled during startup" });
  }

  state.status = "running";
  state.activity = "thinking";
  state.sessionFile = session.sessionFile;
  notify();

  let providerError: string | undefined;
  let currentLine = "";
  let currentThought = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta" && sub.delta) {
        currentLine += sub.delta;
        const lines = currentLine.split("\n");
        currentLine = lines.pop() ?? "";
        if (lines.length > 0) appendTranscript(state, lines);
        state.activity = "writing";
        notify();
      }
      if (sub?.type === "thinking_delta" && sub.delta) {
        // Thinking streams into the transcript with a distinct prefix — at
        // high effort it is usually the most informative part of the run.
        currentThought += sub.delta;
        const lines = currentThought.split("\n");
        currentThought = lines.pop() ?? "";
        if (lines.length > 0) appendTranscript(state, lines.filter((l) => l.trim()).map((l) => `· ${l}`));
        state.activity = "thinking";
        notify();
      }
    } else if (event.type === "tool_execution_start") {
      const toolName = event.toolName ?? "tool";
      state.activity = `running ${toolName}`;
      appendTranscript(state, [summarizeToolCall(toolName, event.args)]);
      notify();
    } else if (event.type === "tool_execution_end") {
      appendTranscript(state, [summarizeToolResult(event.toolName ?? "tool", event.result, event.isError ?? false)]);
      notify();
    } else if (event.type === "message_end") {
      const message = event.message;
      if (message?.role === "assistant") {
        accumulateUsage(state, message.usage);
        if (message.stopReason === "error" && typeof message.errorMessage === "string") {
          providerError = message.errorMessage;
        }
        notify();
      }
    }
  });

  const abortRun = () => {
    void session.abort();
  };
  let timedOut = false;
  options.signal?.addEventListener("abort", abortRun, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    abortRun();
  }, options.timeoutMs);

  // Only messages produced by this run may become the answer: the seeded fork
  // already contains assistant text, and a failed panelist must never surface
  // stale fork content as its own answer.
  const baselineMessageCount = session.messages.length;
  let promptError: string | undefined;
  try {
    await session.prompt(options.question);
  } catch (error) {
    promptError = errorText(error);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortRun);
    if (currentThought.trim()) appendTranscript(state, [`· ${currentThought}`]);
    if (currentLine) appendTranscript(state, [currentLine]);
    unsubscribe();
  }

  const cancelled = options.signal?.aborted ?? false;
  const answer = finalAnswer(session.messages.slice(baselineMessageCount));
  state.sessionFile = session.sessionFile ?? state.sessionFile;
  await disposeWithGrace(session);

  if (cancelled) {
    state.status = "cancelled";
    state.activity = "cancelled";
    return finish({ ok: false, cancelled: true, error: "cancelled" });
  }
  if (timedOut) {
    state.status = "error";
    state.error = `timed out after ${Math.round(options.timeoutMs / 1000)}s`;
    state.activity = "timed out";
    return finish({ ok: false, error: state.error });
  }
  if (answer) {
    state.status = "done";
    state.activity = "answered";
    state.answer = answer;
    return finish({ ok: true, answer });
  }
  state.status = "error";
  state.error = providerError ?? promptError ?? "panelist finished without an answer (possible timeout or context overflow)";
  state.activity = "failed";
  return finish({ ok: false, error: state.error });
}

/**
 * The panelist's final answer: text of the last cleanly-completed assistant
 * message (`stopReason: "stop"`) that carries any, so a trailing tool-only
 * turn does not blank the result and a partial message — errored, aborted
 * mid-stream, or cut off at the output-length limit — is never returned as a
 * complete answer.
 */
export function finalAnswer(messages: readonly AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; stopReason?: string; content?: unknown };
    if (message.role !== "assistant" || message.stopReason !== "stop") continue;
    const text = assistantText(message.content);
    if (text) return text;
  }
  return undefined;
}

function assistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: string }).text === "string" &&
      (block as { text: string }).text.trim()
    ) {
      texts.push((block as { text: string }).text.trim());
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function accumulateUsage(state: PanelistState, usage: unknown): void {
  if (usage === null || typeof usage !== "object") return;
  const u = usage as { input?: number; output?: number; cost?: { total?: number } };
  state.tokens += (u.input ?? 0) + (u.output ?? 0);
  if (typeof u.cost?.total === "number") state.cost = (state.cost ?? 0) + u.cost.total;
}

function appendTranscript(state: PanelistState, lines: string[]): void {
  state.transcript.push(...lines);
  if (state.transcript.length > TRANSCRIPT_TAIL_LINES) {
    state.transcript.splice(0, state.transcript.length - TRANSCRIPT_TAIL_LINES);
  }
}

async function disposeWithGrace(session: PanelistSession): Promise<void> {
  try {
    await Promise.race([
      Promise.resolve(session.dispose()),
      new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS)),
    ]);
  } catch {
    // Disposal failures must never mask the panelist result.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One-line tool-call summary with its most salient argument, for the live transcript. */
export function summarizeToolCall(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const salient =
    typeof a.command === "string" ? a.command
    : typeof a.path === "string" ? a.path
    : typeof a.file_path === "string" ? a.file_path
    : typeof a.pattern === "string" ? a.pattern
    : typeof a.query === "string" ? a.query
    : typeof a.url === "string" ? a.url
    : safeArgs(args);
  const suffix = salient ? `: ${clipLine(salient, 100)}` : "";
  return `▸ ${toolName}${suffix}`;
}

/** One-line tool-result summary (first meaningful output line), for the live transcript. */
export function summarizeToolResult(toolName: string, result: unknown, isError: boolean): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  const text = Array.isArray(content)
    ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n")
    : "";
  const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
  const glyph = isError ? "✗" : "✓";
  return `${glyph} ${toolName}${firstLine ? `: ${clipLine(firstLine.trim(), 100)}` : ""}`;
}

function clipLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeArgs(args: unknown): string {
  try {
    const text = JSON.stringify(args) ?? "";
    return text === "{}" ? "" : text;
  } catch {
    return "";
  }
}