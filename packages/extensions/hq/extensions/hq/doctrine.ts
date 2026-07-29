/**
 * Doctrine: the user's rules, as plain files.
 *
 * Global rules live in doctrine/global.md and project rules in
 * doctrine/projects/<slug>.md, with the project file taking precedence where
 * both speak. Rules enter one of two ways only: the user edits the file, or the
 * user ratifies a proposal. No inference from watching, ever (AC-4.3).
 *
 * The Meta section of the global file is HQ's own configuration — batching,
 * graduation thresholds, audit rate — so the numbers that govern HQ are as
 * reviewable as the rules that govern the work.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteText, materializeIfAbsent, type ErrorReporter, silentReporter } from "./io.ts";
import { hqPaths, projectDoctrinePath, projectSlug } from "./paths.ts";
import { DOCTRINE_GLOBAL_SEED, DOCTRINE_PROJECT_SEED } from "./templates.ts";

/**
 * Sections whose lines can decide a case, and therefore satisfy the coverage gate
 * that lets HQ answer a stop without the user.
 *
 * Tastes shape how a decision is made; escalation rules say when to ask. Neither
 * decides anything, but both parse as bullets with real citations, so prose alone
 * cannot keep them out of the coverage check: a caveat in section text is never
 * rendered to the worker. This list is the gate instead.
 */
export const DECIDING_SECTIONS: ReadonlySet<string> = new Set([
  "Doors",
  "Directives",
  "Precedents",
]);

export interface DoctrineRule {
  /** Citable identity, e.g. "global.md § Doors #a1b2c3d4" — content, not position. */
  citation: string;
  section: string;
  /** The rule as one line, with any wrapped continuation folded in. */
  text: string;
  scope: "global" | "project";
  /** 1-based line the bullet starts on, and the last line it occupies. */
  line: number;
  endLine: number;
  /** Whether a line in this section can decide a case, or only shape one. */
  decides: boolean;
}

export interface MetaDoctrine {
  batchMax: number;
  batchTrivialOnly: boolean;
  graduationConsecutiveAgreements: number;
  graduationMinDays: number;
  auditSampleRate: number;
  stalenessMinutes: number;
}

export const META_DEFAULTS: MetaDoctrine = {
  batchMax: 4,
  batchTrivialOnly: true,
  graduationConsecutiveAgreements: 10,
  graduationMinDays: 14,
  auditSampleRate: 0.2,
  stalenessMinutes: 30,
};

export interface Doctrine {
  globalText: string;
  projectText: string | undefined;
  rules: DoctrineRule[];
  meta: MetaDoctrine;
}

/** Creates the global file if absent. Never touches an existing file. */
export async function seedDoctrine(root: string): Promise<{ created: boolean }> {
  const created = await materializeIfAbsent(hqPaths(root).doctrineGlobal, DOCTRINE_GLOBAL_SEED);
  return { created };
}

export async function seedProjectDoctrine(
  root: string,
  project: string,
): Promise<{ created: boolean }> {
  const created = await materializeIfAbsent(
    projectDoctrinePath(root, project),
    DOCTRINE_PROJECT_SEED(project),
  );
  return { created };
}

async function readIfPresent(path: string, onError: ErrorReporter): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onError(`Unable to read doctrine ${path}`, error);
    }
    return undefined;
  }
}

/** Parses `- rule text` bullets under `## Section` headings. */
export function parseRules(
  text: string,
  fileLabel: string,
  scope: "global" | "project",
): DoctrineRule[] {
  const rules: DoctrineRule[] = [];
  let section = "(preamble)";
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^##\s+(.*\S)\s*$/.exec(line);
    if (heading?.[1]) {
      section = heading[1];
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!bullet?.[1]) continue;
    if (section === "Meta") continue;
    // The seeded "add your rules here" bullets are instructions to the user, not
    // rules HQ may cite — a placeholder must never be able to authorize a decision.
    if (PLACEHOLDER_RULE.test(bullet[1])) continue;

    // Fold continuation lines so a wrapped rule reads as one rule, but cite the
    // line the bullet itself is on — that is where the user will look.
    const bulletLine = index + 1;
    let endLine = bulletLine;
    let body = bullet[1];
    let lookahead = index + 1;
    while (lookahead < lines.length) {
      const next = lines[lookahead] ?? "";
      if (/^\s+\S/.test(next) && !/^\s*[-*]\s/.test(next)) {
        body += ` ${next.trim()}`;
        lookahead += 1;
        endLine = lookahead;
        index = lookahead - 1;
        continue;
      }
      break;
    }

    rules.push({
      // The citation is content-addressed, not position-addressed: HQ's own
      // ratifications insert and splice lines, and a line-numbered citation stored
      // on a queued packet would silently re-bind to a different rule.
      citation: `${fileLabel} § ${section} #${fingerprint(body)}`,
      section,
      text: body,
      scope,
      line: bulletLine,
      endLine,
      decides: DECIDING_SECTIONS.has(section),
    });
  }
  return rules;
}

