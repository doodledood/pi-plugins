import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal, CheckerDecision, CheckerSessionContext, CheckerVerdict, GoalControllerConfig, ThinkingLevel } from "./types.ts";
import { buildCheckerPrompt } from "./prompts.ts";
import { CHECKER_AUDIT_TOOLS_ARG, CHECKER_DISABLED_RESOURCE_ARGS } from "./checker-profile.ts";
import { normalizeCheckerModelBootstrapPaths } from "./checker-model-bootstrap.ts";

export interface CheckerRunInput {
  goal: ActiveGoal;
  context: CheckerSessionContext;
  config: GoalControllerConfig;
  cwd: string;
  model: ExtensionContext["model"];
  thinkingLevel: ThinkingLevel;
  checkerModelBootstrapPaths?: readonly string[];
  signal?: AbortSignal;
}

export interface CheckerRunner {
  run(input: CheckerRunInput): Promise<CheckerVerdict>;
}

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

class CheckerFailure extends Error {
  public override readonly name = "CheckerFailure";
}

type VerdictValidationCode = "not-json" | "missing-decision" | "conflicting-fields" | "insufficient-proof";

class VerdictValidationError extends Error {
  public override readonly name = "VerdictValidationError";
  public constructor(public readonly code: VerdictValidationCode, message: string) {
    super(message);
  }
}

export class PiSubprocessCheckerRunner implements CheckerRunner {
  public constructor(private readonly pi: Pick<ExtensionAPI, "exec">) {}

