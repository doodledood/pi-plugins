#!/usr/bin/env node
/**
 * Copies the live HQ global doctrine into this repo, so the rules HQ actually decides by
 * are versioned here with the rest of the setup instead of living only on one machine.
 *
 * One direction by default, and only the global file. Project doctrine under
 * `~/.pi/hq/doctrine/projects/` stays local: it is keyed by working directory and names
 * whatever the user happened to be working in.
 *
 *   node scripts/sync-doctrine.mjs            # live  -> repo (default)
 *   node scripts/sync-doctrine.mjs --check    # exit 1 if the repo copy is out of date
 *   node scripts/sync-doctrine.mjs --install  # repo  -> live, only when there is no live file
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const REPO_COPY = join(dirname(new URL(import.meta.url).pathname), "..", "setup", "hq", "doctrine.global.md");

function livePath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const base = process.env.HQ_HOME?.trim() ??
    (agentDir ? join(agentDir.replace(/^~(?=$|\/)/, homedir()), "hq") : join(homedir(), ".pi", "hq"));
  return join(base, "doctrine", "global.md");
}

const mode = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--install")
  ? "install"
  : "sync";
const live = livePath();

if (mode === "install") {
  // Never clobber a live file: doctrine is the user's, and HQ's own installer holds the
  // same rule. A machine with rules already on it keeps them.
  if (existsSync(live)) {
    console.log(`doctrine already present, left untouched: ${live}`);
  } else if (!existsSync(REPO_COPY)) {
    console.log("no doctrine in the repo to install");
  } else {
    mkdirSync(dirname(live), { recursive: true });
    writeFileSync(live, readFileSync(REPO_COPY, "utf8"));
    console.log(`installed doctrine: ${live}`);
  }
  process.exit(0);
}

if (!existsSync(live)) {
  console.log(`no live doctrine at ${live}; nothing to sync`);
  process.exit(0);
}

const liveText = readFileSync(live, "utf8");
const repoText = existsSync(REPO_COPY) ? readFileSync(REPO_COPY, "utf8") : undefined;

if (mode === "check") {
  if (liveText === repoText) {
    console.log("doctrine in sync");
    process.exit(0);
  }
  console.error(
    `setup/hq/doctrine.global.md is out of date with ${live}\n` +
      "run: npm run sync:doctrine",
  );
  process.exit(1);
}

if (liveText === repoText) {
  console.log("doctrine already in sync");
  process.exit(0);
}
mkdirSync(dirname(REPO_COPY), { recursive: true });
writeFileSync(REPO_COPY, liveText);
const rules = liveText.split("\n").filter((line) => line.startsWith("- ")).length;
console.log(`synced doctrine from ${live} (${rules} lines under headings)`);
