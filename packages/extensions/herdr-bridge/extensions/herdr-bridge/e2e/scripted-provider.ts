// A Pi extension for the end-to-end runs: a model provider, `hbfake/scripted`, whose replies are
// scripted by markers in the latest message, so every run is the same and spends nothing. It also
// registers `open_dialogs`, a tool that opens Pi's own dialogs for the status-bridge checks.
//
// Markers in the latest user or custom message:
//   CALL <tool> <json>   call that tool with that JSON
//   SLOW <ms>            wait that long, then reply
//   ASK_ONE / ASK_TWO    call ask_user_question with one / two questions
//   DIALOGS <json>       call open_dialogs with that JSON
//   a joke request       the first one in the run asks which topic (ask_user_question); later ones reply with a joke
//   anything else        reply "ECHO: <text>"; a wake-up gets "WOKE: <its first line>"
// After a tool result the reply is "TOOL RESULT: <result text>".
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const ONE = {
  questions: [
    {
      question: "Which joke topic should I use?",
      header: "Topic",
      options: [
        { label: "Software", description: "A joke about programmers." },
        { label: "Insurance", description: "A joke about claims." },
      ],
    },
  ],
};
const TWO = {
  questions: [
    ...ONE.questions,
    {
      question: "How long should the joke be?",
      header: "Length",
      options: [
        { label: "One line", description: "A one-liner." },
        { label: "Story", description: "A short story." },
      ],
    },
  ],
};

function textOf(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part: any) => (part.type === "text" ? part.text : "")).join("");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for the first caller in this run's agent directory to claim `marker`. */
function firstInRun(marker: string): boolean {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return false;
  try {
    closeSync(openSync(join(dir, marker), "wx"));
    return true;
  } catch {
    return false;
  }
}

export default function scriptedProvider(pi: any): void {
  pi.registerTool({
    name: "open_dialogs",
    label: "Open dialogs",
    description: "Test tool: opens Pi dialogs. kind select opens one titled select; kind nested opens a custom dialog and a select inside it.",
    parameters: Type.Object({ kind: Type.String() }),
    async execute(_id: string, params: { kind: string }, _signal: unknown, _onUpdate: unknown, ctx: any) {
      if (params.kind === "select") {
        const choice = await ctx.ui.select("Pick a topic", ["Software", "Insurance"]);
        return { content: [{ type: "text", text: `picked ${choice}` }] };
      }
      // Nested: an outer custom dialog stays open while an inner overlay dialog opened on top of it
      // is answered first.
      let inner = "";
      const outer = await ctx.ui.custom((_tui: any, _theme: any, _kb: any, done: (value: string) => void) => {
        setTimeout(() => {
          void ctx.ui
            .custom(
              (_t: any, _th: any, _k: any, closeInner: (value: string) => void) => ({
                render: () => ["Inner question: press enter to answer"],
                invalidate: () => {},
                handleInput: (data: string) => {
                  if (data === "\r" || data === "\n") closeInner("answered");
                },
              }),
              { overlay: true },
            )
            .then((value: string) => {
              inner = value;
            });
        }, 300);
        return {
          render: () => ["Outer dialog: press enter to close"],
          invalidate: () => {},
          handleInput: (data: string) => {
            if (data === "\r" || data === "\n") done("closed");
          },
        };
      });
      return { content: [{ type: "text", text: `outer ${outer}, inner ${inner}` }] };
    },
  });

  pi.registerProvider("hbfake", {
    baseUrl: "http://127.0.0.1/never-called",
    apiKey: "fake",
    api: "hbfake-api",
    models: [
      {
        id: "scripted",
        name: "Scripted (herdr-bridge e2e)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000,
        maxTokens: 2_000,
      },
    ],
    streamSimple: (model: any, context: any) => {
      const stream = createAssistantMessageEventStream();
      const messages = (context.messages ?? []).filter((m: any) => m.role !== "system");
      const last = messages.at(-1);
      void (async () => {
        const output: any = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        const reply = (text: string) => {
          output.content.push({ type: "text", text });
          stream.push({ type: "start", partial: output });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
          stream.push({ type: "done", reason: "stop", message: output });
          stream.end(output);
        };
        const call = (name: string, args: unknown) => {
          const toolCall = { type: "toolCall" as const, id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args as Record<string, any> };
          output.stopReason = "toolUse";
          output.content.push(toolCall);
          stream.push({ type: "start", partial: output });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
          stream.push({ type: "done", reason: "toolUse", message: output });
          stream.end(output);
        };
        if (last?.role === "toolResult") return reply(`TOOL RESULT: ${textOf(last)}`);
        const text = textOf(last);
        // A wake-up quotes other sessions' screens, markers included; it only ever gets an answer.
        if (text.startsWith("Herdr session") || text.startsWith("herdr-bridge")) return reply(`WOKE: ${text.split("\n")[0]}`);
        const callMatch = text.match(/CALL (\S+) (\{[\s\S]*\})\s*$/);
        if (callMatch) return call(callMatch[1]!, JSON.parse(callMatch[2]!));
        const slow = text.match(/SLOW (\d+)/);
        if (slow) {
          await sleep(Number(slow[1]));
          return reply(`SLOW DONE after ${slow[1]} ms`);
        }
        if (text.includes("ASK_TWO")) return call("ask_user_question", TWO);
        if (text.includes("ASK_ONE")) return call("ask_user_question", ONE);
        if (/\bjoke\b/i.test(text) && !text.includes("Invoke the run-ticket")) {
          if (firstInRun("joke-asked")) return call("ask_user_question", ONE);
          return reply("Why did the developer go broke? Because he used up all his cache.");
        }
        const dialogs = text.match(/DIALOGS (\{[\s\S]*\})/);
        if (dialogs) return call("open_dialogs", JSON.parse(dialogs[1]!));
        return reply(`ECHO: ${text}`);
      })();
      return stream;
    },
  });
}
