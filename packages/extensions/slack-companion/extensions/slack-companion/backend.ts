// The one seam to Slack. The first backend calls the owner's Slack MCP tools from plain code
// through pi-mcp-adapter's documented runtime event, so watching costs no model tokens.
// See docs/adr/20261104-watch-slack-by-polling-through-the-mcp-adapter.md.
import { readFile } from "node:fs/promises";
import type { ToolNames } from "./config.ts";
import type { Conversation } from "./conversation.ts";
import {
  type CandidateMessage,
  compareTs,
  parseChannelListing,
  parseLookup,
  parseProfile,
  parseSendResult,
  parseThreadListing,
  tsNeighbors,
} from "./format.ts";

export interface Identity {
  userId: string;
  name: string;
}

export interface SlackBackend {
  whoAmI(): Promise<Identity>;
  /** Every candidate message newer than `oldest` (exclusive), all pages. Candidates are unconfirmed. */
  readSince(conversation: Conversation, oldest: string | undefined): Promise<CandidateMessage[]>;
  /** One message as Slack has it (genuine author and text), or "missing" when it does not exist. */
  lookupMessage(channelId: string, ts: string): Promise<CandidateMessage | "missing">;
  /** Does the message with this ts belong to the watched conversation? */
  belongsTo(conversation: Conversation, ts: string): Promise<boolean>;
  /** Post `text`; throws SendUncertainError when Slack may or may not have taken it. */
  send(channelId: string, text: string, threadTs: string | undefined): Promise<{ ts: string; channelId: string }>;
}

/** A call that failed: the read did not happen. */
export class BackendError extends Error {
  override name = "BackendError";
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** The adapter is not ready yet (a session is still starting): try again on the next poll. */
export class BackendNotReadyError extends BackendError {
  override name = "BackendNotReadyError";
}

/** A send whose outcome is unknown; it must be reconciled, never re-sent blind. */
export class SendUncertainError extends Error {
  override name = "SendUncertainError";
}

export const RUNTIME_TOOL_CALL_EVENT = "pi-mcp-adapter:runtime-tool-call:v1";

export interface EventBus {
  emit(channel: string, data: unknown): void;
}

interface RuntimeToolCallRequest {
  version: 1;
  tool: string;
  args?: Record<string, unknown>;
  server?: string;
  result?: Promise<{ ok: true; result: { content: unknown[]; details?: any } } | { ok: false; error: Error }>;
}

const NOT_READY = /require an active Pi session|initialization is still in progress|MCP is not initialized/i;

/** Call an MCP tool through pi-mcp-adapter; the result exactly as the adapter guards it. */
export async function runMcpToolGuarded(events: EventBus, tool: string, args: Record<string, unknown>, server?: string): Promise<{ content: unknown[]; details?: any }> {
  const request: RuntimeToolCallRequest = { version: 1, tool, args, ...(server ? { server } : {}) };
  events.emit(RUNTIME_TOOL_CALL_EVENT, request);
  if (!request.result) {
    throw new BackendError("pi-mcp-adapter is not installed or not loaded, so Slack cannot be read from code", "no_adapter");
  }
  const outcome = await request.result;
  if (!outcome.ok) {
    const message = outcome.error.message;
    if (NOT_READY.test(message)) throw new BackendNotReadyError(`${tool}: ${message}`, "not_ready");
    const code = /MCP tool call failed: (\S+)/.exec(message)?.[1];
    throw new BackendError(`${tool} failed: ${message}`, code);
  }
  return outcome.result;
}

/** Call an MCP tool and return its whole text, reading the adapter's spill file when it truncated. */
export async function runMcpTool(events: EventBus, tool: string, args: Record<string, unknown>, server?: string): Promise<string> {
  const result = await runMcpToolGuarded(events, tool, args, server);
  const guard = result.details?.outputGuard;
  if (guard?.truncated) {
    if (typeof guard.fullOutputPath !== "string") {
      throw new BackendError(`${tool} returned a truncated result whose full text could not be saved${guard.writeError ? `: ${guard.writeError}` : ""}`, "truncated");
    }
    return readFile(guard.fullOutputPath, "utf8");
  }
  return result.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text as string)
    .join("\n");
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 50;
/** Adapter codes that mean the tool or server is misconfigured, not that a message is gone. */
const CONFIG_CODES = new Set(["tool_not_found", "tool_not_found_after_reconnect", "server_not_found", "no_adapter"]);

export class McpSlackBackend implements SlackBackend {
  constructor(
    private readonly events: EventBus,
    private readonly tools: ToolNames,
    private readonly server?: string,
  ) {}

