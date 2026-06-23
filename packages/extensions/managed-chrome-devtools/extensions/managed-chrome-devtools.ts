import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXTENSION_NAME = "managed-chrome-devtools";
const DEFAULT_PORT = "9222";
const PORT = process.env.CHROME_DEVTOOLS_PORT ?? DEFAULT_PORT;
const WRAPPER_PATH = join(homedir(), ".local/bin/chrome-devtools-mcp-managed");
const PROFILE_PATH = join(homedir(), ".cache/chrome-devtools-mcp/manual-profile");
const LOG_FILE = join(homedir(), ".cache/chrome-devtools-mcp/chrome-managed.log");
const BROWSER_URL = `http://127.0.0.1:${PORT}`;
const READY_CACHE_MS = 30_000;
const MCP_WARNING_THROTTLE_MS = 5 * 60_000;

let lastReadyAt = 0;
let lastMcpMissingWarningAt = 0;

const WRAPPER_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "",
  "PORT=\"${CHROME_DEVTOOLS_PORT:-9222}\"",
  "PROFILE=\"${CHROME_DEVTOOLS_PROFILE:-$HOME/.cache/chrome-devtools-mcp/manual-profile}\"",
  "BROWSER_URL=\"http://127.0.0.1:${PORT}\"",
  "LOG_FILE=\"${CHROME_DEVTOOLS_LOG_FILE:-$HOME/.cache/chrome-devtools-mcp/chrome-managed.log}\"",
  "",
  "is_ready() {",
  "  curl -fsS \"${BROWSER_URL}/json/version\" >/dev/null 2>&1",
  "}",
  "",
  "find_chrome() {",
  "  if [[ -n \"${CHROME_DEVTOOLS_CHROME_BIN:-}\" ]]; then",
  "    printf '%s\\n' \"$CHROME_DEVTOOLS_CHROME_BIN\"",
  "    return 0",
  "  fi",
  "",
  "  case \"$(uname -s)\" in",
  "    Darwin)",
  "      for candidate in \\",
  "        \"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\" \\",
  "        \"/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta\" \\",
  "        \"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary\" \\",
  "        \"/Applications/Chromium.app/Contents/MacOS/Chromium\"; do",
  "        if [[ -x \"$candidate\" ]]; then",
  "          printf '%s\\n' \"$candidate\"",
  "          return 0",
  "        fi",
  "      done",
  "      ;;;;;;",
  "    Linux)",
  "      for candidate in google-chrome-stable google-chrome chromium chromium-browser; do",
  "        if command -v \"$candidate\" >/dev/null 2>&1; then",
  "          command -v \"$candidate\"",
  "          return 0",
  "        fi",
  "      done",
  "      ;;;;;;",
  "  esac",
  "",
  "  return 1",
  "}",
  "",
  "start_chrome() {",
  "  local chrome_bin",
  "  chrome_bin=\"$(find_chrome)\" || {",
  "    echo \"Could not find Chrome. Set CHROME_DEVTOOLS_CHROME_BIN to the Chrome executable path.\" >&2",
  "    exit 1",
  "  }",
  "",
  "  mkdir -p \"$PROFILE\" \"$(dirname \"$LOG_FILE\")\"",
  "",
  "  # Launch Chrome ourselves, then let chrome-devtools-mcp attach to it. This avoids",
  "  # MCP/Puppeteer launch defaults such as --enable-automation while keeping a",
  "  # dedicated persistent profile for cross-harness reuse.",
  "  nohup \"$chrome_bin\" \\",
  "    --remote-debugging-address=127.0.0.1 \\",
  "    --remote-debugging-port=\"$PORT\" \\",
  "    --remote-allow-origins='*' \\",
  "    --user-data-dir=\"$PROFILE\" \\",
  "    --no-first-run \\",
  "    --no-default-browser-check \\",
  "    about:blank \\",
  "    >>\"$LOG_FILE\" 2>&1 &",
  "}",
  "",
  "wait_until_ready() {",
  "  local attempts=\"${CHROME_DEVTOOLS_WAIT_ATTEMPTS:-100}\"",
  "  local sleep_s=\"${CHROME_DEVTOOLS_WAIT_SLEEP:-0.2}\"",
  "",
  "  for ((i = 1; i <= attempts; i++)); do",
  "    if is_ready; then",
  "      return 0",
  "    fi",
  "    sleep \"$sleep_s\"",
  "  done",
  "",
  "  echo \"Chrome did not expose DevTools at ${BROWSER_URL} after ${attempts} attempts.\" >&2",
  "  echo \"Chrome profile: ${PROFILE}\" >&2",
  "  echo \"Chrome log: ${LOG_FILE}\" >&2",
  "  exit 1",
  "}",
  "",
  "if ! is_ready; then",
  "  start_chrome",
  "  wait_until_ready",
  "fi",
  "",
  "case \"${1:-}\" in",
  "  --start-only)",
  "    echo \"Chrome DevTools ready at ${BROWSER_URL}\"",
  "    echo \"Profile: ${PROFILE}\"",
  "    exit 0",
  "    ;;;;;;",
  "  --print-config)",
  "    echo \"BROWSER_URL=${BROWSER_URL}\"",
  "    echo \"PROFILE=${PROFILE}\"",
  "    echo \"LOG_FILE=${LOG_FILE}\"",
  "    exit 0",
  "    ;;;;;;",
  "esac",
  "",
  "exec npx -y chrome-devtools-mcp@latest \\",
  "  --browserUrl \"$BROWSER_URL\" \\",
  "  --no-usage-statistics \\",
  "  \"$@\"",
  "",
].join("\n").replaceAll(";;;;;;", ";;");

