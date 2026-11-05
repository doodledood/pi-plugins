// A fake of the official Slack MCP server behind pi-mcp-adapter's runtime tool-call event, writing
// the same detailed text formats the real server returns (see format.ts and the fixtures in
// format.test.ts, captured from the real server and scrubbed). Names and ids are invented.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_TOOL_CALL_EVENT } from "./backend.ts";
import { compareTs } from "./format.ts";

export interface FakeMessage {
  ts: string;
  userId: string;
  name: string;
  text: string;
  /** Root ts when this is a thread reply. */
  threadTs?: string;
}

export interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeSlackOptions {
  ownerId?: string;
  ownerName?: string;
  /** The gateway variant redacts emails; the official server shows them. */
  redactEmails?: boolean;
  appId?: string;
  /** False: a thread read with no reply prints no "No thread messages" trailer (a server unlike the real one). */
  emptyTrailer?: boolean;
}

type Listener = (request: any) => void;
export interface Bus {
  on(channel: string, handler: Listener): unknown;
  emit(channel: string, data: unknown): void;
}

export class FakeSlack {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly channels = new Map<string, FakeMessage[]>();
  readonly calls: FakeCall[] = [];
  private clockSec = 1_793_700_000;
  private micro = 100_000;
  redactEmails: boolean;
  appId: string;
  /**
   * What the next calls of a tool do, in order: "ok" (answer normally), "error" (ok:false, the
   * adapter's generic code), "post-then-error" (a send that posted, then failed), "truncate",
   * "truncate-unsaved", "garbage" (text the parser cannot read), "not-ready" (the adapter is still starting), "auth" (the login expired), "disabled" (the server is
   * disabled), "ansi-error" (an error whose text carries terminal control sequences), "not-started"
   * (the adapter's start-up failed).
   */
  failures = new Map<string, Array<"ok" | "error" | "post-then-error" | "truncate" | "truncate-unsaved" | "garbage" | "not-ready" | "auth" | "disabled" | "ansi-error" | "not-started">>();
  /** Page size the fake uses regardless of the requested limit, to force pagination. */
  pageSize = 100;
  /** Channel names the listing header shows (a channel not here shows "general"). */
  readonly channelNames = new Map<string, string>();
  /** Runs after each call is answered, before the answer returns: lets a test change Slack between two reads. */
  afterCall: ((tool: string, args: Record<string, unknown>) => void) | undefined;
  /** Seconds the fake clock moves per message. */
  secondsPerMessage = 1;

  constructor(options: FakeSlackOptions = {}) {
    this.ownerId = options.ownerId ?? "UOWNER0001";
    this.ownerName = options.ownerName ?? "Dana Owner";
    this.redactEmails = options.redactEmails ?? false;
    this.appId = options.appId ?? "A0FAKEAPP";
    this.emptyTrailer = options.emptyTrailer ?? true;
  }

  /** Whether a thread read with no reply ends with the server's "No thread messages" trailer (the real one does). */
  private readonly emptyTrailer: boolean;

  /** Wall-clock milliseconds matching the fake's newest ts (tests pass this as the engine's now). */
  nowMs(): number {
    return (this.clockSec + 200) * 1000;
  }

  nextTs(): string {
    this.micro += 1;
    this.clockSec += this.secondsPerMessage;
    return `${this.clockSec}.${String(this.micro).padStart(6, "0")}`;
  }

  /** Wall-clock milliseconds of the newest ts, without the slack nowMs() adds. */
  clockMs(): number {
    return this.clockSec * 1000;
  }

  /** A message whose ts is `secondsAgo` in the past: Slack can make a message visible after a later one. */
  postLate(channelId: string, userId: string, name: string, text: string, secondsAgo: number, threadTs?: string): FakeMessage {
    this.micro += 1;
    const message: FakeMessage = { ts: `${this.clockSec - secondsAgo}.${String(this.micro).padStart(6, "0")}`, userId, name, text, ...(threadTs ? { threadTs } : {}) };
    const list = this.channels.get(channelId) ?? [];
    list.push(message);
    this.channels.set(channelId, list);
    return message;
  }

