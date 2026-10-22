// message-stash.ts — single-slot draft stash for Pi's input editor.
//
// Ctrl+Option+S stashes the current editor text and clears the editor so a
// temporary message can be sent. After the next user message is sent, the
// stashed draft is restored automatically into an empty editor. If the editor
// already holds new text, the draft stays stashed and the user is told so.
// Option+Shift+S manually pops the stash.
//
// Each session has its own slot. Pi re-imports extensions on /new, /resume,
// /fork and /reload, so the slot is handed over through the Pi process at that
// moment: the outgoing session leaves it under the session it is switching to,
// and only that session picks it up. Another session in the same process (a
// BTW aside, say) never sees or clears it.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "message-stash";

type RestoreSource = "auto" | "manual";

interface StashSlot {
  text: string | undefined;
  autoRestorePending: boolean;
}

const HANDOFF_KEY = Symbol.for("@doodledood/pi-message-stash/handoff");
/** Stands for a session with no file (an in-memory session) in the handoff map. */
const NO_FILE = "";

/** Slots in transit between a session and its replacement, keyed by the replacement's session file. */
function handoffs(): Map<string, StashSlot> {
  const holder = globalThis as typeof globalThis & { [HANDOFF_KEY]?: Map<string, StashSlot> };
  holder[HANDOFF_KEY] ??= new Map();
  return holder[HANDOFF_KEY];
}

export default function messageStash(pi: ExtensionAPI) {
  const slot: StashSlot = { text: undefined, autoRestorePending: false };
  let operationInProgress = false;
  let suppressAutoRestoreUntil = 0;

  const updateStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      STATUS_KEY,
      slot.text === undefined ? undefined : `draft stashed (${formatDraftSize(slot.text)})`,
    );
  };

  const stashCurrentDraft = async (ctx: ExtensionContext): Promise<void> => {
    if (operationInProgress) return;
    operationInProgress = true;

    try {
      const currentText = ctx.ui.getEditorText();
      if (isBlank(currentText)) {
        ctx.ui.notify(
          slot.text === undefined
            ? "Nothing to stash."
            : "A draft is already stashed. Press Option+Shift+S to restore it.",
          "info",
        );
        return;
      }

      if (slot.text !== undefined) {
        const overwrite = await ctx.ui.confirm(
          "Overwrite stashed draft?",
          "A draft is already stashed. Replace it with the current editor input?",
        );
        if (!overwrite) {
          // Some terminals/TUI paths can deliver the dialog-closing key back to
          // the editor immediately after the popup closes. Keep the existing
          // stash and its one-shot auto-restore, but ignore any user-message
          // event caused by the popup interaction itself.
          suppressAutoRestoreUntil = Date.now() + 750;
          ctx.ui.notify("Stash unchanged.", "info");
          return;
        }
      }

      slot.text = currentText;
      slot.autoRestorePending = true;
      ctx.ui.setEditorText("");
      updateStatus(ctx);
      ctx.ui.notify(
        `Draft stashed (${formatDraftSize(currentText)}). Send a temporary message; the draft will restore after it is sent.`,
        "info",
      );
    } finally {
      operationInProgress = false;
    }
  };

  const restoreDraft = (ctx: ExtensionContext, draft: string, source: RestoreSource): void => {
    ctx.ui.setEditorText(draft);
    slot.text = undefined;
    slot.autoRestorePending = false;
    updateStatus(ctx);
    ctx.ui.notify(source === "auto" ? "Stashed draft restored." : "Stashed draft popped.", "info");
  };

  const popStashedDraft = async (ctx: ExtensionContext): Promise<void> => {
    if (operationInProgress) return;

    const draft = slot.text;
    if (draft === undefined) {
      ctx.ui.notify("No stashed draft.", "info");
      return;
    }

    operationInProgress = true;
    try {
      if (!isBlank(ctx.ui.getEditorText())) {
        const replace = await ctx.ui.confirm(
          "Replace current input?",
          "Replace the current editor input with the stashed draft?",
        );
        if (!replace) {
          ctx.ui.notify("Stash kept.", "info");
          return;
        }
      }
      restoreDraft(ctx, draft, "manual");
    } finally {
      operationInProgress = false;
    }
  };

  pi.registerShortcut("ctrl+alt+s", {
    description: "Stash current editor draft and clear the editor",
    handler: stashCurrentDraft,
  });

  pi.registerShortcut("alt+shift+s", {
    description: "Pop stashed editor draft into the editor",
    handler: popStashedDraft,
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    const draft = slot.text;
    if (!slot.autoRestorePending || draft === undefined) return;
    if (operationInProgress || Date.now() < suppressAutoRestoreUntil) return;

    // One-shot and never interactive: this runs inside the agent's turn, so it must not wait on the user,
    // and text typed since the stash is newer than the draft. With the editor in use, the draft stays
    // stashed for a manual Option+Shift+S.
    slot.autoRestorePending = false;
    if (isBlank(ctx.ui.getEditorText())) {
      restoreDraft(ctx, draft, "auto");
      return;
    }
    updateStatus(ctx);
    ctx.ui.notify("Your draft is still stashed because the editor has new text. Press Option+Shift+S to restore it.", "info");
  });

  pi.on("session_start", (_event, ctx) => {
    const key = ctx.sessionManager.getSessionFile() ?? NO_FILE;
    const handed = handoffs().get(key);
    if (handed) {
      handoffs().delete(key);
      Object.assign(slot, handed);
    }
    updateStatus(ctx);
  });
  pi.on("session_shutdown", (event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (event.reason === "quit" || slot.text === undefined) return;
    // A reload keeps the session file; the other switches name the session they open.
    const key = event.targetSessionFile ?? ctx.sessionManager.getSessionFile() ?? NO_FILE;
    handoffs().set(key, { ...slot });
  });
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function formatDraftSize(text: string): string {
  const lineCount = text.split("\n").length;
  const charCount = text.length;
  const charLabel = charCount === 1 ? "char" : "chars";
  if (lineCount <= 1) return `${charCount} ${charLabel}`;

  const lineLabel = lineCount === 1 ? "line" : "lines";
  return `${lineCount} ${lineLabel}, ${charCount} ${charLabel}`;
}