function setupSnippet(): string {
  return [
    "Managed Chrome DevTools setup:",
    `- Wrapper: ${WRAPPER_PATH}`,
    `- Profile: ${PROFILE_PATH}`,
    `- Browser URL: ${BROWSER_URL}`,
    "- Start command: /managed-chrome start",
    `- Direct start command: ${WRAPPER_PATH} --start-only`,
    "",
    "Configure the chrome-devtools MCP server to use the managed wrapper, then reload Pi.",
    "",
    "Pi / MCP JSON:",
    "```json",
    JSON.stringify(
      {
        mcpServers: {
          "chrome-devtools": {
            command: WRAPPER_PATH,
            args: [],
            directTools: true,
          },
        },
      },
      null,
      2,
    ),
    "```",
    "",
    "Codex TOML:",
    "```toml",
    "[mcp_servers.chrome-devtools]",
    `command = "${WRAPPER_PATH}"`,
    "args = []",
    "```",
  ].join("\n");
}

function ensureWrapper(): { updated: boolean } {
  const current = existsSync(WRAPPER_PATH) ? readFileSync(WRAPPER_PATH, "utf8") : undefined;
  if (current === WRAPPER_SCRIPT) {
    chmodSync(WRAPPER_PATH, 0o755);
    return { updated: false };
  }

  mkdirSync(dirname(WRAPPER_PATH), { recursive: true });
  writeFileSync(WRAPPER_PATH, WRAPPER_SCRIPT, "utf8");
  chmodSync(WRAPPER_PATH, 0o755);
  return { updated: current !== undefined };
}

