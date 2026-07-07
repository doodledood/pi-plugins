import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExecOptions,
  ExecResult,
  ExtensionCommandContext,
  ExtensionContext,
  EventBus,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ThinkingLevel } from "./types.ts";

export type HostThinkingLevel = ThinkingLevel;

type Handler<E, R = void> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

export interface GoalControllerHost {
  events: EventBus;
  registerTool<TParams extends TSchema>(tool: ToolDefinition<TParams>): void;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }): void;
  on(event: "session_start", handler: Handler<SessionStartEvent>): void;
  on(event: "session_tree", handler: Handler<SessionTreeEvent>): void;
  on(event: "session_shutdown", handler: Handler<SessionShutdownEvent>): void;
  on(event: "session_compact", handler: Handler<SessionCompactEvent>): void;
  on(event: "before_agent_start", handler: Handler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
  on(event: "agent_end", handler: Handler<AgentEndEvent>): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  getThinkingLevel(): HostThinkingLevel;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

export type CapturedHandlers = {
  session_start?: Handler<SessionStartEvent>;
  session_tree?: Handler<SessionTreeEvent>;
  session_shutdown?: Handler<SessionShutdownEvent>;
  session_compact?: Handler<SessionCompactEvent>;
  before_agent_start?: Handler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
  agent_end?: Handler<AgentEndEvent>;
};
