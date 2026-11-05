// Runs the package's tests with a temp folder of their own, removed afterwards: the scenarios make
// many fake homes, lock folders and sandbox scratch folders, and none should outlive the run.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "slack-companion-tests-"));
// This node, with its own flags (a preload such as a simulated platform passes on), running tsx.
const args = [...process.execArgv, "--import", "tsx", "--test", "--test-timeout=60000", ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, TMPDIR: dir } });
// Ctrl-C reaches the child through the terminal; this process waits for it to end, then cleans up.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  rmSync(dir, { recursive: true, force: true });
  throw error;
});
child.on("exit", (code, signal) => {
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? (signal ? 1 : 0));
});
