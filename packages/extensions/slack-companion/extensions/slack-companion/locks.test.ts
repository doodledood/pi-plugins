// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md: one session owns a
// conversation on this machine, and a dead holder's lock is reclaimed.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LockManager, RELEASED_MARKER_MS } from "./locks.ts";

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
  const taken = b.acquire("D1/top");
  assert.equal(taken.ok, true);
  assert.equal(taken.ok && taken.previous?.sessionId, "a", "the session that held it last is named");
  alive.delete(2);
  const reclaimed = a.acquire("D1/top");
  assert.equal(reclaimed.ok && reclaimed.previous?.sessionId, "b", "b died without releasing; it held it last");
  a.release("D1/top");
  assert.deepEqual(a.acquire("D1/top"), { ok: true }, "taking back one's own released lock names no one");
});

test("a damaged lock file is held until it is old; a takeover cannot be won twice; old markers are swept", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const a = new LockManager(dir, { pid: 1, sessionId: "a" }, () => true);
  const b = new LockManager(dir, { pid: 2, sessionId: "b" }, () => true);
  writeFileSync(join(dir, "D1_top.json"), "");
  assert.equal(a.acquire("D1/top").ok, false, "a lock read half-written, or damaged, is not taken at once");
  const old = (Date.now() - 11 * 60_000) / 1000;
  utimesSync(join(dir, "D1_top.json"), old, old);
  assert.equal(a.acquire("D1/top").ok, true, "damaged and old: reclaimed");
  // Two sessions judge the same dead holder's lock free: only one wins.
  const dead = new LockManager(dir, { pid: 9, sessionId: "dead" }, () => true);
  dead.acquire("D2/top");
  const judgeDead = (pid: number) => pid !== 9;
  const c = new LockManager(dir, { pid: 3, sessionId: "c" }, judgeDead);
  const d = new LockManager(dir, { pid: 4, sessionId: "d" }, judgeDead);
  const first = c.acquire("D2/top");
  const second = d.acquire("D2/top");
  assert.deepEqual([first.ok, second.ok], [true, false], "the second sees the first one's fresh lock");
  // Markers older than the keep time go; temp files a crash left behind go.
  b.acquire("D3/top");
  b.release("D3/top");
  writeFileSync(join(dir, "D9_top.json.1.x.tmp"), "{}");
  const ancient = (Date.now() - RELEASED_MARKER_MS - 60_000) / 1000;
  utimesSync(join(dir, "D3_top.json"), ancient, ancient);
  utimesSync(join(dir, "D9_top.json.1.x.tmp"), ancient, ancient);
  a.sweep();
  assert.deepEqual(readdirSync(dir).sort(), ["D1_top.json", "D2_top.json"]);
});

test("a takeover that loses a race to another session puts that session's lock back", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const dead = new LockManager(dir, { pid: 9, sessionId: "dead" }, () => true);
  dead.acquire("D1/top");
  const judgeDead = (pid: number) => pid !== 9;
  const c = new LockManager(dir, { pid: 3, sessionId: "c" }, judgeDead);
  const d = new LockManager(dir, { pid: 4, sessionId: "d" }, judgeDead);
  // c reads the dead holder's lock; before c moves it aside, d takes it over.
  const read = (c as any).readFile.bind(c);
  let raced = false;
  (c as any).readFile = (path: string) => {
    const holder = read(path);
    if (!raced && holder?.sessionId === "dead") {
      raced = true;
      assert.equal(d.acquire("D1/top").ok, true);
    }
    return holder;
  };
  assert.equal(c.acquire("D1/top").ok, false, "c sees d's fresh lock and does not take it");
  assert.equal(JSON.parse(readFileSync(join(dir, "D1_top.json"), "utf8")).sessionId, "d", "d's lock is in place");
});
