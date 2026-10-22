# @doodledood/pi-btw

A `/btw` side conversation for Pi. BTW opens one child `AgentSession` in a Pi-owned right overlay so you can ask questions and think things through while the main session keeps working, without adding the child conversation or its tool results to the parent history.

BTW requires Pi 1.4.0 or newer and its interactive TUI. It refuses to register under an older Pi host with an actionable compatibility error: its mouse handling uses Pi's native fullscreen mouse routing (introduced in 1.0.0), and `send_to_main` relies on how Pi 1.4 queues messages and reports when main is idle. It does not open in RPC, JSON, or print mode.

The child forks in place: it starts from the parent's latest persisted, compaction-aware state at the moment you open it — including tool calls of a parent turn that is still running — trimmed only when the branch ends in a tool call whose result has not landed yet. Content the parent is still streaming is not persisted anywhere and cannot be forked. The child is told it may have been forked mid-work and to address your messages rather than continue the parent's unfinished task. It inherits the parent's model, thinking level, working directory, and best-effort active tool set. Parent and child histories remain separate, but they intentionally share the same project workspace.

## Read-only posture

BTW is for answering, not doing. The child is instructed to stay read-only — inspect, explain, discuss — and to point changes back at the main session. It does not inherit the parent's `edit` and `write` tools, nor goal-controller's `goal` tool. This is a posture, not a sandbox: inherited tools such as `bash` can still change files, so the instruction carries the rest.

The fork also leaves the parent's extension state behind. Pi `custom` session entries are extension-private state that never reaches the model — goal-controller's active goal among them. Carrying them over made child extensions restore that state, so a parent goal would resume and fire continuation turns inside the aside. The child starts from the parent's conversation with those entries dropped; the main session keeps its goal untouched.

## Relaying to main

The child-only `send_to_main` tool sends one message to the main session on your behalf, as if you had typed it there — for example the verdict you reached in BTW. The child calls it only when you ask it to tell, send, or relay something to main. The message arrives as a user message prefixed `[Relayed from my BTW side conversation]`; it starts a main turn when main is idle and queues as a follow-up behind the current run when main is busy. While main is compacting (even if BTW was opened mid-compaction), the message waits and is sent once compaction ends. Several relays in one child turn arrive in the order the child sent them. The tool result says whether the message was handed to main: if BTW closes or is stopped before main can take it, the child and the pane are told it was **not delivered**, never that it was sent. This is the only path by which BTW adds anything to the main session.

## Use

After installation, restart Pi or run `/reload` once.

| Command | Behavior |
| --- | --- |
| `/btw` | Open the child or focus the existing pane. |
| `/btw explain the current approach` | Open/focus the pane and submit text to the child. |
| `/btw done` | Abort, dispose, and close the child. |

Inside the pane:

| Control | Behavior |
| --- | --- |
| `Enter` | Submit the editor contents. Prompts submitted during a child run wait locally in order. |
| Mouse wheel over the pane | Scroll the BTW transcript, using Pi's wheel speed setting (`fullscreenWheelScrollLines`). The main transcript does not move. |
| `PgUp` / `PgDn`, `Ctrl+Up` / `Ctrl+Down` | Scroll by roughly one viewport. |
| `Esc` | Abort an active child run; when idle, return focus to the parent. |
| Click the pane / click main | Focus BTW, or hand focus back to the main session — anywhere on main, transcript or editor. Focus stays where you put it. |
| `/main` | Return focus to the parent while keeping BTW visible. |
| `done`, `/done`, `/btw done` | Close BTW. |

The overlay presents separate parent/child activity, streaming output, tool progress and results, retries, compaction, errors, and aborts. Its transcript projection is bounded; the child's own session file remains authoritative while the pane is open.

## Parent updates

The child does not continuously synchronize parent content after its fork. When the parent settles at a newer head, BTW adds a minimal hidden notice to the child that the child-only `check_parent_updates` tool is available. The child can explicitly pull the parent entries persisted since the fork when a later answer depends on them.

The tool reports no-op, linear-update, post-compaction, or branch-divergence state; normalizes and bounds returned content; records the pull only in child history; and never mutates parent history.

## Install

### Local clone

From a clone of this repository:

```bash
pi install /absolute/path/to/pi-plugins/packages/extensions/btw
```

The local package path remains the installation source, so edits in the clone are picked up after `/reload`.

### npm (after publication)

```bash
pi install npm:@doodledood/pi-btw
```

### Only BTW from the Git bundle

Use Pi's object-form package filter in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/btw/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

The repository's root Git package already includes BTW alongside all other root resources. Do not add a second BTW source when using that unfiltered bundle.

## Configuration, state, and workspace

BTW has no package-specific config file, environment variables, or credentials.

Each aside is a mode-`0600` JSONL session clone. When the parent session is persisted, the clone is written to `<parent-session-file-without-.jsonl>/btw/` — nested beneath Pi's `sessions/` directory, alongside the parent session file — and **kept when the pane closes**. An aside is a real model conversation that costs real money; deleting it on close destroyed the only record of that spend. Keeping it lets the `simple-statusline` cost surfaces count it in the session-tree total and `/cost` attribute it, and leaves the aside readable afterwards. Its header records the parent session file as `parentSession`.

