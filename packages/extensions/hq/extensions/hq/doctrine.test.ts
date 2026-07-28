import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  applyRatifiedRule,
  coverageFor,
  insertUnderSection,
  loadDoctrine,
  META_DEFAULTS,
  parseMeta,
  parseRules,
  seedDoctrine,
  seedProjectDoctrine,
} from "./doctrine.ts";
import { hqPaths, projectDoctrinePath } from "./paths.ts";
import { dropRoot, makeRoot } from "./testing.ts";

test("rules parse with a citable location, and Meta is not a rule", () => {
  const rules = parseRules(
    `# Doctrine\n\n## Doors\n\n- Treat deploys as one-way\n  doors unless authorized.\n- Local edits are two-way.\n\n## Meta\n\n- batch-max: 3\n`,
    "global.md",
    "global",
  );
  assert.equal(rules.length, 2);
  assert.equal(rules[0]?.section, "Doors");
  assert.match(rules[0]?.text ?? "", /one-way doors unless authorized/);
  assert.match(rules[0]?.citation ?? "", /^global\.md § Doors L\d+$/);
  assert.equal(rules.some((rule) => rule.section === "Meta"), false);
});

test("a wrapped rule is cited at the line its bullet is on", () => {
  const rules = parseRules(
    `## Doors\n\n- first rule\n- a rule that wraps\n  onto a second line\n- third rule\n`,
    "global.md",
    "global",
  );
  assert.deepEqual(rules.map((rule) => rule.citation), [
    "global.md § Doors L3",
    "global.md § Doors L4",
    "global.md § Doors L6",
  ]);
});

test("the seed's own placeholder bullets are never citable rules", async () => {
  const root = await makeRoot("hq-doctrine-placeholders");
  try {
    await seedDoctrine(root);
    await seedProjectDoctrine(root, "/work/alpha");
    const doctrine = await loadDoctrine(root, "/work/alpha");
    const citable = doctrine.rules.map((rule) => rule.text);
    assert.equal(
      citable.some((text) => /^Add (current directives|only precedents|project-specific)/i.test(text)),
      false,
      "an instruction to the user must not be able to authorize a decision",
    );
    assert.equal(citable.length > 0, true, "the real rules are still citable");
  } finally {
    await dropRoot(root);
  }
});

test("Meta values come from the file, and nonsense falls back to the default", () => {
  const parsed = parseMeta(
    `## Meta\n\n- batch-max: 2\n- batch-trivial-only: false\n- audit-sample-rate: 0.5\n- graduation-min-days: not-a-number\n`,
  );
  assert.equal(parsed.batchMax, 2);
  assert.equal(parsed.batchTrivialOnly, false);
  assert.equal(parsed.auditSampleRate, 0.5);
  assert.equal(parsed.graduationMinDays, META_DEFAULTS.graduationMinDays);
  assert.deepEqual(parseMeta("# no meta here"), META_DEFAULTS);
});

test("seeding is idempotent and never overwrites an edited file", async () => {
  const root = await makeRoot("hq-doctrine-seed");
  try {
    assert.equal((await seedDoctrine(root)).created, true);
    const path = hqPaths(root).doctrineGlobal;
    const seeded = await readFile(path, "utf8");
    assert.match(seeded, /## Doors/);
    assert.match(seeded, /## Meta/);

    await writeFile(path, `${seeded}\n- my own rule\n`, "utf8");
    assert.equal((await seedDoctrine(root)).created, false);
    assert.match(await readFile(path, "utf8"), /- my own rule/);

    assert.equal((await seedProjectDoctrine(root, "/work/alpha")).created, true);
    assert.equal((await seedProjectDoctrine(root, "/work/alpha")).created, false);
  } finally {
    await dropRoot(root);
  }
});

test("project rules load after global ones, so the project reads as governing", async () => {
  const root = await makeRoot("hq-doctrine-merge");
  try {
    await seedDoctrine(root);
    await seedProjectDoctrine(root, "/work/alpha");
    await writeFile(
      projectDoctrinePath(root, "/work/alpha"),
      `# alpha\n\n## Directives\n\n- In alpha, never retry a failing suite without reading the log.\n`,
      "utf8",
    );
    const doctrine = await loadDoctrine(root, "/work/alpha");
    const scopes = doctrine.rules.map((rule) => rule.scope);
    assert.equal(scopes.includes("global"), true);
    assert.equal(scopes.at(-1), "project");
    assert.match(doctrine.rules.at(-1)?.citation ?? "", /^projects\//);
  } finally {
    await dropRoot(root);
  }
});

test("a ratified rule is appended under its section; an amendment replaces in place", async () => {
  const root = await makeRoot("hq-doctrine-ratify");
  try {
    await seedDoctrine(root);
    const path = hqPaths(root).doctrineGlobal;

    const added = await applyRatifiedRule({
      root,
      scope: "global",
      section: "Precedents",
      ruleText: "In ci-flake: retry once before investigating.",
    });
    assert.equal(added.applied, true);
    const afterAdd = await readFile(path, "utf8");
    assert.match(afterAdd, /- In ci-flake: retry once before investigating\./);
    const precedentsIndex = afterAdd.indexOf("## Precedents");
    assert.equal(afterAdd.indexOf("In ci-flake") > precedentsIndex, true);

    const amended = await applyRatifiedRule({
      root,
      scope: "global",
      section: "Precedents",
      ruleText: "In ci-flake: retry twice before investigating.",
      replaces: "In ci-flake: retry once before investigating.",
    });
    assert.equal(amended.applied, true);
    const afterAmend = await readFile(path, "utf8");
    assert.match(afterAmend, /retry twice/);
    assert.equal(afterAmend.includes("retry once"), false);

    const missing = await applyRatifiedRule({
      root,
      scope: "global",
      section: "Precedents",
      ruleText: "something else",
      replaces: "a rule that is not there",
    });
    assert.equal(missing.applied, false);
  } finally {
    await dropRoot(root);
  }
});

test("a section that does not exist yet is created rather than guessed at", () => {
  const inserted = insertUnderSection("# Doc\n\n## Doors\n\n- a rule\n", "Precedents", "- new");
  assert.match(inserted, /## Precedents\n\n- new/);
  const appended = insertUnderSection("# Doc\n\n## Doors\n\n- a rule\n", "Doors", "- second");
  assert.match(appended, /- a rule\n- second/);
});

test("coverage buckets follow what was cited and whether the user agreed", () => {
  assert.equal(coverageFor({ citations: [], shadowAgreed: true }), "uncovered");
  assert.equal(coverageFor({ citations: ["global.md § Doors L4"], shadowAgreed: true }), "covered-agreed");
  assert.equal(coverageFor({ citations: ["global.md § Doors L4"], shadowAgreed: false }), "contradicts");
  assert.equal(coverageFor({ citations: ["global.md § Doors L4"], shadowAgreed: null }), "covered-agreed");
});
