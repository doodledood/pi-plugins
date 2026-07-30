import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createHqExtension, SEAT_MESSAGE_TYPE } from "./index.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { dropRoot, fixedClock, makeRoot, makeStore, packetDraftFixture, recordingSpawner } from "./testing.ts";
import { KIND_ENV, MANAGED_ENV, PACKET_ENV } from "./spawn.ts";
import { DRILL_TIER_ENV } from "./drills.ts";

interface Host {
  pi: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void> | void>;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  sentUserMessages: string[];
}

function fakeHost(): Host {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void> | void>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sentUserMessages: string[] = [];

  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
    ) => commands.set(name, options.handler),
    on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
    sendUserMessage: (content: string) => sentUserMessages.push(content),
    sendMessage: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;

  return { pi, tools, commands, handlers, sentUserMessages };
}

function fakeCommandCtx(overrides: { mode?: string; hasUI?: boolean } = {}) {
  const notifications: string[] = [];
  const confirms: string[] = [];
  const ctx = {
    mode: overrides.mode ?? "print",
    hasUI: overrides.hasUI ?? false,
    cwd: "/work/alpha",
    ui: {
      notify: (message: string) => notifications.push(message),
      confirm: async (title: string) => {
        confirms.push(title);
        return true;
      },
      input: async () => undefined,
      select: async () => undefined,
      custom: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "sess-seat",
      getSessionFile: () => "/tmp/sess-seat.jsonl",
      getLeafId: () => "leaf1",
      getBranch: () => [],
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, confirms };
}

async function activate(root: string) {
  const host = fakeHost();
  const { spawner, calls } = recordingSpawner();
  createHqExtension({
    stateRoot: root,
    config: { ...DEFAULT_CONFIG },
    spawner,
    now: fixedClock(),
  })(host.pi);
  return { host, calls };
}

test("the extension registers its commands and its tools", async () => {
  const root = await makeRoot("hq-wiring");
  try {
    const { host } = await activate(root);
    assert.deepEqual(
      [...host.commands.keys()].sort(),
      ["fleet", "hq", "hq_graduate", "hq_revoke", "hq_send_off", "hq_take_back"],
    );
    for (const name of [
      "hq_queue_plan",
      "hq_ask",
      "hq_drill",
      "hq_fleet",
      "hq_delegate",
      "hq_defect",
      "hq_audit",
      "hq_source_read",
      "hq_stop_context",
      "hq_triage_outcome",
      "hq_drill_context",
      "hq_drill_result",
      "hq_set_title",
    ]) {
      assert.equal(host.tools.has(name), true, `${name} is registered`);
    }
    for (const event of ["session_start", "agent_start", "agent_end", "agent_settled", "session_shutdown", "before_agent_start"]) {
      assert.equal(host.handlers.has(event), true, `${event} is hooked`);
    }
  } finally {
    await dropRoot(root);
  }
});

test("the seat's posture rides as a hidden message and never replaces the system prompt", async () => {
  const root = await makeRoot("hq-seat-prompt");
  try {
    const { host } = await activate(root);
    const { ctx } = fakeCommandCtx();

    // Before the seat is taken, no posture is injected.
    const before = await host.handlers.get("before_agent_start")?.(
      { type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.equal(before, undefined);

    await host.commands.get("hq")?.("", ctx);
    const injected = (await host.handlers.get("before_agent_start")?.(
      { type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    )) as { systemPrompt?: string; message?: { customType: string; content: string; display: boolean } } | undefined;

    assert.equal(injected?.systemPrompt, undefined, "the system prompt is left alone for cache stability");
    assert.equal(injected?.message?.customType, SEAT_MESSAGE_TYPE);
    assert.equal(injected?.message?.display, false);
    assert.match(injected?.message?.content ?? "", /chief of staff/);

    // Only once per activation.
    const second = await host.handlers.get("before_agent_start")?.(
      { type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.equal(second, undefined);
  } finally {
    await dropRoot(root);
  }
});

test("taking the seat seeds doctrine, sweeps stops, and kicks off a cycle", async () => {
  const root = await makeRoot("hq-seat-start");
  try {
    const { host } = await activate(root);
    const { ctx, notifications } = fakeCommandCtx();
    await host.commands.get("hq")?.("", ctx);
    assert.match(notifications.join("\n"), /HQ seat active/);
    assert.equal(host.sentUserMessages.length, 1);
    assert.match(host.sentUserMessages[0] ?? "", /queue is empty/);
  } finally {
    await dropRoot(root);
  }
});

test("/hq off hands the seat back", async () => {
  const root = await makeRoot("hq-seat-off");
  try {
    const { host } = await activate(root);
    const { ctx, notifications } = fakeCommandCtx();
    await host.commands.get("hq")?.("", ctx);
    await host.commands.get("hq")?.("off", ctx);
    assert.match(notifications.join("\n"), /seat released/);

    const injected = await host.handlers.get("before_agent_start")?.(
      { type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.equal(injected, undefined, "a released seat injects nothing");
  } finally {
    await dropRoot(root);
  }
});

test("a managed worker cannot take the seat", async () => {
  const root = await makeRoot("hq-seat-worker");
  const previous = process.env[MANAGED_ENV];
  process.env[MANAGED_ENV] = "1";
  try {
    const { host } = await activate(root);
    const { ctx, notifications } = fakeCommandCtx();
    await host.commands.get("hq")?.("", ctx);
    assert.match(notifications.join("\n"), /managed worker session/);
    assert.equal(host.sentUserMessages.length, 0);
  } finally {
    if (previous === undefined) delete process.env[MANAGED_ENV];
    else process.env[MANAGED_ENV] = previous;
    await dropRoot(root);
  }
});

test("the seat's tools refuse a session that has not taken the seat", async () => {
  const root = await makeRoot("hq-tool-guard");
  try {
    const { host } = await activate(root);
    const { ctx } = fakeCommandCtx();
    const plan = host.tools.get("hq_queue_plan");
    assert.ok(plan);
    const result = await plan.execute("call-1", {} as never, undefined, undefined, ctx as never);
    assert.match(
      result.content.map((part) => ("text" in part ? part.text : "")).join(" "),
      /seat is not active/,
    );
  } finally {
    await dropRoot(root);
  }
});

test("graduation asks for confirmation and only then grants the domain", async () => {
  const root = await makeRoot("hq-graduate-command");
  try {
    const { host } = await activate(root);
    const { ctx, notifications, confirms } = fakeCommandCtx();

    await host.commands.get("hq_graduate")?.("", ctx);
    assert.match(notifications.join("\n"), /Name the domain/);

    await host.commands.get("hq_graduate")?.("ci-flake", ctx);
    assert.equal(confirms.length, 1);
    assert.match(notifications.join("\n"), /Graduated ci-flake/);

    await host.commands.get("hq_revoke")?.("ci-flake", ctx);
    assert.match(notifications.join("\n"), /comes back to you/);
  } finally {
    await dropRoot(root);
  }
});

test("a resumed copy can report its answer without being told the packet id", async () => {
  // A tier-2 drill is a fork of the source session: it is asked a question and
  // never learns HQ's packet id, so the run's environment must supply it.
  const root = await makeRoot("hq-drill-env-packet");
  const previous = { ...process.env };
  try {
    const store = makeStore(root, fixedClock());
    await store.ensure();
    const { packet } = await store.createPacket(packetDraftFixture());

    const { host } = await activate(root);
    const { ctx } = fakeCommandCtx();
    process.env[MANAGED_ENV] = "1";
    process.env[KIND_ENV] = "drill";
    process.env[PACKET_ENV] = packet.id;
    process.env[DRILL_TIER_ENV] = "2";

    const submit = host.tools.get("hq_drill_result");
    assert.ok(submit);
    const result = await submit.execute(
      "call-1",
      {
        answer: "It picked normalizeInput because cleanInput did not say what cleaning meant.",
        quotes: [{ text: "normalizeInput", attribution: "sess-a (copy)" }],
      } as never,
      undefined,
      undefined,
      ctx as never,
    );
    assert.match(
      result.content.map((part) => ("text" in part ? part.text : "")).join(" "),
      new RegExp(`Recorded on packet ${packet.id}`),
    );

    const stored = await store.readPacket(packet.id);
    assert.equal(stored?.annotations.length, 1);
    assert.equal(stored?.annotations[0]?.tier, 2);
  } finally {
    for (const key of [MANAGED_ENV, KIND_ENV, PACKET_ENV, DRILL_TIER_ENV]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await dropRoot(root);
  }
});

test("worker tools refuse a session that is not that kind of worker", async () => {
  const root = await makeRoot("hq-worker-guard");
  try {
    const { host } = await activate(root);
    const { ctx } = fakeCommandCtx();
    for (const name of ["hq_stop_context", "hq_drill_context", "hq_set_title"]) {
      const tool = host.tools.get(name);
      assert.ok(tool);
      const result = await tool.execute(
        "call-1",
        { stopId: "s", packetId: "p", sessionId: "x", title: "t" } as never,
        undefined,
        undefined,
        ctx as never,
      );
      const body = result.content.map((part) => ("text" in part ? part.text : "")).join(" ");
      assert.match(body, /Refused/, `${name} refuses the wrong caller`);
    }
  } finally {
    await dropRoot(root);
  }
});

test("a fresh seat over the same state sees exactly the same packets to rule", async () => {
  const root = await makeRoot("hq-seat-restart");
  try {
    // Two packets seeded the way triage would, before any seat exists.
    const { makeStore, packetDraftFixture } = await import("./testing.ts");
    const store = makeStore(root);
    await store.ensure();
    const first = await store.createPacket(packetDraftFixture());
    const second = await store.createPacket(
      // A different session: one session has at most one open decision.
      packetDraftFixture({
        title: "raise the CI timeout",
        domain: "ci-config",
        sourceSessionId: "sess-b",
      }),
    );
    assert.equal(first.packet.status, "pending");
    assert.equal(second.packet.status, "pending");

    const before = await activate(root);
    const firstCtx = fakeCommandCtx();
    await before.host.commands.get("hq")?.("", firstCtx.ctx);
    const firstPlan = await runPlan(before.host, firstCtx.ctx);
    assert.match(firstCtx.notifications.join("\n"), /2 packets to rule/);

    // The seat dies mid-queue: shutdown, then a completely fresh extension instance.
    await before.host.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, firstCtx.ctx);

    const after = await activate(root);
    const secondCtx = fakeCommandCtx();
    await after.host.commands.get("hq")?.("", secondCtx.ctx);
    const secondPlan = await runPlan(after.host, secondCtx.ctx);

    assert.match(secondCtx.notifications.join("\n"), /2 packets to rule/);
    assert.deepEqual(
      idsIn(secondPlan),
      idsIn(firstPlan),
      "a restarted seat re-derives the identical pending set from disk",
    );
    assert.deepEqual(idsIn(secondPlan).sort(), [first.packet.id, second.packet.id].sort());
  } finally {
    await dropRoot(root);
  }
});

async function runPlan(host: Host, ctx: ExtensionCommandContext): Promise<string> {
  const tool = host.tools.get("hq_queue_plan");
  assert.ok(tool);
  const result = await tool.execute("call", {} as never, undefined, undefined, ctx as never);
  return result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
}

function idsIn(plan: string): string[] {
  return [...plan.matchAll(/\b(pkt-[A-Za-z0-9-]+)\b/g)].map((match) => match[1] ?? "");
}
