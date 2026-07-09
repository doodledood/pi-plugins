import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { clampTimeout, loadConfig } from "./config.ts";
import { resolveExcludedTools } from "./child-profile.ts";
import { PiSubprocessAdvisorRunner } from "./runner.ts";
import {
  ADVISOR_PROMPT_SNIPPET,
  ADVISOR_SYSTEM_PROMPT,
  ADVISOR_TOOL_DESCRIPTION,
  ADVISOR_TOOL_GUIDELINES,
  MODEL_FIELD_DESCRIPTION,
  QUERY_FIELD_DESCRIPTION,
  TIMEOUT_FIELD_DESCRIPTION,
} from "./prompts.ts";
import type { AdvisorConsultConfig, AdvisorResult, AdvisorRunner, ThinkingLevel } from "./types.ts";
import { INHERIT_MODEL } from "./types.ts";
import type { AdvisorConsultHost } from "./host.ts";

/** Absolute path to the child bootstrap, passed to the subprocess via `-e`. */
const BOOTSTRAP_EXTENSION_PATH = fileURLToPath(new URL("./child-bootstrap.ts", import.meta.url));

const advisorSchema = Type.Object({
  query: Type.String({ description: QUERY_FIELD_DESCRIPTION }),
  model: Type.Optional(Type.String({ description: MODEL_FIELD_DESCRIPTION })),
  thinking: Type.Optional(
    Type.Union(
      [
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
      ],
      { description: "Optional advisor reasoning effort (Pi-native names). Defaults to the configured level (xhigh)." },
    ),
  ),
  timeout_ms: Type.Optional(Type.Number({ description: TIMEOUT_FIELD_DESCRIPTION })),
});
type AdvisorParams = Static<typeof advisorSchema>;

export interface ConsultDeps {
  runner: AdvisorRunner;
  config: AdvisorConsultConfig;
  cwd: string;
  parentModelPattern?: string;
  bootstrapExtensionPath: string;
  signal?: AbortSignal;
}

export interface ConsultOutput {
  text: string;
  details: Record<string, unknown>;
}

/**
 * Pure orchestration for one advisor consult: validate input, resolve model /
 * thinking / timeout, run the subprocess, and format a parent-facing result.
 * Kept free of Pi API objects so it is testable with a fake runner.
 */
export async function consult(params: AdvisorParams, deps: ConsultDeps): Promise<ConsultOutput> {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) {
    return {
      text: "advisor_consult needs a non-empty `query`: a context-rich advisory brief (objective, key facts, your current read, the tensions, and the decision). Nothing was consulted.",
      details: { ok: false, error: "empty_query" },
    };
  }

  const thinking: ThinkingLevel = params.thinking ?? deps.config.defaultThinking;
  const { model, inherited } = resolveModel(params.model, deps.config, deps.parentModelPattern);
  const timeout = resolveTimeout(params.timeout_ms, deps.config);
  const excludedTools = resolveExcludedTools(deps.config.excludedTools);

  const result = await deps.runner.run({
    query,
    model,
    thinking,
    timeoutMs: timeout.timeoutMs,
    cwd: deps.cwd,
    systemPrompt: ADVISOR_SYSTEM_PROMPT,
    bootstrapExtensionPath: deps.bootstrapExtensionPath,
    excludedTools,
    signal: deps.signal,
  });

  return formatResult(result, { requestedModel: model, inherited, timeoutNote: timeout.note });
}

export function resolveModel(
  paramModel: string | undefined,
  config: AdvisorConsultConfig,
  parentModelPattern: string | undefined,
): { model?: string; inherited: boolean } {
  const requested = typeof paramModel === "string" ? paramModel.trim() : "";
  const setting = requested || config.defaultModel;
  if (!setting || setting === INHERIT_MODEL) {
    return { model: parentModelPattern, inherited: true };
  }
  return { model: setting, inherited: false };
}

