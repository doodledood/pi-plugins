import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { KeyId } from "@earendil-works/pi-tui";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** One configured (or picked) panel member: a model reference plus effort. */
export interface PanelistSpec {
  /** Model reference as accepted by pi's CLI resolver, e.g. "anthropic/claude-fable-5". */
  model: string;
  thinking: ThinkingLevel;
}

export interface PanelConfig {
  /** Lineup shown in the picker. Empty/missing config falls back to DEFAULT_PANELISTS. */
  panelists: PanelistSpec[];
  /** Which lineup entries start selected. Indexes into `panelists`. */
  preselected: number[];
  /** Keybinding that opens the live inspect view while a panel runs. */
  inspectKeybinding: KeyId;
  /** Per-panelist wall-clock budget. */
  timeoutMs: number;
}

export interface LoadedPanelConfig {
  config: PanelConfig;
  path: string;
  warning?: string;
}

export type PanelistStatus = "pending" | "running" | "done" | "error" | "cancelled";

/** Live view of one panelist run, consumed by the widget/overlay and result layer. */
export interface PanelistState {
  id: number;
  spec: PanelistSpec;
  status: PanelistStatus;
  /** Short human description of what the panelist is doing right now. */
  activity: string;
  /** Rolling tail of streamed output for the inspect overlay. */
  transcript: string[];
  tokens: number;
  /** Best-effort dollar cost; undefined when the provider reports no cost. */
  cost: number | undefined;
  startedAt: number;
  endedAt?: number;
  answer?: string;
  error?: string;
  sessionFile?: string;
}

export interface PanelistResult {
  spec: PanelistSpec;
  ok: boolean;
  answer?: string;
  error?: string;
  cancelled?: boolean;
  elapsedMs: number;
  tokens: number;
  cost: number | undefined;
  sessionFile?: string;
}

/**
 * The narrow session surface the runner needs. The production implementation
 * wraps a real in-process pi SDK AgentSession; tests substitute a stub.
 */
export interface PanelistSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: PanelistSessionEvent) => void): () => void;
  readonly messages: AgentMessage[];
  readonly sessionFile: string | undefined;
  dispose(): void;
}

/**
 * Minimal event union the runner consumes — a narrowable discriminated union
 * (subset of AgentSessionEvent shapes). Real sessions emit further event types;
 * the production adapter in host.ts casts them into this union at the boundary
 * and the runner simply ignores types it doesn't handle.
 */
export type PanelistSessionEvent =
  | { type: "message_update"; assistantMessageEvent?: { type: string; delta?: string } }
  | { type: "tool_execution_start"; toolName?: string }
  | { type: "message_end"; message?: { role?: string; stopReason?: string; errorMessage?: string; usage?: unknown } };

export interface SpawnPanelistOptions {
  spec: PanelistSpec;
  systemPrompt: string;
  forkMessages: AgentMessage[];
  cwd: string;
  /** Session storage directory; undefined = pi's default location. */
  sessionDir?: string;
}

export type SpawnPanelist = (options: SpawnPanelistOptions) => Promise<PanelistSession>;
