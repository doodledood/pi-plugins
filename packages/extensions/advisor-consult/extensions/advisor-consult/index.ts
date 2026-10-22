import { fileURLToPath } from "node:url";
import { keyHint, resolveCliModel, type ExtensionAPI, type ExtensionContext, type ModelRuntime, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { clampTimeout, loadConfig } from "./config.ts";
import { resolveExcludedTools } from "./child-profile.ts";
import { formatDuration } from "./format.ts";
import { PiSubprocessAdvisorRunner } from "./runner.ts";
import { deriveChildSessionDir } from "./sidecar.ts";
import {
  ADVISOR_PROMPT_SNIPPET,
  ADVISOR_SYSTEM_PROMPT,
  ADVISOR_TOOL_DESCRIPTION,
  ADVISOR_TOOL_GUIDELINES,
  MODEL_FIELD_DESCRIPTION,
  QUERY_FIELD_DESCRIPTION,
  TIMEOUT_FIELD_DESCRIPTION,
} from "./prompts.ts";
import {
  INHERIT_MODEL,
  THINKING_LEVELS,
  isThinkingLevel,
  type AdvisorConsultConfig,
  type AdvisorResult,
  type AdvisorRunner,
  type ThinkingLevel,
} from "./types.ts";
import type { AdvisorConsultHost } from "./host.ts";

/** Sidecar folder name for advisor sessions under the parent session. */
export const ADVISOR_SESSION_KIND = "advisor";

/** Absolute path to the child bootstrap, passed to the subprocess via `-e`. */
const BOOTSTRAP_EXTENSION_PATH = fileURLToPath(new URL("./child-bootstrap.ts", import.meta.url));

const advisorSchema = Type.Object({
  query: Type.String({ description: QUERY_FIELD_DESCRIPTION }),
  model: Type.Optional(Type.String({ description: MODEL_FIELD_DESCRIPTION })),
  thinking: Type.Optional(
    Type.Enum(THINKING_LEVELS, {
      description: "Optional advisor reasoning effort (Pi-native names). Defaults to the configured level (xhigh).",
    }),
  ),
  timeout_ms: Type.Optional(Type.Number({ description: TIMEOUT_FIELD_DESCRIPTION })),
});
type AdvisorParams = Static<typeof advisorSchema>;

type AdvisorCallArgs = Partial<Record<keyof AdvisorParams, unknown>>;

interface DisplayField {
  value: string;
  provenance: "requested" | "configured default" | "clamped" | "pending" | "invalid";
}

interface AdvisorCallPresentation {
  collapsedHeader: string;
  collapsedQuery: string;
  expanded: string;
}

class AdvisorCallView {
  private collapsedHeader = "";
  private collapsedQuery = "";
  private readonly expandedText = new Text("", 0, 0);
  private expanded = false;
  /**
   * The last width's lines. pi draws the whole transcript every frame and keeps no lines between
   * frames, so a call that has stopped changing hands back the same lines until update() or invalidate().
   */
  private drawn: { width: number; lines: string[] } | undefined;

  update(presentation: AdvisorCallPresentation, expanded: boolean): void {
    this.collapsedHeader = presentation.collapsedHeader;
    this.collapsedQuery = presentation.collapsedQuery;
    this.expandedText.setText(presentation.expanded);
    this.expanded = expanded;
    this.drawn = undefined;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.drawn?.width === width) return this.drawn.lines;
    const lines = this.expanded
      ? this.expandedText.render(width).map((line) => truncateToWidth(line, width))
      : [truncateToWidth(this.collapsedHeader, width), truncateToWidth(this.collapsedQuery, width)];
    this.drawn = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.drawn = undefined;
    this.expandedText.invalidate();
  }
}

/** Per-row renderer state Pi shares between a call's call and result renders. */
interface AdvisorRowState {
  ranWith?: AdvisorConsultConfig;
  callView?: AdvisorCallView;
}

function configFromDetails(details: unknown): AdvisorConsultConfig | undefined {
  if (!isRecord(details) || !isRecord(details.config)) return undefined;
  const config = details.config;
  if (
    typeof config.defaultModel !== "string" ||
    !isThinkingLevel(config.defaultThinking) ||
    typeof config.defaultTimeoutMs !== "number" ||
    typeof config.minTimeoutMs !== "number" ||
    typeof config.maxTimeoutMs !== "number" ||
    !Array.isArray(config.excludedTools)
  ) {
    return undefined;
  }
  return config as unknown as AdvisorConsultConfig;
}