  private call(tool: string, args: Record<string, unknown>): Promise<string> {
    return runMcpTool(this.events, tool, args, this.server);
  }

  async whoAmI(): Promise<Identity> {
    return parseProfile(await this.call(this.tools.userProfile, { response_format: "detailed" }));
  }

  async readSince(conversation: Conversation, oldest: string | undefined): Promise<CandidateMessage[]> {
    const collected: CandidateMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const base: Record<string, unknown> = { channel_id: conversation.channelId, limit: PAGE_LIMIT, response_format: "detailed" };
      if (oldest) base.oldest = oldest;
      if (cursor) base.cursor = cursor;
      if (conversation.kind === "thread") {
        const listing = parseThreadListing(await this.call(this.tools.readThread, { ...base, message_ts: conversation.threadTs }));
        // The parent is the thread root; it is new only when the root itself is unseen.
        if (page === 0 && listing.parent && (!oldest || compareTs(listing.parent.ts, oldest) > 0)) collected.push(listing.parent);
        collected.push(...listing.messages);
        cursor = listing.nextCursor;
      } else {
        const listing = parseChannelListing(await this.call(this.tools.readChannel, base));
        collected.push(...listing.messages);
        cursor = listing.nextCursor;
      }
      if (!cursor) return collected;
    }
    throw new BackendError(`more than ${MAX_PAGES} pages of new messages; reading stopped rather than skip any`, "too_many_pages");
  }

  async lookupMessage(channelId: string, ts: string): Promise<CandidateMessage | "missing"> {
    const args = { channel_id: channelId, message_ts: ts, limit: 1, response_format: "detailed" };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return parseLookup(await this.call(this.tools.readThread, args));
      } catch (error) {
        // The server reports a missing message as a tool error ("thread_not_found"), which the
        // adapter reduces to its generic code; one retry separates a blip from a message that is not there.
        if (error instanceof BackendError && !(error instanceof BackendNotReadyError) && !CONFIG_CODES.has(error.code ?? "") && attempt === 0) continue;
        if (error instanceof BackendError && !(error instanceof BackendNotReadyError) && !CONFIG_CODES.has(error.code ?? "")) return "missing";
        throw error;
      }
    }
  }

  async belongsTo(conversation: Conversation, ts: string): Promise<boolean> {
    const { before, after } = tsNeighbors(ts);
    if (conversation.kind === "thread") {
      if (ts === conversation.threadTs) return true;
      const listing = parseThreadListing(await this.call(this.tools.readThread, {
        channel_id: conversation.channelId, message_ts: conversation.threadTs, oldest: before, latest: after, limit: 2, response_format: "detailed",
      }));
      return listing.messages.some((m) => m.ts === ts);
    }
    // A top-level message: the first block of a one-message channel read around its ts is genuine.
    const listing = parseChannelListing(await this.call(this.tools.readChannel, {
      channel_id: conversation.channelId, oldest: before, latest: after, limit: 1, response_format: "detailed",
    }));
    return listing.messages[0]?.ts === ts;
  }

  async send(channelId: string, text: string, threadTs: string | undefined): Promise<{ ts: string; channelId: string }> {
    const args: Record<string, unknown> = { channel_id: channelId, message: text };
    if (threadTs) args.thread_ts = threadTs;
    let result: string;
    try {
      result = await this.call(this.tools.sendMessage, args);
    } catch (error) {
      // A failed call may still have posted: Slack can accept a message the client never hears back about.
      throw new SendUncertainError(`${this.tools.sendMessage}: ${(error as Error).message}`);
    }
    try {
      return parseSendResult(result);
    } catch (error) {
      throw new SendUncertainError((error as Error).message);
    }
  }
}
