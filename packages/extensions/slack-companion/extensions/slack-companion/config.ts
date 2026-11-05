// Configuration: ~/.pi/agent/slack-companion.json (the agent directory honours
// PI_CODING_AGENT_DIR). Every key is optional; an invalid file fails loudly and leaves the
// package off rather than guessing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";

const KEY_RE = /^((ctrl|alt|shift)\+)*([a-z0-9]|f([1-9]|1[0-2])|enter|tab|space|escape|up|down|left|right|home|end|pageup|pagedown)$/;

export interface ToolNames {
  readChannel: string;
  readThread: string;
  sendMessage: string;
  userProfile: string;
}

export interface SlackCompanionConfig {
  /** Nothing watches or sends until this is true (or `/slack on`). */
  enabled: boolean;
  /** MCP server name to pass with every call; unset lets the adapter resolve the tool. */
  server?: string;
  tools: ToolNames;
  pollSeconds: number;
  /** "provider/model-id" for the speak-or-stay-silent check; unset picks the cheapest model of the session's provider. */
  triageModel?: string;
  pauseAfterSends: number;
  quietHours: number;
  marker: string;
  panelKey: KeyId;
  /** Domains the helper's sandboxed shell may reach. An allowed domain can also receive writes. */
  allowedDomains: string[];
  /** MCP tools the helper may use although their server does not mark them read-only. */
  investigativeTools: string[];
  /**
   * MCP servers whose tools reach no helper unless listed as `server/tool` in investigativeTools,
   * though marked read-only: the ones that drive the owner's logged-in browser, plus any the owner
   * adds. The owner's own Slack server is always private as well.
   */
  privateServers: string[];
  /**
   * Folders in the home the helper may read besides the project. The rest of the home is closed
   * to it: credentials live in too many places there to list them.
   */
  readableFolders: string[];
  /** Daily spend cap per conversation in USD; unset means no cap. */
  spendCapUsdPerDay?: number;
}

export const DEFAULT_CONFIG: SlackCompanionConfig = {
  enabled: false,
  tools: {
    readChannel: "slack_read_channel",
    readThread: "slack_read_thread",
    sendMessage: "slack_send_message",
    userProfile: "slack_read_user_profile",
  },
  pollSeconds: 60,
  pauseAfterSends: 5,
  quietHours: 24,
  marker: "🤖",
  panelKey: "alt+s",
  allowedDomains: [],
  investigativeTools: [],
  privateServers: ["chrome-devtools", "playwright", "puppeteer", "filesystem"],
  readableFolders: [],
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function configPath(agentDir: string): string {
  return join(agentDir, "slack-companion.json");
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConfigError(message);
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

/** Parse a config object; unknown keys are rejected so a typo cannot silently do nothing. */
export function parseConfig(raw: unknown): SlackCompanionConfig {
  expect(!!raw && typeof raw === "object" && !Array.isArray(raw), "the config must be a JSON object");
  const input = raw as Record<string, unknown>;
  const known = new Set([...Object.keys(DEFAULT_CONFIG), "server", "triageModel", "spendCapUsdPerDay"]);
  for (const key of Object.keys(input)) expect(known.has(key), `unknown config key "${key}"`);
  const config: SlackCompanionConfig = { ...DEFAULT_CONFIG, tools: { ...DEFAULT_CONFIG.tools } };
  if ("enabled" in input) {
    expect(typeof input.enabled === "boolean", "enabled must be true or false");
    config.enabled = input.enabled;
  }
  if ("server" in input) {
    expect(isText(input.server), "server must be a non-empty string");
    config.server = input.server;
  }
  if ("tools" in input) {
    const tools = input.tools as Record<string, unknown>;
    expect(!!tools && typeof tools === "object" && !Array.isArray(tools), "tools must be an object");
    for (const [key, value] of Object.entries(tools)) {
      expect(key in config.tools, `unknown tools key "${key}"`);
      expect(isText(value), `tools.${key} must be a non-empty string`);
      config.tools[key as keyof ToolNames] = value;
    }
  }
  const positive = (key: "pollSeconds" | "pauseAfterSends" | "quietHours", min: number) => {
    if (!(key in input)) return;
    const value = input[key];
    expect(typeof value === "number" && Number.isFinite(value) && value >= min, `${key} must be a number of at least ${min}`);
    config[key] = value;
  };
  positive("pollSeconds", 10);
  positive("pauseAfterSends", 1);
  positive("quietHours", 1);
  if ("triageModel" in input) {
    expect(isText(input.triageModel) && input.triageModel.includes("/"), 'triageModel must look like "provider/model-id"');
    config.triageModel = input.triageModel;
  }
  if ("marker" in input) {
    expect(typeof input.marker === "string", "marker must be a string");
    config.marker = input.marker;
  }
  if ("panelKey" in input) {
    expect(typeof input.panelKey === "string" && KEY_RE.test(input.panelKey), 'panelKey must be a key such as "alt+s" (modifiers ctrl, alt, shift joined by +, then one key)');
    config.panelKey = input.panelKey as KeyId;
  }
  if ("allowedDomains" in input) {
    expect(isTextList(input.allowedDomains), "allowedDomains must be a list of domains");
    config.allowedDomains = input.allowedDomains;
  }
  if ("investigativeTools" in input) {
    expect(isTextList(input.investigativeTools), "investigativeTools must be a list of tool names");
    config.investigativeTools = input.investigativeTools;
  }
  if ("privateServers" in input) {
    expect(isTextList(input.privateServers), "privateServers must be a list of MCP server names");
    // Added to the built-in list, never in place of it: adding a mail server must not open the browser.
    config.privateServers = [...new Set([...DEFAULT_CONFIG.privateServers, ...input.privateServers])];
  }
  if ("readableFolders" in input) {
    expect(isTextList(input.readableFolders) && input.readableFolders.every((f) => isAbsolute(f) || f.startsWith("~/")), "readableFolders must be a list of absolute folders (or ~/…)");
    config.readableFolders = input.readableFolders;
  }
  if ("spendCapUsdPerDay" in input) {
    const cap = input.spendCapUsdPerDay;
    expect(typeof cap === "number" && cap > 0, "spendCapUsdPerDay must be a positive number");
    config.spendCapUsdPerDay = cap;
  }
  return config;
}

export function loadConfig(agentDir: string): SlackCompanionConfig {
  const path = configPath(agentDir);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, tools: { ...DEFAULT_CONFIG.tools } };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  try {
    return parseConfig(raw);
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
}

/** `/slack on`: set `enabled: true`, keeping every other key the owner wrote. */
export function enableInConfig(agentDir: string): void {
  const path = configPath(agentDir);
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, enabled: true }, null, 2)}\n`, { mode: 0o600 });
}