  public async run(input: CheckerRunInput): Promise<CheckerVerdict> {
    const prompt = buildCheckerPrompt(input.goal, input.context);
    const effectiveModel = resolveModelPattern(input.config.checker.model, input.model);
    const args = checkerArgs(input, prompt, effectiveModel);
    const startedAt = Date.now();
    let result: ExecResult;
    try {
      result = await this.pi.exec("pi", args, {
        cwd: input.cwd,
        timeout: input.config.checker.timeoutMs,
        signal: input.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CheckerFailure([
        "Goal checker subprocess could not start or complete.",
        checkerConfigSummary(input.config, effectiveModel),
        `Execution classification: ${classifyExecutionFailure(message)}`,
      ].join("\n"));
    }
    const elapsedMs = Math.max(0, Date.now() - startedAt);

    if (result.killed || result.code !== 0) {
      throw new CheckerFailure(formatCheckerSubprocessFailure(result, input.config, elapsedMs, effectiveModel));
    }

    const finalText = verdictTextFromJsonMode(result.stdout, input.config, effectiveModel);
    try {
      return parseCheckerVerdict(finalText);
    } catch (error) {
      throw new CheckerFailure([
        "Goal checker returned an invalid verdict.",
        checkerConfigSummary(input.config, effectiveModel),
        `Verdict classification: ${classifyVerdictFailure(error)}`,
      ].join("\n"));
    }
  }
}

function formatCheckerSubprocessFailure(
  result: ExecResult,
  config: GoalControllerConfig,
  elapsedMs: number,
  effectiveModel: string | undefined,
): string {
  const configSummary = checkerConfigSummary(config, effectiveModel);
  const noVerdict = "No checker verdict was returned.";
  const output = outputDiagnostics(result);

  if (result.killed) {
    const reachedTimeout = elapsedMs >= Math.max(0, config.checker.timeoutMs - Math.min(1_000, Math.floor(config.checker.timeoutMs * 0.05)));
    const reason = reachedTimeout
      ? `Goal checker subprocess timed out after ${formatDuration(elapsedMs)} (configured timeout ${formatDuration(config.checker.timeoutMs)} / timeoutMs=${config.checker.timeoutMs}) and was terminated.`
      : `Goal checker subprocess was terminated after ${formatDuration(elapsedMs)} before the configured timeout elapsed (${formatDuration(config.checker.timeoutMs)} / timeoutMs=${config.checker.timeoutMs}); this usually means the host or user aborted the checker.`;
    return [reason, `Exit code: ${result.code}.`, configSummary, noVerdict, output].filter(Boolean).join("\n");
  }

  return [
    `Goal checker subprocess exited with code ${result.code} after ${formatDuration(elapsedMs)} before returning a verdict.`,
    configSummary,
    noVerdict,
    output,
  ].filter(Boolean).join("\n");
}

function outputDiagnostics(result: ExecResult): string | undefined {
  const stderr = result.stderr.trim();
  const assistant = scanJsonMode(result.stdout).finalAssistantMessage;
  const stopReason = checkerStopReason(stringProperty(assistant, "stopReason"));
  const errorMessage = stringProperty(assistant, "errorMessage");
  const parts = [
    stderr ? `Stderr classification: ${classifyExecutionFailure(stderr)}` : undefined,
    stopReason ? `Assistant stop reason: ${stopReason}.` : undefined,
    errorMessage ? `Provider classification: ${classifyProviderFailure(errorMessage)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function classifyProviderFailure(message: string): string {
  if (/reverse engineering or duplicating model outputs/iu.test(message)) {
    return "The provider refused the checker request as suspected reverse engineering or duplicating model outputs.";
  }
  if (/no models match|model[^\r\n]*(?:not found|does not exist|invalid|unavailable|not supported)|model_not_found|unknown model|no such model|(?:404[^\r\n]*model|model[^\r\n]*404)/iu.test(message)) return "The requested checker model could not be resolved.";
  if (/rate.?limit|quota|\b429\b/iu.test(message)) return "The provider reported a rate-limit or quota failure.";
  if (/unauthorized|forbidden|authentication|authorization|invalid[_ -]?api[_ -]?key|incorrect api key|credentials?|\b401\b|\b403\b/iu.test(message)) {
    return "The provider reported an authentication or authorization failure.";
  }
  if (/timed?\s*out|timeout/iu.test(message)) return "The provider request timed out.";
  return "The provider returned an assistant error. Inspect local Pi logs for details.";
}

function classifyExecutionFailure(message: string): string {
  if (/reverse engineering or duplicating model outputs/iu.test(message)) {
    return "The provider refused the checker request as suspected reverse engineering or duplicating model outputs.";
  }
  if (/rate.?limit|quota|\b429\b/iu.test(message)) return "The provider reported a rate-limit or quota failure.";
  if (/no models match|model[^\r\n]*(?:not found|does not exist|invalid|unavailable|not supported)|model_not_found|unknown model|no such model|(?:404[^\r\n]*model|model[^\r\n]*404)/iu.test(message)) return "The requested checker model could not be resolved.";
  if (/no API key|API key not found|missing credentials?/iu.test(message)) {
    return "Checker process authentication or authorization failed.";
  }
  if (/enoent|spawn|(?:command|executable)[^\r\n]*not found/iu.test(message)) return "The checker process could not be launched.";
  if (/timed?\s*out|timeout/iu.test(message)) return "The checker process timed out.";
  if (/unauthorized|forbidden|authentication|authorization|invalid[_ -]?api[_ -]?key|incorrect api key|credentials?|\b401\b|\b403\b/iu.test(message)) {
    return "Checker process authentication or authorization failed.";
  }
  return "Checker process execution failed. Inspect local Pi logs for details.";
}

function classifyVerdictFailure(error: unknown): string {
  if (!(error instanceof VerdictValidationError)) return "The checker verdict failed schema validation.";
  if (error.code === "not-json") return "The checker response was not a JSON verdict object.";
  if (error.code === "missing-decision") return "The checker verdict omitted a recognized decision.";
  if (error.code === "conflicting-fields") return "The checker verdict contained conflicting decision fields.";
  return "The completion verdict did not contain sufficient consistent proof.";
}

const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN = "(?:x[_-]?)?api[_-]?key|apikey|secret|token|password|passwd|passphrase|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret";

// Redaction is intentionally quote-agnostic: a failing bootstrap extension often
// renders provider config with Node's `util.inspect`, whose default is
// single-quoted strings (`{ apiKey: 'sk-...' }`), so both quote styles must be
// scrubbed. Auth-scheme stripping is anchored to an `authorization` header so
// ordinary prose like "basic validation failed" is not mangled.
export function redactSecrets(value: string): string {
  return value
    // Authorization headers: keep the header name and auth scheme word, drop the
    // credential (which may contain spaces, e.g. `Bearer <jwt>`).
    .replace(
      /\b((?:proxy-)?authorization\s*[:=]\s*)['"]?((?:bearer|basic|digest)\s+)?[^\r\n'"}]+/gi,
      (_match, prefix: string, scheme = "") => `${prefix}${scheme}${REDACTED}`,
    )
    // Standalone bearer tokens outside an Authorization header.
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`)
    // Quoted values may contain spaces and delimiters, so consume the whole
    // matching quoted value before handling unquoted carriers.
    .replace(
      new RegExp(`((?<![A-Za-z0-9_-])['"]?(?:${SECRET_KEY_PATTERN})['"]?\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*"`, "gi"),
      (_match, prefix: string) => `${prefix}"${REDACTED}"`,
    )
    .replace(
      new RegExp(`((?<![A-Za-z0-9_-])['"]?(?:${SECRET_KEY_PATTERN})['"]?\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*'`, "gi"),
      (_match, prefix: string) => `${prefix}'${REDACTED}'`,
    )
    // Truncated diagnostics can end before a quoted value closes.
    .replace(
      new RegExp(`((?<![A-Za-z0-9_-])['"]?(?:${SECRET_KEY_PATTERN})['"]?\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*\\\\?$`, "gim"),
      (_match, prefix: string) => `${prefix}"${REDACTED}`,
    )
    .replace(
      new RegExp(`((?<![A-Za-z0-9_-])['"]?(?:${SECRET_KEY_PATTERN})['"]?\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*\\\\?$`, "gim"),
      (_match, prefix: string) => `${prefix}'${REDACTED}`,
    )
    .replace(
      new RegExp(`((?<![A-Za-z0-9_-])['"]?(?:${SECRET_KEY_PATTERN})['"]?\\s*[:=]\\s*)([^\\s\\r\\n'"}][^\\r\\n'"}]*?)(?=\\s+[A-Za-z][\\w-]*\\s*=|,\\s*['"]?[A-Za-z][\\w-]*['"]?\\s*[:=]|[,;.]\\s+|\\s*}|$)`, "gi"),
      (_match, prefix: string) => `${prefix}${REDACTED}`,
    )
    // OpenAI-style secret keys anywhere else in the text.
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED);
}

function formatDuration(ms: number): string {
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function checkerArgs(input: CheckerRunInput, prompt: string, model: string | undefined): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--tools",
    CHECKER_AUDIT_TOOLS_ARG,
    ...CHECKER_DISABLED_RESOURCE_ARGS,
  ];

