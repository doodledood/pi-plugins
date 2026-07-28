// sidecar.ts — where a child run's session file lives.
//
// Convention (shared with @gotgenes/pi-subagents' `tasks/` and read by the
// simple-statusline cost scanner): `<parent-session-file-without-.jsonl>/<kind>/`.
// Two properties make it the right home for a spawned run's session:
//   - it is reachable from the parent session path, so the run's spend and
//     transcript can be found later;
//   - pi lists sessions from one directory non-recursively (installed
//     pi-coding-agent, dist/core/session-manager.js listSessionsFromDir), so these
//     files never appear in the user's session list or /resume picker.
// Duplicated per package rather than shared, so each extension stays individually
// installable; it is a path convention, not behavior.

import { basename, dirname, join } from "node:path";

/** Sidecar directory for a child run of `kind`, or undefined when the parent is not persisted. */
export function deriveChildSessionDir(parentSessionFile: string | undefined, kind: string): string | undefined {
  if (!parentSessionFile) return undefined;
  return join(dirname(parentSessionFile), basename(parentSessionFile, ".jsonl"), kind);
}
