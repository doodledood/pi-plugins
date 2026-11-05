# @doodledood/pi-slack-companion

The people your Pi session messages on Slack can work with it directly. You do not relay between them.

When your session sends someone a Slack message, Pi watches that conversation. When they reply, a read-only, sandboxed fork of your session answers them in the thread. This fork is the **Slack helper**. Information they give goes to your session as their words. Anything that would change your work waits for your approval.

It is for people who run Pi with a Slack MCP server and want the conversations their sessions start to continue safely without them.

## How it works

1. **Start.** Your session sends a Slack message, or you run `/slack <link>` on a conversation someone else started. Pi then watches that conversation: the top level of a direct message, or one thread. It never watches a whole channel.
2. **Watch.** Plain code reads each watched conversation about once a minute through your Slack MCP tools. This uses no model and no tokens.
3. **Filter.** The code skips your session's own posts, reactions and repeats. It handles `stop` itself. Each remaining batch of new messages gets one call to a small, cheap model, which decides if the agent has something to say. Most chat between people gets a "no", and costs only that call.
4. **Answer.** Pi forks your session, as it is at that moment, into a helper in memory. The helper reads, investigates and replies in the thread, at most once per batch. It can also stay silent.
5. **Hand off.** The helper gives information your session asked for to your session, as the sender's words. A request for an action waits in the panel for your approval. When you approve, your session gets exactly the text you saw. While the watch is live, the person is told.

## Prerequisites

- Pi 1.4.0 or newer.
- [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), with a Slack MCP server configured. The package calls Slack's tools from code through the adapter's runtime tool-call event. Pi's built-in MCP support has no such event. Without the adapter, the package loads and tells you that it cannot watch.
- If pi-mcp-adapter asks you to approve tool calls (`approveTools`), leave the Slack tools that slack-companion reads out of it: the package reads without asking, and a watch stops if a read needs approval.
- A Slack MCP server whose output the package can read. The package reads the detailed format of the official Slack MCP server, directly or through a gateway that hides emails. You can set the tool names for a server that uses different names.
- For the helper's shell: [sandbox-runtime](https://github.com/anthropics/sandbox-runtime), which installs with the package. macOS uses its built-in Seatbelt. On Linux the helper has no shell yet (see *Known limits*). If the sandbox cannot start, the helper has no shell.

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

- A watch ends when the helper says the conversation has what it needed, or when anyone sends `stop`. It also ends when you stop it, or after a quiet period.
- A watch pauses after it sends 5 messages without you, or when its daily spend cap is reached. Your next message in Pi resumes a watch paused for the message count. A spend-cap pause waits for you to press `r`, which lifts the cap for the rest of that day. A reply the helper wrote during a pause waits and goes out as written when you resume.
- While a watch is paused, at most 20 messages wait for you. Older ones are dropped. The watch's last note says how many were dropped since the waiting list was last answered. One conversation can have at most 10 requests waiting for you; the helper is told when it is full.
- If a read fails for a reason that can pass (a rate limit, a dropped connection), the watch tries again at the next read. After 5 failures in a row, or at once for a problem that does not pass, it stops and tells you why. The reason says what to do: for example, run `/mcp-auth` when your Slack login expired. Then press `w`. A result too large for the adapter to save whole is read again in smaller pages once before the watch stops.
- When another of your Pi sessions posts in a watched conversation, it has seen what came before its post. So messages that waited here from before that post are not answered here; a notice says how many and from whom, and you can check in Slack that the other session answered them. The helper does not answer while a read still holds messages back for the next read, so such a post is always seen first.
- Another Pi session can take a conversation over only when this session's process is gone. If that happens while this session still runs (its lock file was removed by hand, or damaged), the watch here stops and says so. Messages that waited here are not answered here; a notice says how many and from whom. Press `w` to watch it again: the rule above leaves what the other session answered.
- Requests that wait for you stay in the panel after their watch ends, until you approve or deny them. While the watch is live, your approval or denial is sent to the person, even during a pause. After the watch ends, the person is not told; an approved request still goes to your session, which can report the result there.
- Watches come back when you resume the session. Pi then reads what arrived while it was closed. Nothing answers while Pi is closed or the machine sleeps.