Because Pi lists sessions from one directory non-recursively, these nested files never appear in the session list or the `/resume` picker. They are retained for the life of the parent session; deleting the parent's `.jsonl` file and the sibling directory of the same name removes every aside with it.

When the parent session is **not** persisted, the aside falls back to an OS temporary directory named `pi-btw-*` and normal close removes that whole directory, as before — there is no parent session to attach the spend to. A hard process kill can leave such a temporary directory that the terminated process can no longer clean up.

Parent history is never modified either way.

Parent and child tools share the same working directory and can mutate the same files concurrently. This is deliberate shared-workspace behavior, not filesystem isolation: coordinate conflicting edits and re-read shared state before writing. Files changed by child tools remain after the child closes.

## Accepted experimental limitations

BTW is a focused ask/try workspace, not a nested copy of Pi's complete interactive mode.

- Built-in interactive slash menus and child session replacement are not embedded.
- The child reloads installed resources in the same process. Stateful extension factories, provider overrides, module globals, listeners, and other process-wide effects may be duplicated or shared; there is no RPC or provider-isolation boundary.
- Child select/confirm/input/editor/custom dialogs bridge through the parent UI. Requests to replace global working/thinking presentation, widgets, header, footer, editor, title, raw terminal listeners, theme, tool-expansion state, or session are intentionally not applied.
- Mouse input comes from Pi's fullscreen mode (`tuiMode: "fullscreen"`, the default). BTW never writes terminal mouse-mode sequences itself. In Pi's regular screen mode there is no mouse, so use the keyboard controls. A press or drag over the pane is left to Pi's text selection.
- Pi gives an overlay no signal for clicks outside it, so BTW observes main-screen clicks by wrapping the `handleMouse` of Pi's top-level main components while the pane is open; the wrapper returns Pi's own result unchanged and is removed on close.
- Resources reload in-process with this BTW extension filtered out to prevent recursion.
- Runtime-only SDK tool identity cannot be inherited exactly. Requested active tool names may resolve to another discoverable definition. A parent tool that a fresh load cannot resolve — for example an MCP proxy tool the parent registered under an older config — does not block opening: BTW opens with every tool that does resolve and shows a warning in the pane naming the ones it left behind, so the reduction is visible rather than silent.
- Third-party child extensions can enqueue public `nextTurn` context that Pi's API cannot clear on abort. BTW-owned prompts and parent-update notices avoid that queue; closing disposes the child runtime.
- Cancelling a prompt that is already inside Pi's prompt preflight (input handlers, auth checks) cannot withdraw it through Pi's public API; BTW aborts its run at `agent_start` instead, before model work proceeds.
- Child prompts use the parent's configured model and can incur normal model cost. Automated tests use controlled local providers and make no network requests.

If extension/provider interference or runtime non-fidelity is unacceptable, close or uninstall BTW.

## Troubleshooting

- **Unsupported Pi version:** install/use Pi 1.4.0 or newer for this package version. BTW refuses to register under older host versions.
- **Wheel or clicks do nothing:** check that Pi runs in fullscreen mode (`tuiMode` in `/settings`). Regular screen mode has no mouse input.
- **No active parent model:** select or configure a model in the parent session, then run `/btw` again.
- **Missing inherited tools:** BTW still opens and warns in the pane which parent tools it could not bring along. This usually means the parent loaded under different config or extensions than a fresh load would; restart or `/reload` the parent to bring them back in sync. Runtime-only SDK tool overrides may require using the parent session instead.
- **Model/thinking/cwd mismatch:** BTW fails visibly instead of opening a child that would not match the parent. Close the pane, reload/restart Pi, and retry after confirming the parent model is available from installed resources.
- **Overlay or child startup failure:** the error notification names the failing stage. Run `/btw done` if a pane remains, then `/reload` or restart Pi. If a stateful provider/extension conflicts with the in-process child, uninstall BTW rather than relying on that combination.
- **Temporary residue after a hard kill:** after confirming no Pi process or BTW pane is using it, remove stale directories named `pi-btw-*` from the OS temporary directory (`$TMPDIR` on macOS, otherwise the platform temp directory). Normal close removes these automatically.

## Verify

From this package directory:

```bash
npm run verify
```

This runs strict TypeScript checks and deterministic Node tests covering compaction-aware forks, parent-update pulls, child lifecycle and cleanup, model/tool/cwd inheritance, history isolation, shared-workspace effects, prompt serialization and cancellation, recursion filtering, the read-only tool set, the parent-state-free fork, `send_to_main` delivery through a real parent session (ordering, compaction, undelivered relays), TUI rendering, and mouse wheel and click-focus behavior on Pi's real fullscreen renderer.

The tests use temporary directories and controlled local provider streams; they do not call a live model.

## Uninstall

Remove the source you installed:

```bash
pi remove /absolute/path/to/pi-plugins/packages/extensions/btw
# After npm publication:
pi remove npm:@doodledood/pi-btw
```

For the Git-bundle filter, remove the object-form entry from `~/.pi/agent/settings.json`. If you use the full root bundle, narrow its filter or remove that bundle instead; do not delete files inside Pi's managed Git checkout.

Restart Pi or run `/reload` afterward. Uninstalling BTW does not revert filesystem changes previously made by child tools.