export function resolveTimeout(
  paramTimeout: number | undefined,
  config: AdvisorConsultConfig,
): { timeoutMs: number; note?: string } {
  if (paramTimeout === undefined || paramTimeout === null) {
    return { timeoutMs: config.defaultTimeoutMs };
  }
  if (typeof paramTimeout !== "number" || !Number.isFinite(paramTimeout) || paramTimeout <= 0) {
    return {
      timeoutMs: config.defaultTimeoutMs,
      note: `Ignored invalid timeout_ms; used the default ${config.defaultTimeoutMs} ms.`,
    };
  }
  const clamped = clampTimeout(paramTimeout, config);
  const note =
    clamped !== Math.floor(paramTimeout)
      ? `Clamped timeout_ms to ${clamped} ms (bounds ${config.minTimeoutMs}–${config.maxTimeoutMs} ms).`
      : undefined;
  return { timeoutMs: clamped, note };
}

function formatResult(
  result: AdvisorResult,
  meta: { requestedModel?: string; inherited: boolean; timeoutNote?: string },
): ConsultOutput {
  if (!result.ok) {
    return {
      text: [meta.timeoutNote, result.error].filter(Boolean).join("\n\n"),
      details: {
        ok: false,
        timedOut: result.timedOut === true,
        elapsedMs: result.elapsedMs,
        model: result.model,
        requestedModel: meta.requestedModel,
      },
    };
  }

  const headerBits = [`advisor · model: ${result.model ?? meta.requestedModel ?? "unknown"} · ${formatDuration(result.elapsedMs)}`];
  const notes: string[] = [];
  if (meta.timeoutNote) notes.push(meta.timeoutNote);
  if (!meta.inherited && meta.requestedModel && result.model && modelsDiffer(meta.requestedModel, result.model)) {
    notes.push(`note: requested model '${meta.requestedModel}' was not used; the advisor ran on '${result.model}'.`);
  }

  const text = [`[${headerBits.join("")}]`, ...notes, "", result.advice ?? ""].join("\n").trim();
  return {
    text,
    details: {
      ok: true,
      model: result.model,
      requestedModel: meta.requestedModel,
      elapsedMs: result.elapsedMs,
    },
  };
}

/** Compare model identifiers tolerantly (provider/id vs bare id). */
export function modelsDiffer(requested: string, actual: string): boolean {
  const norm = (value: string): string => {
    const trimmed = value.trim().toLowerCase();
    const slash = trimmed.lastIndexOf("/");
    return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  };
  return norm(requested) !== norm(actual);
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

function resolveModelPattern(model: ExtensionContext["model"]): string | undefined {
  const provider = stringProperty(model, "provider");
  const id = stringProperty(model, "id");
  if (provider && id) return `${provider}/${id}`;
  return id;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.trim().length > 0 ? property.trim() : undefined;
}

export function activate(pi: AdvisorConsultHost, runner: AdvisorRunner): void {
  pi.registerTool({
    name: "advisor_consult",
    label: "Advisor Consult",
    description: ADVISOR_TOOL_DESCRIPTION,
    promptSnippet: ADVISOR_PROMPT_SNIPPET,
    promptGuidelines: [...ADVISOR_TOOL_GUIDELINES],
    parameters: advisorSchema,
    async execute(_toolCallId: string, params: AdvisorParams, signal, _onUpdate, ctx: ExtensionContext) {
      const loaded = loadConfig();
      if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
      const output = await consult(params, {
        runner,
        config: loaded.config,
        cwd: ctx.cwd,
        parentModelPattern: resolveModelPattern(ctx.model),
        bootstrapExtensionPath: BOOTSTRAP_EXTENSION_PATH,
        signal,
      });
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: output.details,
      };
    },
  });
}

export default function advisorConsult(pi: ExtensionAPI): void {
  activate(pi, new PiSubprocessAdvisorRunner(pi));
}