## Safety model

**The helper cannot change your work.** It loads no extension. It has only these tools:

- `read`, `grep`, `find` and `ls`.
- On macOS, a `bash` shell. Every command runs under sandbox-runtime. The shell can write only to its scratch folder, `$SCRATCH`. It has no network unless you allow domains. It gets no environment variable whose name looks like a credential.
- Every MCP tool that its server marks read-only, plus the tools you list as investigative. Private servers are the exception: the helper gets their tools only if you list them as `server/tool`, and only those that read.
  - Your own Slack server is always private (search, other channels, your private messages): your other conversations are yours.
  - The servers in `privateServers` are private. By default these are `chrome-devtools`, `playwright` and `puppeteer`, which drive your browser: their read-only tools still see your cookies, logins and private pages. The names must match your MCP config's server names exactly. Add any other server that reaches your private data, such as a browser server under another name, or mail.

  The ones your session has active now, and the listed ones, are tools of their own. The helper finds and calls the rest through two tools, `search_read_only_tools` and `call_read_only_tool`, so its prompt stays small. The helper calls them all through your session's adapter.
- Its own `reply_in_slack` and `hand_off_to_main`.

It has no edit, write or Slack-send tool, and it cannot use your session's other tools. Pi loads no extension for it, so no extension code runs when a helper starts. A helper run stops after 25 model turns.

**Secrets stay out.**

- The helper's file tools read only what is open to them: the project, the folders you list in `readableFolders`, the file of each skill your session offers it, and the files its own MCP calls saved. Everything else is closed, on every platform. A path is judged by the spelling the disk gives back, so another spelling of a closed file (other letter case, the `/System/Volumes/Data` form, a symlink) is closed too.
- The shell (macOS) cannot read your home folder or the temp folder, which holds your session's full tool output and pi-mcp-adapter's saved results. It reads the project, the folders you list, the repository's own folders when the project is a git worktree or subfolder, and your toolchains: Pi's `bin`, git's settings, and version managers such as `~/.nvm`, `~/.cargo/bin` and `~/.pyenv`. Other system folders stay readable to it. It writes only to `$SCRATCH`, which is also its `TMPDIR`.
- Credentials live in too many places in a home folder to list them all (`~/.config`, `~/Library`, dotfiles), and your documents are yours: that is why the home is closed. If you run Pi in your home folder itself, or in a folder listed below, nothing in it is open.
- Inside what is open, these stay closed: `~/.ssh`, cloud credential folders, `gh`'s login, password stores and keyrings, `~/.mcp-auth`, and the config folders of agent tools, which hold API keys, MCP servers' keys and tokens (Pi's agent folder with its `models.json`, `~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.windsurf`, `~/.config/opencode`, `~/.config/mcp` and Claude's desktop app folder).
- They also cannot read files or folders named like credentials, or their copies and backups (such as `auth.json.bak`). These are `.env*`, `auth.json*`, `.netrc*`, `.npmrc*`, `.pgpass*`, `credentials`, `credentials.json*`, `.git-credentials*`, SSH keys, shell history files, `mcp.json*`, `.mcp.json*`, `mcp-adapter.json*`, `mcp-auth.json*`, `.credentials.json*`, `.claude.json*`, `claude_desktop_config.json*` and `opencode.json*` (every MCP config pi-mcp-adapter imports servers from). Both match these names in any letter case, anywhere in a path.
- The file tools cannot read `/proc` or `/dev/fd`. The shell gets no credential variables in its own environment.
- The file tools check the file they will open, so `~`, `@` and `file://` forms do not get past the check. Search output drops lines that name a closed file, context lines too.
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
| `investigativeTools` | `[]` | MCP tools the helper can use although their server does not mark them read-only, shown to it as tools of their own. Write `tool` or `server/tool`. This is also how you give it a private server's read tools; write those as `server/tool`. A private server's tool that posts or changes anything is never given, even if listed. |
| `privateServers` | `["chrome-devtools", "playwright", "puppeteer"]` | MCP servers whose tools the helper gets only when listed as `server/tool`, though they are marked read-only. Your own Slack server is always private too. The servers you set are added to the default list. |
| `readableFolders` | `[]` | Folders in your home folder that the helper can read besides the project. Write absolute paths or `~/…`. The home folder itself, a folder holding it, and a secret folder (or one inside it) are ignored. |
| `spendCapUsdPerDay` | unset | Pause a conversation when its helpers and checks spend this much in one day. |

