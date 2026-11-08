#!/usr/bin/env node
// Regenerates the root AGENTS.md "## Coding Conventions" section from setup/CODING_CONVENTIONS.md.
// Run it after every sync of setup/CODING_CONVENTIONS.md; the structure check fails, naming this
// command, until the two match. Holds part of
// docs/adr/20260820-split-coding-conventions-from-setup-agents.md.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { embedConventions } from "./verify-structure-helpers.mjs";

const root = join(import.meta.dirname, "..");
const agentsPath = join(root, "AGENTS.md");
const agentsText = readFileSync(agentsPath, "utf8");
const conventionsText = readFileSync(join(root, "setup", "CODING_CONVENTIONS.md"), "utf8");
const embedded = embedConventions({ agentsText, conventionsText });

if (embedded === agentsText) {
  console.log("AGENTS.md: Coding Conventions section already matches setup/CODING_CONVENTIONS.md");
} else {
  writeFileSync(agentsPath, embedded);
  console.log("AGENTS.md: regenerated the Coding Conventions section from setup/CODING_CONVENTIONS.md");
}
