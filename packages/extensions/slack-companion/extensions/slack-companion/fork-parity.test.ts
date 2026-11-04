// fork.ts copies BTW's pure fork functions; both copies must behave the same.
import assert from "node:assert/strict";
import test from "node:test";
import * as btw from "../../../btw/src/fork.ts";
import { forkEntriesForChild, selectForkBranch } from "./fork.ts";

const entry = (id: string, extra: Record<string, unknown>) => ({ id, parentId: null, timestamp: "2026-11-04T00:00:00.000Z", ...extra }) as any;
const user = (id: string) => entry(id, { type: "message", message: { role: "user", content: "hi" } });
const custom = (id: string) => entry(id, { type: "custom", customType: "goal-controller-state", data: {} });
const toolUse = (id: string, callId: string) => entry(id, { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: callId, name: "read", arguments: {} }] } });
const result = (id: string, callId: string) => entry(id, { type: "message", message: { role: "toolResult", toolCallId: callId, content: [] } });
const compaction = (id: string, keep: string) => entry(id, { type: "compaction", firstKeptEntryId: keep, summary: "s" });

const fixtures = [
  [user("a"), custom("b"), user("c")],
  [custom("a"), compaction("b", "a"), user("c")],
  [user("a"), toolUse("b", "t1")],
  [user("a"), toolUse("b", "t1"), result("c", "t1"), custom("d")],
  [user("a"), custom("b"), custom("c"), compaction("d", "b"), user("e")],
];

test("the copied fork functions match BTW's on every fixture", () => {
  for (const fixture of fixtures) {
    for (const idle of [true, false]) assert.deepEqual(selectForkBranch(fixture, idle), btw.selectForkBranch(fixture, idle));
    assert.deepEqual(forkEntriesForChild(fixture), btw.forkEntriesForChild(fixture));
  }
});
