// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md (secret locations),
// docs/adr/20261104-find-the-shells-secret-files-once-per-helper-run-on-linux.md (the Linux walk) and
// docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md (secret-shaped replies).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { denyReadEntries, findSecretFiles, SECRET_WALK_MS, startShellSandbox } from "./sandbox.ts";
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
  // Linux: literal paths only, so bubblewrap walks nothing per command.
  const linux = denyReadEntries({ cwd: join(root, "project"), home: root, agentDir: join(root, ".pi", "agent"), allowedDomains: [], platform: "linux", linuxSecretFiles: [join(root, "project", ".env")] });
  const paths = linux.map((e) => (typeof e === "string" ? e : e.literal ? e.path : ""));
  assert.ok(paths.includes(join(root, "project", ".env")) && paths.includes(join(root, ".pi", "agent", "mcp-auth.json")));
  assert.equal(linux.some((e) => typeof e === "string"), false, "every Linux entry is marked literal: no pattern, no per-command walk");
  assert.ok(entries.includes(join(root, ".pi", "agent", "auth.json")), "the agent folder's auth file, named outright");
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

test("on Linux the secret files are found once, by a walk that skips installed packages and gives up loudly when slow", async () => {
  const { root } = home();
  const project = join(root, "project");
  mkdirSync(join(project, "deep", "er"), { recursive: true });
  writeFileSync(join(project, "deep", "er", ".env.production"), "x");
  mkdirSync(join(project, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(project, "node_modules", "pkg", ".env"), "x");
  mkdirSync(join(root, "other", "a", "b", "c"), { recursive: true });
  writeFileSync(join(root, "other", "a", ".env"), "x"); // depth 3 from the home: found
  writeFileSync(join(root, "other", "a", "b", "c", ".env"), "x"); // depth 5: past the home's depth
  const found = findSecretFiles([{ dir: project }, { dir: root, depth: 4 }], Date.now() + 5000);
  assert.equal(found.complete, true);
  assert.ok(found.files.includes(join(project, "deep", "er", ".env.production")), "the project is walked whole, though it sits in the home");
  assert.ok(found.files.includes(join(root, "other", "a", ".env")));
  assert.equal(found.files.includes(join(root, "other", "a", "b", "c", ".env")), false);
  assert.equal(found.files.some((f) => f.includes("node_modules")), false);
  let clock = 0;
  assert.equal(findSecretFiles([{ dir: project }], 1, () => (clock += 2)).complete, false, "past the deadline: incomplete");
  const configs: unknown[] = [];
  const runtime = { isSupportedPlatform: () => true, initialize: async (c: unknown) => { configs.push(c); }, updateConfig: (c: unknown) => { configs.push(c); }, wrapWithSandbox: async (c: string) => c };
  const started = await startShellSandbox({ cwd: project, allowedDomains: [], home: root, agentDir: join(root, ".pi", "agent"), platform: "linux" }, runtime as any);
  assert.equal(started.ok, true);
  const denyRead = ((configs.at(-1) as any).filesystem.denyRead as Array<{ path: string }>).map((e) => e.path);
  assert.ok(denyRead.includes(join(project, "deep", "er", ".env.production")) && denyRead.includes(join(project, ".env")));
  if (started.ok) await started.dispose();
  // A walk that runs out of time leaves the helper without a shell, saying why; no sandbox starts.
  let tick = 0;
  const before = configs.length;
  const slow = await startShellSandbox({ cwd: project, allowedDomains: [], home: root, agentDir: join(root, ".pi", "agent"), platform: "linux", now: () => (tick += SECRET_WALK_MS) }, runtime as any);
  assert.equal(slow.ok, false);
  if (!slow.ok) assert.match(slow.reason, /too large to check quickly/);
  assert.equal(configs.length, before);
});
