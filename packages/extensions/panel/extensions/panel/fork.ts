import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Convert the active branch's context entries (from
 * `ctx.sessionManager.buildContextEntries()`: active branch, compaction
 * applied) into the panelist's seed: a single user-role message carrying the
 * full conversation as a reviewer-readable transcript document.
 *
 * Why a transcript and not replayed messages: seeding another model's outputs
 * into a provider as assistant-role turns trips anti-distillation guards —
 * Anthropic hard-blocks such requests ("duplicating model outputs" ToS
 * refusal, observed live on fable). A panelist is an outside reviewer of the
 * conversation, not the assistant in it, so the transcript framing is both
 * safe on every vendor and semantically truer. Full history is preserved:
 * user turns, assistant turns labeled with their producing model, tool
 * calls/results, bash executions, compaction/branch summaries, and injected
 * context notes.
 */
export function forkMessagesFromEntries(entries: readonly SessionEntry[]): AgentMessage[] {
  const transcript = transcriptFromEntries(entries);
  if (!transcript) return [];
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Transcript of the conversation under review (verbatim; the panel question follows in the next message):\n\n${transcript}`,
        },
      ],
      timestamp: Date.now(),
    } as AgentMessage,
  ];
}

/** The transcript body: pi's own entry→message conversion, serialized per role. */
export function transcriptFromEntries(entries: readonly SessionEntry[]): string {
  const sections: string[] = [];
  for (const message of entries.flatMap((entry) => sessionEntryToContextMessages(entry))) {
    const section = renderMessage(message as unknown as Record<string, unknown>);
    if (section) sections.push(section);
  }
  return sections.join("\n\n");
}

function renderMessage(message: Record<string, unknown>): string | undefined {
  switch (message.role) {
    case "user":
      return `USER:\n${contentText(message.content)}`;
    case "assistant": {
      const model = typeof message.model === "string" && message.model ? ` (${message.model})` : "";
      const parts = [`ASSISTANT${model}:`];
      const text = contentText(message.content, parts);
      if (text) parts.splice(1, 0, text);
      return parts.length > 1 ? parts.join("\n") : undefined;
    }
    case "toolResult":
      return `[tool result]\n${contentText(message.content)}`;
    case "bashExecution":
      // `!!`-prefixed commands are flagged excludeFromContext: pi never sends
      // their output to any model, and neither may the transcript — this is
      // exactly where users park sensitive or huge output.
      if (message.excludeFromContext === true) return undefined;
      return `[user ran: ${String(message.command ?? "")}]\n${String(message.output ?? "")}`;
    case "compactionSummary":
      return `[summary of earlier conversation]\n${String(message.summary ?? "")}`;
    case "branchSummary":
      return `[summary of an abandoned conversation branch]\n${String(message.summary ?? "")}`;
    case "custom": {
      const label = typeof message.customType === "string" ? message.customType : "note";
      return `[context note: ${label}]\n${contentText(message.content)}`;
    }
    default:
      return undefined;
  }
}

/** Text blocks joined; tool calls summarized inline via the collector when given. */
function contentText(content: unknown, toolCallCollector?: string[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; name?: string; arguments?: unknown };
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b.type === "toolCall" && toolCallCollector) {
      toolCallCollector.push(`[called tool: ${b.name ?? "?"} ${safeJson(b.arguments)}]`);
    } else if (b.type === "image") texts.push("[image]");
  }
  return texts.join("\n");
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? "";
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return "";
  }
}