  for (const extensionPath of normalizeCheckerModelBootstrapPaths(input.checkerModelBootstrapPaths)) {
    args.push("-e", extensionPath);
  }

  if (model) args.push("--model", model);

  const thinking = input.config.checker.thinking === "inherit" ? input.thinkingLevel : input.config.checker.thinking;
  args.push("--thinking", thinking);
  args.push(prompt);
  return args;
}

function resolveModelPattern(setting: string, model: ExtensionContext["model"]): string | undefined {
  if (setting !== "inherit") return setting;
  const provider = stringProperty(model, "provider");
  const id = stringProperty(model, "id");
  if (provider && id) return `${provider}/${id}`;
  return id;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property.trim() : undefined;
}

function verdictTextFromJsonMode(
  stdout: string,
  config: GoalControllerConfig,
  effectiveModel: string | undefined,
): string {
  const { textBlocks, finalAssistantMessage, nonJsonLineCount, malformedEventCount } = scanJsonMode(stdout);
  const stopReason = checkerStopReason(stringProperty(finalAssistantMessage, "stopReason"));
  const errorMessage = stringProperty(finalAssistantMessage, "errorMessage");

  // The terminal outcome is trustworthy only after every emitted JSONL record
  // passes the protocol boundary.
  if (nonJsonLineCount > 0 || malformedEventCount > 0) {
    const counts = [
      nonJsonLineCount > 0
        ? `${nonJsonLineCount} non-JSON line${nonJsonLineCount === 1 ? "" : "s"}`
        : undefined,
      malformedEventCount > 0
        ? `${malformedEventCount} malformed recognized event envelope${malformedEventCount === 1 ? "" : "s"}`
        : undefined,
    ].filter((count): count is string => count !== undefined).join(", ");
    throw new CheckerFailure([
      `Goal checker returned a malformed Pi JSON event stream (${counts}).`,
      checkerConfigSummary(config, effectiveModel),
    ].join("\n"));
  }

  // Earlier failed attempts can remain in the stream when Pi retries. The final
  // assistant message is authoritative once retries settle.
  if (stopReason === "error" || stopReason === "aborted" || errorMessage) {
    const parts = [
      "Goal checker model failed before returning a verdict.",
      checkerConfigSummary(config, effectiveModel),
      stopReason ? `Assistant stop reason: ${stopReason}.` : undefined,
      errorMessage ? `Provider classification: ${classifyProviderFailure(errorMessage)}` : undefined,
      config.checker.model === "inherit"
        ? "The checker inherited the active session model. Configure checker.model explicitly in goal-controller.config.json if that model cannot perform checker work."
        : undefined,
    ];
    throw new CheckerFailure(parts.filter((part): part is string => part !== undefined).join("\n"));
  }

  if (finalAssistantMessage && stopReason !== "stop") {
    throw new CheckerFailure([
      "Goal checker model did not finish with a complete verdict response.",
      checkerConfigSummary(config, effectiveModel),
      `Assistant stop reason: ${stopReason ?? "missing"}.`,
    ].join("\n"));
  }

  if (finalAssistantMessage && !assistantMessageHasText(finalAssistantMessage)) {
    throw new CheckerFailure([
      "Goal checker model returned no verdict text.",
      checkerConfigSummary(config, effectiveModel),
      stopReason ? `Assistant stop reason: ${stopReason}.` : undefined,
    ].filter((part): part is string => part !== undefined).join("\n"));
  }

  // Reconstruct ordered terminal text, then prefer the last balanced JSON object
  // that is a valid verdict. This tolerates provider block-splitting and trailing
  // prose with unrelated braces without consulting earlier assistant turns.
  const finalText = textBlocks.join("");
  const candidates = jsonObjectCandidates(finalText);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate !== undefined && containsCheckerVerdict(candidate)) return candidate;
  }
  if (finalText) return finalText;

  throw new CheckerFailure([
    "Goal checker Pi JSON event stream ended without an assistant message_end verdict.",
    checkerConfigSummary(config, effectiveModel),
  ].join("\n"));
}

