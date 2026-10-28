import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isolateAgentDir } from "./smoke-agent-dir.ts";

test("a smoke run resolves Pi's agent directory inside its own work directory", () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  const workDir = mkdtempSync(join(tmpdir(), "panel-smoke-isolation-"));
  try {
    const dir = isolateAgentDir(workDir);
    assert.equal(dir, join(workDir, "agent"));
    assert.equal(getAgentDir(), dir);
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("both smoke scripts isolate the agent directory right after creating their work directory", () => {
  for (const script of ["smoke.ts", "smoke-cancel.ts"]) {
    const source = readFileSync(join(import.meta.dirname, script), "utf8");
    assert.match(source, /const workDir = mkdtempSync\([^\n]*\);\nisolateAgentDir\(workDir\);\n/, script);
  }
});
