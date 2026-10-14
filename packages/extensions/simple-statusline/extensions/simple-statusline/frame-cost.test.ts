/**
 * Frame cost: pi redraws the footer on every frame — 30 times a second while a tool runs — so the
 * footer must not walk the session on a frame where the session has not changed. Without that, its
 * cost grows with every entry the session ever recorded, and compaction never brings it back down.
 */
import assert from "node:assert/strict";
import test from "node:test";
import simpleStatusline from "../simple-statusline.ts";
import type { SessionEntryLike } from "./cache.ts";

type Handler = (event: any, ctx: any) => unknown;

const plainTheme = { fg: (_tone: string, text: string) => text };
const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => undefined, onBranchChange: () => () => {} };

function assistant(id: string, input: number, read: number, write: number, tokens = input + read + write): SessionEntryLike {
  return { type: "message", id, message: { role: "assistant", timestamp: 1, usage: { input, cacheRead: read, cacheWrite: write, totalTokens: tokens } as never } };
}

/** A long session: thousands of entries on the active branch. */
function longBranch(count: number): SessionEntryLike[] {
  return Array.from({ length: count }, (_, i) => assistant(`e${i}`, 100, 9_000 + (i % 7), i % 50 === 0 ? 2_000 : 0));
}

/** pi's view of a session, counting every call that walks its entries. */
function session(branch: SessionEntryLike[]) {
  const walks = { branch: 0, entries: 0, projection: 0, usage: 0 };
  const model = { id: "test-model", provider: "test", contextWindow: 200_000 };
  const ctx = {
    cwd: "/tmp/project",
    model,
    getContextUsage: () => {
      walks.usage += 1;
      // pi's estimate walks the branch; the fake derives it from the branch so staleness shows.
      const tokens = branch.length * 1_000;
      return { tokens, contextWindow: ctx.model.contextWindow, percent: (tokens * 100) / ctx.model.contextWindow };
    },
    sessionManager: {
      getLeafId: () => branch.at(-1)?.id ?? null,
      getBranch: () => {
        walks.branch += 1;
        return branch;
      },
      getEntries: () => {
        walks.entries += 1;
        return branch;
      },
      buildSessionProjection: () => {
        walks.projection += 1;
        return { entries: [] };
      },
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
    },
    ui: { setStatus() {}, setFooter: (factory: any) => (footerFactory = factory), notify() {} },
  };
  let footerFactory: any;
  const handlers = new Map<string, Handler>();
  simpleStatusline({ on: (event: string, handler: Handler) => handlers.set(event, handler), getThinkingLevel: () => "off", registerCommand() {} });
  handlers.get("session_start")!({ reason: "startup" }, ctx);
  const footer = footerFactory({ requestRender() {} }, plainTheme, footerData) as { render(width: number): string[] };
  const resetWalks = () => Object.assign(walks, { branch: 0, entries: 0, projection: 0, usage: 0 });
  return { ctx, footer, walks, resetWalks, emit: (event: string, payload: object = {}) => handlers.get(event)?.(payload, ctx) };
}

test("the footer walks no session entries on a frame where nothing changed", () => {
  const { footer, walks, resetWalks } = session(longBranch(6_000));
  footer.render(200);
  resetWalks();
  for (let frame = 0; frame < 30; frame++) footer.render(200);
  assert.deepEqual(walks, { branch: 0, entries: 0, projection: 0, usage: 0 }, "an unchanged session was walked again while drawing");
});

test("the footer stays current through every change a session goes through", () => {
  const branch = longBranch(200);
  const live = session(branch);
  const freshLine = () => session([...branch]).footer.render(200);
  let shown = live.footer.render(200);
  /** The footer after a change must match a fresh one, and differ from before, so a stale footer fails. */
  const check = (label: string) => {
    const expected = freshLine();
    assert.notDeepEqual(expected, shown, `${label} should change what the footer shows`);
    assert.deepEqual(live.footer.render(200), expected, `stale footer after ${label}`);
    shown = expected;
  };

  assert.deepEqual(shown, freshLine(), "start");
  // A streaming update appends nothing; the footer keeps what it showed.
  live.emit("message_update", { message: { role: "assistant" } });
  assert.deepEqual(live.footer.render(200), shown, "a streaming update changes nothing");
  // Every finished message, tool result, compaction, branch summary or custom entry moves the leaf.
  branch.push(assistant("tool-1", 0, 0, 0));
  live.emit("message_end", { message: { role: "toolResult" } });
  check("a tool result");
  branch.push(assistant("turn-2", 50, 100, 30_000));
  live.emit("turn_end", {});
  check("a turn that broke the cache");
  branch.push({ type: "compaction", id: "compact-1" });
  live.emit("session_compact", {});
  check("a compaction");
  branch.push({ type: "custom", id: "custom-1" });
  check("a custom entry that fires no event");
  // Navigating back to an earlier entry shortens the branch.
  branch.splice(150);
  live.emit("session_tree", {});
  check("tree navigation");
  // A model switch changes the window the context share is measured against.
  live.ctx.model = { ...live.ctx.model, id: "big-model", contextWindow: 1_000_000 };
  live.emit("model_select", {});
  const switched = live.footer.render(200).join("\n");
  assert.match(switched, /big-model/);
  assert.match(switched, /\/1\.0m/, "the context share is measured against the new model's window");
});