function scanJsonMode(stdout: string): {
  textBlocks: string[];
  finalAssistantMessage: Record<string, unknown> | undefined;
  nonJsonLineCount: number;
  malformedEventCount: number;
} {
  const textBlocks: string[] = [];
  let finalAssistantMessage: Record<string, unknown> | undefined;
  let nonJsonLineCount = 0;
  let malformedEventCount = 0;
  let lifecycleObserved = false;
  let lifecycleSettled = false;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = safeJsonParse(line);
    if (!isRecord(event) || typeof event.type !== "string") {
      nonJsonLineCount += 1;
      continue;
    }
    if (!isValidJsonModeEventEnvelope(event)) {
      malformedEventCount += 1;
      continue;
    }
    if (isLifecycleEvent(event.type)) {
      lifecycleObserved = true;
      lifecycleSettled = event.type === "agent_settled";
    }
    if (event.type !== "message_end") continue;
    if (lifecycleObserved && lifecycleSettled) lifecycleSettled = false;
    const message = event.message;
    if (!isRecord(message) || typeof message.role !== "string") {
      nonJsonLineCount += 1;
      continue;
    }
    if (message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) {
      nonJsonLineCount += 1;
      continue;
    }
    finalAssistantMessage = message;
    textBlocks.length = 0;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        textBlocks.push(block.text);
      }
    }
  }

  if (!lifecycleObserved || !lifecycleSettled) malformedEventCount += 1;
  return { textBlocks, finalAssistantMessage, nonJsonLineCount, malformedEventCount };
}

