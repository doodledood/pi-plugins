# @doodledood/pi-slack-companion

The people your Pi session messages on Slack can work with it directly. You do not relay between them.

When your session sends someone a Slack message, Pi watches that conversation. When they reply, a read-only, sandboxed fork of your session answers them in the thread. This fork is the **Slack helper**. Information they give goes to your session as their words. Anything that would change your work waits for your approval.

It is for people who run Pi with a Slack MCP server and want the conversations their sessions start to continue safely without them.

## How it works

1. **Start.** Your session sends a Slack message, or you run `/slack <link>` on a conversation someone else started. Pi then watches that conversation: the top level of a direct message, or one thread. It never watches a whole channel.
2. **Watch.** Plain code reads each watched conversation about once a minute through your Slack MCP tools. This uses no model and no tokens.
3. **Filter.** The code skips your session's own posts, reactions and repeats. It handles `stop` itself. Each remaining batch of new messages gets one call to a small, cheap model, which decides if the agent has something to say. Most chat between people gets a "no", and costs only that call.
4. **Answer.** Pi forks your session, as it is at that moment, into a helper in memory. The helper reads, investigates and replies in the thread, at most once per batch. It can also stay silent.
5. **Hand off.** The helper gives information your session asked for to your session, as the sender's words. A request for an action waits in the panel for your approval. When you approve, your session gets exactly the text you saw, and the person is told.

## Prerequisites

- Pi 1.4.0 or newer.
- [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), with a Slack MCP server configured. The package calls Slack's tools from code through the adapter's runtime tool-call event. Pi's built-in MCP support has no such event. Without the adapter, the package loads and tells you that it cannot watch.
- A Slack MCP server whose output the package can read. The package reads the detailed format of the official Slack MCP server, directly or through a gateway that hides emails. You can set the tool names for a server that uses different names.
- For the helper's shell: [sandbox-runtime](https://github.com/anthropics/sandbox-runtime), which installs with the package. macOS uses its built-in Seatbelt. Linux needs `bubblewrap`, `socat` and `ripgrep`. If the sandbox cannot start, the helper has no shell.

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

The package is **off until you turn it on**. Run `/slack on` once, or set `"enabled": true` in its config. An update of the whole bundle never starts to answer anyone for you.

## Use

| Command or key | What it does |
| --- | --- |
| `/slack on` | Turns the package on (writes `enabled: true`). Messages this session sends then start watches. |
| `/slack <link>` | Watches a conversation someone else started, or one that someone stopped. In a thread, the helper answers the part after your last message there. In a direct message, it answers what comes after the linked message. |
| `/slack` or `alt+s` | Opens the panel. See *The panel* below. |
| `/slack off` | Messages this session sends no longer start watches, until `/slack on`. |
| `/slack stop` | Stops every watch in this session. |
| `stop` in Slack | Anyone in the conversation can send a message that is only the word `stop` (any case). This ends the watch there. A later send from your session does not start it again; `/slack <link>` does. |

The session also gets a `slack_watch` tool. You can tell it "handle this thread <link>" or "stop watching it". The tool cannot restart a conversation that someone stopped; only you can, with `/slack <link>` or `w` in the panel.

One line above the editor shows each watch, what the helper did last, and the requests that wait for you. Paused watches come first, then watches whose helper is answering now. Your session's transcript shows only your work and the hand-offs that reach your session.

### The panel

- Requests that wait for you come first, with their full text, who asked, and when. Press `a` to approve or `d` to deny. You can approve a request only after you saw all of it. A long request scrolls with `↓`, `space` or `PgDn`, and who asked stays in view.
- Watched conversations come next: paused ones, then ones that stopped with an error you have not seen, then the rest. Each shows its last few events and times. Press `s` to stop one, or `r` to resume a paused one.
- Ended conversations come last, newest first. A watch that stopped with an error always shows. Press `w` to watch it again. The panel shows the last three quiet ends; press `enter` on "N more ended" to see all.

### When a watch ends or pauses

