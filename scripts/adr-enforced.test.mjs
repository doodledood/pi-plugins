// Every file a decision record names under `## Enforced by` carries a comment citing that record,
// as docs/adr/CONVENTIONS.md requires: someone about to weaken the check meets the decision first.
// A bare file name in the line resolves against the folder of the path named before it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readRecords } from "./adr-index.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const adrDir = join(root, "docs", "adr");

/** The files an Enforced by line names, resolved from the repository root. */
export function namedChecks(line) {
  const files = [];
  let folder = "";
  for (const [, token] of line.matchAll(/`([^`\s]+\.(?:ts|mjs|js|yml|yaml))`/g)) {
    const path = token.includes("/") ? token : join(folder, token);
    if (token.includes("/")) folder = dirname(token);
    files.push(path);
  }
  return files;
}

function enforcedBy(text) {
  const match = text.match(/^## Enforced by\s*\n([\s\S]*?)(?=\n## |\s*$)/m);
  return match ? match[1].trim() : undefined;
}

test("each file a record names under Enforced by exists and cites the record", () => {
  const missing = [];
  for (const record of readRecords(adrDir)) {
    if (!record.status?.startsWith("Accepted")) continue;
    const line = enforcedBy(readFileSync(join(adrDir, record.file), "utf8"));
    if (!line || /^(not yet|none) —/.test(line)) continue;
    for (const path of namedChecks(line)) {
      const full = join(root, path);
      if (!existsSync(full)) missing.push(`${record.file}: names ${path}, which does not exist`);
      else if (!readFileSync(full, "utf8").includes(`docs/adr/${record.file}`)) missing.push(`${record.file}: ${path} has no comment citing docs/adr/${record.file}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("bare file names resolve against the folder named before them", () => {
  assert.deepEqual(namedChecks("`packages/a/x/one.test.ts` (\"t\") and `two.test.ts` (\"u\"); `scripts/s.mjs`"), [
    "packages/a/x/one.test.ts",
    "packages/a/x/two.test.ts",
    "scripts/s.mjs",
  ]);
});
