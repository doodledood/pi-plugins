import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { repoNameFromOriginUrl, repoNameFromCommonDir, resolveProjectKey } from "./project.ts";
import { tmpDir } from "./testutil.ts";

test("repoNameFromOriginUrl parses ssh and https forms", () => {
  assert.equal(repoNameFromOriginUrl("git@github.com:example-org/example-service.git"), "example-service");
  assert.equal(repoNameFromOriginUrl("https://github.com/example-org/example-service.git"), "example-service");
  assert.equal(repoNameFromOriginUrl("https://github.com/example-org/example-service"), "example-service");
  assert.equal(repoNameFromOriginUrl("ssh://git@host/owner/repo.git"), "repo");
  assert.equal(repoNameFromOriginUrl(""), undefined);
});

test("repoNameFromCommonDir extracts the repo folder (worktrees share it)", () => {
  assert.equal(repoNameFromCommonDir("/Users/x/Projects/example-service/.git"), "example-service");
  assert.equal(repoNameFromCommonDir("/Users/x/Projects/example-service/.git/"), "example-service");
  assert.equal(repoNameFromCommonDir("/Users/x/Projects/example-service"), "example-service");
});

test("resolveProjectKey falls back to cwd basename for a non-git dir", () => {
  const dir = tmpDir();
  assert.equal(resolveProjectKey(dir), basename(dir));
});
