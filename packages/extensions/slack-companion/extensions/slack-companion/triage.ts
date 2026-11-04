// The cheap speak-or-stay-silent check that runs before any helper is forked
// (docs/adr/20261104-let-the-agent-carry-slack-conversations-on-by-itself.md).
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { SlackMessage } from "./reader.ts";

export const TRIAGE_MARKER = "[slack-companion triage]";

export interface TriageInput {
  label: string;
  ownerName: string;
  addressed: boolean;
  /** The agent's own recent messages in this conversation, to judge whether it is being answered. */
  agentMessages: readonly SlackMessage[];
  recent: readonly SlackMessage[];
  batch: readonly SlackMessage[];
}

export function triageContext(input: TriageInput): Context {
  const line = (m: SlackMessage) => `- ${m.userName}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`;
  const systemPrompt = `${TRIAGE_MARKER}
You decide whether ${input.ownerName}'s AI agent should take part in a Slack conversation now. Answer with exactly YES or NO.
Answer YES when the new messages address the agent, answer or follow up on something the agent asked, or ask something the agent can usefully answer. Answer NO for thanks, acknowledgements, chat between other people, or anything that needs no reply from the agent.`;
  const user = [
    `Conversation: ${input.label}${input.addressed ? " (direct message or the agent was mentioned)" : ""}`,
    input.agentMessages.length ? `The agent's recent messages here:\n${input.agentMessages.map(line).join("\n")}` : "The agent has not posted here yet.",
    input.recent.length ? `Earlier messages:\n${input.recent.map(line).join("\n")}` : "",
    `New messages:\n${input.batch.map(line).join("\n")}`,
    "Should the agent respond or act now? YES or NO.",
  ].filter(Boolean).join("\n\n");
  return { systemPrompt, messages: [{ role: "user", content: user, timestamp: Date.now() }] };
}

export function triageVerdict(message: AssistantMessage): boolean {
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim().toUpperCase();
  return /^\W*YES\b/.test(text);
}

/** The configured triage model, else the cheapest model of the session's provider, else the session's own. */
export function chooseTriageModel(
  configured: string | undefined,
  sessionModel: Model<Api>,
  available: readonly Model<Api>[],
): { model: Model<Api>; note?: string } {
  if (configured) {
    const [provider, ...rest] = configured.split("/");
    const id = rest.join("/");
    const found = available.find((m) => m.provider === provider && m.id === id);
    if (found) return { model: found };
    return { model: sessionModel, note: `triage model ${configured} is not available; using the session's model` };
  }
  const priced = available
    .filter((m) => m.provider === sessionModel.provider && (m.cost.input > 0 || m.cost.output > 0) && m.input.includes("text"))
    .sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output));
  if (priced[0]) return { model: priced[0] };
  return { model: sessionModel, note: "no priced model of the session's provider; triage uses the session's model" };
}
