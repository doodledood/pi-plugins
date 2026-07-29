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
  recordJudgmentSettings,
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

test("a working copy can be the only HQ a child loads", () => {
  // With an installed HQ also on disk, a child that discovers both dies on a
  // tool-name conflict before it runs anything.
  const request = { kind: "worker" as const, prompt: "go", cwd: "/tmp" };
  assert.deepEqual(buildArgv(request, "/repo/hq/index.ts", true).slice(0, 3), [
    "-ne",
    "-e",
    "/repo/hq/index.ts",
  ]);
  assert.equal(buildArgv(request, "/repo/hq/index.ts").includes("-ne"), false);
});

/** A child that starts and exits cleanly, enough for the spawner's detached path. */
function fakeChild() {
  return {
    pid: 4242,
    unref() {},
    once(_event: string, _handler: (value: unknown) => void) {},
  } as never;
}

test("judgment workers inherit how the seat thinks; a titler does not", async () => {
  const root = await makeRoot("hq-judgment");
  try {
    // Triage reads a stop, applies doctrine and writes the decision the user acts on.
    // A cheaper model there does not save the user work, it changes what reaches them.
    await recordJudgmentSettings(root, { model: "anthropic/big-model", thinking: "high" });
    const seen: string[][] = [];
    const spawner = createSpawner({
      root,
      env: { PATH: process.env.PATH ?? "" },
      spawnImpl: ((_bin: string, argv: string[]) => {
        seen.push(argv);
        return fakeChild();
      }) as never,
    });

    await spawner({ kind: "triage", prompt: "triage it", cwd: root });
    assert.deepEqual(seen[0]?.slice(0, 4), [
      "--model",
      "anthropic/big-model",
      "--thinking",
      "high",
    ]);

    await spawner({ kind: "titler", prompt: "name it", cwd: root, model: "fast/small" });
    assert.equal(seen[1]?.includes("anthropic/big-model"), false, "the titler keeps its own");
    assert.equal(seen[1]?.includes("--thinking"), false);

    // An explicit model on the request still wins over the recorded one.
    await spawner({ kind: "drill", prompt: "read it", cwd: root, model: "chosen/model" });
    assert.equal(seen[2]?.includes("chosen/model"), true);
  } finally {
    await dropRoot(root);
  }
});

test("no seat has been taken yet, so a judgment worker just takes its own default", async () => {
  const root = await makeRoot("hq-judgment-none");
  try {
    const seen: string[][] = [];
    const spawner = createSpawner({
      root,
      env: { PATH: process.env.PATH ?? "" },
      spawnImpl: ((_bin: string, argv: string[]) => {
        seen.push(argv);
        return fakeChild();
      }) as never,
    });
    await spawner({ kind: "triage", prompt: "triage it", cwd: root });
    assert.equal(seen[0]?.includes("--model"), false);
  } finally {
    await dropRoot(root);
  }
});
