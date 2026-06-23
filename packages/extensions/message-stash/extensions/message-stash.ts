// message-stash.ts — single-slot draft stash for Pi's input editor.
//
// Ctrl+Option+S stashes the current editor text and clears the editor so a
// temporary message can be sent. After the next normal user message is sent,
// the stashed draft is restored automatically. Option+Shift+S manually pops
// the stash.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "message-stash";

type RestoreSource = "auto" | "manual";

export default function messageStash(pi: ExtensionAPI) {
  let stashedText: string | undefined;
  let autoRestorePending = false;
  let operationInProgress = false;
  let suppressAutoRestoreUntil = 0;

  const updateStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      STATUS_KEY,
      stashedText === undefined ? undefined : `draft stashed (${formatDraftSize(stashedText)})`,
    );
  };

  const stashCurrentDraft = async (ctx: ExtensionContext): Promise<void> => {
    if (operationInProgress) return;
    operationInProgress = true;

    try {
      const currentText = ctx.ui.getEditorText();
      if (isBlank(currentText)) {
        ctx.ui.notify(
          stashedText === undefined
            ? "Nothing to stash."
            : "A draft is already stashed. Press Option+Shift+S to restore it.",
          "info",
        );
        return;
      }

      if (stashedText !== undefined) {
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

      stashedText = currentText;
      autoRestorePending = true;
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

  const popStashedDraft = async (ctx: ExtensionContext, source: RestoreSource): Promise<boolean> => {
    if (operationInProgress) return false;

    const draft = stashedText;
    if (draft === undefined) {
      if (source === "manual") ctx.ui.notify("No stashed draft.", "info");
      return false;
    }

    operationInProgress = true;
    try {
      const currentText = ctx.ui.getEditorText();
      if (!isBlank(currentText)) {
        const replace = await ctx.ui.confirm(
          source === "auto" ? "Restore stashed draft?" : "Replace current input?",
          source === "auto"
            ? "The editor already has input. Replace it with the stashed draft?"
            : "Replace the current editor input with the stashed draft?",
        );
        if (!replace) {
          if (source === "auto") {
            autoRestorePending = false;
            updateStatus(ctx);
            ctx.ui.notify("Stashed draft kept. Press Option+Shift+S to restore it.", "info");
          } else {
            ctx.ui.notify("Stash kept.", "info");
          }
          return false;
        }
      }

      ctx.ui.setEditorText(draft);
      stashedText = undefined;
      autoRestorePending = false;
      updateStatus(ctx);
      ctx.ui.notify(source === "auto" ? "Stashed draft restored." : "Stashed draft popped.", "info");
      return true;
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
    handler: async (ctx) => {
      await popStashedDraft(ctx, "manual");
    },
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user") return;
    if (!autoRestorePending || stashedText === undefined) return;
    if (operationInProgress || Date.now() < suppressAutoRestoreUntil) return;

    // One-shot auto restore: if replacement is declined, the stash remains for
    // manual Option+Shift+S restore but future messages do not keep prompting.
    autoRestorePending = false;
    updateStatus(ctx);
    await popStashedDraft(ctx, "auto");
  });

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));
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