/** Instructional bullets shipped in the seed, which are never citable rules. */
const PLACEHOLDER_RULE = /^Add (current directives|only precedents|approved project-specific|project-specific directives)/i;

/**
 * A Meta value as the user leaves it in the file. The seeded file annotates each
 * value with its allowed range — `- batch-max: 4    (1-20)` — and a user editing
 * the number keeps that hint, so the trailing parenthetical is part of the
 * expected shape and must be stripped rather than turning the value into
 * nonsense that silently falls back to the default.
 */
function parseMetaValue(raw: string): string {
  return raw.trim().replace(/\s*\([^()]*\)\s*$/, "").trim().replace(/\.$/, "");
}

export function parseMeta(text: string): MetaDoctrine {
  const meta = { ...META_DEFAULTS };
  const metaSection = /^##\s+Meta\s*$/m.exec(text);
  if (!metaSection || metaSection.index === undefined) return meta;

  const rest = text.slice(metaSection.index);
  const end = /\n##\s+/.exec(rest.slice(1));
  const body = end?.index !== undefined ? rest.slice(0, end.index + 1) : rest;

  const numeric = (key: string, current: number, min: number, max: number): number => {
    const match = new RegExp(`^\\s*[-*]\\s+${key}\\s*:\\s*(.+)$`, "m").exec(body);
    if (!match?.[1]) return current;
    const value = Number(parseMetaValue(match[1]));
    if (!Number.isFinite(value) || value < min || value > max) return current;
    return value;
  };
  const boolean = (key: string, current: boolean): boolean => {
    const match = new RegExp(`^\\s*[-*]\\s+${key}\\s*:\\s*(.+)$`, "m").exec(body);
    if (!match?.[1]) return current;
    const value = parseMetaValue(match[1]).toLowerCase();
    if (value === "true" || value === "yes") return true;
    if (value === "false" || value === "no") return false;
    return current;
  };

  meta.batchMax = numeric("batch-max", meta.batchMax, 1, 20);
  meta.batchTrivialOnly = boolean("batch-trivial-only", meta.batchTrivialOnly);
  meta.graduationConsecutiveAgreements = numeric(
    "graduation-consecutive-agreements",
    meta.graduationConsecutiveAgreements,
    1,
    1000,
  );
  meta.graduationMinDays = numeric("graduation-min-days", meta.graduationMinDays, 0, 3650);
  meta.auditSampleRate = numeric("audit-sample-rate", meta.auditSampleRate, 0, 1);
  meta.stalenessMinutes = numeric("staleness-minutes", meta.stalenessMinutes, 1, 10080);
  return meta;
}

/**
 * Loads the doctrine that applies to a project: global rules plus project rules,
 * with project rules last so a later rule in the same section reads as the
 * governing one.
 */
export async function loadDoctrine(
  root: string,
  project: string | undefined,
  onError: ErrorReporter = silentReporter,
): Promise<Doctrine> {
  const paths = hqPaths(root);
  const globalText = (await readIfPresent(paths.doctrineGlobal, onError)) ?? "";
  const projectText = project
    ? await readIfPresent(projectDoctrinePath(root, project), onError)
    : undefined;

  const rules = [
    ...parseRules(globalText, "global.md", "global"),
    ...(projectText && project
      ? parseRules(projectText, `projects/${projectSlug(project)}.md`, "project")
      : []),
  ];

  return { globalText, projectText, rules, meta: parseMeta(globalText) };
}

