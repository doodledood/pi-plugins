# managed-chrome-devtools

Manage a persistent Chrome DevTools MCP browser profile and wrapper from Pi.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/managed-chrome-devtools
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.3.1",
      "extensions": ["packages/extensions/managed-chrome-devtools/extensions/managed-chrome-devtools.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration and local state

`managed-chrome-devtools` creates and manages local machine state for Chrome DevTools MCP. These paths are generated on the installing machine and should not be committed:

- Wrapper script: `~/.local/bin/chrome-devtools-mcp-managed`
- Chrome profile: `~/.cache/chrome-devtools-mcp/manual-profile`
- Chrome log: `~/.cache/chrome-devtools-mcp/chrome-managed.log`

The extension writes or refreshes the wrapper script on session start. It uses a dedicated Chrome profile so browser state is isolated from the user's normal Chrome profile.

### Environment overrides

Set these locally when the defaults do not fit your machine:

- `CHROME_DEVTOOLS_PORT` — DevTools port, defaults to `9222`.
- `CHROME_DEVTOOLS_PROFILE` — Chrome user-data-dir for the managed profile.
- `CHROME_DEVTOOLS_LOG_FILE` — log file path.
- `CHROME_DEVTOOLS_CHROME_BIN` — Chrome/Chromium executable path when auto-detection fails.
- `CHROME_DEVTOOLS_WAIT_ATTEMPTS` — readiness polling attempts for the wrapper.
- `CHROME_DEVTOOLS_WAIT_SLEEP` — seconds between readiness polls.

### MCP setup requirement

Configure the `chrome-devtools` MCP server to run the managed wrapper. Example Pi `mcp.json` entry:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "~/.local/bin/chrome-devtools-mcp-managed",
      "args": [],
      "directTools": true
    }
  }
}
```

Run `/managed-chrome doctor` or call `managed_chrome_status({"start": true})` to print the exact wrapper path and setup snippet for the current machine.
