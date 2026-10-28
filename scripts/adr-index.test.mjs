import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildIndex, buildStrategyLines, expected, withStrategyList } from "./adr-index.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("the decision index is exactly what the records rebuild", () => {
  assert.equal(readFileSync(join(root, "docs", "adr", "README.md"), "utf8"), expected().index, "run node scripts/adr-index.mjs");
});

test("the North Star's strategy list is exactly what the records rebuild", () => {
  assert.equal(readFileSync(join(root, "NORTH_STAR.md"), "utf8"), expected().northStar, "run node scripts/adr-index.mjs");
});

test("a status token outside a link becomes a link, one inside a link stays as written", () => {
  const index = buildIndex([
    { file: "20260101-a.md", title: "A", status: "Superseded by 20260202-b", area: "x" },
    { file: "20260202-b.md", title: "B", status: "Accepted; narrowed by [20260303-c](20260303-c.md) (scope)", area: "x" },
    { file: "20260303-c.md", title: "C", status: undefined, area: "y" },
  ]);
  assert.match(index, /\| Superseded by \[20260202-b\]\(20260202-b\.md\) \| x \|/);
  assert.match(index, /\| Accepted; narrowed by \[20260303-c\]\(20260303-c\.md\) \(scope\) \| x \|/);
  assert.match(index, /\| \[C\]\(20260303-c\.md\) \| — \| y \|/);
});

test("a record with no Area fails the rebuild instead of leaving a blank cell", () => {
  assert.throws(() => buildIndex([{ file: "20260101-a.md", title: "A", status: "Accepted", area: undefined }]), /no "## Area"/);
});

test("the strategy list holds each Strategy record in effect, with its signpost joined on one line", () => {
  const lines = buildStrategyLines([
    { file: "1.md", title: "Grow through one channel", status: "Accepted", area: "Strategy", revisitWhen: "a second channel\n  brings a third of sign-ups" },
    { file: "2.md", title: "Old choice", status: "Superseded by 3", area: "Strategy" },
    { file: "3.md", title: "Not strategy", status: "Accepted", area: "packaging" },
  ]);
  assert.deepEqual(lines, ["- Grow through one channel — revisit when: a second channel brings a third of sign-ups"]);
  const doc = "# North Star\n\n## Open\n\n- q\n\n## Strategy choices in force\n";
  assert.equal(withStrategyList(doc, lines), `${doc}\n${lines[0]}\n`);
  assert.equal(withStrategyList(`${doc}\n${lines[0]}\n`, []), doc);
});
