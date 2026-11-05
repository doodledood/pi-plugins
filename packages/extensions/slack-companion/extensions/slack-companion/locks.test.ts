// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md: one session owns a
// conversation on this machine, and a lock is taken only from a holder that is gone.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DAMAGED_LOCK_MS, LockManager } from "./locks.ts";

const BOOT = 29_000_000;

test("a live holder keeps the lock, however long it slept; its owner re-acquires; release frees it", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const alive = new Set([1, 2]);
  const a = new LockManager(dir, { pid: 1, sessionId: "a" }, (pid) => alive.has(pid), BOOT);
  const b = new LockManager(dir, { pid: 2, sessionId: "b" }, (pid) => alive.has(pid), BOOT);
  assert.deepEqual(a.acquire("D1/top"), { ok: true });
  assert.deepEqual(a.acquire("D1/top"), { ok: true });
  const denied = b.acquire("D1/top");
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && "holder" in denied && denied.holder.sessionId, "a");
  b.release("D1/top");
  assert.ok(a.holds("D1/top"), "releasing someone else's lock does nothing");
  a.release("D1/top");
  assert.deepEqual(readdirSync(dir), [], "a released lock leaves nothing behind");
  assert.deepEqual(b.acquire("D1/top"), { ok: true });
  assert.equal(a.holds("D1/top"), false);
});

test("a holder whose process is gone, or that is from before a restart, is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const crashed = new LockManager(dir, { pid: 9, sessionId: "crashed" }, () => true, BOOT);
  crashed.acquire("D1/top");
  const sees9Gone = new LockManager(dir, { pid: 3, sessionId: "c" }, (pid) => pid !== 9, BOOT);
  assert.deepEqual(sees9Gone.acquire("D1/top"), { ok: true });
  assert.equal(crashed.holds("D1/top"), false, "the replaced holder no longer holds it");
  const beforeRestart = new LockManager(dir, { pid: 4, sessionId: "old" }, () => true, BOOT - 600);
  beforeRestart.acquire("D2/top");
  const afterRestart = new LockManager(dir, { pid: 5, sessionId: "new" }, () => true, BOOT);
  assert.deepEqual(afterRestart.acquire("D2/top"), { ok: true }, "a pid alive again after a restart is someone else");
  assert.deepEqual(readdirSync(join(dir, "D2_top")), ["2.json"], "the replaced lock file is removed");
});

test("two sessions taking the same free lock: only one wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  new LockManager(dir, { pid: 9, sessionId: "dead" }, () => true, BOOT).acquire("D1/top");
  const sees9Gone = (pid: number) => pid !== 9;
  const c = new LockManager(dir, { pid: 3, sessionId: "c" }, sees9Gone, BOOT);
  const d = new LockManager(dir, { pid: 4, sessionId: "d" }, sees9Gone, BOOT);
  // c reads the dead holder's lock; before c writes the next one, d takes it.
  const top = (c as any).top.bind(c);
  let raced = false;
  (c as any).top = (folder: string) => {
    const found = top(folder);
    if (!raced && found?.holder?.sessionId === "dead") {
      raced = true;
      assert.deepEqual(d.acquire("D1/top"), { ok: true });
    }
    return found;
  };
  const lost = c.acquire("D1/top");
  assert.equal(lost.ok, false, "c finds d's lock in place of the one it judged free");
  assert.ok(d.holds("D1/top"));
  assert.equal(c.holds("D1/top"), false);
});

test("an unreadable lock file is respected for a minute, then replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  mkdirSync(join(dir, "D1_top"));
  writeFileSync(join(dir, "D1_top", "1.json"), "");
  const a = new LockManager(dir, { pid: 1, sessionId: "a" }, () => true, BOOT);
  assert.deepEqual(a.acquire("D1/top"), { ok: false, damaged: true }, "being written, or damaged: not taken at once");
  const old = (Date.now() - DAMAGED_LOCK_MS - 1000) / 1000;
  utimesSync(join(dir, "D1_top", "1.json"), old, old);
  assert.deepEqual(a.acquire("D1/top"), { ok: true });
});
