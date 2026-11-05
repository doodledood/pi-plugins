// Runs the package's tests with a temp folder of their own, removed afterwards: the scenarios make
// many fake homes, lock folders and sandbox scratch folders, and none should outlive the run.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "slack-companion-tests-"));
// This node, with its own flags (a preload such as a simulated platform passes on), running tsx.
const args = [...process.execArgv, "--import", "tsx", "--test", "--test-timeout=60000", ...process.argv.slice(2)];
const run = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, TMPDIR: dir } });
rmSync(dir, { recursive: true, force: true });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
