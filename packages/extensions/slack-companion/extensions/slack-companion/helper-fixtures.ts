// Shared by helper.test.ts and shell.test.ts: a helper run in a real fork, a home folder of the
// test's own, and the real shell sandbox. Not a test file itself.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import type { SessionEntry, Skill } from "@earendil-works/pi-coding-agent";
import { selectForkBranch } from "./fork.ts";
import { runHelper, type HelperBatch, type HelperEnvironment } from "./helper.ts";
import { helperMcpTools, mcpCachePathIn, readMcpCache } from "./mcp-tools.ts";
import { createHarness, type Harness, textOf, type Reply } from "./pi-harness.ts";
import { NO_SHELL_ON_LINUX, startShellSandbox, type ShellSandbox } from "./sandbox.ts";
import { readPolicy } from "./secrets.ts";

export const batch: HelperBatch = {
  conversationLabel: "DM with Robin Colleague",
  ownerName: "Dana Owner",
  inChannel: false,
  context: [],
  messages: [{ ts: "1793700100.000001", userId: "U0COLL0001", userName: "Robin Colleague", text: "can you check?", agentFooter: false }],
  waitingApprovals: [],
  requestRoom: 1,
};

/** A home folder of the test's own, with a key in ~/.ssh and an OAuth token under the agent folder. */
export function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "helper-home-"));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE-KEY-CONTENT");
  mkdirSync(join(home, ".pi", "agent", "mcp-oauth"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "mcp-oauth", "tokens.json"), "OAUTH-TOKEN-CONTENT");
  return home;
}

export const realSandbox = (cwd: string, home: string) => startShellSandbox({ cwd, allowedDomains: [], home, agentDir: join(home, ".pi", "agent") });
export const noShell = async (): Promise<ShellSandbox> => ({ ok: false, reason: "this test uses no shell" });

/**
 * Whether a real shell scenario can run here. On Linux the helper has no shell by decision
 * (docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md): the scenario then checks
 * exactly that and ends, which is a pass, not a skip. Elsewhere it skips only where sandbox-runtime
 * does not support the platform; anywhere else, a shell that did not start is a failure.
 */
export async function shellRunsHere(t: { skip(message?: string): void; diagnostic(message: string): void }, probe: ShellSandbox): Promise<boolean> {
  if (probe.ok) return true;
  if (probe.reason === NO_SHELL_ON_LINUX) {
    assert.equal(process.platform, "linux", "only Linux refuses the shell by decision");
    t.diagnostic(`no shell on Linux, as decided: ${probe.reason}`);
    return false;
  }
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  if (SandboxManager.isSupportedPlatform()) assert.fail(`sandbox-runtime supports this platform but did not start: ${probe.reason}`);
  t.skip(`sandbox-runtime does not support this platform: ${probe.reason}`);
  return false;
}

export type Step = Reply | ((context: Context) => Reply);

export async function helperRun(steps: Step[], options: { home?: string; sandbox?: (cwd: string, home: string) => Promise<ShellSandbox>; signal?: AbortSignal; skills?: (agentDir: string) => Skill[]; prepare?: (h: Harness) => void } = {}) {
  const queue = [...steps];
  const h = await createHarness({
    replies: (c, role) => {
      if (role !== "helper") return { kind: "text", text: "ok" };
      const next = queue.shift() ?? { kind: "text", text: "done" };
      return typeof next === "function" ? next(c) : next;
    },
  });
  options.prepare?.(h);
  await h.session.prompt("hello");
  const home = options.home ?? fakeHome();
  writeFileSync(join(h.workspace, ".env"), "TOKEN=secret-value");
  writeFileSync(join(h.workspace, "config.ts"), "line one\nline two\n");
  const handlerRunsBefore = h.foreign.handlerRuns;
  // An extension the owner installed globally: the helper must not load it.
  mkdirSync(join(h.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(h.agentDir, "extensions", "installed-elsewhere.ts"), [
    'import { writeFileSync } from "node:fs";',
    "export default function (pi: any) {",
    `  writeFileSync(${JSON.stringify(join(h.agentDir, "installed-factory-ran"))}, "yes");`,
    `  pi.on("before_agent_start", () => writeFileSync(${JSON.stringify(join(h.agentDir, "installed-ran"))}, "yes"));`,
    '  pi.registerTool({ name: "installed_tool", label: "installed", description: "installed", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "installed" }], details: {} }; } });',
    "}",
  ].join("\n"));
  const env: HelperEnvironment = {
    cwd: h.workspace,
    agentDir: h.agentDir,
    model: h.session.model!,
    thinkingLevel: "off",
    streamSimple: (m, c, o) => h.registry.streamSimple(m, c, o),
    branch: selectForkBranch(h.session.sessionManager.getBranch() as SessionEntry[], true),
    systemPromptOptions: { cwd: h.workspace, ...(options.skills ? { skills: options.skills(h.agentDir) } : {}) },
    events: h.events,
    mcpTools: helperMcpTools(readMcpCache(mcpCachePathIn(h.agentDir)), new Set(h.session.getActiveToolNames()), [], { blocked: ["slack_send_message"] }),
    // No shell unless a test uses one: a real sandbox costs time on every run.
    sandbox: await (options.sandbox ?? noShell)(h.workspace, home),
    reads: readPolicy({ home, agentDir: join(home, ".pi", "agent"), roots: [h.workspace] }),
  };
  const outcome = await runHelper(env, batch, options.signal).finally(async () => {
    if (env.sandbox.ok) await env.sandbox.dispose(); // no scratch folder outlives the test
  });
  const results = outcome.ownEntries
    .filter((e: any) => e.type === "message" && e.message.role === "toolResult")
    .map((e: any) => ({ tool: e.message.toolName as string, isError: e.message.isError as boolean, text: textOf(e.message.content) }));
  return { h, outcome, results, home, handlerRunsBefore };
}


export async function runInShell(t: any, cwd: string, home: string, command: string, agentDir = join(home, ".pi", "agent")): Promise<string | undefined> {
  const sandbox = await startShellSandbox({ cwd, allowedDomains: [], home, agentDir });
  if (!(await shellRunsHere(t, sandbox)) || !sandbox.ok) return undefined;
  t.after(() => sandbox.dispose());
  let out = "";
  await sandbox.operations.exec(command, cwd, { onData: (d) => { out += d.toString(); }, env: process.env });
  return out;
}
