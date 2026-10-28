// Rebuilds the decision-record index (docs/adr/README.md) and the North Star's
// "Strategy choices in force" list from the records, by the rebuild rules in
// docs/adr/CONVENTIONS.md and docs/NORTH_STAR_CONVENTIONS.md.
//
//   node scripts/adr-index.mjs          write both from the records
//   node scripts/adr-index.mjs --check  exit 1 when either differs from what the records give
//
// scripts/adr-index.test.mjs runs the check with the rest of `npm run verify:structure`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const STRATEGY_HEADING = "## Strategy choices in force";

/** The text of a `## <name>` section: the lines up to the next heading, trimmed. */
function section(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start === -1) return undefined;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

/** Every `YYYYMMDD-kebab-title` token outside an existing Markdown link becomes a link to its file. */
function linkTokens(status) {
  return status
    .split(/(\[[^\]]*\]\([^)]*\))/)
    .map((part) =>
      part.startsWith("[") ? part : part.replace(/\b(\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g, "[$1]($1.md)"),
    )
    .join("");
}

export function readRecords(adrDir) {
  return readdirSync(adrDir)
    .filter((file) => file.endsWith(".md") && file !== "README.md" && file !== "CONVENTIONS.md")
    .sort()
    .map((file) => {
      const text = readFileSync(join(adrDir, file), "utf8");
      const heading = text.match(/^# ADR: (.+)$/m);
      if (!heading) throw new Error(`${file}: no "# ADR: " heading`);
      const status = section(text, "Status");
      return {
        file,
        title: heading[1].trim(),
        status: status ? status.split("\n")[0].trim() : undefined,
        area: section(text, "Area"),
        revisitWhen: section(text, "Revisit when"),
      };
    });
}

export function buildIndex(records) {
  const rows = records.map((record) => {
    if (!record.area) throw new Error(`${record.file}: no "## Area" — add the field rather than leaving the column empty`);
    const date = `${record.file.slice(0, 4)}-${record.file.slice(4, 6)}-${record.file.slice(6, 8)}`;
    const status = record.status ? linkTokens(record.status) : "—";
    return `| ${date} | [${record.title}](${record.file}) | ${status} | ${record.area} |`;
  });
  return `# Architecture Decision Records\n\n| Date | ADR | Status | Area |\n|------|-----|--------|------|\n${rows.join("\n")}\n`;
}

export function buildStrategyLines(records) {
  return records
    .filter((record) => record.status?.startsWith("Accepted") && record.area === "Strategy")
    .map((record) => {
      const signpost = record.revisitWhen
        ?.split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ");
      return `- ${record.title}${signpost ? ` — revisit when: ${signpost}` : ""}`;
    });
}

/** The North Star with its strategy list replaced by `lines`; the list runs to the next heading or the end. */
export function withStrategyList(northStar, lines) {
  const at = northStar.indexOf(`${STRATEGY_HEADING}\n`);
  if (at === -1) throw new Error(`NORTH_STAR.md: no "${STRATEGY_HEADING}" section`);
  const bodyStart = at + STRATEGY_HEADING.length + 1;
  const next = northStar.slice(bodyStart).search(/^#{1,2} /m);
  const rest = next === -1 ? "" : `\n${northStar.slice(bodyStart + next)}`;
  return `${northStar.slice(0, bodyStart)}${lines.length ? `\n${lines.join("\n")}\n` : ""}${rest}`;
}

export function expected(repoRoot = root) {
  const records = readRecords(join(repoRoot, "docs", "adr"));
  const northStar = readFileSync(join(repoRoot, "NORTH_STAR.md"), "utf8");
  return {
    index: buildIndex(records),
    northStar: withStrategyList(northStar, buildStrategyLines(records)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const want = expected();
  const indexPath = join(root, "docs", "adr", "README.md");
  const northStarPath = join(root, "NORTH_STAR.md");
  if (process.argv.includes("--check")) {
    const drift = [];
    if (readFileSync(indexPath, "utf8") !== want.index) drift.push("docs/adr/README.md");
    if (readFileSync(northStarPath, "utf8") !== want.northStar) drift.push("NORTH_STAR.md (Strategy choices in force)");
    if (drift.length) {
      console.error(`rebuilt from the records, these differ: ${drift.join(", ")} — run node scripts/adr-index.mjs`);
      process.exit(1);
    }
    console.log("adr index ok");
  } else {
    writeFileSync(indexPath, want.index);
    writeFileSync(northStarPath, want.northStar);
    console.log("wrote docs/adr/README.md and the North Star's strategy list");
  }
}
