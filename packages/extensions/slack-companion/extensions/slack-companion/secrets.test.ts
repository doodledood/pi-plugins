// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md (secret locations),
// docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md (no shell on Linux),
// docs/adr/20261104-close-the-home-folder-to-the-slack-helper.md (the closed home) and
// docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md (secret-shaped replies).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { denyReadEntries, NO_SHELL_ON_LINUX, startShellSandbox } from "./sandbox.ts";
import { canonicalPath, filterUnreadableLines, findSecretShape, isReadablePath, openedFolders, readableRoots, readPolicy, type ReadPolicy, sanitizeEnv, secretDirectories, skillFolder, stripControl } from "./secrets.ts";

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
  const agentDir = join(root, ".pi", "agent");
  return { root, agentDir, policy: readPolicy({ home: root, agentDir, roots: [join(root, "project")] }) };
}

const closed = (policy: ReadPolicy, cwd: string, path: string) => !isReadablePath(policy, cwd, path);

test("the file tools read only the project; secret names, symlinks out of it and the rest of the home are closed", () => {
  const { root, policy } = home();
  const cwd = join(root, "project");
  assert.equal(closed(policy, cwd, "app.ts"), false);
  assert.equal(closed(policy, cwd, "@app.ts"), false);
  assert.equal(closed(policy, cwd, pathToFileURL(join(cwd, "app.ts")).href), false);
  assert.equal(closed(policy, cwd, ".env"), true);
  assert.equal(closed(policy, cwd, "innocent.txt"), true, "a symlink is judged by where it leads");
  for (const path of [join(root, ".ssh", "id_ed25519"), "~/.ssh/id_ed25519", "@~/.ssh/id_ed25519", "~/.pi/agent/mcp-oauth/tokens.json", "../.ssh/id_ed25519", "~", "~/notes.txt", "/proc/self/environ", "/dev/fd/0", tmpdir()]) {
    assert.equal(closed(policy, cwd, path), true, path);
  }
  for (const name of [".env.local", "credentials.json~", ".mcp.json", ".git-credentials", ".zsh_history", "auth.json.bak", "mcp-auth.json"]) assert.equal(closed(policy, cwd, name), true, name);
  for (const name of ["credentials.ts", "environment.md", "authorization.json"]) assert.equal(closed(policy, cwd, name), false, `${name} is ordinary code`);
});

test("another spelling of a path is closed, not missed: case, the data volume, a secret name in capitals", () => {
  const { root, policy } = home();
  const cwd = join(root, "project");
  writeFileSync(join(cwd, "AUTH.JSON"), "x");
  for (const path of [".ENV", "AUTH.JSON", "Credentials.Json", join(root.toUpperCase(), ".ssh", "id_ed25519"), join("/System/Volumes/Data", root, ".ssh", "id_ed25519")]) {
    assert.equal(closed(policy, cwd, path), true, path);
  }
  // The data-volume spelling of a project file is that same file, so it reads (on macOS, where it exists).
  if (process.platform === "darwin") assert.equal(closed(policy, cwd, join("/System/Volumes/Data", canonicalPath(cwd), "app.ts")), false);
  // On a case-insensitive disk, the project's own files read in any case; the check uses the stored spelling.
  if (process.platform === "darwin") assert.equal(closed(policy, cwd, join(cwd.toUpperCase(), "APP.TS")), false);
});

test("the folders that open the home: never the home, a folder holding it, a secret folder or one inside it", () => {
  const { root, agentDir } = home();
  mkdirSync(join(root, ".config", "gcloud"), { recursive: true });
  writeFileSync(join(root, ".config", "gcloud", "adc.json"), "x");
  writeFileSync(join(root, ".config", "notes.txt"), "x");
  mkdirSync(join(root, "repo", "credentials"), { recursive: true });
  const roots = readableRoots(root, [root, "/", agentDir, join(agentDir, "skills"), join(root, ".aws"), join(root, "repo", "credentials"), join(root, "repo")], agentDir);
  assert.deepEqual(roots, [canonicalPath(join(root, "repo"))]);
  // A folder the owner opens that holds a secret folder: the secret folder stays closed.
  const policy = readPolicy({ home: root, agentDir, roots: [join(root, "project"), join(root, ".config")] });
  assert.equal(closed(policy, root, "~/.config/notes.txt"), false);
  for (const path of ["~/.config/gcloud/adc.json", "~/.config/gh/hosts.yml", "~/.config/opencode/x.txt", "~/.config/mcp/servers.toml"]) assert.equal(closed(policy, root, path), true, path);
  const library = readPolicy({ home: root, agentDir, roots: [join(root, "Library")] });
  assert.equal(closed(library, root, "~/Library/Application Support/Claude/Cookies"), true);
});

