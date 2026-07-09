import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AdvisorResult, AdvisorRunInput, AdvisorRunner } from "./types.ts";
import { buildAdvisorUserPrompt } from "./prompts.ts";
import { redactSecrets } from "./redact.ts";

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

const MAX_DIAGNOSTIC_CHARS = 2_000;

/**
 * Runs the advisor as an independent `pi` subprocess. The subprocess loads the
 * user's normal extensions (so the advisor keeps a broad tool surface) but with
 * a replaced advisor system prompt, the hazardous tools excluded, and a child
 * bootstrap that broadens the active non-MCP tool set.
 */
export class PiSubprocessAdvisorRunner implements AdvisorRunner {
  public constructor(private readonly pi: Pick<ExtensionAPI, "exec">) {}

  public async run(input: AdvisorRunInput): Promise<AdvisorResult> {
    const args = advisorArgs(input);
    const startedAt = Date.now();
    const result = await this.pi.exec("pi", args, {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      signal: input.signal,
    });
    const elapsedMs = Math.max(0, Date.now() - startedAt);

    if (result.killed) {
      const timedOut = reachedTimeout(elapsedMs, input.timeoutMs);
      return {
        ok: false,
        elapsedMs,
        timedOut,
        error: formatTerminationError(result, input, elapsedMs, timedOut),
      };
    }

    if (result.code !== 0) {
      return { ok: false, elapsedMs, error: formatExitError(result, input, elapsedMs) };
    }

    const parsed = parseAdvisorOutput(result.stdout);
    if (!parsed.advice) {
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
    "--no-session",
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

export function reachedTimeout(elapsedMs: number, timeoutMs: number): boolean {
  const slack = Math.min(1_000, Math.floor(timeoutMs * 0.05));
  return elapsedMs >= Math.max(0, timeoutMs - slack);
}

function formatTerminationError(result: ExecResult, input: AdvisorRunInput, elapsedMs: number, timedOut: boolean): string {
  const reason = timedOut
    ? `Advisor produced no reliable advice: the subprocess timed out after ${formatDuration(elapsedMs)} (limit ${formatDuration(input.timeoutMs)}) and was terminated. Treat this as "no advice available", not as a signal either way.`
    : `Advisor produced no reliable advice: the subprocess was terminated after ${formatDuration(elapsedMs)} before its ${formatDuration(input.timeoutMs)} limit (usually a caller/host abort).`;
  return [reason, configSummary(input), diagnostics(result)].filter(Boolean).join("\n");
}

function formatExitError(result: ExecResult, input: AdvisorRunInput, elapsedMs: number): string {
  return [
    `Advisor subprocess exited with code ${result.code} after ${formatDuration(elapsedMs)} without returning advice.`,
    configSummary(input),
    diagnostics(result),
  ]
    .filter(Boolean)
    .join("\n");
}

function configSummary(input: AdvisorRunInput): string {
  return `Advisor config: model=${input.model ?? "(inherited)"}, thinking=${input.thinking}, timeoutMs=${input.timeoutMs}.`;
}

function diagnostics(result: ExecResult): string | undefined {
  const parts = [outputTail("stderr", result.stderr), outputTail("stdout tail", result.stdout)].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
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
  model?: string;
}

/**
 * Extract the advisor's final advice and the model it ran on from Pi JSON-mode
 * output. Advice is the text of the last assistant message that carries any,
 * so a trailing tool-only turn does not blank out the result.
 */
export function parseAdvisorOutput(stdout: string): ParsedAdvisorOutput {
  let advice: string | undefined;
  let model: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = safeJsonParse(line);
    if (!isRecord(event) || event.type !== "message_end") continue;
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    const text = assistantText(message.content);
    if (text) {
      advice = text;
      if (typeof message.model === "string" && message.model.trim()) model = message.model.trim();
    }
  }
  return { advice, model };
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

function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1_000);
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
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