/** Lines of a collapsed result, matching Pi's own preview of tool output. */
const COLLAPSED_RESULT_LINES = 10;

/** The tool output as Pi's default view shows it: a ten-line preview, the whole text when expanded. */
function renderResultText(content: readonly { type: string; text?: string }[], expanded: boolean, theme: Theme): Text {
  const output = content
    .filter((block) => block.type === "text")
    .map((block) => sanitizeOutput(block.text ?? ""))
    .join("\n");
  const lines = output.split("\n");
  const shown = expanded ? lines : lines.slice(0, COLLAPSED_RESULT_LINES);
  let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
  const remaining = lines.length - shown.length;
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  }
  return new Text(text, 0, 0);
}

function sanitizeOutput(value: string): string {
  let out = "";
  for (const character of value.replace(/\r/gu, "")) {
    const codePoint = character.codePointAt(0)!;
    out += codePoint === 0x0a || codePoint === 0x09 || !isTerminalControl(codePoint) ? character : `\\x${codePoint.toString(16).padStart(2, "0")}`;
  }
  return out;
}

export interface ConsultDeps {
  runner: AdvisorRunner;
  config: AdvisorConsultConfig;
  cwd: string;
  parentModelPattern?: string;
  bootstrapExtensionPath: string;
  /** Where the advisor's session file goes; undefined when the parent has none. */
  sessionDir?: string;
  signal?: AbortSignal;
  /**
   * What a `--model` pattern resolves to (`provider/id`), the way Pi resolves it: thinking suffixes and fuzzy
   * matches included. Undefined when the pattern resolves to no single model.
   */
  resolveModelPattern?: (pattern: string) => string | undefined;
}

export interface ConsultOutput {
  text: string;
  /** True when the consult produced no advice: the result is reported to the model as a failed tool call. */
  isError: boolean;
  details: Record<string, unknown> & { ok: boolean };
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
      isError: true,
      details: { ok: false, error: "empty_query", config: deps.config },
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
    ...(deps.sessionDir ? { sessionDir: deps.sessionDir } : {}),
    excludedTools,
    signal: deps.signal,
  });

  return formatResult(result, {
    requestedModel: model,
    inherited,
    timeoutNote: timeout.note,
    config: deps.config,
    resolveModelPattern: deps.resolveModelPattern,
  });
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
  meta: {
    requestedModel?: string;
    inherited: boolean;
    timeoutNote?: string;
    config: AdvisorConsultConfig;
    resolveModelPattern?: (pattern: string) => string | undefined;
  },
): ConsultOutput {
  if (!result.ok) {
    return {
      text: [meta.timeoutNote, result.error].filter(Boolean).join("\n\n"),
      isError: true,
      details: {
        ok: false,
        timedOut: result.timedOut === true,
        elapsedMs: result.elapsedMs,
        model: result.model,
        requestedModel: meta.requestedModel,
        config: meta.config,
      },
    };
  }

  const headerBits = [`advisor · model: ${result.model ?? meta.requestedModel ?? "unknown"} · ${formatDuration(result.elapsedMs)}`];
  const notes: string[] = [];
  if (meta.timeoutNote) notes.push(meta.timeoutNote);
  if (!meta.inherited && meta.requestedModel && result.model && modelNotUsed(meta.requestedModel, result.model, meta.resolveModelPattern)) {
    notes.push(`note: requested model '${meta.requestedModel}' was not used; the advisor ran on '${result.model}'.`);
  }

  const text = [`[${headerBits.join("")}]`, ...notes, "", result.advice ?? ""].join("\n").trim();
  return {
    text,
    isError: false,
    details: {
      ok: true,
      model: result.model,
      requestedModel: meta.requestedModel,
      elapsedMs: result.elapsedMs,
      config: meta.config,
    },
  };
}

/**
 * True when the advisor ran on a model other than the one its pattern resolves to. The pattern is compared
 * through Pi's own resolution, so `model:high` or a fuzzy `fable` that resolves to the model used is not a
 * mismatch. A pattern that resolves to no single model here gives nothing to compare against: no note.
 */
