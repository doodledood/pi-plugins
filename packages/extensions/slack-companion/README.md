# @doodledood/pi-slack-companion

The people your Pi session messages on Slack can work with it directly, without you relaying between them.

When your session sends someone a Slack message, Pi watches that conversation. When they reply, a read-only, sandboxed fork of your session — the **Slack helper** — answers them in the thread. Information they give goes to your session as their words. Anything that would change your work waits for your approval. You stop being both the doorbell ("they answered") and the send button ("ask them").

It is for people who run Pi with a Slack MCP server and want the conversations their sessions start to carry on without them, safely.

## How it works

1. **Start.** Your session sends a Slack message, or you run `/slack <link>` on a conversation someone else started. Pi watches that conversation: a direct message's top level, or one thread — never a whole channel.
2. **Watch.** Plain code reads each watched conversation about once a minute through your Slack MCP tools. It uses no model and no tokens.
3. **Filter.** The code skips your session's own posts, reactions and repeats, and handles `stop` itself. Each remaining batch of new messages gets one cheap call to a small model: does the agent have something to say? Most chat between people gets a no, and costs only that call.
4. **Answer.** Pi forks your session, as it is at that moment, into a helper in memory. The helper reads, investigates and replies in the thread — once per batch — or stays silent.
5. **Hand off.** The helper passes information your session asked for to your session as the sender's words. A request for an action waits in the panel for your approval; when you approve, your session gets exactly the text you saw, and the person is told.

## Prerequisites

- Pi 1.4.0 or newer.
- [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), with a Slack MCP server configured. The package calls Slack's tools from code through the adapter's documented runtime tool-call event, which Pi's built-in MCP support does not offer. Without the adapter the package loads and tells you it cannot watch.
- A Slack MCP server whose output the package can read. It reads the official Slack MCP server's detailed format (directly, or through a gateway that redacts emails). Tool names are configurable for servers that name the same tools differently.
- For the helper's shell: [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (installed with the package). macOS uses its built-in Seatbelt; Linux needs `bubblewrap`, `socat` and `ripgrep`. Where the sandbox cannot start, the helper runs without a shell.

## Install

Local clone:

```bash
pi install /absolute/path/to/pi-plugins/packages/extensions/slack-companion
```

npm (after publication):

```bash
pi install npm:@doodledood/pi-slack-companion
```

Only this package from the Git bundle, in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/slack-companion/extensions/slack-companion/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

The package is **off until you turn it on**: run `/slack on` once, or set `"enabled": true` in its config. An update of the whole bundle never starts answering anyone on your behalf.

## Use

| Command or key | What it does |
| --- | --- |
| `/slack on` | Turn the package on (writes `enabled: true`) and let messages this session sends start watches. |
| `/slack <link>` | Watch a conversation someone else started; the helper answers the part nobody has answered yet. |
| `/slack` or `alt+s` | Open the panel: watched conversations, what the helper did, and requests waiting for you (`a` approve, `d` deny, `r` resume, `s` stop). |
| `/slack off` | Messages this session sends stop starting watches (until `/slack on`). |
| `/slack stop` | Stop every watch in this session. |
| `stop` in Slack | Anyone in the conversation can type exactly `stop` to end the watch there. |

The session also gets a `slack_watch` tool, so you can say "handle this thread <link>" or "stop watching it".

One line above the editor shows each watch, what the helper last did, and how many requests wait for you. Main's transcript shows only your work and the hand-offs that reach your session.

A watch ends when the helper says the conversation has what it needed, when anyone types `stop`, when you stop it, after a quiet period, or when the session closes. Resume the session and it reads what arrived while it was closed. Nothing answers while Pi is closed or the machine is asleep.

## Safety model

