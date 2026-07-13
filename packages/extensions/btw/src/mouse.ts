import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  acquireSharedMouseLease,
  hasOtherSharedMouseOwner,
  SHARED_MOUSE_SEQUENCES,
  type SharedMouseLease,
} from "./mouse-lease.ts";

const SGR_MOUSE_PREFIX = "\x1b[<";
const LEGACY_MOUSE_PREFIX = "\x1b[M";
const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const MODIFIER_BITS = [4, 8, 16] as const;
const WHEEL_SCROLL_LINES = 3;

export interface ScreenBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type ParsedSgrMouseInput =
  | { kind: "malformed" }
  | { kind: "other"; button: number; column: number; row: number }
  | { kind: "primary-press"; button: number; column: number; row: number }
  | { kind: "wheel-up"; button: number; column: number; row: number }
  | { kind: "wheel-down"; button: number; column: number; row: number };

function hasBit(value: number, bit: number): boolean {
  return Math.floor(value / bit) % 2 === 1;
}

/** Parse one complete SGR mouse sequence. SGR-looking malformed input remains identifiable for safe consumption. */
export function parseSgrMouseInput(data: string): ParsedSgrMouseInput | undefined {
  if (!data.startsWith(SGR_MOUSE_PREFIX)) return undefined;
  if (data.length > 64) return { kind: "malformed" };

  const match = SGR_MOUSE_PATTERN.exec(data);
  if (!match) return { kind: "malformed" };

  const button = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  if (
    !Number.isSafeInteger(button) ||
    !Number.isSafeInteger(column) ||
    !Number.isSafeInteger(row) ||
    button < 0 ||
    column < 1 ||
    row < 1
  ) {
    return { kind: "malformed" };
  }

  const terminator = match[4];
  const modifiers = MODIFIER_BITS.reduce(
    (sum, bit) => sum + (hasBit(button, bit) ? bit : 0),
    0,
  );
  const unmodifiedButton = button - modifiers;
  if (terminator === "M") {
    if (unmodifiedButton === 0) {
      return { kind: "primary-press", button, column, row };
    }
    if (unmodifiedButton === 64) {
      return { kind: "wheel-up", button, column, row };
    }
    if (unmodifiedButton === 65) {
      return { kind: "wheel-down", button, column, row };
    }
  }
  return { kind: "other", button, column, row };
}

export function containsPoint(bounds: ScreenBounds, column: number, row: number): boolean {
  return column >= bounds.left && column <= bounds.right && row >= bounds.top && row <= bounds.bottom;
}

export interface BtwMouseInputScope {
  dispose(): void;
}

export function enableBtwMouseInput(options: {
  ui: Pick<ExtensionUIContext, "onTerminalInput">;
  tui: Pick<TUI, "terminal">;
  getBounds(): ScreenBounds | undefined;
  isBtwFocused(): boolean;
  scrollBtw(delta: number): void;
  focusBtw(): void;
  focusMain(): void;
}): BtwMouseInputScope {
  const owner = {};
  let lease: SharedMouseLease | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    // Remove BTW's raw consumer before releasing the shared terminal mode.
    // Attempt every cleanup independently and make repeated disposal harmless.
    try {
      unsubscribe?.();
    } catch {
      // Continue releasing the shared mouse owner.
    }
    unsubscribe = undefined;
    try {
      lease?.release();
    } catch {
      // Teardown is best-effort and idempotent across all resources.
    }
    lease = undefined;
  };

  try {
    unsubscribe = options.ui.onTerminalInput((data) => {
      const event = parseSgrMouseInput(data);
      if (!event) {
        // If a terminal honors button reporting but not SGR coordinates, Pi's
        // input buffer emits the complete six-byte legacy report. Never route
        // that raw control sequence into an editor; focus routing remains SGR-only.
        return data.startsWith(LEGACY_MOUSE_PREFIX) ? { consume: true } : undefined;
      }

      // Another cooperative overlay owns normal focused-component routing.
      // Defer all SGR-looking input so Pi can deliver it there unchanged.
      if (hasOtherSharedMouseOwner(owner)) return undefined;

      if (event.kind === "primary-press") {
        const bounds = options.getBounds();
        if (bounds) {
          if (containsPoint(bounds, event.column, event.row)) options.focusBtw();
          else options.focusMain();
        }
      } else if (event.kind === "wheel-up" || event.kind === "wheel-down") {
        const bounds = options.getBounds();
        if (
          bounds &&
          options.isBtwFocused() &&
          containsPoint(bounds, event.column, event.row)
        ) {
          options.scrollBtw(event.kind === "wheel-up" ? WHEEL_SCROLL_LINES : -WHEEL_SCROLL_LINES);
        }
      }

      // As sole owner, consume valid, non-click, and malformed SGR-looking
      // mouse input so no terminal escape sequence reaches either editor.
      return { consume: true };
    });
    lease = acquireSharedMouseLease(options.tui.terminal, owner);
  } catch (error) {
    dispose();
    throw error;
  }

  return { dispose };
}

export const BTW_MOUSE_SEQUENCES = SHARED_MOUSE_SEQUENCES;