export function modelNotUsed(
  requested: string,
  actual: string,
  resolveModelPattern: ((pattern: string) => string | undefined) | undefined,
): boolean {
  const expected = resolveModelPattern?.(requested);
  if (!expected) return false;
  const [expectedProvider, expectedId] = splitModel(expected);
  const [actualProvider, actualId] = splitModel(actual);
  if (expectedId !== actualId) return true;
  return expectedProvider !== undefined && actualProvider !== undefined && expectedProvider !== actualProvider;
}

function splitModel(value: string): [string | undefined, string] {
  const trimmed = value.trim().toLowerCase();
  const slash = trimmed.indexOf("/");
  return slash >= 0 ? [trimmed.slice(0, slash), trimmed.slice(slash + 1)] : [undefined, trimmed];
}

/**
 * Resolve a `--model` pattern against the parent's model registry with Pi's CLI resolver, the same rules the
 * advisor subprocess applies to its `--model` flag.
 */
function registryPatternResolver(registry: ExtensionContext["modelRegistry"]): (pattern: string) => string | undefined {
  // resolveCliModel reads only these two runtime methods; the extension API exposes the registry facade.
  // Both are type-checked against Pi's ModelRuntime; only the widening to the full type is a cast.
  const members: Pick<ModelRuntime, "getModels" | "hasConfiguredAuth"> = {
    getModels: () => registry.getAll(),
    hasConfiguredAuth: (provider) => registry.getAvailable().some((model) => model.provider === provider),
  };
  const runtime = members as ModelRuntime;
  return (pattern) => {
    const resolved = resolveCliModel({ cliModel: pattern, modelRuntime: runtime });
    return resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : undefined;
  };
}

function presentAdvisorCall(
  rawArgs: unknown,
  config: AdvisorConsultConfig,
  argsComplete: boolean,
  theme: Theme,
): AdvisorCallPresentation {
  const args = isRecord(rawArgs) ? (rawArgs as AdvisorCallArgs) : {};
  const model = displayModel(args.model, config, argsComplete);
  const thinking = displayThinking(args.thinking, config, argsComplete);
  const timeout = displayTimeout(args.timeout_ms, config, argsComplete);
  const query = displayQuery(args.query, argsComplete);
  const separator = theme.fg("dim", " · ");

  return {
    collapsedHeader: [
      theme.fg("toolTitle", theme.bold("Advisor Consult")),
      theme.fg("accent", model.value),
      theme.fg("accent", thinking.value),
      theme.fg("accent", timeout.value),
    ].join(separator),
    collapsedQuery: `${theme.fg("dim", "query: ")}${theme.fg("toolOutput", query.collapsed)}`,
    expanded: [
      theme.fg("toolTitle", theme.bold("Advisor Consult")),
      renderDisplayField("model", model, theme),
      renderDisplayField("effort", thinking, theme),
      renderDisplayField("timeout", timeout, theme),
      theme.fg("dim", "query:"),
      theme.fg("toolOutput", query.expanded),
    ].join("\n"),
  };
}

function displayModel(value: unknown, config: AdvisorConsultConfig, argsComplete: boolean): DisplayField {
  if (!argsComplete) return pendingField(partialString(value));
  if (value !== undefined && typeof value !== "string") return invalidField();
  const requested = typeof value === "string" ? value.trim() : "";
  const resolved = resolveModel(requested || undefined, config, undefined);
  return {
    value: resolved.inherited ? "parent model" : escapeDisplayText(resolved.model ?? config.defaultModel),
    provenance: requested ? "requested" : "configured default",
  };
}

function displayThinking(value: unknown, config: AdvisorConsultConfig, argsComplete: boolean): DisplayField {
  if (!argsComplete) return pendingField(partialString(value));
  if (value !== undefined) {
    if (!isThinkingLevel(value)) return invalidField();
    return { value, provenance: "requested" };
  }
  return { value: config.defaultThinking, provenance: "configured default" };
}

function displayTimeout(value: unknown, config: AdvisorConsultConfig, argsComplete: boolean): DisplayField {
  if (!argsComplete) {
    const partial = typeof value === "number" && Number.isFinite(value) ? `${value}ms` : "…";
    return pendingField(partial);
  }
  if (value !== undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) return invalidField();
    const resolved = resolveTimeout(value, config);
    return {
      value: formatDuration(resolved.timeoutMs),
      provenance: value <= 0 ? "configured default" : resolved.timeoutMs === Math.floor(value) ? "requested" : "clamped",
    };
  }
  return { value: formatDuration(config.defaultTimeoutMs), provenance: "configured default" };
}