test("exact files open: a loose skill file and a result the helper's own call saved, nothing beside them", () => {
  const { root, agentDir } = home();
  const skill = join(agentDir, "skills", "notes", "SKILL.md");
  mkdirSync(join(agentDir, "skills", "notes"), { recursive: true });
  writeFileSync(skill, "x");
  writeFileSync(join(agentDir, "skills", "notes", "other.md"), "x");
  const policy = readPolicy({ home: root, agentDir, roots: [join(root, "project")], files: [skill] });
  assert.equal(closed(policy, root, skill), false);
  assert.equal(closed(policy, root, join(agentDir, "skills", "notes", "other.md")), true);
  assert.equal(closed(policy, root, join(agentDir, "models.json")), true);
});

test("the shell sandbox denies every secret folder, and secret file names at any depth from the root", () => {
  const { root, agentDir } = home();
  const entries = denyReadEntries({ cwd: join(root, "project"), home: root, agentDir, allowedDomains: [] });
  for (const dir of secretDirectories(root, agentDir)) assert.ok(entries.includes(dir), `${dir} is denied`);
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

test("output lines naming what the helper may not read are dropped; other text stays", () => {
  const { root, policy } = home();
  const cwd = join(root, "project");
  writeFileSync(join(cwd, "release-2-notes.md"), "x");
  writeFileSync(join(cwd, "README.md"), "x");
  const grepOut = ["app.ts:1: code", ".env:1: TOKEN=x", ".env-2- SECRET=y", "release-2-notes.md-3- text", "innocent.txt:1: key", "README.md-2- text", "No more matches"].join("\n");
  assert.equal(filterUnreadableLines(policy, cwd, ".", grepOut), ["app.ts:1: code", "release-2-notes.md-3- text", "README.md-2- text", "No more matches"].join("\n"), "match and context lines alike");
  assert.equal(filterUnreadableLines(policy, cwd, ".", "app.ts\n.env\ninnocent.txt"), "app.ts", "bare paths from find and ls");
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
  const { root, agentDir } = home();
  const cwd = join(root, "project");
  // Closed even when the owner opens the folders holding them (the home's dot-folders, ~/Library) and the project.
  const policy = readPolicy({ home: root, agentDir, roots: [cwd, join(root, ".config"), join(root, "Library"), join(root, ".agents"), join(root, ".vscode")] });
  // pi-mcp-adapter 7.0.1, config.ts: its own configs and every import source (IMPORT_PATHS).
  const adapterSources = [
    "~/.config/mcp/mcp.json", "~/.agents/mcp.json", "~/.agents/mcp/mcp.json", ".mcp.json", ".pi/mcp.json", "~/.pi/agent/mcp.json", "~/.pi/agent/mcp-adapter.json",
    "~/.cursor/mcp.json", "~/.claude/mcp.json", "~/.claude.json", "~/.claude/claude_desktop_config.json",
    "~/Library/Application Support/Claude/claude_desktop_config.json", "~/.codex/config.toml", "~/.codex/config.json",
    "~/.config/opencode/opencode.json", "opencode.json", "~/.windsurf/mcp.json", ".vscode/mcp.json",
  ];
  for (const path of adapterSources) assert.equal(closed(policy, cwd, path), true, path);
  // Each harness folder is closed whole: files whose names match no secret pattern, one per folder.
  for (const path of [
    "~/.pi/agent/models.json", "~/.pi/agent/settings.json", "~/.claude/settings.json", "~/.codex/history.jsonl", "~/.cursor/cli-config.json",
    "~/.gemini/oauth_creds.txt", "~/.windsurf/settings.json", "~/.config/opencode/auth-notes.txt", "~/.config/mcp/servers.toml",
    "~/Library/Application Support/Claude/Cookies", "~/.claude.json.backup",
  ]) assert.equal(closed(policy, cwd, path), true, path);
});

test("a skill opens its own folder, never the home, a folder holding it or one holding a secret folder", () => {
  const { root, agentDir } = home();
  const policy = readPolicy({ home: root, agentDir, roots: [join(root, "project")] });
  const inAgent = join(agentDir, "git", "pkg", "skills", "notes");
  mkdirSync(inAgent, { recursive: true });
  assert.equal(skillFolder(policy, join(inAgent, "SKILL.md")), canonicalPath(inAgent), "a folder skill in Pi's agent folder");
  assert.equal(skillFolder(policy, join(root, "SKILL.md")), undefined, "a SKILL.md at the home's top opens only itself");
  assert.equal(skillFolder(policy, join(agentDir, "SKILL.md")), undefined, "nor Pi's agent folder");
  assert.equal(skillFolder(policy, join(root, ".pi", "SKILL.md")), undefined, "nor a folder holding a secret folder");
  assert.equal(skillFolder(policy, join(inAgent, "handy.md")), undefined, "a loose skill file opens only itself");
  mkdirSync(join(root, ".agents"), { recursive: true });
  assert.equal(skillFolder(policy, join(root, ".agents", "SKILL.md")), undefined, "nor a home dot-folder holding a SKILL.md directly");
  const source = join(root, "dev", "skills-src", "linked");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "x");
  mkdirSync(join(agentDir, "skills", "linked"), { recursive: true });
  symlinkSync(join(source, "SKILL.md"), join(agentDir, "skills", "linked", "SKILL.md"));
  assert.equal(skillFolder(policy, join(agentDir, "skills", "linked", "SKILL.md")), canonicalPath(source), "a linked SKILL.md opens where it leads");
});

test("a repository opens its folders only when its top folder could be opened: never a dotfiles repository at ~ or in ~/.config", () => {
  const { root, agentDir } = home();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "ignore" });
  git(root, "init", "-q");
  mkdirSync(join(root, "scratch-project"));
  assert.deepEqual(openedFolders({ home: root, agentDir, cwd: join(root, "scratch-project"), readable: [] }), [canonicalPath(join(root, "scratch-project"))], "the home's .git is not opened");
  mkdirSync(join(root, ".config", "nvim"), { recursive: true });
  git(join(root, ".config"), "init", "-q");
  assert.deepEqual(openedFolders({ home: root, agentDir, cwd: join(root, ".config", "nvim"), readable: [] }), [canonicalPath(join(root, ".config", "nvim"))], "a dot-folder repository opens only the project");
  const repo = join(root, "code", "app");
  mkdirSync(join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q");
  const opened = openedFolders({ home: root, agentDir, cwd: join(repo, "sub"), readable: [] });
  assert.ok(opened.includes(canonicalPath(repo)), "a subfolder's repository top is opened");
  // A worktree of a bare repository opens the bare folder; a bare dotfiles repository does not.
  const bare = join(root, "code", "proj.git");
  git(join(root, "code"), "init", "-q", "--bare", bare);
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "c");
  git(repo, "push", "-q", bare, "HEAD:main");
  git(bare, "worktree", "add", "-q", join(root, "code", "proj-wt"), "main");
  assert.ok(openedFolders({ home: root, agentDir, cwd: join(root, "code", "proj-wt"), readable: [] }).includes(canonicalPath(bare)));
  const dotBare = join(root, ".dotfiles");
  git(root, "init", "-q", "--bare", dotBare);
  git(dotBare, "worktree", "add", "-q", join(root, "code", "dots-wt"));
  assert.equal(openedFolders({ home: root, agentDir, cwd: join(root, "code", "dots-wt"), readable: [] }).includes(canonicalPath(dotBare)), false);
});

