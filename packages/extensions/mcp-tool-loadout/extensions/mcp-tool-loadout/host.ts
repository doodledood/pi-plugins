// Minimal typed seam over the Pi API so the event wiring can be unit-tested with a
// plain mock (no casts, no `any`). The real ExtensionAPI is assignable to LoadoutPi,
// because each handler's event/ctx type is a *widening* of Pi's concrete types (a
// handler that needs less is assignable where Pi passes more).
import type { ToolInfo, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

/** The only ctx members the handlers use. Wider than ExtensionContext so ExtensionContext is assignable. */
export interface LoadoutCtx {
  cwd: string;
  ui: { setStatus(key: string, text: string): void };
}

/** Minimal shapes of the events the handlers actually read. */
export interface SystemPromptCarrier {
  /** Pi's mutable prompt sections; a section is diffed and patched by Pi, keeping the prompt cache. */
  systemPromptOptions: { sections: Record<string, string> };
}
export interface ToolCallCarrier {
  toolName: string;
  input: unknown;
}

type Handler<E, R = void> = (event: E, ctx: LoadoutCtx) => Promise<R | void> | R | void;

export interface LoadoutHandlerMap {
  session_start: Handler<unknown>;
  before_agent_start: Handler<SystemPromptCarrier>;
  tool_call: Handler<ToolCallCarrier, ToolCallEventResult>;
}

/** Subset of ExtensionAPI used by the event wiring. */
export interface LoadoutPi {
  on<E extends keyof LoadoutHandlerMap>(event: E, handler: LoadoutHandlerMap[E]): void;
  getAllTools(): ToolInfo[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}
