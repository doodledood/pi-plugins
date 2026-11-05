// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md (secret locations),
// docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md (no shell on Linux) and
// docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md (secret-shaped replies).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { denyReadEntries, NO_SHELL_ON_LINUX, startShellSandbox } from "./sandbox.ts";
import { defaultSecretPolicy, filterSecretLines, findSecretShape, isSecretPath, sanitizeEnv, stripControl, walksIntoSecrets } from "./secrets.ts";

function home() {
  const root = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(root, ".ssh"));
  writeFileSync(join(root, ".ssh", "id_ed25519"), "key");
  mkdirSync(join(root, "project"));
  writeFileSync(join(root, "project", ".env"), "TOKEN=x");
  writeFileSync(join(root, "project", "app.ts"), "code");
  symlinkSync(join(root, ".ssh", "id_ed25519"), join(root, "project", "innocent.txt"));
  mkdirSync(join(root, ".pi", "agent", "mcp-oauth"), { recursive: true });
  writeFileSync(join(root, ".pi", "agent", "mcp-oauth", "tokens.json"), "{}");
  return { root, policy: defaultSecretPolicy(join(root, ".pi", "agent"), root) };
}

test("secret folders, secret file names and symlinks into them are secret; project code is not", () => {
  const { root, policy } = home();
  const cwd = join(root, "project");
  assert.equal(isSecretPath(policy, cwd, join(root, ".ssh", "id_ed25519")), true);
  assert.equal(isSecretPath(policy, cwd, ".env"), true);
  assert.equal(isSecretPath(policy, cwd, "innocent.txt"), true, "a symlink is judged by where it leads");
  assert.equal(isSecretPath(policy, cwd, "app.ts"), false);
  assert.equal(walksIntoSecrets(policy, cwd, root), true, "searching the home folder would walk into ~/.ssh");
  assert.equal(walksIntoSecrets(policy, cwd, "."), false);
});

test("every spelling Pi's tools accept for a secret path is caught: ~, @, file:// and unicode spaces", () => {
  const { root, policy } = home();
  const cwd = join(root, "project");
  for (const spelling of [
    "~/.ssh/id_ed25519",
    "@~/.ssh/id_ed25519",
    "~/.pi/agent/mcp-oauth/tokens.json",
    `@${join(root, ".ssh", "id_ed25519")}`,
    pathToFileURL(join(root, ".ssh", "id_ed25519")).href,
    `@${pathToFileURL(join(root, ".aws", "credentials")).href}`,
    "@.env",
    "~/.ssh",
    "../.ssh/id_ed25519",
    "~/.pi/agent/mcp-adapter.json",
  ]) assert.equal(isSecretPath(policy, cwd, spelling), true, spelling);
  for (const spelling of ["~", "@~", "~/.pi", pathToFileURL(root).href]) assert.equal(walksIntoSecrets(policy, cwd, spelling), true, spelling);
  for (const path of ["/proc/self/environ", "~/.config/gh/hosts.yml", "~/.git-credentials", "~/.zsh_history", "~/.pi/agent/auth.json.bak-openai1m", "~/.pi/agent/mcp.json.2026-11-01.bak", ".env.local", "credentials.json~", "~/.pi/agent/mcp-auth.json", "~/.pi/agent/mcp-auth.json.bak", ".mcp.json", "~/.claude/.credentials.json"]) assert.equal(isSecretPath(policy, cwd, path), true, path);
  for (const path of ["credentials.ts", "environment.md", "authorization.json"]) assert.equal(isSecretPath(policy, cwd, path), false, `${path} is ordinary code`);
  assert.equal(isSecretPath(policy, cwd, "@app.ts"), false);
});

test("the shell sandbox denies every secret folder, and secret file names at any depth from the root", () => {
  const { root, policy } = home();
  const entries = denyReadEntries({ cwd: join(root, "project"), home: root, agentDir: join(root, ".pi", "agent"), allowedDomains: [] });
  for (const dir of policy.directories.filter((d) => d !== "/proc")) assert.ok(entries.includes(dir), `${dir} is denied`);
  assert.equal(entries.includes("/proc"), false, "/proc is for the file tools only");
  for (const name of [".env*", "auth.json*", ".git-credentials*", ".*_history"]) assert.ok(entries.includes(`/**/${name}`), `${name} anywhere`);
  assert.ok(entries.includes(join(root, ".pi", "agent")), "Pi's agent folder, closed whole");
  for (const name of [".env*", "auth.json*", ".netrc*", ".npmrc*", "credentials", "id_ed25519*", "mcp.json*", "mcp-adapter.json*"]) {
    assert.ok(entries.includes(`${root}/**/${name}`), `${name} is denied under the home`);
    assert.ok(entries.includes(`${join(root, "project")}/**/${name}`), `${name} is denied under the project`);
  }
  assert.ok(entries.every((e) => typeof e === "string" && e.startsWith("/")), "every entry is anchored; bare globs do not match on macOS");
});

