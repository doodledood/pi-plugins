// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md: one session owns a
// conversation on this machine, and a dead holder's lock is reclaimed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LockManager } from "./locks.ts";

test("a live holder keeps the lock; its owner re-acquires; release frees it; a dead holder is reclaimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const alive = new Set([1, 2]);
  const a = new LockManager(dir, { pid: 1, sessionId: "a" }, (pid) => alive.has(pid));
  const b = new LockManager(dir, { pid: 2, sessionId: "b" }, (pid) => alive.has(pid));
  assert.deepEqual(a.acquire("D1/top"), { ok: true });
  assert.deepEqual(a.acquire("D1/top"), { ok: true });
  const denied = b.acquire("D1/top");
  assert.equal(denied.ok, false);
  b.release("D1/top");
  assert.equal(b.acquire("D1/top").ok, false, "releasing someone else's lock does nothing");
  a.release("D1/top");
  assert.deepEqual(b.acquire("D1/top"), { ok: true });
  alive.delete(2);
  assert.deepEqual(a.acquire("D1/top"), { ok: true }, "b died without releasing");
});
