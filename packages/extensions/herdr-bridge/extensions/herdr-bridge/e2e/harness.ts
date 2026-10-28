// What the end-to-end and contract runs share: a Herdr session of their own, a temporary Pi agent
// directory outside the repository, and helpers to start Pi in panes and read what happened.
//
// Nothing here touches the person's default Herdr session or writes under ~/.pi/agent: every
// Herdr command names this run's session, and every Pi runs with PI_CODING_AGENT_DIR pointing at
// the run's own directory. Installed packages are loaded read-only from where they are installed.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HerdrError, isShellNotReady } from "../herdr.ts";
import { WAKEUP_TYPE } from "../messages.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BRIDGE_EXTENSION = resolve(HERE, "..", "index.ts");
export const SCRIPTED_PROVIDER = join(HERE, "scripted-provider.ts");
export const RPIV_DIALOG = join(homedir(), ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-ask-user-question", "index.ts");

export class Failure extends Error {}

let passed = 0;
export function check(condition: unknown, what: string, detail?: unknown): void {
  if (!condition) {
    throw new Failure(`FAIL: ${what}${detail === undefined ? "" : `\n  got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
  passed++;
  console.log(`ok ${passed} - ${what}`);
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 30_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value as T;
    } catch (error) {
      last = error;
    }
    await sleep(everyMs);
  }
  throw new Failure(`FAIL: timed out after ${timeoutMs} ms waiting for ${what}${last ? `\n  last error: ${String(last)}` : ""}`);
}

export interface Agent {
  name?: string;
  agent?: string;
  agent_status: string;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd?: string;
  completion_seq?: number;
  agent_session?: { value?: string };
}

export interface RunOptions {
  /** Extension files or folders every Pi in this run loads, besides Herdr's integration. */
  extensions: string[];
  /** Extra settings for the run's agent directory. */
  settings?: Record<string, unknown>;
}

/** One run: its own Herdr session and agent directory, removed by {@link Run.close}. */
export class Run {
  readonly id = `hbe2e-${process.pid}-${Date.now().toString(36)}`;
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-bridge-e2e-")));
  readonly agentDir = join(this.root, "agent");
  private server?: ReturnType<typeof spawn>;

  constructor(readonly options: RunOptions) {}

  async open(): Promise<this> {
    mkdirSync(this.agentDir, { recursive: true });
    execFileSync("herdr", ["integration", "install", "pi"], { env: { ...process.env, PI_CODING_AGENT_DIR: this.agentDir }, stdio: "pipe" });
    const integration = join(this.agentDir, "extensions", "herdr-agent-state.ts");
    if (!existsSync(integration)) throw new Failure(`FAIL: Herdr did not install its Pi integration into ${this.agentDir}`);
    writeFileSync(
      join(this.agentDir, "settings.json"),
      JSON.stringify(
        {
          defaultProvider: "hbfake",
          defaultModel: "scripted",
          // Pi's built-in MCP is off in every run, and the MCP adapter is never loaded (see
          // installedExtensions): both reach MCP servers from global config and OAuth entries in the
          // operating system's credential store, which no check may touch.
          extensions: ["-builtin:mcp", ...this.options.extensions],
          quietStartup: true,
          enableInstallTelemetry: false,
          ...this.options.settings,
        },
        null,
        2,
      ),
    );
    this.server = spawn("herdr", ["--session", this.id, "server"], { stdio: "ignore", detached: false });
    await waitFor("this run's Herdr server", () => this.herdr(["workspace", "list"]), 20_000);
    return this;
  }

  /** A Herdr command in this run's session, parsed from JSON when it prints JSON. */
  herdr(args: string[]): any {
    const out = execFileSync("herdr", ["--session", this.id, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      return JSON.parse(out).result;
    } catch {
      return out;
    }
  }

  /** A Herdr command that is expected to fail; returns its error code. */
  herdrError(args: string[]): string | undefined {
    try {
      execFileSync("herdr", ["--session", this.id, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return undefined;
    } catch (error: any) {
      const text = String(error.stdout || error.stderr || "");
      try {
        return JSON.parse(text).error?.code ?? text;
      } catch {
        return text;
      }
    }
  }

  folder(name: string): string {
    const path = join(this.root, name);
    mkdirSync(path, { recursive: true });
    return realpathSync(path);
  }

  /** Starts Pi in a new workspace for `folder`, the way a person would by hand. */
  startPi(name: string, folder: string, env: Record<string, string> = {}, piArgs: string[] = []): Agent {
    const envArgs = Object.entries({ PI_CODING_AGENT_DIR: this.agentDir, ...env }).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const created = this.herdr(["workspace", "create", "--cwd", folder, "--label", name, "--no-focus", ...envArgs]);
    return this.startPiIn(name, created.root_pane.pane_id, piArgs);
  }

  /** Starts Pi in an existing shell pane, waiting for its shell to reach its prompt first. */
  startPiIn(name: string, paneId: string, piArgs: string[] = []): Agent {
    const args = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "90000", ...(piArgs.length ? ["--", ...piArgs] : [])];
    for (let attempt = 1; ; attempt++) {
      try {
        this.herdr(args);
        return this.waitIdleSync(name);
      } catch (error: any) {
        if (error instanceof Failure) throw error;
        const text = String(error.stdout || error.stderr || error.message);
        if (attempt >= 20 || !isShellNotReady(new HerdrError(text))) throw new Failure(`FAIL: herdr agent start ${name} failed: ${text}`);
        execFileSync("sleep", ["0.5"]);
      }
    }
  }

  /** Blocks until Herdr reports `name` idle or done, so typed input lands. */
  waitIdleSync(name: string, timeoutMs = 60_000): Agent {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const agent = this.agent(name);
      if (agent && agent.agent === "pi" && (agent.agent_status === "idle" || agent.agent_status === "done")) return agent;
      if (Date.now() > deadline) throw new Failure(`FAIL: ${name} never reported idle (last: ${agent?.agent_status})`);
      execFileSync("sleep", ["0.25"]);
    }
  }

  agents(): Agent[] {
    return this.herdr(["agent", "list"]).agents;
  }

  agent(name: string): Agent | undefined {
    return this.agents().find((a) => a.name === name);
  }

  status(name: string): string | undefined {
    return this.agent(name)?.agent_status;
  }

  /** Types `text` into `name` and returns once Herdr sees it start working (or stop at a question). */
  prompt(name: string, text: string): void {
    this.herdr(["agent", "prompt", name, text, "--wait", "--until", "working", "--until", "blocked", "--timeout", "20000"]);
  }

  screen(name: string): string {
    return this.herdr(["agent", "read", name, "--source", "visible", "--lines", "60"]);
  }

  close(): void {
    try {
      execFileSync("herdr", ["session", "stop", this.id], { stdio: "ignore" });
    } catch {}
    this.server?.kill("SIGTERM");
    try {
      execFileSync("herdr", ["session", "delete", this.id], { stdio: "ignore" });
    } catch {}
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** A Pi session file's entries. */
export function entries(sessionPath: string): any[] {
  if (!existsSync(sessionPath)) return [];
  return readFileSync(sessionPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => (part?.type === "text" ? part.text : "")).join("");
}

/** User-visible messages of a session, in order: user, assistant text, tool results and custom messages. */
export function transcript(sessionPath: string): { role: string; text: string; customType?: string }[] {
  return entries(sessionPath).flatMap((entry) => {
    if (entry.type === "message") return [{ role: entry.message.role, text: textOf(entry.message.content) }];
    if (entry.type === "custom_message") return [{ role: "custom", text: textOf(entry.content), customType: entry.customType }];
    return [];
  });
}

export function wakeups(sessionPath: string): string[] {
  return transcript(sessionPath)
    .filter((m) => m.role === "custom" && m.customType === WAKEUP_TYPE)
    .map((m) => m.text);
}

/**
 * Installed packages left out of every run, because they reach the person's live credentials
 * outside the run's agent directory: the MCP adapter connects to servers from the global MCP config
 * and reads and clears OAuth entries in the operating system's credential store; the web-access
 * package reads browser cookie keys from the credential store when used.
 */
export const LEFT_OUT = ["pi-mcp-adapter", "pi-web-access"];

/**
 * Installed packages whose source was read and reaches no credentials outside the run's agent
 * directory: what they read, such as auth.json, they resolve through PI_CODING_AGENT_DIR.
 */
export const CHECKED = [
  "@gotgenes/pi-subagents",
  "@juicesharp/rpiv-ask-user-question",
  "@juicesharp/rpiv-todo",
  "@amaster.ai/pi-image-gen",
  "github.com/doodledood/pi-plugins",
  "github.com/doodledood/manifest-dev",
];

/** Herdr's own Pi integration, which every run installs into its own agent directory. */
const HERDR_INTEGRATION = "herdr-agent-state.ts";

/**
 * Splits installed package sources and local extension files into those a run may load and those
 * it leaves out. Anything neither checked nor left out fails: a package installed later is read and
 * classified before any check loads it, so no run reaches credentials by accident.
 */
export function classifyInstalled(sources: readonly string[], localFiles: readonly string[]): { load: string[]; leftOut: string[] } {
  const load: string[] = [];
  const leftOut: string[] = [];
  const unknown: string[] = [];
  for (const source of sources) {
    if (LEFT_OUT.some((name) => source.includes(name))) leftOut.push(source);
    else if (CHECKED.some((name) => source.includes(name))) load.push(source);
    else unknown.push(source);
  }
  for (const file of localFiles) {
    if (file === HERDR_INTEGRATION) continue;
    unknown.push(`local extension ${file}`);
  }
  if (unknown.length) {
    throw new Failure(`FAIL: installed ${unknown.join(", ")} not classified; read its source, then add it to CHECKED or LEFT_OUT in e2e/harness.ts`);
  }
  return { load, leftOut };
}

/** The person's installed Pi extensions, as files Pi can load read-only from where they are, with the package sources left out. */
export function installedExtensions(): { paths: string[]; leftOut: string[] } {
  const agent = join(homedir(), ".pi", "agent");
  const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
  const entries: { source: string; excluded: Set<string> }[] = (settings.packages ?? []).map((entry: any) => ({
    source: typeof entry === "string" ? entry : entry.source,
    excluded: new Set<string>((typeof entry === "object" ? entry.extensions ?? [] : []).filter((e: string) => e.startsWith("-")).map((e: string) => e.slice(1))),
  }));
  const local = join(agent, "extensions");
  const localFiles = existsSync(local) ? readdirSync(local).filter((file) => statSync(join(local, file)).isFile() && /\.(ts|js)$/.test(file)) : [];
  const { load, leftOut } = classifyInstalled(
    entries.map((e) => e.source),
    localFiles,
  );
  const out: string[] = [];
  for (const { source, excluded } of entries) {
    if (!load.includes(source)) continue;
    let dir: string | undefined;
    if (source.startsWith("npm:")) dir = join(agent, "npm", "node_modules", source.slice(4).replace(/@[^/@]+$/, ""));
    else if (source.startsWith("git:")) dir = join(agent, "git", source.slice(4).replace(/@[^/]+$/, ""));
    if (!dir || !existsSync(join(dir, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const rel of manifest.pi?.extensions ?? []) {
      const clean = rel.replace(/^\.\//, "");
      if (excluded.has(clean)) continue;
      const path = join(dir, clean);
      if (existsSync(path)) out.push(path);
    }
  }
  return { paths: out, leftOut };
}
