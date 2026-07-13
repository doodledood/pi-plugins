const ENABLE_BUTTON_REPORTING = "\x1b[?1000h";
const DISABLE_BUTTON_REPORTING = "\x1b[?1000l";
const ENABLE_SGR_REPORTING = "\x1b[?1006h";
const DISABLE_SGR_REPORTING = "\x1b[?1006l";

/**
 * Process-global protocol shared by independently installed Pi extensions.
 * Keep the symbol and state shape stable across package-local implementations.
 */
export const SHARED_MOUSE_LEASE_SYMBOL = Symbol.for(
  "@doodledood/pi-plugins/shared-sgr-mouse-lease/v1",
);

export interface MouseTerminalWriter {
  write(data: string): void;
}

interface SharedMouseLeaseState {
  protocol: "@doodledood/pi-plugins/shared-sgr-mouse-lease/v1";
  owners: Set<unknown>;
  terminal: MouseTerminalWriter;
}

export interface SharedMouseLease {
  release(): void;
}

function readState(): SharedMouseLeaseState | undefined {
  const candidate = (globalThis as any)[SHARED_MOUSE_LEASE_SYMBOL] as unknown;
  if (candidate === undefined) return undefined;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    (candidate as Partial<SharedMouseLeaseState>).protocol !==
      "@doodledood/pi-plugins/shared-sgr-mouse-lease/v1" ||
    !((candidate as Partial<SharedMouseLeaseState>).owners instanceof Set) ||
    typeof (candidate as Partial<SharedMouseLeaseState>).terminal?.write !== "function"
  ) {
    throw new Error("Incompatible process-global SGR mouse lease state.");
  }
  return candidate as SharedMouseLeaseState;
}

function releaseOwner(owner: unknown): void {
  let state: SharedMouseLeaseState | undefined;
  try {
    state = readState();
  } catch {
    return;
  }
  if (!state || !state.owners.delete(owner) || state.owners.size > 0) return;

  delete (globalThis as any)[SHARED_MOUSE_LEASE_SYMBOL];
  try {
    state.terminal.write(DISABLE_SGR_REPORTING);
  } catch {
    // Attempt every terminal-mode restoration independently.
  }
  try {
    state.terminal.write(DISABLE_BUTTON_REPORTING);
  } catch {
    // Release is best-effort and remains idempotent after terminal failure.
  }
}

/** Acquire one exact-owner reference, enabling reporting only for the first owner. */
export function acquireSharedMouseLease(
  terminal: MouseTerminalWriter,
  owner: unknown,
): SharedMouseLease {
  const existing = readState();
  if (existing) {
    existing.owners.add(owner);
    return { release: () => releaseOwner(owner) };
  }

  const state: SharedMouseLeaseState = {
    protocol: "@doodledood/pi-plugins/shared-sgr-mouse-lease/v1",
    owners: new Set([owner]),
    terminal,
  };
  (globalThis as any)[SHARED_MOUSE_LEASE_SYMBOL] = state;
  let buttonEnableStarted = false;
  let sgrEnableStarted = false;
  try {
    buttonEnableStarted = true;
    terminal.write(ENABLE_BUTTON_REPORTING);
    sgrEnableStarted = true;
    terminal.write(ENABLE_SGR_REPORTING);
  } catch (error) {
    delete (globalThis as any)[SHARED_MOUSE_LEASE_SYMBOL];
    if (sgrEnableStarted) {
      try {
        terminal.write(DISABLE_SGR_REPORTING);
      } catch {
        // Preserve the setup error while continuing rollback.
      }
    }
    if (buttonEnableStarted) {
      try {
        terminal.write(DISABLE_BUTTON_REPORTING);
      } catch {
        // Preserve the setup error.
      }
    }
    throw error;
  }

  return { release: () => releaseOwner(owner) };
}

/** True when an exact owner should defer SGR input to another focused overlay. */
export function hasOtherSharedMouseOwner(owner: unknown): boolean {
  const state = readState();
  if (!state) return false;
  for (const candidate of state.owners) {
    if (candidate !== owner) return true;
  }
  return false;
}

export const SHARED_MOUSE_SEQUENCES = {
  enableButtonReporting: ENABLE_BUTTON_REPORTING,
  disableButtonReporting: DISABLE_BUTTON_REPORTING,
  enableSgrReporting: ENABLE_SGR_REPORTING,
  disableSgrReporting: DISABLE_SGR_REPORTING,
} as const;
