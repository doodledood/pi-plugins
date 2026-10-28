import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeHerdr } from "./fake-herdr.ts";
import { Herdr } from "./herdr.ts";
import { chooseName, promptLanded, startSession } from "./start.ts";

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "herdr-bridge-start-")));

test("a folder Herdr has no workspace for gets one, and Pi starts there with the first prompt", async () => {
  const fake = new FakeHerdr();
  const dir = folder();
  const started = await startSession(new Herdr(fake.run), { folder: dir, name: "jokes", prompt: "tell a joke" }, { cwd: "/", env: { PI_CODING_AGENT_DIR: "/tmp/agent" } });
  assert.equal(started.name, "jokes");
  assert.equal(started.folder, dir);
  assert.equal(started.sessionPath, "/sessions/jokes.jsonl");
  const create = fake.commands.find((c) => c[0] === "workspace" && c[1] === "create")!;
  assert.deepEqual(create.slice(create.indexOf("--cwd"), create.indexOf("--cwd") + 2), ["--cwd", dir]);
  assert.ok(create.includes("PI_CODING_AGENT_DIR=/tmp/agent"), "the new tab runs Pi with this session's agent directory");
  assert.deepEqual(fake.prompts, [{ target: "jokes", text: "tell a joke" }]);
});

test("a folder with a workspace gets a new tab in it", async () => {
  const fake = new FakeHerdr();
  const dir = folder();
  fake.workspaces.push({ workspaceId: "w7", label: "proj" });
  fake.panes.push({ paneId: "w7:p1", tabId: "w7:t1", workspaceId: "w7", cwd: dir });
  const started = await startSession(new Herdr(fake.run), { folder: dir, prompt: "go" }, { cwd: "/", env: {} });
  assert.equal(started.workspaceId, "w7");
  assert.notEqual(started.tabId, "w7:t1", "its own new tab, not the existing one");
  assert.ok(!fake.commands.some((c) => c[0] === "workspace" && c[1] === "create"));
});

test("a relative folder resolves against this session's folder", async () => {
  const fake = new FakeHerdr();
  const parent = folder();
  const dir = join(parent, "sub");
  (await import("node:fs")).mkdirSync(dir);
  const started = await startSession(new Herdr(fake.run), { folder: "sub", prompt: "go" }, { cwd: parent, env: {} });
  assert.equal(started.folder, dir);
});

test("names: one asked for is checked; none asked for comes from the folder, avoiding live names", () => {
  assert.equal(chooseName(undefined, "/x/My Project!", new Set()), "my-project-");
  assert.equal(chooseName(undefined, "/x/proj", new Set(["proj"])), "proj-2");
  assert.equal(chooseName(undefined, "/x/123", new Set()), "pi");
  assert.throws(() => chooseName("Bad Name", "/x", new Set()), /not a valid Herdr agent name/);
  assert.throws(() => chooseName("taken", "/x", new Set(["taken"])), /already named "taken"/);
});

test("failures name the cause, and a failed start names what it left and how to close it", async () => {
  const dir = folder();
  await assert.rejects(startSession(new Herdr(new FakeHerdr().run), { folder: join(dir, "nope"), prompt: "go" }, { cwd: "/", env: {} }), /does not exist/);
  const file = join(dir, "f.txt");
  writeFileSync(file, "x");
  await assert.rejects(startSession(new Herdr(new FakeHerdr().run), { folder: file, prompt: "go" }, { cwd: "/", env: {} }), /is a file, not a folder/);
  await assert.rejects(startSession(new Herdr(new FakeHerdr().run), { folder: dir, prompt: "  " }, { cwd: "/", env: {} }), /prompt is empty/);

  const notReady = new FakeHerdr();
  notReady.failures.set("agent start", { code: "agent_not_ready", message: "not ready" });
  await assert.rejects(
    startSession(new Herdr(notReady.run), { folder: dir, prompt: "go" }, { cwd: "/", env: {} }),
    /stopped at a startup prompt.*left workspace w1 open; close it with `herdr workspace close w1`/s,
  );

  const existing = new FakeHerdr();
  existing.workspaces.push({ workspaceId: "w3", label: "p" });
  existing.panes.push({ paneId: "w3:p1", tabId: "w3:t1", workspaceId: "w3", cwd: dir });
  existing.failures.set("agent prompt", { code: "agent_blocked", message: "blocked" });
  await assert.rejects(
    startSession(new Herdr(existing.run), { folder: dir, name: "x", prompt: "go" }, { cwd: "/", env: {} }),
    /first prompt was not delivered: blocked.*close it with `herdr pane close w3:p\d+`/s,
  );

  const unreachable = new FakeHerdr();
  unreachable.failures.set("agent list", { code: "herdr_not_found", message: "the `herdr` command was not found on PATH" });
  await assert.rejects(startSession(new Herdr(unreachable.run), { folder: dir, prompt: "go" }, { cwd: "/", env: {} }), /not found on PATH/);
});