test("a folder whose name begins like an open one is not inside it; a folder named like a secret closes its contents", () => {
  const { root, agentDir } = home();
  const app = join(root, "code", "app");
  mkdirSync(join(app, "credentials"), { recursive: true });
  mkdirSync(join(app, ".env.d"), { recursive: true });
  mkdirSync(join(app, "creds"), { recursive: true });
  mkdirSync(join(root, "code", "app-secrets"), { recursive: true });
  for (const [path, body] of [[join(app, "credentials", "prod.key"), "k"], [join(app, ".env.d", "prod"), "k"], [join(app, "creds", "notes.md"), "n"], [join(root, "code", "app-secrets", "x"), "s"]] as const) writeFileSync(path, body);
  const policy = readPolicy({ home: root, agentDir, roots: [app] });
  assert.equal(closed(policy, app, "../app-secrets/x"), true, "a sibling sharing the project's name as a prefix");
  assert.equal(closed(policy, app, "credentials/prod.key"), true);
  assert.equal(closed(policy, app, ".env.d/prod"), true);
  assert.equal(closed(policy, app, "creds/notes.md"), false);
});

test("a folder listed in another spelling of the home (the data volume) does not open the home", () => {
  if (process.platform !== "darwin") return;
  const { root, agentDir } = home();
  assert.deepEqual(readableRoots(root, [join("/System/Volumes/Data", canonicalPath(root))], agentDir), []);
});