function isLifecycleEvent(type: unknown): boolean {
  return type === "agent_start"
    || type === "agent_end"
    || type === "agent_settled"
    || type === "compaction_start"
    || type === "compaction_end"
    || type === "auto_retry_start"
    || type === "auto_retry_end";
}

function isValidJsonModeEventEnvelope(event: Record<string, unknown>): boolean {
  switch (event.type) {
    case "session":
      return hasStringProperties(event, "id", "timestamp", "cwd")
        && (event.version === undefined || typeof event.version === "number")
        && (event.parentSession === undefined || typeof event.parentSession === "string");
    case "agent_start":
    case "agent_settled":
    case "turn_start":
      // JSON mode serializes AgentSession listener events, not extension-hook
      // events; raw turn_start records have no turnIndex or timestamp fields.
      return true;
    case "agent_end":
      return Array.isArray(event.messages)
        && event.messages.every(isAgentMessageEnvelope)
        && typeof event.willRetry === "boolean";
    case "turn_end":
      return isAgentMessageEnvelope(event.message)
        && Array.isArray(event.toolResults)
        && event.toolResults.every((result) => isAgentMessageEnvelope(result) && result.role === "toolResult");
    case "message_start":
      return isAgentMessageEnvelope(event.message);
    case "message_end":
      return isTerminalMessageEnvelope(event.message);
    case "message_update":
      return isAgentMessageEnvelope(event.message) && isAssistantMessageEventEnvelope(event.assistantMessageEvent);
    case "tool_execution_start":
      return hasStringProperties(event, "toolCallId", "toolName") && Object.hasOwn(event, "args");
    case "tool_execution_update":
      return hasStringProperties(event, "toolCallId", "toolName")
        && Object.hasOwn(event, "args")
        && Object.hasOwn(event, "partialResult");
    case "tool_execution_end":
      return hasStringProperties(event, "toolCallId", "toolName")
        && Object.hasOwn(event, "result")
        && typeof event.isError === "boolean";
    case "queue_update":
      return isStringArray(event.steering) && isStringArray(event.followUp);
    case "compaction_start":
      return isCompactionReason(event.reason);
    case "entry_appended":
      return isSessionEntryEnvelope(event.entry);
    case "session_info_changed":
      return event.name === undefined || typeof event.name === "string";
    case "thinking_level_changed":
      return isThinkingLevel(event.level);
    case "compaction_end":
      return isCompactionReason(event.reason)
        && typeof event.aborted === "boolean"
        && typeof event.willRetry === "boolean"
        && (event.result === undefined || isCompactionResult(event.result))
        && (event.errorMessage === undefined || typeof event.errorMessage === "string");
    case "auto_retry_start":
      return hasNumberProperties(event, "attempt", "maxAttempts", "delayMs")
        && typeof event.errorMessage === "string";
    case "auto_retry_end":
      return typeof event.success === "boolean"
        && typeof event.attempt === "number"
        && (event.finalError === undefined || typeof event.finalError === "string");
    default:
      // Unknown event types remain forward-compatible; every event type known to
      // the current Pi JSON contract must carry its required envelope fields.
      return true;
  }
}

function isTerminalMessageEnvelope(value: unknown): value is Record<string, unknown> {
  return isAgentMessageEnvelope(value);
}

function isAgentMessageEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.role !== "string") return false;
  switch (value.role) {
    case "assistant":
      return hasStringProperties(value, "api", "provider", "model")
        && Array.isArray(value.content)
        && value.content.every(isAssistantContent)
        && isUsage(value.usage)
        && checkerStopReason(stringProperty(value, "stopReason")) !== undefined
        && (value.errorMessage === undefined || typeof value.errorMessage === "string")
        && (value.responseModel === undefined || typeof value.responseModel === "string")
        && (value.responseId === undefined || typeof value.responseId === "string")
        && (value.diagnostics === undefined || (Array.isArray(value.diagnostics) && value.diagnostics.every(isAssistantDiagnostic)))
        && typeof value.timestamp === "number";
    case "user":
      return (typeof value.content === "string" || (Array.isArray(value.content) && value.content.every(isUserContent)))
        && typeof value.timestamp === "number";
    case "toolResult":
      return hasStringProperties(value, "toolCallId", "toolName")
        && Array.isArray(value.content)
        && value.content.every(isUserContent)
        && (value.addedToolNames === undefined || isStringArray(value.addedToolNames))
        && typeof value.isError === "boolean"
        && typeof value.timestamp === "number";
    case "custom":
      return typeof value.customType === "string"
        && (typeof value.content === "string" || (Array.isArray(value.content) && value.content.every(isUserContent)))
        && typeof value.display === "boolean"
        && typeof value.timestamp === "number";
    case "bashExecution":
      return hasStringProperties(value, "command", "output")
        && (value.exitCode === undefined || typeof value.exitCode === "number")
        && typeof value.cancelled === "boolean"
        && typeof value.truncated === "boolean"
        && (value.fullOutputPath === undefined || typeof value.fullOutputPath === "string")
        && (value.excludeFromContext === undefined || typeof value.excludeFromContext === "boolean")
        && typeof value.timestamp === "number";
    case "branchSummary":
      return hasStringProperties(value, "summary", "fromId") && typeof value.timestamp === "number";
    case "compactionSummary":
      return typeof value.summary === "string"
        && typeof value.tokensBefore === "number"
        && typeof value.timestamp === "number";
    default:
      return false;
  }
}

function isSessionEntryEnvelope(value: unknown): boolean {
  if (!isRecord(value)
    || !hasStringProperties(value, "type", "id", "timestamp")
    || (value.parentId !== null && typeof value.parentId !== "string")) return false;
  switch (value.type) {
    case "message":
      return isAgentMessageEnvelope(value.message);
    case "thinking_level_change":
      return typeof value.thinkingLevel === "string";
    case "model_change":
      return hasStringProperties(value, "provider", "modelId");
    case "compaction":
      return hasStringProperties(value, "summary", "firstKeptEntryId")
        && typeof value.tokensBefore === "number"
        && (value.fromHook === undefined || typeof value.fromHook === "boolean");
    case "branch_summary":
      return hasStringProperties(value, "fromId", "summary")
        && (value.fromHook === undefined || typeof value.fromHook === "boolean");
    case "custom":
      return typeof value.customType === "string";
    case "custom_message":
      return typeof value.customType === "string"
        && (typeof value.content === "string" || (Array.isArray(value.content) && value.content.every(isUserContent)))
        && typeof value.display === "boolean";
    case "label":
      return typeof value.targetId === "string"
        && (value.label === undefined || typeof value.label === "string");
    case "session_info":
      return value.name === undefined || typeof value.name === "string";
    default:
      return false;
  }
}

function isAssistantDiagnostic(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.timestamp !== "number") return false;
  if (value.details !== undefined && !isRecord(value.details)) return false;
  if (value.error === undefined) return true;
  return isRecord(value.error)
    && typeof value.error.message === "string"
    && (value.error.name === undefined || typeof value.error.name === "string")
    && (value.error.stack === undefined || typeof value.error.stack === "string")
    && (value.error.code === undefined || typeof value.error.code === "string" || typeof value.error.code === "number");
}

function isAssistantContent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "text") {
    return typeof value.text === "string"
      && (value.textSignature === undefined || typeof value.textSignature === "string");
  }
  if (value.type === "thinking") {
    return typeof value.thinking === "string"
      && (value.thinkingSignature === undefined || typeof value.thinkingSignature === "string")
      && (value.redacted === undefined || typeof value.redacted === "boolean");
  }
  return value.type === "toolCall"
    && hasStringProperties(value, "id", "name")
    && isRecord(value.arguments)
    && (value.thoughtSignature === undefined || typeof value.thoughtSignature === "string");
}

function isUserContent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  return value.type === "image"
    && hasStringProperties(value, "data", "mimeType");
}

function isUsage(value: unknown): boolean {
  return isRecord(value)
    && hasNumberProperties(value, "input", "output", "cacheRead", "cacheWrite", "totalTokens")
    && (value.cacheWrite1h === undefined || typeof value.cacheWrite1h === "number")
    && (value.reasoning === undefined || typeof value.reasoning === "number")
    && isRecord(value.cost)
    && hasNumberProperties(value.cost, "input", "output", "cacheRead", "cacheWrite", "total");
}