// Holds docs/adr/20261028-host-pi-in-herdr-and-ship-a-bridge.md — weakening this test reverses that decision.
test("starting runs only the start sequence: no close, no keys, no other prompt", async () => {
  const fake = new FakeHerdr();
  await startSession(new Herdr(fake.run), { folder: folder(), name: "w", prompt: "go" }, { cwd: "/", env: {} });
  const writes = fake.writes().map((c) => `${c[0]} ${c[1]}`);
  assert.deepEqual(writes, ["workspace create", "agent start", "agent prompt"]);
});

test("a stalled first prompt that lands late is not typed again; one that never lands is typed once more", async () => {
  const dir = folder();
  const session = join(dir, "worker.jsonl");
  const slow = new FakeHerdr();
  slow.stallPrompts = 1;
  slow.onPrompt = () => setTimeout(() => writeFileSync(session, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`), 50);
  const herdr = new Herdr(slow.run);
  const realStart = herdr.startPi.bind(herdr);
  herdr.startPi = async (...args) => ({ ...(await realStart(...args)), sessionPath: session });
  await startSession(herdr, { folder: dir, name: "late", prompt: "go" }, { cwd: "/", env: {}, landedTimeoutMs: 3_000, pollMs: 10 });
  assert.equal(slow.prompts.length, 1, "a prompt that landed late is typed once");

  const lost = new FakeHerdr();
  lost.stallPrompts = 1;
  await startSession(new Herdr(lost.run), { folder: dir, name: "lost", prompt: "go" }, { cwd: "/", env: {}, landedTimeoutMs: 100, pollMs: 10 });
  assert.equal(lost.prompts.length, 2, "a prompt that never landed is typed a second time");

  const stuck = new FakeHerdr();
  stuck.stallPrompts = 2;
  await assert.rejects(
    startSession(new Herdr(stuck.run), { folder: dir, name: "stuck", prompt: "go" }, { cwd: "/", env: {}, landedTimeoutMs: 50, pollMs: 10 }),
    /first prompt was not delivered/,
  );
  assert.equal(stuck.prompts.length, 2, "never more than two attempts");
});

test("promptLanded reads the user messages of a session file", () => {
  const dir = folder();
  const file = join(dir, "s.jsonl");
  assert.equal(promptLanded(file, "x"), false);
  writeFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: "x" } })}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "y" }] } })}\n`);
  assert.equal(promptLanded(file, "x"), true);
  assert.equal(promptLanded(file, "y"), false);
  assert.equal(promptLanded(undefined, "x"), false);
});

test("a new pane whose shell is not at its prompt yet is waited for, not failed", async () => {
  const fake = new FakeHerdr();
  fake.shellNotReady = 3;
  const started = await startSession(new Herdr(fake.run), { folder: folder(), name: "patient", prompt: "go" }, { cwd: "/", env: {}, pollMs: 10 });
  assert.equal(started.name, "patient");
  assert.equal(fake.commands.filter((c) => c[0] === "agent" && c[1] === "start").length, 4);
});

test("a Pi that exits before its first prompt, or never reports ready, says so", async () => {
  const dir = folder();
  const gone = new FakeHerdr();
  const herdr = new Herdr(gone.run);
  const realStart = herdr.startPi.bind(herdr);
  herdr.startPi = async (...args) => {
    const agent = await realStart(...args);
    gone.panes.forEach((p) => p.agent?.name === "brief" && delete p.agent);
    return agent;
  };
  await assert.rejects(
    startSession(herdr, { folder: dir, name: "brief", prompt: "go" }, { cwd: "/", env: {}, pollMs: 10 }),
    /Pi exited before it was ready for its first prompt.*close it with `herdr workspace close w1`/s,
  );

  const unknown = new FakeHerdr();
  const herdr2 = new Herdr(unknown.run);
  const realStart2 = herdr2.startPi.bind(herdr2);
  herdr2.startPi = async (...args) => {
    const agent = await realStart2(...args);
    unknown.panes.forEach((p) => p.agent && (p.agent.status = "unknown"));
    return agent;
  };
  await assert.rejects(
    startSession(herdr2, { folder: dir, name: "blind", prompt: "go" }, { cwd: "/", env: {}, pollMs: 10, readyTimeoutMs: 50 }),
    /Herdr cannot read its state.*herdr integration install pi/s,
  );
});