- A watch ends when the helper says the conversation has what it needed, when anyone sends `stop`, when you stop it, or after a quiet period.
- A watch pauses after it sends 5 messages without you, or when its daily spend cap is reached. Your next message in Pi resumes a watch paused for the message count. A spend-cap pause waits for you to press `r`, which lifts the cap for the rest of that day. A reply the helper wrote during a pause waits and goes out as written when you resume.
- While a watch is paused, at most 20 messages wait for you; older ones stay only as context. One conversation can have at most 10 requests waiting for you.
- If a read fails for a reason that can pass (a rate limit, a dropped connection), the watch tries again at the next read. After 5 failures in a row, or at once for a problem that does not pass, it stops and tells you why. If your Slack login expires, the watch stops and tells you to run `/mcp-auth`; then press `w`.
- Requests that wait for you stay in the panel after their watch ends, until you approve or deny them. While the watch is live, your approval or denial is sent to the person, even during a pause. After the watch ends, the person is not told; an approved request still goes to your session, which can report the result there.
- Watches come back when you resume the session. Pi then reads what arrived while it was closed. Nothing answers while Pi is closed or the machine sleeps.

## Safety model

**The helper cannot change your work.** It loads no extension. It has only these tools:

- `read`, `grep`, `find` and `ls`.
- A `bash` shell. Every command runs under sandbox-runtime. The shell can write only to its scratch folder, `$SCRATCH`. It has no network unless you allow domains. It gets no environment variable whose name looks like a credential.
- Every MCP tool that its server marks read-only, plus the tools you list as investigative. The ones your session has active now, and the listed ones, are tools of their own. The helper finds and calls the rest through two tools, `search_read_only_tools` and `call_read_only_tool`, so its prompt stays small. The helper calls them all through your session's adapter.
- Its own `reply_in_slack` and `hand_off_to_main`.

It has no edit, write or Slack-send tool, and it cannot use your session's other tools. Pi loads no extension for it, so no extension code runs when a helper starts. A helper run stops after 25 model turns.

**Secrets stay out.**

- The helper's file tools and shell cannot read `~/.ssh`, cloud credential folders or MCP token stores.
- They cannot read files named like credentials anywhere under your home or project: `.env`, `.env.*`, `auth.json`, `.netrc`, `.npmrc`, `.pgpass`, `credentials`, SSH keys, `mcp.json` and `mcp-adapter.json`.
- The file tools check the path that they will open, so `~`, `@` and `file://` forms do not get past the check. Search output drops lines from these files, context lines too.
- The package does not send a reply that contains something shaped like a key or token. It tells you instead.

**Actions wait for you.** The helper turns anything that would change your work, or that cannot be undone, into a request in the panel. Only you, in Pi, can approve it. Your session gets an approved request marked `[Slack approval]`, and information marked `[Slack hand-off]`. Slack text and display names cannot carry these markers, and cannot fake the quotes that the helper reads: the package replaces them with look-alike characters.

**Nothing from Slack gives more permission.** Nothing read from Slack approves anything, restarts a stopped conversation or removes a limit. Text that copies the server's format cannot add or change a message:

- The package confirms every new message by a lookup of its own id. The lookup gives the true author and text.
- It also checks that the message is in the watched conversation. In a thread, text in the thread's first message cannot pass this check. The package skips an id only when a read that succeeded shows that the id is not there, and then it tells you.
- It confirms at most 15 messages per watch per read. The rest wait for the next read. A burst of messages is slow, but none is skipped.

**What the helper can share.** The package serves anyone who posts in a watched conversation. The helper knows what your session knows, so its replies can share session content with the people there. A read-only tool that reaches the internet can carry content out. Watch only conversations whose readers you trust with that.

**It does not spam.** It sends at most one reply per batch of messages. In channels, it replies only in the thread. It marks every message as your agent's. The first message in a conversation says whose agent it is.

## Configuration