function isCompactionResult(value: unknown): boolean {
  return isRecord(value)
    && hasStringProperties(value, "summary", "firstKeptEntryId")
    && typeof value.tokensBefore === "number"
    && (value.estimatedTokensAfter === undefined || typeof value.estimatedTokensAfter === "number");
}

function isAssistantMessageEventEnvelope(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "start":
      return isAgentMessageEnvelope(value.partial) && value.partial.role === "assistant";
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return typeof value.contentIndex === "number"
        && isAgentMessageEnvelope(value.partial)
        && value.partial.role === "assistant";
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return typeof value.contentIndex === "number"
        && typeof value.delta === "string"
        && isAgentMessageEnvelope(value.partial)
        && value.partial.role === "assistant";
    case "text_end":
    case "thinking_end":
      return typeof value.contentIndex === "number"
        && typeof value.content === "string"
        && isAgentMessageEnvelope(value.partial)
        && value.partial.role === "assistant";
    case "toolcall_end":
      return typeof value.contentIndex === "number"
        && isAssistantContent(value.toolCall)
        && isRecord(value.toolCall)
        && value.toolCall.type === "toolCall"
        && isAgentMessageEnvelope(value.partial)
        && value.partial.role === "assistant";
    case "done":
      return (value.reason === "stop" || value.reason === "length" || value.reason === "toolUse")
        && isAgentMessageEnvelope(value.message)
        && value.message.role === "assistant";
    case "error":
      return (value.reason === "error" || value.reason === "aborted")
        && isAgentMessageEnvelope(value.error)
        && value.error.role === "assistant";
    default:
      return false;
  }
}

function hasStringProperties(value: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

function hasNumberProperties(value: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "number");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCompactionReason(value: unknown): boolean {
  return value === "manual" || value === "threshold" || value === "overflow";
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max";
}

function assistantMessageHasText(message: Record<string, unknown>): boolean {
  const content = message.content;
  return Array.isArray(content) && content.some(
    (block) => isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
  );
}

function checkerStopReason(value: string | undefined): "stop" | "length" | "toolUse" | "error" | "aborted" | undefined {
  if (value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted") return value;
  return undefined;
}

function checkerConfigSummary(config: GoalControllerConfig, modelPattern: string | undefined): string {
  const selection = config.checker.model === "inherit"
    ? `effectiveModel=${modelPattern ?? "unresolved"}`
    : `requestedModel=${modelPattern ?? config.checker.model}`;
  return redactSecrets(`Checker config: model=${config.checker.model}, thinking=${config.checker.thinking}, timeoutMs=${config.checker.timeoutMs}, ${selection}.`);
}

export function safeCheckerFailureMessage(
  error: unknown,
  config: GoalControllerConfig,
  model: ExtensionContext["model"],
): string {
  if (error instanceof CheckerFailure) {
    return error.message.length > 4_000 ? `${error.message.slice(0, 4_000)}…` : error.message;
  }
  const modelPattern = resolveModelPattern(config.checker.model, model);
  return [
    "Goal checker failed unexpectedly. Inspect local Pi logs for details.",
    checkerConfigSummary(config, modelPattern),
  ].join("\n");
}

function jsonObjectCandidates(text: string): string[] {
  const containers: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0; start < text.length; start += 1) {
    const opening = text[start];
    if (opening !== "{" && opening !== "[") continue;
    const closings = [opening === "{" ? "}" : "]"];
    let quoted = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === "{") closings.push("}");
      else if (char === "[") closings.push("]");
      else if (char === "}" || char === "]") {
        if (closings.pop() !== char) break;
        if (closings.length === 0) {
          containers.push({ start, end: index, text: text.slice(start, index + 1) });
          break;
        }
      }
    }
  }

  return containers
    .filter((candidate) => candidate.text.startsWith("{"))
    .filter((candidate) => !containers.some((parent) => (
      parent.start < candidate.start
      && parent.end > candidate.end
    )))
    .map((candidate) => candidate.text);
}

