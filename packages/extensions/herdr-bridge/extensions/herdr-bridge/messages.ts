// The words a wake-up says. Each message is read by the model in the session that started the
// work, so it states what happened and the exact commands that act on it.
import type { Wakeup } from "./tracker.ts";

export const WAKEUP_TYPE = "herdr-bridge-wakeup";

/** How many lines of a waiting session's screen a blocked wake-up carries. */
export const SCREEN_LINES = 40;

/** The visible screen of a waiting session, with blank lines trimmed at both ends and runs of them collapsed. */
export function dialogExcerpt(screen: string): string {
  const lines = screen.replace(/\r/g, "").split("\n").map((line) => line.trimEnd());
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim() && (kept.length === 0 || !kept.at(-1)!.trim())) continue;
    kept.push(line);
  }
  while (kept.length && !kept.at(-1)!.trim()) kept.pop();
  return kept.join("\n");
}

/** How to answer a waiting dialog through Herdr's agent commands; `target` is the session's name. */
export function answerSteps(target: string, paneId: string): string {
  return [
    "Answer it with Herdr's agent commands (`herdr agent prompt` is refused while a dialog waits):",
    `- To choose a numbered option N: \`herdr agent send-keys ${target} N\`.`,
    `- To answer in your own words: send the number of its \`Type something.\` row with \`herdr agent send-keys ${target} N\`, then \`herdr pane send-text ${paneId} "<your answer>"\`, then \`herdr agent send-keys ${target} enter\`.`,
    `- A dialog without numbers: move with \`herdr agent send-keys ${target} up\` or \`down\`, confirm with \`enter\`.`,
    `- Several questions show as tabs: answer each one in turn; then, on the Submit tab, send \`enter\`.`,
    `- Then check with \`herdr agent read ${target} --source visible\` that the dialog closed.`,
    "Answer a routine question yourself when the work's instructions or the person's request settle it. Bring a call that needs the person to them instead of answering it.",
  ].join("\n");
}

/** The text of one wake-up. `screen` is the waiting session's screen, for a blocked wake-up. */
export function wakeupText(wakeup: Wakeup, screen?: string): string {
  const who = `\`${wakeup.name}\` (pane ${wakeup.paneId})`;
  switch (wakeup.kind) {
    case "finished":
      return [
        `Herdr session ${who}, which you started, finished a turn and is waiting for input.`,
        `Read it with \`herdr agent read ${wakeup.name} --source recent --lines 80\`; send it more with \`herdr agent prompt ${wakeup.name} "<text>"\`; when its work is done, close it with \`herdr pane close ${wakeup.paneId}\`.`,
      ].join("\n");
    case "blocked": {
      const excerpt = screen === undefined ? undefined : dialogExcerpt(screen);
      return [
        `Herdr session ${who}, which you started, is waiting at a question.`,
        excerpt
          ? `Its screen (the last ${SCREEN_LINES} lines; part of a long dialog may be off screen or on another tab — read again after each answer):\n\`\`\`\n${excerpt}\n\`\`\``
          : `Its screen could not be read; read it with \`herdr agent read ${wakeup.name} --source visible\`.`,
        answerSteps(wakeup.name, wakeup.paneId),
      ].join("\n");
    }
    case "quiet":
      return [
        `Herdr session ${who}, which you started, has been working for ${wakeup.quietMinutes} minutes with no change.`,
        `Check on it with \`herdr agent read ${wakeup.name} --source recent --lines 80\`; if it is stuck past its timeout, stop it with \`herdr pane close ${wakeup.paneId}\`.`,
      ].join("\n");
    case "gone":
      return `Herdr session ${who}, which you started, has exited or its pane closed. Its Pi session file stays on disk.`;
  }
}
