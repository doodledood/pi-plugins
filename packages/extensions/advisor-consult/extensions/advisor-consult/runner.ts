import type { AdvisorResult, AdvisorRunInput, AdvisorRunner } from "./types.ts";
import { runAdvisorProcess, type AdvisorExec, type AdvisorExecResult } from "./exec.ts";
import { formatDuration } from "./format.ts";
import { buildAdvisorUserPrompt } from "./prompts.ts";
import { redactSecrets } from "./redact.ts";

const MAX_DIAGNOSTIC_CHARS = 2_000;

/**
 * Runs the advisor as an independent `pi` subprocess. The subprocess loads the
 * user's normal extensions (so the advisor keeps a broad tool surface) but with
 * a replaced advisor system prompt, the hazardous tools excluded, and a child
 * bootstrap that broadens the active non-MCP tool set.
 *
 * The run persists its session into the parent's sidecar directory rather than
 * discarding it: an advisor consult costs real money, and a run with no session
 * leaves nothing for any cost surface to find. See `sidecar.ts` for why that
 * location keeps the consult out of the user's session list.
 */
export class PiSubprocessAdvisorRunner implements AdvisorRunner {
  public constructor(private readonly exec: AdvisorExec = runAdvisorProcess) {}

  public async run(input: AdvisorRunInput): Promise<AdvisorResult> {
    const args = advisorArgs(input);
    const startedAt = Date.now();
    const result = await this.exec("pi", args, { cwd: input.cwd, timeoutMs: input.timeoutMs, signal: input.signal });
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const parsed = parseAdvisorOutput(result.stdout);

    // A finished answer counts even when the termination landed while the advisor was shutting down
    // (its own session_shutdown hooks, a session flush): the run had already settled on it.
    if (parsed.advice && parsed.settled) {
      return { ok: true, advice: parsed.advice, model: parsed.model, elapsedMs };
    }

    if (result.terminatedBy) {
      const timedOut = result.terminatedBy === "timeout";
      return {
        ok: false,
        elapsedMs,
        timedOut,
        error: formatTerminationError(result, input, elapsedMs, timedOut),
      };
    }

    if (result.spawnError || result.code !== 0) {
      return { ok: false, elapsedMs, error: formatExitError(result, input, elapsedMs) };
    }

    if (!parsed.advice) {
      // Pi exits 0 even when the model call itself errors (e.g. an unknown
      // model id 404s): the failure rides on an assistant message with
      // stopReason "error" and an errorMessage, not on the exit code. Surface
      // that as the actual cause instead of a misleading "no advice" message.
      if (parsed.errorMessage) {
        return { ok: false, elapsedMs, model: parsed.model, error: formatModelError(parsed, input, elapsedMs, result) };
      }
      return {
        ok: false,
        elapsedMs,
        error: [
          `Advisor subprocess exited cleanly after ${formatDuration(elapsedMs)} but produced no advice text.`,
          diagnostics(result),
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    return { ok: true, advice: parsed.advice, model: parsed.model, elapsedMs };
  }
}

export function advisorArgs(input: AdvisorRunInput): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    // Persist into the parent's sidecar when the parent has a session file; fall back
    // to no session only when there is no parent session to attach the spend to.
    ...(input.sessionDir ? ["--session-dir", input.sessionDir] : ["--no-session"]),
    "--no-context-files",
    "--system-prompt",
    input.systemPrompt,
    "-e",
    input.bootstrapExtensionPath,
  ];

  if (input.excludedTools.length > 0) {
    args.push("--exclude-tools", input.excludedTools.join(","));
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  args.push("--thinking", input.thinking);
  args.push(buildAdvisorUserPrompt(input.query));
  return args;
}

function formatTerminationError(result: AdvisorExecResult, input: AdvisorRunInput, elapsedMs: number, timedOut: boolean): string {
  const reason = timedOut
    ? `Advisor produced no reliable advice: the subprocess timed out after ${formatDuration(elapsedMs)} (limit ${formatDuration(input.timeoutMs)}) and was terminated. Treat this as "no advice available", not as a signal either way.`
    : `Advisor produced no reliable advice: the consult was aborted by the caller or host after ${formatDuration(elapsedMs)}, and the subprocess was terminated.`;
  return [reason, configSummary(input), diagnostics(result)].filter(Boolean).join("\n");
}

function formatExitError(result: AdvisorExecResult, input: AdvisorRunInput, elapsedMs: number): string {
  return [
    result.spawnError
      ? `Advisor subprocess could not start: ${redactSecrets(result.spawnError)}`
      : `Advisor subprocess exited with code ${result.code} after ${formatDuration(elapsedMs)} without returning advice.`,
    configSummary(input),
    diagnostics(result),
  ]
    .filter(Boolean)
    .join("\n");
}

function configSummary(input: AdvisorRunInput): string {
  return `Advisor config: model=${input.model ?? "(inherited)"}, thinking=${input.thinking}, timeoutMs=${input.timeoutMs}.`;
}

// Matches provider "model not found / unknown model" failures across providers.
const MODEL_NOT_FOUND_PATTERN = /not[_\s-]?found|unknown model|no such model|does not exist|\b404\b|invalid.*model|model.*(unavailable|not (found|available|supported))/i;
const MODEL_LIST_HINT =
  "To see the models available in this environment, run `pi --list-models` (or `/model` / Ctrl+P interactively). Then set advisorConsult.defaultModel or pass a valid `model` argument.";

/**
 * Format a clear, actionable error when the advisor subprocess ran but its final
 * model call did not finish (Pi reports errors via stopReason "error" on exit code 0).
 * For model-not-found failures, point the parent at how to list valid models.
 */
function formatModelError(parsed: ParsedAdvisorOutput, input: AdvisorRunInput, elapsedMs: number, result: AdvisorExecResult): string {
  const detail = redactSecrets(parsed.errorMessage ?? "").trim().slice(0, 600) || "unknown model/provider error";
  const lines = [
    `Advisor produced no advice: the advisor's final model call did not finish (${formatDuration(elapsedMs)}). Treat this as "no advice available", not as a signal either way.`,
    `Error: ${detail}`,
    configSummary(input),
    MODEL_NOT_FOUND_PATTERN.test(detail)
      ? MODEL_LIST_HINT
      : "This usually means the model is unavailable or misconfigured (no provider access, a rate limit, or a request the model rejected). Check the configured advisor model, provider auth, and the request size.",
    diagnostics(result),
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Only stderr is shown. Stdout is the advisor's JSON event stream, which carries its streamed text; a result
 * that says "no reliable advice" must not hand the parent a half-written answer through the back door.
 */
function diagnostics(result: AdvisorExecResult): string | undefined {
  return outputTail("stderr", result.stderr);
}

function outputTail(label: string, value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const redacted = redactSecrets(trimmed);
  const tail = redacted.length > MAX_DIAGNOSTIC_CHARS ? `…${redacted.slice(-MAX_DIAGNOSTIC_CHARS)}` : redacted;
  return `${label}:\n${tail}`;
}

export interface ParsedAdvisorOutput {
  advice?: string;
  /** Model of the advice-bearing message, else of the last assistant message; `provider/id` when Pi names both. */
  model?: string;
  /** Why the run's final model call produced no answer: a provider error, the output limit, or an abort. */
  errorMessage?: string;
  /** True once the run settled (Pi's `agent_settled`, not aborted) after its last assistant message. */
  settled: boolean;
}

/** Stop reasons for a final message that is not a finished answer. */
const UNFINISHED_STOPS = new Set(["error", "length", "aborted"]);

/**
 * Extract the advisor's final advice, the model it ran on, and any failure from Pi JSON-mode output.
 *
 * The run's last assistant message decides. If it errored, hit the output limit, or was aborted, there is no
 * advice: neither its partial text nor an earlier turn's narration ("Let me check the logs first.") is the
 * advisor's answer. If it finished but carries no text (a trailing tool-only turn), the last finished text
 * before it is the answer.
 */
export function parseAdvisorOutput(stdout: string): ParsedAdvisorOutput {
  let advice: string | undefined;
  let adviceModel: string | undefined;
  let lastModel: string | undefined;
  let finalStop: unknown;
  let finalError: string | undefined;
  let settled = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = safeJsonParse(line);
    if (!isRecord(event)) continue;
    if (event.type === "agent_settled") {
      settled = event.aborted !== true;
      continue;
    }
    if (event.type !== "message_end") continue;
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    settled = false;
    lastModel = messageModel(message) ?? lastModel;
    finalStop = message.stopReason;
    finalError =
      typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage.trim() : undefined;
    const text = assistantText(message.content);
    if (text && !UNFINISHED_STOPS.has(String(finalStop))) {
      advice = text;
      adviceModel = lastModel;
    }
  }
  if (UNFINISHED_STOPS.has(String(finalStop))) {
    const errorMessage =
      finalStop === "length"
        ? "the advisor's final answer was cut off at the model's output token limit"
        : finalStop === "aborted"
          ? (finalError ?? "the advisor's final model call was aborted")
          : (finalError ?? "the advisor's final model call failed");
    return { model: lastModel, errorMessage, settled };
  }
  return { advice, model: adviceModel ?? lastModel, settled };
}

function messageModel(message: Record<string, unknown>): string | undefined {
  const model = typeof message.model === "string" ? message.model.trim() : "";
  if (!model) return undefined;
  const provider = typeof message.provider === "string" ? message.provider.trim() : "";
  return provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;
}

function assistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      texts.push(block.text.trim());
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