function containsCheckerVerdict(text: string): boolean {
  try {
    parseCheckerVerdict(text);
    return true;
  } catch {
    return false;
  }
}

export function parseCheckerVerdict(text: string): CheckerVerdict {
  const parsed = safeJsonParse(extractJsonObject(text));
  if (!isRecord(parsed)) throw new VerdictValidationError("not-json", `checker did not return a JSON object: ${text.slice(0, 300)}`);

  const decision = checkerDecision(parsed.decision);
  if (!decision) throw new VerdictValidationError("missing-decision", "checker verdict must include a recognized decision");
  const complete = decision === "complete";
  const blocked = decision === "blocked";
  if (parsed.complete !== undefined && parsed.complete !== complete) {
    throw new VerdictValidationError("conflicting-fields", `checker verdict decision=${decision} conflicts with complete=${String(parsed.complete)}`);
  }
  if (parsed.blocked !== undefined && parsed.blocked !== blocked) {
    throw new VerdictValidationError("conflicting-fields", `checker verdict decision=${decision} conflicts with blocked=${String(parsed.blocked)}`);
  }
  const reason = typeof parsed.reason === "string" && parsed.reason.trim().length > 0 ? parsed.reason.trim() : complete ? "Checker marked the goal complete." : "Checker did not find the goal complete.";
  const evidence = stringArray(parsed.evidence);
  const requirementVerdicts = requirements(parsed.requirements);

  if (complete) {
    assertCompleteVerdictHasEvidence(evidence, requirementVerdicts);
  }

  return {
    decision,
    complete,
    blocked,
    reason,
    nextTurnGuidance: stringArrayOrString(parsed.nextTurnGuidance),
    evidence,
    unmetRequirements: stringArray(parsed.unmetRequirements),
    requirements: requirementVerdicts,
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)?.[1];
  return fenced?.trim() ?? trimmed;
}

function requirements(value: unknown): CheckerVerdict["requirements"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new VerdictValidationError("insufficient-proof", "checker verdict requirements must be an array");
  const result: NonNullable<CheckerVerdict["requirements"]> = [];
  for (const item of value) {
    if (!isRecord(item)) throw new VerdictValidationError("insufficient-proof", "checker verdict contains a malformed requirement entry");
    const requirement = typeof item.requirement === "string" && item.requirement.trim() ? item.requirement : undefined;
    const status = item.status;
    if (!requirement || !isRequirementStatus(status)) {
      throw new VerdictValidationError("insufficient-proof", "checker verdict contains a malformed requirement entry");
    }
    result.push({
      requirement,
      status,
      evidence: typeof item.evidence === "string" ? item.evidence : undefined,
    });
  }
  return result.length > 0 ? result : undefined;
}

function checkerDecision(value: unknown): CheckerDecision | undefined {
  if (value === "complete" || value === "continue" || value === "waiting_for_user" || value === "blocked") return value;
  return undefined;
}

function isRequirementStatus(value: unknown): value is "satisfied" | "unsatisfied" | "unclear" | "not_applicable" {
  return value === "satisfied" || value === "unsatisfied" || value === "unclear" || value === "not_applicable";
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return strings.length > 0 ? strings : undefined;
}

function stringArrayOrString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const array = stringArray(value);
  return array?.join("\n");
}

function assertCompleteVerdictHasEvidence(
  evidence: string[] | undefined,
  requirementVerdicts: CheckerVerdict["requirements"],
): void {
  if (!evidence || evidence.length === 0) {
    throw new VerdictValidationError("insufficient-proof", "complete checker verdict must include at least one evidence item");
  }
  if (!requirementVerdicts || requirementVerdicts.length === 0) {
    throw new VerdictValidationError("insufficient-proof", "complete checker verdict must include requirement-by-requirement assessment");
  }
  const unproven = requirementVerdicts.filter((item) => item.status !== "satisfied" && item.status !== "not_applicable");
  if (unproven.length > 0) {
    throw new VerdictValidationError("insufficient-proof", `complete checker verdict has unproven requirements: ${unproven.map((item) => item.requirement).join(", ")}`);
  }
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