The config file is `~/.pi/agent/slack-companion.json`. The agent folder follows `PI_CODING_AGENT_DIR`. Every key is optional. An unknown key or a wrong type stops the package and names the problem.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Nothing watches or sends until this is true. |
| `tools` | `slack_read_channel`, `slack_read_thread`, `slack_send_message`, `slack_read_user_profile` | Your server's names for `readChannel`, `readThread`, `sendMessage`, `userProfile`. |
| `server` | unset | The MCP server name to pass with every call, when tool names are ambiguous. |
| `pollSeconds` | `60` | How often each watch is read. The minimum is 10. |
| `triageModel` | the cheapest priced model of your session's provider | `"provider/model-id"` for the speak-or-stay-silent check. If that model is not available, or no priced model exists, the check uses your session's model and tells you. |
| `pauseAfterSends` | `5` | Messages to one conversation without you before it pauses. |
| `quietHours` | `24` | Hours without a message before a watch ends. |
| `marker` | `🤖` | The prefix on every message the agent sends. |
| `panelKey` | `alt+s` | The key that opens the panel. |
| `allowedDomains` | `[]` | Domains the helper's shell can reach. An allowed domain can also receive data. |
| `investigativeTools` | `[]` | MCP tools the helper can use although their server does not mark them read-only. They are also shown to it as tools of their own. Write `tool` or `server/tool`. |
| `spendCapUsdPerDay` | unset | Pause a conversation when its helpers and checks spend this much in one day. |

## Files it reads and writes

- It reads its config, above. It also reads pi-mcp-adapter's tool cache, `~/.pi/agent/mcp-cache.json`, to check the Slack tool names at start and to find the MCP tools that their servers mark read-only.
- It writes its state into your session file as custom entries, which the model does not see. This lets watches survive `/reload` and resume. It writes a snapshot only when something changed. Each part of the state has a limit, and an ended watch keeps only what the panel needs. If a later version of the package cannot read a saved snapshot, it keeps the requests that wait for you and names the watches it lost.
- It writes one lock file per watched conversation under `~/.pi/agent/slack-companion/locks/`. Two sessions on one machine then never answer the same conversation. A session that ends releases its locks. The next session takes over a lock from a session that died. A session that loses a lock to another session stops answering there and tells you.
- It writes the entries of each helper run, with their usage, under `<session file without .jsonl>/slack-companion/`. Session-tree cost accounting counts them. If you delete the session, delete that folder too: Pi does not remove it. A session that is not saved to a file writes no such entries, and the package tells you that their spend cannot be attributed.
- It records the cost of each check in the session as a `pi-cost-record` entry.
- The helper's shell gets a scratch folder in the system temp folder. The package removes it after each run.

## Known limits

- Nothing answers while Pi is closed or the machine sleeps. Resume catches up.
- Pi's built-in MCP support gives code no way to call a tool, so the package needs pi-mcp-adapter.
- Every read is an MCP call, and Slack keeps audit logs of MCP activity. Each watch reads once a minute, plus two calls for each new message and one for each send it must check.
- Locks work on one machine. Two machines that watch the same direct message could both answer.
- At start, the package checks the Slack tool names against your Slack server's tools in the adapter's cache. If the adapter has not listed that server yet, the first read reports a wrong name instead.

## Verify

```bash
npm run typecheck --workspace @doodledood/pi-slack-companion
npm run test --workspace @doodledood/pi-slack-companion
```

The tests run real Pi sessions in memory with a scripted model and a fake Slack server that writes the official server's formats. They use no network and no Slack. `scripts/verify drive slack-companion` runs them as the project's recipe. `scripts/verify drive slack-companion-live` checks the parser against your real server. Ask first before you run it: it posts two messages to your own Slack direct message.

## Uninstall

Remove the package the way you installed it: `pi remove <the source you installed>`, or delete its entry from `packages` in `~/.pi/agent/settings.json`. Then delete `~/.pi/agent/slack-companion.json` and `~/.pi/agent/slack-companion/` if you want no trace. Helper records stay in each session's `slack-companion/` folder until you delete them.