  post(channelId: string, userId: string, name: string, text: string, threadTs?: string): FakeMessage {
    const message: FakeMessage = { ts: this.nextTs(), userId, name, text, ...(threadTs ? { threadTs } : {}) };
    const list = this.channels.get(channelId) ?? [];
    list.push(message);
    this.channels.set(channelId, list);
    return message;
  }

  messages(channelId: string): FakeMessage[] {
    return this.channels.get(channelId) ?? [];
  }

  attach(bus: Bus): void {
    bus.on(RUNTIME_TOOL_CALL_EVENT, (request: any) => {
      if (request.result !== undefined) return;
      const tool = String(request.tool);
      if (!tool.startsWith("slack_") && tool !== "slack-companion-probe") return;
      request.result = this.handle(tool, request.args ?? {});
    });
  }

  private email(name: string): string {
    const local = name.toLowerCase().replace(/\s+/g, ".");
    return this.redactEmails ? "[EMAIL:****.*****@*******.***]" : `${local}@example.com`;
  }

  private header(m: FakeMessage): string {
    return `${m.name} <${this.email(m.name)}> (${m.userId})`;
  }

  private time(ts: string): string {
    return new Date(Number(ts.split(".")[0]) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  }

  private async handle(tool: string, args: Record<string, unknown>): Promise<any> {
    if (tool === "slack-companion-probe") return { ok: false, error: new Error("Unsupported MCP runtime tool-call version: 0") };
    this.calls.push({ tool, args });
    const failure = this.failures.get(tool)?.shift();
    // The adapter reduces a failed call to its own code, as the real one does.
    if (failure === "error") return { ok: false, error: new Error("MCP tool call failed: tool_error") };
    let text: string;
    try {
      text = this.respond(tool, args);
      this.afterCall?.(tool, args);
    } catch (error) {
      const code = /no tool/.test((error as Error).message) ? "tool_not_found" : "tool_error";
      return { ok: false, error: new Error(`MCP tool call failed: ${code}`) };
    }
    if (failure === "not-started") return { ok: false, error: new Error("MCP is not initialized") };
    if (failure === "disabled") return { ok: false, error: new Error("MCP tool call failed: server_disabled") };
    if (failure === "ansi-error") return { ok: false, error: new Error("MCP tool call failed: \u001b[2Jtool_error\u001b]0;pwned\u0007 while reading") };
    if (failure === "auth") return { ok: false, error: new Error("MCP tool call failed: auth_required") };
    if (failure === "not-ready") return { ok: false, error: new Error("MCP initialization is still in progress") };
    if (failure === "garbage") return { ok: true, result: { content: [{ type: "text", text: "<html>Service Unavailable</html>" }] } };
    if (failure === "post-then-error") return { ok: false, error: new Error("MCP tool call failed: tool_error") };
    if (failure === "truncate" || failure === "truncate-unsaved") {
      const dir = mkdtempSync(join(tmpdir(), "fake-guard-"));
      const fullOutputPath = join(dir, "output.txt");
      writeFileSync(fullOutputPath, text);
      const preview = `${text.slice(0, 200)}\n\n[MCP text output truncated: original 9 lines / 9KB. Truncated: showing 3 of 9 lines (2000 line limit). Full text saved to: ${fullOutputPath}]`;
      const outputGuard = failure === "truncate" ? { truncated: true, fullOutputPath } : { truncated: true, writeError: "disk full" };
      return { ok: true, result: { content: [{ type: "text", text: preview }], details: { outputGuard } } };
    }
    return { ok: true, result: { content: [{ type: "text", text }], details: {} } };
  }

  private respond(tool: string, args: Record<string, unknown>): string {
    const channelId = String(args.channel_id ?? "");
    switch (tool) {
      case "slack_read_user_profile":
        return JSON.stringify({ result: `User ID: ${this.ownerId}\nUsername: owner\nDisplay Name: ${this.ownerName}\nReal Name: ${this.ownerName}\nTitle: Engineer\nEmail: ${this.email(this.ownerName)}\nStatus:  \n` });
      case "slack_send_message": {
        const text = `${String(args.message)}\n*Sent using* <@${this.appId}|Slack MCP>`;
        const threadTs = typeof args.thread_ts === "string" ? args.thread_ts : undefined;
        const posted = this.post(channelId, this.ownerId, this.ownerName, text, threadTs);
        return JSON.stringify({
          message_link: `https://example.slack.com/archives/${channelId}/p${posted.ts.replace(".", "")}`,
          message_context: { message_ts: posted.ts, channel_id: channelId },
        });
      }
      case "slack_read_channel": {
        const oldest = typeof args.oldest === "string" ? args.oldest : undefined;
        const latest = typeof args.latest === "string" ? args.latest : undefined;
        const top = this.messages(channelId)
          .filter((m) => !m.threadTs && (!oldest || compareTs(m.ts, oldest) > 0) && (!latest || compareTs(m.ts, latest) < 0))
          .sort((a, b) => compareTs(b.ts, a.ts));
        const offset = typeof args.cursor === "string" ? Number(args.cursor) : 0;
        const page = top.slice(offset, offset + this.pageSize);
        const more = offset + this.pageSize < top.length;
        const blocks = page.map((m) => {
          const replies = this.messages(channelId).filter((r) => r.threadTs === m.ts);
          const thread = replies.length ? `\nThread: ${replies.length} ${replies.length === 1 ? "reply" : "replies"} (latest: ${this.time(replies.at(-1)!.ts)})` : "";
          return `=== Message from ${this.header(m)} at ${this.time(m.ts)} === \nMessage TS: ${m.ts}\n${m.text}${thread}`;
        });
        return JSON.stringify({
          messages: `Channel: ${channelId.startsWith("D") ? "DM" : `#${this.channelNames.get(channelId) ?? "general"}`} (${channelId})\n\n${blocks.join("\n\n")}`,
          pagination_info: more ? `There are more messages available. To view the next page, use cursor: \`${offset + this.pageSize}\`\n` : "There are no more messages in this channel.\n",
        });
      }
      case "slack_read_thread": {
        const ts = String(args.message_ts);
        const all = this.messages(channelId);
        const root = all.find((m) => m.ts === ts);
        if (!root) throw new Error("execution_failed: thread_not_found");
        const oldest = typeof args.oldest === "string" ? args.oldest : undefined;
        const latest = typeof args.latest === "string" ? args.latest : undefined;
        const replies = root.threadTs ? [] : all.filter((m) => m.threadTs === root.ts).sort((a, b) => compareTs(a.ts, b.ts));
        const fresh = replies.filter((m) => (!oldest || compareTs(m.ts, oldest) > 0) && (!latest || compareTs(m.ts, latest) < 0));
        const offset = typeof args.cursor === "string" ? Number(args.cursor) : 0;
        const limit = Math.min(Number(args.limit ?? 100), this.pageSize);
        // Asked about a reply, the real server shows that reply alone, as the "parent" (verified live).
        const page = fresh.slice(offset, offset + limit);
        const more = offset + limit < fresh.length;
        const parent = `=== THREAD PARENT MESSAGE ===\nFrom: ${this.header(root)}\nTime: ${this.time(root.ts)}\nMessage TS: ${root.ts}\n${root.text}\n\n`;
        const body = page.length
          ? `=== THREAD REPLIES (${replies.length} total) ===\n\n${page.map((m, i) => `--- Reply ${offset + i + 1} of ${replies.length} ---\nFrom: ${this.header(m)}\nTime: ${this.time(m.ts)}\nMessage TS: ${m.ts}\n${m.text}`).join("\n\n")}\n`
          : this.emptyTrailer ? "No thread messsages\n" : "";
        return JSON.stringify({
          messages: `${parent}${body}`,
          pagination_info: more ? `There are more messages in this thread. To view the next page, use cursor: \`${offset + limit}\`\n` : "There are no more messages in this thread.\n",
        });
      }
      default:
        throw new Error(`fake slack has no tool ${tool}`);
    }
  }
}

/** A minimal event bus for tests that do not run Pi. */
export function memoryBus(): Bus & { listeners: Map<string, Listener[]> } {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    on(channel, handler) {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
    },
    emit(channel, data) {
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
  };
}
