export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Sentinel `defaultModel` value: run the advisor on the parent session's current
 * model instead of a fixed one. Any other value is treated as a Pi `--model`
 * pattern (e.g. `anthropic/claude-fable-5` or `provider/id`).
 */
export const INHERIT_MODEL = "inherit";

export interface AdvisorConsultConfig {
  /**
   * Preferred advisor model. `"inherit"` uses the parent session's model; any
   * other value is a Pi `--model` pattern. Defaults to a Fable-family model
   * because advisor calls are high-leverage and warrant top capability.
   */
  defaultModel: string;
  /** Advisor reasoning effort. Pi-native names only. Defaults to `xhigh`. */
  defaultThinking: ThinkingLevel;
  /** Default subprocess timeout in ms. */
  defaultTimeoutMs: number;
  /** Lower bound for a per-call `timeout_ms` override. */
  minTimeoutMs: number;
  /** Upper bound for a per-call `timeout_ms` override. */
  maxTimeoutMs: number;
  /**
   * Extra tool names denied to the advisor subprocess, on top of the always-on
   * hard denylist (`advisor_consult`, `ask_user_question`). Defaults to the
   * orchestration tools (`goal`, `subagent`, ...) so the invisible advisor
   * cannot start goals or spawn subagents.
   */
  excludedTools: string[];
}

export interface LoadedConfig {
  config: AdvisorConsultConfig;
  warning?: string;
  path: string;
}

export interface AdvisorRunInput {
  /** The parent-authored advisory brief. */
  query: string;
  /** Resolved Pi `--model` pattern, or undefined to inherit the parent model. */
  model?: string;
  /** Resolved advisor reasoning effort. */
  thinking: ThinkingLevel;
  /** Effective, already-clamped subprocess timeout in ms. */
  timeoutMs: number;
  /** Working directory for the advisor subprocess. */
  cwd: string;
  /** Fully-resolved advisor system prompt (`--system-prompt`). */
  systemPrompt: string;
  /** Absolute path to the child tool-loadout bootstrap extension (`-e`). */
  bootstrapExtensionPath: string;
  /** Tool names to remove from the advisor subprocess registry. */
  excludedTools: readonly string[];
  /** Cancellation for the whole consult. */
  signal?: AbortSignal;
}

export interface AdvisorResult {
  /** True when the advisor produced usable advice. */
  ok: boolean;
  /** The advisor's parent-facing advice text (present when `ok`). */
  advice?: string;
  /** Model the advisor subprocess actually ran on, when detectable. */
  model?: string;
  /** Wall-clock duration of the subprocess. */
  elapsedMs: number;
  /** True when the run hit its timeout and was terminated. */
  timedOut?: boolean;
  /** Human-readable, secret-redacted failure explanation (present when not `ok`). */
  error?: string;
}

export interface AdvisorRunner {
  run(input: AdvisorRunInput): Promise<AdvisorResult>;
}
