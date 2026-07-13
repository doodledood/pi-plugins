import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

/**
 * Resolve a ctx.ui.custom overlay without letting Pi's stack-last done()
 * remove an unrelated overlay that was mounted later.
 */
export function settleExactCustomOverlay(
  tui: TUI,
  handle: OverlayHandle,
  done: () => void,
): void {
  handle.hide();
  const sentinel: Component = {
    invalidate() {},
    render() { return []; },
  };
  const sentinelHandle = tui.showOverlay(sentinel, { nonCapturing: true });
  try {
    done();
  } finally {
    // done() normally removes the sentinel. hide() is an idempotent fallback
    // when the host is concurrently tearing down its custom UI.
    sentinelHandle.hide();
  }
}
