// Main's Slack sends reach Pi by every route pi-mcp-adapter offers: the tool by its own name,
// its deferred name `mcp__<server>__<tool>`, and the `mcp` and `mcp__<server>` proxies, whose
// `tool` may itself be any of those names and whose arguments may be an object or a JSON string.
// Both hooks (marking before the send, watching after it) read a send through this one place.
export interface SendCall {
  channelId: string;
  threadTs?: string;
  message: string;
  /** Write a new message text back into the call's input, in the shape it arrived in. */
  setMessage(text: string): void;
}

/** Is `name` the send tool under any of the adapter's names for it? */
export function namesSendTool(name: unknown, sendTool: string): boolean {
  return typeof name === "string" && (name === sendTool || name.endsWith(`__${sendTool}`) || name.endsWith(`_${sendTool}`));
}

function readArgs(holder: Record<string, unknown>, key: string): { args: Record<string, unknown>; write: () => void } | undefined {
  const raw = holder[key];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { args: raw as Record<string, unknown>, write: () => {} };
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      return { args: parsed, write: () => { holder[key] = JSON.stringify(parsed); } };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sendCallOf(toolName: string, input: Record<string, unknown>, sendTool: string): SendCall | undefined {
  let target: { args: Record<string, unknown>; write: () => void } | undefined;
  if (namesSendTool(toolName, sendTool)) target = { args: input, write: () => {} };
  else if ((toolName === "mcp" || toolName.startsWith("mcp__")) && namesSendTool(input.tool, sendTool)) target = readArgs(input, "args");
  if (!target) return undefined;
  const { args, write } = target;
  if (typeof args.channel_id !== "string" || typeof args.message !== "string") return undefined;
  const call: SendCall = {
    channelId: args.channel_id,
    message: args.message,
    setMessage(text) {
      args.message = text;
      write();
    },
  };
  if (typeof args.thread_ts === "string" && args.thread_ts) call.threadTs = args.thread_ts;
  return call;
}