async function isDevtoolsReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BROWSER_URL}/json/version`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startChrome(): Promise<{ ok: boolean; output: string }> {
  ensureWrapper();
  try {
    const { stdout, stderr } = await execFileAsync(WRAPPER_PATH, ["--start-only"], {
      timeout: 30_000,
      env: process.env,
    });
    lastReadyAt = Date.now();
    return { ok: true, output: [stdout, stderr].filter(Boolean).join("\n").trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim(),
    };
  }
}

async function ensureChromeReady(): Promise<{ ok: boolean; output: string; cached: boolean }> {
  if (Date.now() - lastReadyAt < READY_CACHE_MS) {
    return { ok: true, output: "Chrome DevTools readiness was checked recently.", cached: true };
  }

  if (await isDevtoolsReachable()) {
    lastReadyAt = Date.now();
    return { ok: true, output: `Chrome DevTools is reachable at ${BROWSER_URL}.`, cached: false };
  }

  const result = await startChrome();
  return { ...result, cached: false };
}

function chromeDevtoolsVisible(pi: ExtensionAPI): boolean | undefined {
  try {
    const commands = JSON.stringify(pi.getCommands?.() ?? []);
    if (commands.includes("chrome_devtools_")) return true;
    if (commands.includes("chrome-devtools")) return true;
    return false;
  } catch {
    return undefined;
  }
}

function statusText(pi: ExtensionAPI, reachable: boolean): string {
  const mcpVisible = chromeDevtoolsVisible(pi);
  return [
    "Managed Chrome DevTools status:",
    `- Wrapper: ${WRAPPER_PATH}`,
    `- Profile: ${PROFILE_PATH}`,
    `- Browser URL: ${BROWSER_URL}`,
    `- Chrome reachable: ${reachable ? "yes" : "no"}`,
    `- chrome-devtools MCP visible to Pi: ${mcpVisible === undefined ? "unknown" : mcpVisible ? "yes" : "no"}`,
    reachable ? undefined : "- Start command: /managed-chrome start",
    !reachable || mcpVisible === false ? "" : undefined,
    !reachable || mcpVisible === false ? setupSnippet() : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function connectionFailureText(content: Array<{ type: string; text?: string }>): string {
  return content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

export default function managedChromeDevtools(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const wrapper = ensureWrapper();
    const mcpVisible = chromeDevtoolsVisible(pi);
    if (ctx.hasUI && wrapper.updated) {
      ctx.ui.notify(`${EXTENSION_NAME}: refreshed ${WRAPPER_PATH}`, "info");
    }
    if (ctx.hasUI && mcpVisible === false && Date.now() - lastMcpMissingWarningAt > MCP_WARNING_THROTTLE_MS) {
      lastMcpMissingWarningAt = Date.now();
      ctx.ui.notify(`${EXTENSION_NAME}: chrome-devtools MCP tools are not visible. Run /managed-chrome config for setup guidance.`, "warning");
    }
  });

  pi.on("tool_call", async (event) => {
    if (!event.toolName.startsWith("chrome_devtools_")) return;

    const ready = await ensureChromeReady();
    if (!ready.ok) {
      return {
        block: true,
        reason: [
          `${EXTENSION_NAME}: could not start managed Chrome before ${event.toolName}.`,
          ready.output,
          `Wrapper: ${WRAPPER_PATH}`,
          `Profile: ${PROFILE_PATH}`,
          `Browser URL: ${BROWSER_URL}`,
          "Start command: /managed-chrome start",
          `Direct start command: ${WRAPPER_PATH} --start-only`,
        ].filter(Boolean).join("\n"),
      };
    }
  });

  pi.on("tool_result", async (event) => {
    if (!event.toolName.startsWith("chrome_devtools_")) return;

    const text = connectionFailureText(event.content as Array<{ type: string; text?: string }>);
    if (!/Could not connect to Chrome|Failed to fetch browser webSocket URL|DevToolsActivePort/i.test(text)) return;

    const ready = await ensureChromeReady();
    return {
      content: [
        ...event.content,
        {
          type: "text",
          text: [
            "",
            `${EXTENSION_NAME}: Chrome DevTools recovery hint`,
            ready.ok
              ? `Managed Chrome is now reachable at ${BROWSER_URL}. Retry the Chrome DevTools tool call.`
              : `Managed Chrome is still not reachable. Run /managed-chrome doctor or /managed-chrome start. ${ready.output}`,
            `Wrapper: ${WRAPPER_PATH}`,
            `Profile: ${PROFILE_PATH}`,
            `Browser URL: ${BROWSER_URL}`,
            "Start command: /managed-chrome start",
            `Direct start command: ${WRAPPER_PATH} --start-only`,
          ].join("\n"),
        },
      ],
    };
  });

  pi.registerCommand("managed-chrome", {
    description: "Diagnose or start the managed Chrome used by chrome-devtools MCP",
    handler: async (args, ctx) => {
      const command = args.trim() || "doctor";

      if (command === "start") {
        const result = await startChrome();
        ctx.ui.notify(result.ok ? result.output || "Managed Chrome started." : result.output, result.ok ? "info" : "error");
        return;
      }

      if (command === "config" || command === "setup" || command === "snippet") {
        ctx.ui.notify(setupSnippet(), "info");
        return;
      }

      if (command !== "doctor" && command !== "status") {
        ctx.ui.notify("Usage: /managed-chrome [doctor|start|config]", "error");
        return;
      }

      const reachable = await isDevtoolsReachable();
      ctx.ui.notify(statusText(pi, reachable), reachable && chromeDevtoolsVisible(pi) !== false ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "managed_chrome_status",
    label: "Managed Chrome Status",
    description: "Check or start the managed Chrome instance used by chrome-devtools MCP. Use this when Chrome DevTools browser tools are unavailable or cannot connect.",
    promptSnippet: "Check/start the managed Chrome instance backing chrome-devtools MCP",
    promptGuidelines: [
      "Use managed_chrome_status when chrome_devtools tools are missing or report that Chrome cannot be reached; it diagnoses the wrapper and returns the MCP setup snippet when needed.",
    ],
    parameters: {
      type: "object",
      properties: {
        start: {
          type: "boolean",
          description: "Start managed Chrome if it is not reachable",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      ensureWrapper();
      const reachableBefore = await isDevtoolsReachable();
      const startResult = params.start && !reachableBefore ? await startChrome() : undefined;
      const reachableAfter = await isDevtoolsReachable();

      return {
        content: [
          {
            type: "text",
            text: [
              `Wrapper: ${WRAPPER_PATH}`,
              `Profile: ${PROFILE_PATH}`,
              `Browser URL: ${BROWSER_URL}`,
              "Start command: /managed-chrome start",
              `Direct start command: ${WRAPPER_PATH} --start-only`,
              `Reachable before: ${reachableBefore ? "yes" : "no"}`,
              startResult ? `Start result: ${startResult.ok ? "ok" : "failed"}${startResult.output ? `\n${startResult.output}` : ""}` : undefined,
              `Reachable now: ${reachableAfter ? "yes" : "no"}`,
              "",
              "If chrome_devtools_* tools are not available, configure chrome-devtools MCP to use the wrapper and reload Pi:",
              setupSnippet(),
            ].filter((line): line is string => line !== undefined).join("\n"),
          },
        ],
        details: {
          wrapperPath: WRAPPER_PATH,
          profilePath: PROFILE_PATH,
          browserUrl: BROWSER_URL,
          reachableBefore,
          reachableAfter,
          started: Boolean(startResult?.ok),
        },
      };
    },
  });
}
