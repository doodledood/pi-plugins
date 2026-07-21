import { panelQuestionMessage, panelistAnswerMessage, panelistFailureMessage } from "./prompts.ts";
import type { PanelistResult } from "./types.ts";

export const ANSWER_MESSAGE_TYPE = "panel-answer";
export const QUESTION_MESSAGE_TYPE = "panel-question";
export const META_ENTRY_TYPE = "panel-meta";

export interface AnswerMessageDetails {
  /** Anonymous in-context label ("A", "B", …) mapping the main model's references back to a panelist for the user. */
  label: string;
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

/**
 * Provider-side content-screening refusals (e.g. Anthropic's "reverse
 * engineering or duplicating model outputs" ToS block) are account/model-level
 * screening decisions, not answers to the question — raw refusal text is a
 * confusing wall of legalese, so it is summarized with actionable guidance.
 * Observed live: a key can get a sticky per-model flag (fable) while other
 * models on the same key (haiku, sonnet) keep working.
 */
export function humanizePanelistError(error: string): string {
  if (/terms of service|reverse engineering or duplicating model outputs/i.test(error)) {
    return "the provider's content screening blocked the request at the account/model level (this is about the API key × model combination, not your question — other models on the same key usually still work; try a different model for this panelist or retry later)";
  }
  return error;
}

/** Anonymous label for the panelist at a presented position: A..Z, then P27, P28, … */
export function panelistLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `P${index + 1}`;
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
 * Contract: the question and each panelist's final answer enter LLM context
 * verbatim — but ANONYMOUS and RANDOMLY ORDERED (Fisher-Yates via the
 * injectable rng): the main model judges substance, free of brand and
 * position bias. Attribution for the user rides on message details
 * (renderer-only; convertToLlm sends content only) and the context-excluded
 * meta entry. Tool transcripts never enter context.
 */
export function buildInjectionPlan(
  question: string,
  results: readonly PanelistResult[],
  rng: () => number = Math.random,
): InjectionPlan {
  const shuffled = [...results];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as PanelistResult, shuffled[i] as PanelistResult];
  }

  const messages: InjectedMessage[] = [
    {
      customType: QUESTION_MESSAGE_TYPE,
      content: panelQuestionMessage(question, results.length),
      display: false,
    },
  ];
  shuffled.forEach((result, index) => {
    const label = panelistLabel(index); // A, B, C, … in presented order
    messages.push({
      customType: ANSWER_MESSAGE_TYPE,
      content: result.ok
        ? panelistAnswerMessage(label, result.answer ?? "")
        : panelistFailureMessage(label, humanizePanelistError(result.error ?? "unknown error"), result.cancelled ?? false),
      display: true,
      details: {
        label,
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
  });
  return {
    messages,
    triggerIndex: messages.length - 1,
    metaEntry: {
      customType: META_ENTRY_TYPE,
      data: {
        question,
        panelists: shuffled.map((result, index) => ({
          label: panelistLabel(index),
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
