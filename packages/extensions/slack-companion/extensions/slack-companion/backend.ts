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
  SlackFormatError,
} from "./format.ts";

export interface Identity {
  userId: string;
  name: string;
}

export interface SlackBackend {
  whoAmI(): Promise<Identity>;
  /** Every candidate message newer than `oldest` (exclusive), all pages, oldest first. */
  readSince(conversation: Conversation, oldest: string | undefined): Promise<CandidateMessage[]>;
  /** The genuine author of one message, or "missing" when no such message exists. */
  lookup(channelId: string, ts: string): Promise<{ ts: string; userId: string } | "missing">;
  /** Post `text`; throws SendUncertainError when Slack may or may not have taken it. */
  send(channelId: string, text: string, threadTs: string | undefined): Promise<{ ts: string; channelId: string }>;
}

/** A call that failed: the read or send did not happen (or, for sends, may have). */
export class BackendError extends Error {
  override name = "BackendError";
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

/** Call an MCP tool through pi-mcp-adapter and return its whole text, reading a spilled truncation. */
export async function runMcpTool(events: EventBus, tool: string, args: Record<string, unknown>, server?: string): Promise<string> {
  const request: RuntimeToolCallRequest = { version: 1, tool, args, ...(server ? { server } : {}) };
  events.emit(RUNTIME_TOOL_CALL_EVENT, request);
  if (!request.result) {
    throw new BackendError("pi-mcp-adapter is not installed or not loaded, so Slack cannot be read from code");
  }
  const outcome = await request.result;
  if (!outcome.ok) throw new BackendError(`${tool} failed: ${outcome.error.message}`);
  const guard = outcome.result.details?.outputGuard;
  if (guard?.truncated) {
    // The adapter returned only a head preview; the whole text is in its spill file.
    if (typeof guard.fullOutputPath !== "string") {
      throw new BackendError(`${tool} returned a truncated result whose full text could not be saved${guard.writeError ? `: ${guard.writeError}` : ""}`);
    }
    return readFile(guard.fullOutputPath, "utf8");
  }
  return outcome.result.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text as string)
    .join("\n");
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

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
        const text = await this.call(this.tools.readThread, { ...base, message_ts: conversation.threadTs });
        const listing = parseThreadListing(text);
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
    throw new BackendError(`more than ${MAX_PAGES} pages of new messages; reading stopped rather than skip any`);
  }

  async lookup(channelId: string, ts: string): Promise<{ ts: string; userId: string } | "missing"> {
    let text: string;
    try {
      text = await this.call(this.tools.readThread, { channel_id: channelId, message_ts: ts, limit: 1, response_format: "detailed" });
    } catch (error) {
      if (error instanceof BackendError && /thread_not_found|message_not_found|not_found/i.test(error.message)) return "missing";
      throw error;
    }
    try {
      return parseLookup(text);
    } catch (error) {
      if (error instanceof SlackFormatError && /not_found/i.test(error.message)) return "missing";
      throw error;
    }
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
