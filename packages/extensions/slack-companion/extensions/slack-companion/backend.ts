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
  parseChannelName,
  noRepliesTrailerAt,
  parseEnvelope,
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
  /**
   * One message as Slack has it: its genuine author and text. Ask only about a message
   * `belongsTo` confirmed; any failure throws, since a failed call is not evidence of absence.
   */
  lookupMessage(channelId: string, ts: string): Promise<CandidateMessage>;
  /**
   * Does a message with this ts exist in the watched conversation? False only on positive
   * evidence: a read that succeeded and does not hold it. A failed read throws.
   */
  belongsTo(conversation: Conversation, ts: string): Promise<boolean>;
  /** The channel's name as the server shows it (without "#"), when it shows one. */
  channelName(channelId: string): Promise<string | undefined>;
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

/** The adapter is still starting (it may pass; a failed start-up arrives as its own error and is retried, since every call starts it again). */
const NOT_READY = /require an active Pi session|initialization is still in progress/i;

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
const SMALL_PAGE_LIMIT = 20;
const MAX_PAGES = 50;
/** Failures that retrying cannot fix: a misconfigured tool or server, or a result the package cannot use whole. */
const LASTING_CODES = new Set([
  "tool_not_found", "tool_not_found_after_reconnect", "server_not_found", "server_disabled", "ambiguous_tool", "native_tool",
  "no_adapter", "truncated", "too_many_pages", "too_many_ids", "unreadable", "auth_required", "url_elicitation_required",
  "approval_required", "approval_denied",
]);

/** What the owner can do about a lasting failure, by the adapter's code. */
export const FAILURE_HINTS: Readonly<Record<string, string>> = {
  auth_required: "Slack needs you to sign in again (run /mcp-auth for your Slack server)",
  server_disabled: "your Slack MCP server is disabled; enable it in /mcp-adapter",
  ambiguous_tool: "more than one MCP server has this tool; set \"server\" in slack-companion.json",
  url_elicitation_required: "your Slack MCP server asks you to open a link; use one of its tools in Pi once to answer it",
  tool_not_found: "the tool name is wrong; set the right name under \"tools\" in slack-companion.json",
  approval_required: "pi-mcp-adapter asks to approve each Slack read; slack-companion reads without asking, so take its Slack tools out of approveTools",
  approval_denied: "a Slack read was declined; slack-companion reads without asking, so take its Slack tools out of approveTools",
  too_many_ids: "this conversation's text names too many message ids that do not exist; watch it again after that message is edited",
  server_not_found: "the server name is wrong; check \"server\" in slack-companion.json",
};

/**
 * Is this a failure that may pass on its own (a rate limit, a dropped connection, the adapter's
 * backoff, an expired login being renewed)? Such a read is retried on later polls; anything else,
 * and output the parser cannot read, stops the watch at once.
 */
export function isPassingFailure(error: unknown): boolean {
  return error instanceof BackendNotReadyError || (error instanceof BackendError && !LASTING_CODES.has(error.code ?? ""));
}

export class McpSlackBackend implements SlackBackend {
  /** The server was seen ending an empty thread read with its trailer. */
  private trailerConfirmed = false;

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
    try {
      return await this.readPages(conversation, oldest, PAGE_LIMIT);
    } catch (error) {
      // A page too large for the adapter to save whole: read it again in smaller pages, once.
      if (error instanceof BackendError && error.code === "truncated") return this.readPages(conversation, oldest, SMALL_PAGE_LIMIT);
      throw error;
    }
  }

  private async readPages(conversation: Conversation, oldest: string | undefined, limit: number): Promise<CandidateMessage[]> {
    const collected: CandidateMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES * (PAGE_LIMIT / limit); page += 1) {
      const base: Record<string, unknown> = { channel_id: conversation.channelId, limit, response_format: "detailed" };
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
    throw new BackendError(`more than ${MAX_PAGES * PAGE_LIMIT} new messages; reading stopped rather than skip any`, "too_many_pages");
  }


  async lookupMessage(channelId: string, ts: string): Promise<CandidateMessage> {
    return parseLookup(await this.call(this.tools.readThread, { channel_id: channelId, message_ts: ts, limit: 1, response_format: "detailed" }));
  }

  async belongsTo(conversation: Conversation, ts: string): Promise<boolean> {
    const { before, after } = tsNeighbors(ts);
    if (conversation.kind === "thread") {
      if (ts === conversation.threadTs) return true;
      const read = async (oldest: string, latest: string) => {
        const text = await this.call(this.tools.readThread, {
          channel_id: conversation.channelId, message_ts: conversation.threadTs, oldest, latest, limit: 2, response_format: "detailed",
        });
        return { count: parseThreadListing(text).messages.filter((m) => m.ts === ts).length, empty: noRepliesTrailerAt(parseEnvelope(text, "messages").body) >= 0 };
      };
      // The thread's first message comes with every read, and its own text could imitate a reply
      // block naming any id. The window spans one microsecond either side of the id, so the only
      // reply it can hold is that message itself. The server ends a read that holds no reply with
      // its own "No thread messages" trailer, after everything the first message says: a window
      // read ending so holds no reply, whatever named the id.
      const inWindow = await read(before, after);
      if (!inWindow.count || inWindow.empty) return false;
      // That reading needs a server that prints the trailer: confirmed once, with a read whose range
      // can hold no reply. A server that does not is a format the package cannot check: it fails closed.
      if (!this.trailerConfirmed) {
        const control = await read(after, tsNeighbors(after).after);
        if (!control.empty) throw new BackendError("this Slack server's thread format does not mark an empty read, so thread replies cannot be confirmed", "unreadable");
        this.trailerConfirmed = true;
      }
      return true;
    }
    // A top-level message: the first block of a one-message channel read around its ts is genuine.
    const listing = parseChannelListing(await this.call(this.tools.readChannel, {
      channel_id: conversation.channelId, oldest: before, latest: after, limit: 1, response_format: "detailed",
    }));
    return listing.messages[0]?.ts === ts;
  }

  async channelName(channelId: string): Promise<string | undefined> {
    const text = await this.call(this.tools.readChannel, { channel_id: channelId, limit: 1, response_format: "detailed" });
    return parseChannelName(text);
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