- **The helper cannot change your work.** It loads no extension and has only these tools: `read`, `grep`, `find`, `ls`; a `bash` whose every command runs under sandbox-runtime, writing only to a scratch folder, with no network unless you allow domains; the MCP tools your session has that their server marks read-only (or that you list as investigative), called through your session's adapter; and its own `reply_in_slack` and `hand_off_to_main`. It has no edit, write or Slack-send tool and cannot reach your session's tools.
- **Secrets stay out.** The helper's file tools and shell cannot read `~/.ssh`, cloud credential folders, `.env` files, Pi's `auth.json` or MCP token stores. A reply containing something shaped like a key or token is not sent, and you are told.
- **Actions wait for you.** Anything that would change your work or cannot be undone becomes a request in the panel, showing the full text your session would receive. Only you, in Pi, approve it.
- **Slack can only take power away.** Nothing read from Slack approves anything, restarts a stopped conversation or lifts a restriction. Message text that imitates the server's format is caught: every new message is confirmed by a lookup of its own id.
- **What it does share.** Anyone who posts in a watched conversation is served, and the helper knows what your session knows, so replies can share session content with the people there. Read-only tools that reach the internet can carry content out. Watch only conversations whose readers you trust with that.
- **It does not spam.** At most one reply per batch of messages, in its own thread in channels, marked as your agent (the first message says whose agent it is). After 5 messages to one conversation without you, it pauses and asks you.

## Configuration

`~/.pi/agent/slack-companion.json` (the agent folder follows `PI_CODING_AGENT_DIR`). Every key is optional; an unknown key or a wrong type stops the package and names the problem.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Nothing watches or sends until true. |
| `tools` | `slack_read_channel`, `slack_read_thread`, `slack_send_message`, `slack_read_user_profile` | Your server's names for `readChannel`, `readThread`, `sendMessage`, `userProfile`. |
| `server` | unset | MCP server name to pass with every call, when tool names are ambiguous. |
| `pollSeconds` | `60` | How often each watch is read (minimum 10). |
| `triageModel` | the cheapest model of your session's provider | `"provider/model-id"` for the speak-or-stay-silent check; falls back to the session's model when no priced model exists. |
| `pauseAfterSends` | `5` | Messages to one conversation without you before it pauses. |
| `quietHours` | `24` | Hours without a message before a watch ends. |
| `marker` | `🤖` | Prefix on every message the agent sends. |
| `panelKey` | `alt+s` | Key that opens the panel. |
| `allowedDomains` | `[]` | Domains the helper's shell may reach. An allowed domain can also receive data. |
| `investigativeTools` | `[]` | MCP tools the helper may use although their server does not mark them read-only. |
| `spendCapUsdPerDay` | unset | Pause a conversation once its helpers and checks spend this much in a day. |

## Files it reads and writes

- Reads its config, above.
- Writes its state into your session file (custom entries, not sent to the model), so watches survive `/reload` and resume. Watches that ended, resolved requests, the send record and stopped conversations are each kept to a bounded number.
- Writes one lock file per watched conversation under `~/.pi/agent/slack-companion/locks/`, so two sessions on one machine never answer the same conversation. A session that ends releases its locks; a lock left by a session that died is taken over by the next one.
- Writes each helper's own entries, with their usage, under `<session file without .jsonl>/slack-companion/`, so session-tree cost accounting counts them. They are kept with the session and removed with it. A session not saved to a file writes none, and that spend cannot be attributed.
- Each triage call's cost is recorded in the session as a `pi-cost-record` entry.
- The helper's shell gets a scratch folder under the system temp folder.

## Known limits

- Nothing answers while Pi is closed or the machine is asleep; resume catches up.
- Pi's built-in MCP support has no way for code to call a tool, so it needs pi-mcp-adapter.
- Every read is an MCP call; Slack keeps audit logs of MCP activity, so a workspace's admins can see one read a minute per watch.
- Locks hold on one machine. Two machines watching the same direct message could both answer.
- A watch whose read fails (an expired login, a renamed tool, a format the parser cannot read) stops and says why; start it again with `/slack <link>` once fixed.

## Verify

```bash
npm run typecheck --workspace @doodledood/pi-slack-companion
npm run test --workspace @doodledood/pi-slack-companion
```

The tests run real Pi sessions in memory with a scripted model and a fake Slack server that writes the official server's formats; they reach no network and no Slack. `scripts/verify drive slack-companion` runs them as the project's recipe; `scripts/verify drive slack-companion-live` (ask first: it posts to your own Slack direct message) checks the parser against your real server.

## Uninstall

```bash
pi remove /absolute/path/to/pi-plugins/packages/extensions/slack-companion
```

Then delete `~/.pi/agent/slack-companion.json` and `~/.pi/agent/slack-companion/` if you want no trace. Helper records go with their sessions.
