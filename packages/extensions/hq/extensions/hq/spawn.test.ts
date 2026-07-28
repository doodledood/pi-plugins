import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArgv,
  buildEnv,
  createSpawner,
  envKind,
  isManagedEnv,
  KIND_ENV,
  MANAGED_ENV,
  TITLER_ENV,
} from "./spawn.ts";
import { dropRoot, makeRoot } from "./testing.ts";

test("a worker is spawned in print mode, and resume and fork use pi's own flags", () => {
  assert.deepEqual(
    buildArgv({ kind: "worker", prompt: "do the thing", cwd: "/work" }),
    ["--print", "do the thing"],
  );
  assert.deepEqual(
    buildArgv({
      kind: "continuation",
      prompt: "carry on",
      cwd: "/work",
      resumeSessionFile: "/s/a.jsonl",
    }),
    ["--session", "/s/a.jsonl", "--print", "carry on"],
  );
  assert.deepEqual(
    buildArgv({
      kind: "drill",
      prompt: "answer this",
      cwd: "/work",
      forkSessionFile: "/s/a.jsonl",
      model: "fast",
      tools: ["read", "hq_drill_result"],
    }),
    ["--fork", "/s/a.jsonl", "--model", "fast", "--tools", "read,hq_drill_result", "--print", "answer this"],
  );
});

test("the managed marker lives in the child's environment, never the parent's", () => {
  const parent = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
  const child = buildEnv({ kind: "worker", prompt: "p", cwd: "/w" }, "/root", parent);
  assert.equal(child[MANAGED_ENV], "1");
  assert.equal(child[KIND_ENV], "worker");
  assert.equal(child.HQ_HOME, "/root");
  assert.equal(parent[MANAGED_ENV], undefined, "the parent environment is not mutated");
});

test("internal workers cannot trigger another titler", () => {
  for (const kind of ["triage", "drill", "titler"] as const) {
    const env = buildEnv({ kind, prompt: "p", cwd: "/w" }, "/root", {});
    assert.equal(env[TITLER_ENV], "1", `${kind} suppresses titling`);
  }
  const worker = buildEnv({ kind: "worker", prompt: "p", cwd: "/w" }, "/root", {});
  assert.equal(worker[TITLER_ENV], undefined);
});

test("stale origin and packet markers are cleared rather than inherited", () => {
  const env = buildEnv({ kind: "worker", prompt: "p", cwd: "/w" }, "/root", {
    HQ_ORIGIN_SESSION_ID: "old",
    HQ_PACKET_ID: "old-packet",
  });
  assert.equal(env.HQ_ORIGIN_SESSION_ID, undefined);
  assert.equal(env.HQ_PACKET_ID, undefined);
});

test("role and kind are read back from the environment", () => {
  assert.equal(isManagedEnv({}), false);
  assert.equal(isManagedEnv({ [MANAGED_ENV]: "1" }), true);
  assert.equal(envKind({ [KIND_ENV]: "drill" }), "drill");
  assert.equal(envKind({ [KIND_ENV]: "nonsense" }), "worker");
});

test("the spawner passes the child's cwd, env, and argv through and returns a log path", async () => {
  const root = await makeRoot("hq-spawn");
  try {
    const seen: Array<{ bin: string; argv: readonly string[]; options: Record<string, unknown> }> = [];
    const spawner = createSpawner({
      root,
      env: { HQ_PI_BIN: "/usr/local/bin/pi" },
      spawnImpl: ((bin: string, argv: readonly string[], options: Record<string, unknown>) => {
        seen.push({ bin, argv, options });
        return {
          pid: 4242,
          unref() {},
          once() {},
        };
      }) as never,
    });

    const result = await spawner({ kind: "worker", prompt: "go", cwd: "/work/alpha" });
    assert.equal(result.pid, 4242);
    assert.equal(result.logPath.startsWith(root), true);
    assert.equal(seen[0]?.bin, "/usr/local/bin/pi");
    assert.deepEqual(seen[0]?.argv, ["--print", "go"]);
    assert.equal(seen[0]?.options.cwd, "/work/alpha");
    assert.equal(seen[0]?.options.detached, true);
  } finally {
    await dropRoot(root);
  }
});

test("a detached spawn that fails is reported rather than taking down the session", async () => {
  const root = await makeRoot("hq-spawn-error");
  try {
    const reported: Array<{ message: string; error: unknown }> = [];
    let errorHandler: ((error: unknown) => void) | undefined;
    const spawner = createSpawner({
      root,
      env: {},
      onError: (message, error) => reported.push({ message, error }),
      spawnImpl: (() => ({
        pid: undefined,
        unref() {},
        once(event: string, handler: (error: unknown) => void) {
          if (event === "error") errorHandler = handler;
        },
      })) as never,
    });

    await spawner({ kind: "triage", prompt: "look at this stop", cwd: "/work" });
    assert.equal(typeof errorHandler, "function", "the detached path listens for spawn failure");

    // Node emits this asynchronously; without a listener it throws and kills the process.
    errorHandler?.(new Error("spawn pi ENOENT"));
    assert.equal(reported.length, 1);
    assert.match(reported[0]?.message ?? "", /Unable to spawn triage worker/);
  } finally {
    await dropRoot(root);
  }
});

test("a task that starts like a flag still reaches the worker as its prompt", () => {
  // pi's CLI drops the argument after --print when it starts with "-" or "@", so a
  // bulleted or @path-leading task would run a worker with no instruction at all.
  for (const prompt of ["- read the notes and decide", "@notes.md summarize this"]) {
    const argv = buildArgv({ kind: "worker", prompt, cwd: "/work" });
    assert.equal(argv[0], "--print");
    const delivered = argv[1] ?? "";
    assert.equal(delivered.includes(prompt), true, "the task survives");
    assert.equal(/^[-@]/.test(delivered), false, "and no longer looks like a flag");
  }
  const plain = buildArgv({ kind: "worker", prompt: "do the thing", cwd: "/work" });
  assert.deepEqual(plain, ["--print", "do the thing"], "an ordinary task is untouched");
});