function displayQuery(value: unknown, argsComplete: boolean): { collapsed: string; expanded: string } {
  if (!argsComplete) {
    const partial = typeof value === "string" ? value.trim() : "";
    if (!partial) return { collapsed: "…", expanded: "…" };
    return {
      collapsed: escapeDisplayText(partial, false).replace(/\s+/gu, " "),
      expanded: escapeDisplayText(partial, true),
    };
  }
  if (value === undefined) return { collapsed: "[missing query]", expanded: "[missing query]" };
  if (typeof value !== "string") return { collapsed: "[invalid query]", expanded: "[invalid query]" };
  const query = value.trim();
  if (!query) return { collapsed: "[empty query]", expanded: "[empty query]" };
  return {
    collapsed: escapeDisplayText(query, false).replace(/\s+/gu, " "),
    expanded: escapeDisplayText(query, true),
  };
}

function renderDisplayField(label: string, field: DisplayField, theme: Theme): string {
  return `${theme.fg("dim", `${label}: `)}${theme.fg("accent", field.value)}${theme.fg("dim", ` (${field.provenance})`)}`;
}

function pendingField(value = "…"): DisplayField {
  return { value, provenance: "pending" };
}

function partialString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "…";
  return escapeDisplayText(value.trim());
}

function invalidField(): DisplayField {
  return { value: "[invalid]", provenance: "invalid" };
}

function escapeDisplayText(value: string, preserveNewlines = false): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x0a) {
      escaped += preserveNewlines ? "\n" : " ";
    } else if (isTerminalControl(codePoint)) {
      escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else if (isLoneSurrogate(codePoint) || isDirectionalControl(codePoint)) {
      escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function isTerminalControl(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isLoneSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

function isDirectionalControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

export function activate(
  pi: AdvisorConsultHost,
  runner: AdvisorRunner,
  configLoader: typeof loadConfig = loadConfig,
): void {
  pi.registerTool({
    name: "advisor_consult",
    label: "Advisor Consult",
    description: ADVISOR_TOOL_DESCRIPTION,
    promptSnippet: ADVISOR_PROMPT_SNIPPET,
    promptGuidelines: [...ADVISOR_TOOL_GUIDELINES],
    parameters: advisorSchema,
    renderCall(args, theme, context) {
      const state = context.state as AdvisorRowState;
      // A finished call shows the configuration it ran with (carried in its result), not today's file.
      const config = state.ranWith ?? configLoader().config;
      const view = context.lastComponent instanceof AdvisorCallView ? context.lastComponent : new AdvisorCallView();
      const argsSettled = context.argsComplete || context.executionStarted || (!context.isPartial && !context.isError);
      view.update(presentAdvisorCall(args, config, argsSettled, theme), context.expanded);
      state.callView = view;
      return view;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as AdvisorRowState;
      const ranWith = configFromDetails(result.details);
      if (ranWith) {
        state.ranWith = ranWith;
        // Pi draws the call row before the result row, so the header drawn this frame is corrected in place.
        state.callView?.update(presentAdvisorCall(context.args, ranWith, true, theme), options.expanded);
      }
      return renderResultText(result.content, options.expanded, theme);
    },
    async execute(_toolCallId: string, params: AdvisorParams, signal, _onUpdate, ctx: ExtensionContext) {
      const loaded = configLoader();
      if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
      const output = await consult(params, {
        runner,
        config: loaded.config,
        cwd: ctx.cwd,
        parentModelPattern: resolveModelPattern(ctx.model),
        bootstrapExtensionPath: BOOTSTRAP_EXTENSION_PATH,
        sessionDir: deriveChildSessionDir(ctx.sessionManager?.getSessionFile?.(), ADVISOR_SESSION_KIND),
        signal,
        ...(ctx.modelRegistry ? { resolveModelPattern: registryPatternResolver(ctx.modelRegistry) } : {}),
      });
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: output.details,
        isError: output.isError,
      };
    },
  });
}

export default function advisorConsult(pi: ExtensionAPI): void {
  activate(pi, new PiSubprocessAdvisorRunner());
}