test("a sandboxed command sees no credential variables, and the owner sees no control sequences", () => {
  const env = sanitizeEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "y", OPENAI_API_KEY: "z", SLACK_COOKIE: "c" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
  assert.equal(stripControl("ok\u001b[2J\u001b]0;title\u0007 done\u0000"), "ok done");
});

test("output lines naming secret files are dropped", () => {
  const { root, policy } = home();
  const cwd = join(root, "project");
  const grepOut = ["app.ts:1: code", ".env:1: TOKEN=x", ".env-2- SECRET=y", "release-2-notes.md-3- text", "sub/.env.local-4- K=v", "README.md-2- text"].join("\n");
  assert.equal(filterSecretLines(policy, cwd, ".", grepOut), ["app.ts:1: code", "release-2-notes.md-3- text", "README.md-2- text"].join("\n"), "match and context lines alike");
  assert.equal(filterSecretLines(policy, cwd, ".", "app.ts\n.env\ninnocent.txt\nsrc/"), "app.ts\nsrc/", "bare paths from find and ls");
});

test("common credential shapes are recognized; ordinary text is not", () => {
  assert.equal(findSecretShape("key AKIAABCDEFGHIJKLMNOP here"), "AWS access key");
  assert.equal(findSecretShape(`ghp_${"a".repeat(36)}`), "GitHub token");
  assert.equal(findSecretShape("xoxb-123456789012-abcdef"), "Slack token");
  assert.equal(findSecretShape("-----BEGIN OPENSSH PRIVATE KEY-----"), "private key block");
  assert.equal(findSecretShape("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123"), "bearer token");
  assert.equal(findSecretShape(`sk-${"x".repeat(30)}`), "API key");
  assert.equal(findSecretShape("The pass rate moved from 77% to 81%."), undefined);
});

test("on Linux the helper gets no shell, and says why; no sandbox starts", async () => {
  const { root } = home();
  const configs: unknown[] = [];
  const runtime = { isSupportedPlatform: () => true, initialize: async (c: unknown) => { configs.push(c); }, updateConfig: (c: unknown) => { configs.push(c); }, wrapWithSandbox: async (c: string) => c };
  const started = await startShellSandbox({ cwd: join(root, "project"), allowedDomains: [], home: root, agentDir: join(root, ".pi", "agent"), platform: "linux" }, runtime as any);
  assert.deepEqual(started, { ok: false, reason: NO_SHELL_ON_LINUX });
  assert.equal(configs.length, 0);
});

test("every MCP config pi-mcp-adapter imports servers from, and every agent harness's config folder, is secret", () => {
  const { root, policy } = home();
  const cwd = join(root, "project");
  // pi-mcp-adapter 7.0.1, config.ts: its own configs and every import source (IMPORT_PATHS).
  const adapterSources = [
    "~/.config/mcp/mcp.json", "~/.agents/mcp.json", "~/.agents/mcp/mcp.json", ".mcp.json", ".pi/mcp.json", "~/.pi/agent/mcp.json", "~/.pi/agent/mcp-adapter.json",
    "~/.cursor/mcp.json", "~/.claude/mcp.json", "~/.claude.json", "~/.claude/claude_desktop_config.json",
    "~/Library/Application Support/Claude/claude_desktop_config.json", "~/.codex/config.toml", "~/.codex/config.json",
    "~/.config/opencode/opencode.json", "opencode.json", "~/.windsurf/mcp.json", ".vscode/mcp.json",
  ];
  for (const path of adapterSources) assert.equal(isSecretPath(policy, cwd, path), true, path);
  for (const path of ["~/.pi/agent/models.json", "~/.pi/agent/settings.json", "~/.claude/settings.json", "~/.gemini/settings.json", "~/.claude.json.backup"]) assert.equal(isSecretPath(policy, cwd, path), true, path);
});
