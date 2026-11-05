// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md: one session owns a
// conversation on this machine, and a lock is taken only from a holder that is gone.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DAMAGED_LOCK_MS, LockManager, OLD_LOCK_MS } from "./locks.ts";

/** Processes and when they started; a pid missing here is gone. */
function machine(processes: Record<number, string>) {
  return { alive: (pid: number) => pid in processes, startOf: (pid: number) => processes[pid] };
}

test("a live holder keeps the lock, however long it slept; its owner re-acquires; release lets another take it", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const m = machine({ 1: "t1", 2: "t2" });
  const a = new LockManager(dir, { pid: 1, sessionId: "a" }, m.alive, m.startOf);
  const b = new LockManager(dir, { pid: 2, sessionId: "b" }, m.alive, m.startOf);
  assert.deepEqual(a.acquire("D1/top"), { ok: true });
  assert.deepEqual(a.acquire("D1/top"), { ok: true });
  const denied = b.acquire("D1/top");
  assert.equal(!denied.ok && "holder" in denied && denied.holder.sessionId, "a");
  b.release("D1/top");
  assert.ok(a.holds("D1/top"), "releasing someone else's lock does nothing");
  a.release("D1/top");
  assert.equal(a.holds("D1/top"), false);
  assert.deepEqual(b.acquire("D1/top"), { ok: true });
  assert.deepEqual(readdirSync(join(dir, "D1_top")), ["3.json"], "numbers move on: 1 held, 2 released, 3 taken");
});

test("a holder whose process is gone, or whose pid now belongs to a process started at another time, is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const before = machine({ 9: "t9", 3: "t3" });
  new LockManager(dir, { pid: 9, sessionId: "crashed" }, before.alive, before.startOf).acquire("D1/top");
  const afterCrash = machine({ 3: "t3" });
  assert.deepEqual(new LockManager(dir, { pid: 3, sessionId: "c" }, afterCrash.alive, afterCrash.startOf).acquire("D1/top"), { ok: true });
  new LockManager(dir, { pid: 4, sessionId: "old" }, machine({ 4: "t4" }).alive, machine({ 4: "t4" }).startOf).acquire("D2/top");
  const reused = machine({ 4: "another process, started later", 5: "t5" });
  assert.deepEqual(new LockManager(dir, { pid: 5, sessionId: "new" }, reused.alive, reused.startOf).acquire("D2/top"), { ok: true }, "pid 4 now belongs to someone else");
});

test("two sessions taking the same free lock: only one wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const m = machine({ 9: "t9", 3: "t3", 4: "t4" });
  new LockManager(dir, { pid: 9, sessionId: "dead" }, m.alive, m.startOf).acquire("D1/top");
  const gone = machine({ 3: "t3", 4: "t4" });
  const c = new LockManager(dir, { pid: 3, sessionId: "c" }, gone.alive, gone.startOf);
  const d = new LockManager(dir, { pid: 4, sessionId: "d" }, gone.alive, gone.startOf);
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
  assert.equal(c.acquire("D1/top").ok, false, "c finds d's lock in place of the one it judged free");
  assert.ok(d.holds("D1/top"));
});

test("a session that judged an old reading cannot take a number already passed: the live holder keeps the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const m = machine({ 9: "t9", 3: "t3", 4: "t4", 6: "t6" });
  new LockManager(dir, { pid: 9, sessionId: "dead" }, m.alive, m.startOf).acquire("D1/top");
  const gone = machine({ 3: "t3", 4: "t4", 6: "t6" });
  const c = new LockManager(dir, { pid: 3, sessionId: "c" }, gone.alive, gone.startOf);
  const d = new LockManager(dir, { pid: 4, sessionId: "d" }, gone.alive, gone.startOf);
  const f = new LockManager(dir, { pid: 6, sessionId: "f" }, gone.alive, gone.startOf);
  // c reads 1 (dead) and will create 2; meanwhile d takes 2 and lets it go, and f takes the next.
  const top = (c as any).top.bind(c);
  let raced = false;
  (c as any).top = (folder: string) => {
    const found = top(folder);
    if (!raced && found?.holder?.sessionId === "dead") {
      raced = true;
      d.acquire("D1/top");
      d.release("D1/top");
      assert.deepEqual(f.acquire("D1/top"), { ok: true });
    }
    return found;
  };
  assert.equal(c.acquire("D1/top").ok, false);
  assert.ok(f.holds("D1/top"), "f keeps its lock");
});

test("an unreadable lock file is respected for a minute, then replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  mkdirSync(join(dir, "D1_top"));
  writeFileSync(join(dir, "D1_top", "1.json"), "");
  const m = machine({ 1: "t1" });
  const a = new LockManager(dir, { pid: 1, sessionId: "a" }, m.alive, m.startOf);
  assert.deepEqual(a.acquire("D1/top"), { ok: false, damaged: true }, "being written, or damaged: not taken at once");
  const old = (Date.now() - DAMAGED_LOCK_MS - 1000) / 1000;
  utimesSync(join(dir, "D1_top", "1.json"), old, old);
  assert.deepEqual(a.acquire("D1/top"), { ok: true });
});

test("a session start removes lock folders released or abandoned more than a day ago, and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const m = machine({ 1: "t1", 2: "t2" });
  const a = new LockManager(dir, { pid: 1, sessionId: "a" }, m.alive, m.startOf);
  a.acquire("D1/top"); // live
  a.acquire("D2/top");
  a.release("D2/top"); // released, old
  a.acquire("D3/top");
  a.release("D3/top"); // released, fresh
  new LockManager(dir, { pid: 9, sessionId: "crashed" }, () => true, () => "t9").acquire("D4/top"); // abandoned, old
  const old = (Date.now() - OLD_LOCK_MS - 60_000) / 1000;
  for (const name of ["D1_top", "D2_top", "D4_top"]) for (const file of readdirSync(join(dir, name))) utimesSync(join(dir, name, file), old, old);
  new LockManager(dir, { pid: 2, sessionId: "b" }, m.alive, m.startOf).sweep();
  assert.deepEqual(readdirSync(dir).sort(), ["D1_top", "D3_top"]);
});
