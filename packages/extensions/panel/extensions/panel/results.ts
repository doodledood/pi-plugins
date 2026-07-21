import { panelQuestionMessage, panelistAnswerMessage, panelistFailureMessage } from "./prompts.ts";
import type { PanelistResult } from "./types.ts";

export const ANSWER_MESSAGE_TYPE = "panel-answer";
export const QUESTION_MESSAGE_TYPE = "panel-question";
export const META_ENTRY_TYPE = "panel-meta";

export interface AnswerMessageDetails {
  model: string;
  thinking: string;
  ok: boolean;
  cancelled: boolean;
  elapsedMs: number;
  tokens: number;
  cost: number | undefined;
  /** First line of the raw answer, for the collapsed-row preview (renderer-owned clipping). */
  preview: string | undefined;
}

export interface InjectedMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: AnswerMessageDetails;
}

export interface InjectedEntry {
  customType: string;
  data: Record<string, unknown>;
}

export interface InjectionPlan {
  /** Context-participating custom messages, in send order. */
  messages: InjectedMessage[];
  /** Which message index must carry triggerTurn (the last one). */
  triggerIndex: number;
  /** Context-excluded metadata entry (timing, cost, session paths). */
  metaEntry: InjectedEntry;
}

/**
 * Build everything injected into the main session after a panel completes.
 * Contract: the question and each panelist's final answer enter LLM
 * context verbatim and attributed, framed as peer opinions; tool transcripts
 * never do. Cost/timing/session-path metadata rides context-excluded.
 */
export function buildInjectionPlan(question: string, results: readonly PanelistResult[]): InjectionPlan {
  const messages: InjectedMessage[] = [
    {
      customType: QUESTION_MESSAGE_TYPE,
      content: panelQuestionMessage(question, results.length),
      display: false,
    },
  ];
  for (const result of results) {
    messages.push({
      customType: ANSWER_MESSAGE_TYPE,
      content: result.ok
        ? panelistAnswerMessage(result.spec.model, result.spec.thinking, result.answer ?? "")
        : panelistFailureMessage(result.spec.model, result.spec.thinking, result.error ?? "unknown error", result.cancelled ?? false),
      display: true,
      details: {
        model: result.spec.model,
        thinking: result.spec.thinking,
        ok: result.ok,
        cancelled: result.cancelled ?? false,
        elapsedMs: result.elapsedMs,
        tokens: result.tokens,
        cost: result.cost,
        preview: result.ok ? (result.answer ?? "").split("\n").find((line) => line.trim()) : undefined,
      },
    });
  }
  return {
    messages,
    triggerIndex: messages.length - 1,
    metaEntry: {
      customType: META_ENTRY_TYPE,
      data: {
        question,
        panelists: results.map((result) => ({
          model: result.spec.model,
          thinking: result.spec.thinking,
          ok: result.ok,
          cancelled: result.cancelled ?? false,
          elapsedMs: result.elapsedMs,
          tokens: result.tokens,
          cost: result.cost,
          sessionFile: result.sessionFile,
          error: result.error,
        })),
      },
    },
  };
}
