#!/usr/bin/env node
// Regenerates the root AGENTS.md "## Coding Conventions" section from setup/CODING_CONVENTIONS.md.
// Run it after every sync of setup/CODING_CONVENTIONS.md; the structure check fails, naming this
// command, until the two match. `--check` writes nothing and exits 1 when the section is stale.
// Holds docs/adr/20261108-embed-the-coding-conventions-in-the-root-agents-md.md.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { embedConventions } from "./verify-structure-helpers.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) {
  console.error(`usage: node scripts/embed-conventions.mjs [--check]; unknown argument: ${args.find((arg) => arg !== "--check")}`);
  process.exit(2);
}
const check = args.includes("--check");

const root = join(import.meta.dirname, "..");
const agentsPath = join(root, "AGENTS.md");
const agentsText = readFileSync(agentsPath, "utf8");
const conventionsText = readFileSync(join(root, "setup", "CODING_CONVENTIONS.md"), "utf8");
const embedded = embedConventions({ agentsText, conventionsText });

if (embedded === agentsText) {
  console.log("AGENTS.md: Coding Conventions section already matches setup/CODING_CONVENTIONS.md");
} else if (check) {
  console.error("AGENTS.md: Coding Conventions section is stale; run `node scripts/embed-conventions.mjs` to regenerate it");
  process.exit(1);
} else {
  writeFileSync(agentsPath, embedded);
  console.log("AGENTS.md: regenerated the Coding Conventions section from setup/CODING_CONVENTIONS.md");
}
