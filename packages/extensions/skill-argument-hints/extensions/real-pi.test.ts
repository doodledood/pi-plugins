// skill-argument-hints loaded by a real Pi session from its file path, with real skills on disk, drawing on
// pi-tui's real editor. HOME and the agent directory live in a temporary directory. Only the parent TUI and
// the UI context that hands over the editor factory are stand-ins.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, renderFakeCursor, stripTerminalSequences, TUI_KEYBINDINGS, type Component, type TUI } from "@earendil-works/pi-tui";
import YAML from "yaml";

process.env.PI_OFFLINE ??= "1";

const EXTENSION_PATH = new URL("./skill-argument-hints.ts", import.meta.url).pathname;

/** Every argument-hint form the parser must read as YAML does. */
const FRONTMATTER_CASES: string[] = [
  "argument-hint: <ticket-id>",
  "argument-hint: <ticket-id> [--force]",
  "argument-hint: <id> # trailing comment",
  'argument-hint: "<id> [flags]"',
  'argument-hint: "<id>" # comment',
  "argument-hint: '[x]'  # comment",
  "argument-hint: 'it''s <x>'",
  'argument-hint: "tab\\tand \\"quotes\\""',
  "argument-hint: |\n  <a>\n  <b>",
  "argument-hint: |-\n  <a> <b>",
  "argument-hint: |+\n  <a>\n\n",
  "argument-hint: >\n  <a>\n  <b>",
  "argument-hint: >-\n  <a>\n  <b>",
  "argumentHint: <camel>",
  "argument_hint: <snake>",
];

let dir: string;
let agentDir: string;
let cwd: string;
let session: AgentSession;
let editorFactory: ((tui: TUI, theme: unknown, keybindings: unknown) => Component & { setText(text: string): void; focused: boolean }) | undefined;
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PI_AGENT_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};

function writeSkill(name: string, frontmatter: string): void {
  const skillDir = join(agentDir, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}.\n${frontmatter}\n---\nBody.\n`);
}

before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), "skill-hints-real-pi-"));
  const home = join(dir, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(dir, "workspace");
  for (const path of [agentDir, cwd]) mkdirSync(path, { recursive: true });
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;

  writeSkill("ticket", "argument-hint: <ticket-id>");
  FRONTMATTER_CASES.forEach((frontmatter, index) => writeSkill(`case-${index}`, frontmatter));

  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [EXTENSION_PATH], noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create();
  ({ session } = await createAgentSession({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd), settingsManager, modelRuntime, resourceLoader: loader, tools: ["read"] }));
  const inert = () => undefined;
  const ui: Record<string, unknown> = {
    setEditorComponent: (factory: typeof editorFactory) => {
      editorFactory = factory;
    },
    addAutocompleteProvider: inert,
    notify: inert,
    getEditorText: () => "",
    onTerminalInput: () => inert,
    getToolsExpanded: () => false,
    getAllThemes: () => [],
    getTheme: inert,
    setTheme: () => ({ success: false }),
  };
  for (const name of ["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "getEditorComponent", "setToolsExpanded", "select", "confirm", "input", "editor", "custom"]) {
    ui[name] = inert;
  }
  await session.bindExtensions({ uiContext: ui as never, mode: "tui" });
});

after(() => {
  session?.dispose();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

const WIDTH = 200;

/** Type `text` into the extension's editor and return its rendered lines. */
function renderTyped(text: string): string[] {
  assert.ok(editorFactory, "the extension installs its editor in TUI mode");
  const tui = { requestRender() {}, terminal: { rows: 40, columns: WIDTH } } as unknown as TUI;
  const plain = (value: string) => value;
  const theme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
  const editor = editorFactory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS));
  editor.focused = true;
  editor.setText(text);
  return editor.render(WIDTH);
}

/** The phantom text drawn after the typed command, or undefined when none is drawn. */
function hintAfter(command: string): string | undefined {
  const line = renderTyped(`/${command} `).map((raw) => stripTerminalSequences(raw)).find((plain) => plain.includes(`/${command}`));
  assert.ok(line, `the editor shows /${command}`);
  const after = line.slice(line.indexOf(`/${command}`) + command.length + 1).trim();
  return after.length > 0 ? after : undefined;
}

// ── AC-10.1 ─────────────────────────────────────────────────────────────────

test("typing a skill command shows its argument hint at Pi's cursor", () => {
  const raw = renderTyped("/skill:ticket ").find((line) => line.includes("/skill:ticket"));
  assert.ok(raw);
  assert.ok(raw.includes(`${renderFakeCursor(" ")}<ticket-id>`), `no hint right after the cursor in ${JSON.stringify(raw)}`);
  assert.equal(hintAfter("skill:ticket"), "<ticket-id>");
});

test("no hint once arguments are typed", () => {
  const line = renderTyped("/skill:ticket 42").map((raw) => stripTerminalSequences(raw)).find((plain) => plain.includes("/skill:ticket"));
  assert.ok(line);
  assert.doesNotMatch(line, /<ticket-id>/);
});

// ── AC-10.2 ─────────────────────────────────────────────────────────────────

FRONTMATTER_CASES.forEach((frontmatter, index) => {
  test(`argument-hint reads as YAML does: ${JSON.stringify(frontmatter)}`, () => {
    const parsed = YAML.parse(frontmatter) as Record<string, unknown>;
    const value = parsed["argument-hint"] ?? parsed.argumentHint ?? parsed.argument_hint;
    // The hint is shown on one line, so YAML's line breaks become single spaces.
    const expected = String(value).replace(/\s+/g, " ").trim();
    assert.equal(hintAfter(`skill:case-${index}`), expected);
  });
});
