// The words a wake-up says. Each message is read by the model in the session that started the
// work, so it states what happened and the exact commands that act on it.
import type { TrackedSession, Wakeup } from "./tracker.ts";

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

/** How much of a started session's first prompt its starter keeps, to recognise what it is for. */
export const TASK_CHARS = 200;

/** The start of a first prompt on one line, cut at TASK_CHARS. */
export function taskSummary(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > TASK_CHARS ? `${line.slice(0, TASK_CHARS - 1).trimEnd()}…` : line;
}

/** The prompt section name that carries the orchestrator role while started sessions are open. */
export const ORCHESTRATOR_SECTION = "herdr_orchestrator";

/**
 * The orchestrator role, as a system-prompt section, for a session following the sessions it
 * started; undefined when it follows none. It depends only on which sessions are open and what
 * they were started for, so it changes when one starts or exits, not on every wake-up.
 */
export function orchestratorSection(sessions: readonly TrackedSession[], quiet: string): string | undefined {
  if (sessions.length === 0) return undefined;
  const listed = sessions.map((s) => {
    const where = s.folder ? `, in ${s.folder}` : "";
    const task = s.task ? `: "${s.task}"` : "";
    return `- \`${s.name}\` (pane ${s.paneId})${where}${task}`;
  });
  return [
    "You started the Pi sessions below in Herdr and are their orchestrator: each one owns its task, and you coordinate.",
    "- Send work and questions that belong to a session's task to that session with `herdr agent prompt <name> \"<text>\"`, the person's follow-ups, corrections and status questions included, and relay what it reports. Its investigating, editing and answering stay with it.",
    "- Do yourself only work that belongs to no session, and the coordination: reading their output, answering their questions or bringing them to the person, comparing results, and starting, messaging and closing sessions.",
    `- After sending, end your turn rather than polling or sleeping: a message reaches you when a session finishes a turn, waits at a question, stays working for ${quiet} with no change, or exits.`,
    "",
    "Sessions:",
    ...listed,
  ].join("\n");
}

/** The prompt section name that carries the started-session role. */
export const STARTED_SECTION = "herdr_started_session";

/** The started-session role, as a system-prompt section, for a session an orchestrator started. */
export function startedSection(orchestratorPane: string): string {
  return [
    `An orchestrator Pi session in Herdr (pane ${orchestratorPane}) started you and coordinates your work. The person can also switch in and type to you, so a message may come from either.`,
    "- End each turn with a self-contained report of where your task stands: what you did, what you found, and what you need. The orchestrator reads only the end of your screen.",
    "- When you need a decision, ask it as a question with options (ask_user_question where you have it); it reaches the orchestrator with the options intact.",
    "- Leave starting other sessions to the orchestrator: when the work needs another session, say so in your report.",
  ].join("\n");
}
