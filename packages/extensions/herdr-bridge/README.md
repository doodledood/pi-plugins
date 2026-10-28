# pi-herdr-bridge

Run several Pi sessions side by side in [Herdr](https://herdr.dev) and let one of them start and follow the others.

- **`start_agent_session`** starts a separate, interactive Pi session in a folder, in its own Herdr tab, with a first prompt. You can switch to it and type in it like any session you opened yourself.
- **Wake-ups.** The session that started it gets a message when the started session finishes a turn, stops at a question, stays working for 10 minutes with no change, or exits. A message that arrives while the starting session is busy waits until its turn ends.
- **Accurate status.** Any Pi waiting at a dialog — `ask_user_question`, a select, a confirm — shows in Herdr as **blocked**, so you can see it needs you, and Herdr refuses `herdr agent prompt` to it instead of typing into the dialog.

Listing, reading, messaging and stopping sessions stay with Herdr's own agent commands, which Herdr's agent skill documents. The package never closes a pane, types into another session, or answers a dialog on its own: a blocked wake-up gives the starting session the question, its options and the exact Herdr commands that answer it, and the model decides.

This is what makes the manifest-dev `/orchestrate` skill work on Pi: it starts each run "by whatever means the host offers", reads whether the run's session is alive, and checks in when a run ends or every ten minutes.

## Prerequisites

- Herdr, with Pi running inside its panes. Tested with Herdr 0.9.5.
- Herdr's Pi integration: `herdr integration install pi`. It reports each Pi's state to Herdr; the bridge's blocked status reaches Herdr through it, as the `herdr:blocked` event on Pi's event bus.
- Herdr's agent skill, for following sessions: `herdr --skill` prints it.

## Install

With the rest of this repository:

```bash
pi install git:github.com/doodledood/pi-plugins@main
```

Only this extension, through a package filter in `settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/herdr-bridge/extensions/herdr-bridge/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

From a clone: `pi install /path/to/pi-plugins/packages/extensions/herdr-bridge`. Once published to npm: `pi install npm:@doodledood/pi-herdr-bridge`.

It is safe to install everywhere: outside a Herdr pane, and in print, JSON or RPC mode, it registers nothing and runs nothing. Within one Pi process only the primary interactive session acts; in-process children — subagents, `/panel` panelists, `/btw` asides — do not.

## Use it

Open Herdr, start `pi` in a pane, and ask it for sessions in plain words — "create 2 sessions in ~/code/api that each review one module", or run `/orchestrate`. The model calls `start_agent_session`, and each new session appears in Herdr's sidebar under a workspace for its folder: an existing workspace whose panes already work in that folder is reused, otherwise one is created. Click a session or use Herdr's keys to switch to it.

The starting session then hears about each one:

| Wake-up | When | What it says |
|---|---|---|
| finished | the session finishes a turn (Herdr's idle or done) | how to read it, message it, or close it |
| waiting at a question | the session is blocked at a dialog | its screen, the question and options, and the Herdr commands that answer it |
| still working | the session stays working with no change for 10 minutes, and every 10 minutes after | how to check on it and stop it past its timeout |
| exited | the session's Pi exits or its pane closes | that its session file stays on disk |

Only sessions this session started wake it; one you started by hand never does. Each quiet-interval wake-up costs one turn of the starting session. While any started session is open, the bridge reads `herdr agent list` every 2 seconds; a session stays followed until it exits or its pane closes, so close finished sessions you no longer need. If Herdr cannot be read three times in a row, the starting session is woken once to say wake-ups are not arriving.

To follow sessions, the model uses Herdr's commands: `herdr agent list`, `herdr agent get <name>`, `herdr agent read <name> --source recent --lines 80`, `herdr agent prompt <name> "<text>"`, `herdr agent send-keys <name> <keys>` for a waiting dialog, and `herdr pane close <pane>` to stop a session it started.

### When a started session fails to start

The tool reports why: Herdr not reachable, a folder that does not exist, Pi not ready within Herdr's start timeout, or a first prompt that never landed. It closes nothing, so when a start fails partway the error names the workspace, tab or pane it left and the command that closes it.

## What it reads and writes

- **Environment:** `HERDR_ENV` and `HERDR_PANE_ID`, set by Herdr in its panes, decide whether it acts. `PI_CODING_AGENT_DIR`, when set, is passed to each started session's tab, so it runs with the same agent directory. `HERDR_BRIDGE_QUIET_INTERVAL_MS` overrides the 10-minute quiet interval; the end-to-end checks use it to run fast.
- **Herdr commands:** `agent list`, `agent get`, `agent read`, `pane list`, and, to start a session, `workspace create` or `tab create`, `agent start --kind pi` and `agent prompt`.
- **Files read:** when Herdr reports a first prompt stalled, the started session's own Pi session file (its path comes from Herdr), read-only, to see whether the prompt landed before typing it again. A slash-command prompt, or one whose session file Herdr does not report, is never typed twice.
- **Its own session:** custom entries `herdr-bridge-started`, `herdr-bridge-phase` and `herdr-bridge-ended` in the starting session, so a `/reload` or a resume keeps following the sessions it started, and a session that exited meanwhile is reported once. Nothing is written anywhere else.

## Verify it

```bash
npm run test --workspace @doodledood/pi-herdr-bridge       # unit tests against a fake Herdr
npm run e2e --workspace @doodledood/pi-herdr-bridge        # real Herdr, scripted fake model; a few minutes, free
npm run contract --workspace @doodledood/pi-herdr-bridge   # real model; spends credit
```

Or through the repository's harness: `scripts/verify drive herdr-bridge`, and `scripts/verify drive herdr-bridge-contract --yes` for the paid contract runs.

The end-to-end run starts a Herdr session of its own and a temporary Pi agent directory outside the repository, and removes both; it never touches your default Herdr session or `~/.pi/agent`. Its Pis run on a scripted fake provider and load Pi's own dialogs and `ask_user_question` from your install, read-only. One scenario also loads your installed packages, except the MCP adapter, which would reach your MCP servers and your operating system's credential store.

The contract runs put a real orchestrator, on your configured default model, in front of three requests: `/orchestrate`'s own launch and check-in wording (read from the installed skill at run time), "please create 2 sessions in <folder> that tell me a joke", and an explicit request for a background subagent, which must still get a subagent. Each case passes three runs out of three; one run of each costs about $0.10–0.20 of orchestrator spend.

## Uninstall

Remove the package or its filter entry from `settings.json`, or disable it in `pi config`. Started sessions keep running in Herdr; nothing else is left behind.
