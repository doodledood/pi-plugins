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
import { DOCTRINE_GLOBAL_SEED } from "./templates.ts";
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
  assert.match(rules[0]?.citation ?? "", /^global\.md § Doors #[0-9a-f]{8}$/);
  assert.equal(rules.some((rule) => rule.section === "Meta"), false);
});

test("a citation names the rule's content, so it survives the lines around it moving", () => {
  const before = parseRules(
    `## Doors\n\n- first rule\n- a rule that wraps\n  onto a second line\n- third rule\n`,
    "global.md",
    "global",
  );
  assert.deepEqual(before.map((rule) => rule.line), [3, 4, 6]);

  // HQ's own ratifications insert and splice lines. A position-addressed citation
  // stored on a queued packet would then point at a different rule.
  const after = parseRules(
    `## Doors\n\n- inserted rule\n- first rule\n- a rule that wraps\n  onto a second line\n- third rule\n`,
    "global.md",
    "global",
  );
  const byText = new Map(after.map((rule) => [rule.text, rule.citation]));
  for (const rule of before) {
    assert.equal(byText.get(rule.text), rule.citation, `citation moved for: ${rule.text}`);
  }
  assert.notEqual(before[0]?.line, after.find((r) => r.text === "first rule")?.line);
});

test("only sections that can decide a case are marked as deciding", () => {
  const rules = parseRules(
    `## Tastes\n\n- prefer the simple thing\n\n## Doors\n\n- treat deploys as one-way\n\n## Escalation rules\n\n- ask when unsure\n\n## Precedents\n\n- retry once\n`,
    "global.md",
    "global",
  );
  const decides = Object.fromEntries(rules.map((rule) => [rule.section, rule.decides]));
  assert.deepEqual(decides, {
    Tastes: false,
    Doors: true,
    "Escalation rules": false,
    Precedents: true,
  });
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

test("the range hint the seeded file writes next to each value is not read as the value", () => {
  // The seed annotates every Meta line with its range. If the annotation broke
  // parsing, every number would silently fall back to META_DEFAULTS and editing
  // the file would do nothing.
  const parsed = parseMeta(
    `## Meta\n\n- batch-max: 2                            (1\u201320)\n- batch-trivial-only: no                  (true or false)\n- staleness-minutes: 15                   (1\u201310080)\n`,
  );
  assert.equal(parsed.batchMax, 2);
  assert.equal(parsed.batchTrivialOnly, false);
  assert.equal(parsed.stalenessMinutes, 15);
});

test("the seeded file's own Meta numbers are the ones HQ runs on", () => {
  const parsed = parseMeta(DOCTRINE_GLOBAL_SEED);
  for (const [key, value] of Object.entries(parsed)) {
    const bullet = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const match = new RegExp(`^-\\s+${bullet}\\s*:\\s*(\\S+)`, "m").exec(DOCTRINE_GLOBAL_SEED);
    assert.notEqual(match, null, `${bullet} is written in the seeded Meta section`);
    assert.equal(String(value), match?.[1], `${bullet} is parsed from the file, not defaulted`);
  }
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

test("the seed distinguishes a session proceeding from HQ answering for the user", async () => {
  const root = await makeRoot("hq-doctrine-wildcard");
  try {
    await seedDoctrine(root);
    const doctrine = await loadDoctrine(root, undefined);

    // The bullet that permits unblocked progress must name the session as its
    // subject; read as a rule about HQ it would be a wildcard citation that
    // satisfies the coverage gate for any reversible case.
    const judgment = doctrine.rules.find((rule) =>
      /may take a reversible, not-high-blast step/.test(rule.text)
    );
    assert.ok(judgment, "the worker-judgment bullet exists");
    assert.match(judgment.text, /delegated session/);
    assert.equal(/^HQ /.test(judgment.text), false);

    // And the bullet about HQ answering says outright that it is not itself a
    // rule that decides anything.
    const answering = doctrine.rules.find((rule) => /^HQ may answer a stop/.test(rule.text));
    assert.ok(answering, "the HQ-answering bullet exists");
    assert.match(answering.text, /not such a rule|never a line/);
  } finally {
    await dropRoot(root);
  }
});

test("a citation to a rule that cannot decide is not coverage", async () => {
  const root = await makeRoot("hq-coverage-decides");
  try {
    await seedDoctrine(root);
    const doctrine = await loadDoctrine(root, "/work/alpha");
    const taste = doctrine.rules.find((rule) => !rule.decides);
    const decider = doctrine.rules.find((rule) => rule.decides);
    assert.ok(taste && decider, "the seed carries both kinds");

    // The authoring prompt tells workers that citing a shaping line is citing
    // nothing. Coverage has to agree, or the ladder climbs on rules that can
    // never answer a stop.
    assert.equal(
      coverageFor({ citations: [taste.citation], shadowAgreed: true, doctrine }),
      "uncovered",
    );
    assert.equal(
      coverageFor({ citations: [decider.citation], shadowAgreed: true, doctrine }),
      "covered-agreed",
    );
  } finally {
    await dropRoot(root);
  }
});
