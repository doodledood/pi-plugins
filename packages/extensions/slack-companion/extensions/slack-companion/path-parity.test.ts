// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md: the secret guards resolve a path
// argument exactly as Pi's file tools do. Pi does not export its resolver, so this test loads it
// from the installed package and compares it with the copy in secrets.ts on every rule.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveToolPath } from "./secrets.ts";

const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { resolveToCwd } = (await import(pathToFileURL(join(piDist, "core", "tools", "path-utils.js")).href)) as {
  resolveToCwd: (path: string, cwd: string) => string;
};

test("resolveToolPath matches Pi's own resolver on every rule", () => {
  const cwd = "/work/project";
  const inputs = [
    "app.ts", "./src/../app.ts", "/etc/hosts", "~", "~/.ssh/id_ed25519", "@~/.ssh/id_ed25519", "@.env",
    "@/abs/path", "file:///Users/someone/.aws/credentials", "@file:///tmp/x", "~user/x", "a\u00A0b", "\u3000~/x",
    " ~/.ssh", "~\u00A0/x", "..", "@", "", "file://localhost/tmp/y",
  ];
  for (const input of inputs) {
    let theirs: string | Error;
    try {
      theirs = resolveToCwd(input, cwd);
    } catch (error) {
      theirs = error as Error;
    }
    if (theirs instanceof Error) assert.throws(() => resolveToolPath(input, cwd, homedir()), `${JSON.stringify(input)} fails in both`);
    else assert.equal(resolveToolPath(input, cwd, homedir()), theirs, JSON.stringify(input));
  }
});