/**
 * Renders doctrine for a prompt: citable, compact, in precedence order. Lines that
 * only shape a decision are marked, so a worker reading the list can see that
 * citing one is citing nothing.
 */
export function renderDoctrine(doctrine: Doctrine): string {
  if (doctrine.rules.length === 0) return "(no doctrine yet)";
  return doctrine.rules
    .map((rule) =>
      `- [${rule.citation}]${rule.decides ? "" : " (shapes a decision; cannot decide one)"} ${rule.text}`
    )
    .join("\n");
}

/** Short content fingerprint, stable across line moves and reformatting. */
function fingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 8);
}

export type ProposalKind = "new-rule" | "amendment";

export type RatificationRequest = {
  root: string;
  section: string;
  ruleText: string;
  /**
   * For an amendment: the rule being replaced, as `DoctrineRule.text` (folded to
   * one line). The rule is located by parsing the file, so a rule wrapped across
   * several lines is replaced whole.
   */
  replaces?: string;
} & ({ scope: "global" } | { scope: "project"; project: string });

/**
 * Applies a ratified rule. This is the only write path into a doctrine file, and
 * it is reachable only from a user ruling that ratified a proposal.
 */
export async function applyRatifiedRule(
  request: RatificationRequest,
): Promise<{ applied: boolean; reason?: string }> {
  const path = request.scope === "global"
    ? hqPaths(request.root).doctrineGlobal
    : projectDoctrinePath(request.root, request.project);
  if (request.scope === "project") {
    await seedProjectDoctrine(request.root, request.project);
  } else {
    await seedDoctrine(request.root);
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { applied: false, reason: `doctrine file missing: ${path}` };
  }

  if (request.replaces) {
    // A rule can be wrapped across lines in the file, so the amendment is located
    // by parsing the file and matching the folded rule — not by a raw substring,
    // which would never match a wrapped rule.
    const target = parseRules(text, "target", request.scope).find(
      (rule) => rule.text === request.replaces,
    );
    if (!target) {
      return { applied: false, reason: "the rule being amended is no longer in the file" };
    }
    const lines = text.split("\n");
    lines.splice(target.line - 1, target.endLine - target.line + 1, `- ${request.ruleText}`);
    await atomicWriteText(path, lines.join("\n"));
    return { applied: true };
  }

  const updated = insertUnderSection(text, request.section, `- ${request.ruleText}`);
  await atomicWriteText(path, updated);
  return { applied: true };
}

/** Appends a bullet at the end of a section, creating the section if needed. */
export function insertUnderSection(text: string, section: string, bullet: string): string {
  const lines = text.split("\n");
  const headingIndex = lines.findIndex(
    (line) => new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`).test(line),
  );
  if (headingIndex === -1) {
    const trailing = text.endsWith("\n") ? "" : "\n";
    return `${text}${trailing}\n## ${section}\n\n${bullet}\n`;
  }

  let insertAt = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? "")) {
      insertAt = index;
      break;
    }
  }
  let cursor = insertAt;
  while (cursor > headingIndex + 1 && (lines[cursor - 1] ?? "").trim() === "") cursor -= 1;
  lines.splice(cursor, 0, bullet);
  return lines.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which coverage bucket a ruling fell into. Buckets are decided from what the
 * shadow ruling cited and whether the user agreed with it, not from guessing at
 * novelty: cited-and-agreed is evidence, cited-and-overruled is a contradiction
 * to resolve, and uncited is a gap.
 */
export function coverageFor(input: {
  citations: string[];
  shadowAgreed: boolean | null;
  /** The merged doctrine, when the caller has it: only deciding lines cover a case. */
  doctrine?: Doctrine;
}): "covered-agreed" | "contradicts" | "uncovered" {
  // A citation to a Taste or an Escalation rule is not coverage \u2014 the continue and
  // close paths already refuse to act on one, and counting it here would advance the
  // authority ladder on rules that cannot decide anything.
  const deciding = input.doctrine
    ? input.citations.filter((citation) =>
      input.doctrine?.rules.some((rule) => rule.citation === citation && rule.decides)
    )
    : input.citations;
  if (deciding.length === 0) return "uncovered";
  return input.shadowAgreed === false ? "contradicts" : "covered-agreed";
}
