import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { hqPaths } from "./paths.ts";
import { pathExists } from "./io.ts";
import {
  defaultAgentInstructionsPath,
  ensureReference,
  install,
  REFERENCE_MARKER,
  removeReference,
  uninstall,
} from "./install.ts";
import { dropRoot, makeRoot } from "./testing.ts";

test("installing creates the state root, seeds doctrine, and references it once", async () => {
  const home = await makeRoot("hq-install");
  try {
    const stateRoot = join(home, "state");
    const instructions = join(home, "AGENTS.md");
    const config = join(home, "hq.json");
    await writeFile(instructions, "# Agent instructions\n\nExisting content.\n", "utf8");

    const first = await install({ stateRoot, agentInstructions: instructions, configTarget: config });
    assert.equal(await pathExists(hqPaths(stateRoot).queue), true);
    assert.equal(await pathExists(hqPaths(stateRoot).doctrineGlobal), true);
    assert.equal(await pathExists(config), true);
    assert.equal(first.some((note) => note.includes("added")), true);

    const text = await readFile(instructions, "utf8");
    assert.match(text, /Existing content/);
    assert.match(text, /HQ doctrine/);
    assert.equal(text.split(REFERENCE_MARKER).length - 1, 1);

    // Running it again changes nothing.
    await install({ stateRoot, agentInstructions: instructions, configTarget: config });
    const again = await readFile(instructions, "utf8");
    assert.equal(again, text);
  } finally {
    await dropRoot(home);
  }
});

test("installing never overwrites edited doctrine or an edited config", async () => {
  const home = await makeRoot("hq-install-edits");
  try {
    const stateRoot = join(home, "state");
    const instructions = join(home, "AGENTS.md");
    const config = join(home, "hq.json");
    await install({ stateRoot, agentInstructions: instructions, configTarget: config });

    await writeFile(hqPaths(stateRoot).doctrineGlobal, "# mine\n\n- my rule\n", "utf8");
    await writeFile(config, '{"maxConcurrentWorkers": 3}\n', "utf8");
    const notes = await install({ stateRoot, agentInstructions: instructions, configTarget: config });

    assert.equal(await readFile(hqPaths(stateRoot).doctrineGlobal, "utf8"), "# mine\n\n- my rule\n");
    assert.equal(await readFile(config, "utf8"), '{"maxConcurrentWorkers": 3}\n');
    assert.equal(notes.some((note) => note.includes("left untouched")), true);
  } finally {
    await dropRoot(home);
  }
});

test("uninstalling removes the reference and leaves the state readable", async () => {
  const home = await makeRoot("hq-uninstall");
  try {
    const stateRoot = join(home, "state");
    const instructions = join(home, "AGENTS.md");
    const config = join(home, "hq.json");
    await writeFile(instructions, "# Agent instructions\n\nKeep me.\n", "utf8");
    await install({ stateRoot, agentInstructions: instructions, configTarget: config });

    await uninstall({ agentInstructions: instructions });
    const text = await readFile(instructions, "utf8");
    assert.equal(text.includes(REFERENCE_MARKER), false);
    assert.equal(text.includes("HQ doctrine"), false);
    assert.match(text, /Keep me\./);

    assert.equal(await pathExists(hqPaths(stateRoot).doctrineGlobal), true, "state survives");
    assert.equal((await uninstall({ agentInstructions: instructions }))[0]?.includes("absent"), true);
  } finally {
    await dropRoot(home);
  }
});

test("the reference works even when there are no agent instructions yet", async () => {
  const home = await makeRoot("hq-install-fresh");
  try {
    const instructions = join(home, "nested", "AGENTS.md");
    assert.equal(await ensureReference(instructions, "/tmp/doctrine.md"), "added");
    assert.equal(await ensureReference(instructions, "/tmp/doctrine.md"), "already-present");
    assert.match(await readFile(instructions, "utf8"), /\/tmp\/doctrine\.md/);
    assert.equal(await removeReference(instructions), "removed");
  } finally {
    await dropRoot(home);
  }
});

test("the agent instructions path follows the pi directory when it is overridden", () => {
  assert.equal(
    defaultAgentInstructionsPath({ PI_CODING_AGENT_DIR: "/somewhere/.pi/agent" }),
    "/somewhere/.pi/agent/AGENTS.md",
  );
  assert.match(defaultAgentInstructionsPath({}), /\/\.pi\/agent\/AGENTS\.md$/);
});