## Files it reads and writes

- It reads its config, above. It also reads pi-mcp-adapter's tool cache, `~/.pi/agent/mcp-cache.json`. With it, the package checks the Slack tool names at start and finds the MCP tools that their servers mark read-only.
- It writes its state into your session file as custom entries, which the model does not see. This lets watches survive `/reload` and resume. It writes a snapshot only when something changed. Each part of the state has a limit. A watch that ended quietly keeps only what the panel needs.
- A later version of the package may not read a saved snapshot. It then keeps the requests that wait for you, every `stop`, and `/slack off`, and names the watches it lost. If it cannot tell whether automatic starts were on, it turns them off until you run `/slack on`.
- It remembers the last 1000 stops, so a conversation someone stopped does not start again when your session sends to it.
- It keeps one lock folder per watched conversation under `~/.pi/agent/slack-companion/locks/`, holding a numbered lock file. Two sessions on one machine then never answer the same conversation. A lock is taken from another session only when that session's process is gone, or the machine restarted since: never from a session that runs, however long it slept. A session that ends removes its lock file and the folder. A lock file left by a crashed session stays until another session takes the conversation.
- It writes the entries of each helper run, with their usage, under `<session file without .jsonl>/slack-companion/`. Session-tree cost accounting counts them. Pi does not remove that folder when you delete a session. So when a session starts with the package on, it removes such a folder in the same sessions folder when all of these are true:
  - The session file is gone.
  - Every file in the folder is a helper record of that session.
  - The newest record is more than 30 days old.

  It never removes the folder of the session that is running. A session that is not saved to a file writes no such entries, and the package tells you that their spend cannot be attributed.
- It records the cost of each check in the session as a small `pi-cost-record` entry, one per check. These go when the session goes.
- The helper's shell gets a scratch folder in the system temp folder. The package removes it after each run.

## Known limits

- Nothing answers while Pi is closed or the machine sleeps. Resume catches up.
- Pi's built-in MCP support gives code no way to call a tool, so the package needs pi-mcp-adapter.
- Every read is an MCP call, and Slack keeps audit logs of MCP activity. Each watch reads once a minute. Each new message adds two calls. Each send that it must check adds a read and two more calls per match.
- Locks work on one machine. Two machines that watch the same direct message could both answer.
- On Linux the helper has no shell. Its sandbox there can deny files only by path, so denying every secret file name would mean searching the disk before each command. The helper still reads the project with its file tools, which deny secret names on every platform.
- At start, the package checks the Slack tool names against your Slack server's tools in the adapter's cache. If the adapter has not listed that server yet, the first read reports a wrong name instead.

## Verify

```bash
npm run typecheck --workspace @doodledood/pi-slack-companion
npm run test --workspace @doodledood/pi-slack-companion
```

The tests run real Pi sessions in memory with a scripted model and a fake Slack server that writes the official server's formats. They use no network and no Slack. `scripts/verify drive slack-companion` runs them as the project's recipe. `scripts/verify drive slack-companion-live` checks the parser against your real server. Ask first before you run it: it posts two messages to your own Slack direct message.

## Uninstall

Remove the package the way you installed it: `pi remove <the source you installed>`, or delete its entry from `packages` in `~/.pi/agent/settings.json`. Then delete `~/.pi/agent/slack-companion.json` and `~/.pi/agent/slack-companion/` if you want no trace. Helper records stay in each session's `slack-companion/` folder until you delete them.
