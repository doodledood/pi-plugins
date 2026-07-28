/**
 * The fleet overlay: a corner card that never takes the seat.
 *
 * It is declared non-capturing, which is how pi's TUI expresses "this overlay is
 * not part of focus at all": the editor keeps every keystroke while the card is
 * visible. Releasing focus afterwards is not equivalent — handing focus to no
 * component leaves the terminal with nothing to route input to.
 *
 * It handles no keys by design, and refreshes on a timer from a getter, so the
 * substrate stays the only source of truth.
 */

import type { OverlayOptions } from "@earendil-works/pi-tui";
import { renderFleetCard, type FleetCardModel } from "./fleet.ts";

export const FLEET_OVERLAY_OPTIONS = {
  anchor: "top-right",
  width: 34,
  minWidth: 24,
  margin: { top: 1, right: 1 },
  /** The card is never focusable, so the editor never loses input to it. */
  nonCapturing: true,
} satisfies OverlayOptions;

export interface FleetOverlayCallbacks {
  getModel: () => FleetCardModel | undefined;
  requestRender?: () => void;
  refreshIntervalMs?: number;
}

/**
 * A minimal pi TUI component. Deliberately not `Focusable`: it must never
 * receive input, so it declares no focus surface at all.
 */
export class FleetOverlay {
  private readonly ticker: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(private readonly callbacks: FleetOverlayCallbacks) {
    const interval = callbacks.refreshIntervalMs ?? 2_000;
    this.ticker = callbacks.requestRender
      ? setInterval(() => callbacks.requestRender?.(), interval)
      : undefined;
    this.ticker?.unref?.();
  }

  render(width: number): string[] {
    const model = this.callbacks.getModel();
    if (!model) return [];
    const body = renderFleetCard(model, width);
    return frame(body, Math.max(18, Math.min(width, 44)));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ticker) clearInterval(this.ticker);
  }
}

/** Draws the box the mock specified, clipping any overlong line. */
export function frame(body: readonly string[], width: number): string[] {
  const inner = width - 2;
  const title = " fleet ";
  const dashes = Math.max(0, inner - 1 - title.length);
  const top = `┌─${title}${"─".repeat(dashes)}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;
  const lines = body.map((line) => {
    const clipped = line.length > inner - 2 ? `${line.slice(0, inner - 3)}…` : line;
    return `│ ${clipped.padEnd(inner - 2)} │`;
  });
  return [top.slice(0, width), ...lines, bottom];
}
