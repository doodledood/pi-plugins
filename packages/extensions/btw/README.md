# @doodledood/pi-btw

A `/btw` side conversation for Pi. BTW opens one ephemeral child `AgentSession` in a Pi-owned right overlay so you can ask or try something without adding the child conversation or its tool results to the parent history.

BTW requires Pi 0.80.6 and its interactive TUI. It refuses to register under another Pi host version with an actionable compatibility error, because prompt cancellation depends on Pi 0.80.6's `preflightResult` behavior. It does not open in RPC, JSON, or print mode.

The child starts from the parent's latest complete, compaction-aware active branch and inherits its model, thinking level, working directory, and best-effort active tool set. Parent and child histories remain separate, but they intentionally share the same project workspace.

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
| Mouse wheel | Scroll a focused BTW transcript by three lines. |
| `PgUp` / `PgDn`, `Ctrl+Up` / `Ctrl+Down` | Scroll by roughly one viewport. |
| `Esc` | Abort an active child run; when idle, return focus to the parent. |
| Click inside/outside | Focus BTW or return focus to the parent. |
| `/main` | Return focus to the parent while keeping BTW visible. |
| `done`, `/done`, `/btw done` | Close BTW. |

The overlay presents separate parent/child activity, streaming output, tool progress and results, retries, compaction, errors, and aborts. Its transcript projection is bounded; the temp-backed child session remains authoritative while the pane is open.

## Parent updates

The child does not continuously synchronize parent content after its fork. When the parent settles at a newer completed head, BTW adds a minimal hidden notice to the child that the child-only `check_parent_updates` tool is available. The child can explicitly pull completed parent updates when a later answer depends on them.

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

BTW has no package-specific config file, environment variables, credentials, or persistent local state.

Each child uses a mode-`0600` JSONL session clone inside an OS temporary directory named `pi-btw-*`. Normal close removes the whole directory; no child session is written beneath Pi's persistent `sessions/` directory. A hard process kill can leave a temporary directory that the terminated process can no longer clean up.

Parent and child tools share the same working directory and can mutate the same files concurrently. This is deliberate shared-workspace behavior, not filesystem isolation: coordinate conflicting edits and re-read shared state before writing. Files changed by child tools remain after the child closes.

## Accepted experimental limitations

BTW is a focused ask/try workspace, not a nested copy of Pi's complete interactive mode.

- Built-in interactive slash menus and child session replacement are not embedded.
- The child reloads installed resources in the same process. Stateful extension factories, provider overrides, module globals, listeners, and other process-wide effects may be duplicated or shared; there is no RPC or provider-isolation boundary.
- Child select/confirm/input/editor/custom dialogs bridge through the parent UI. Requests to replace global working/thinking presentation, widgets, header, footer, editor, title, raw terminal listeners, theme, tool-expansion state, or session are intentionally not applied.
- While open, BTW temporarily enables standard SGR mouse reporting through Pi's terminal API. Terminals without SGR mouse support retain keyboard controls but not click focus or wheel scrolling. Clicks switch focus but do not reposition the editor cursor.
- Resources reload in-process with this BTW extension filtered out to prevent recursion.
- Runtime-only SDK tool identity cannot be inherited exactly. Requested active tool names may resolve to another discoverable definition; missing names fail visibly rather than silently reducing capability.
- Third-party child extensions can enqueue public `nextTurn` context that Pi's API cannot clear on abort. BTW-owned prompts and parent-update notices avoid that queue; closing disposes the child runtime.
- This experiment is explicitly version-bound to Pi **0.80.6**. Its prompt-cancellation admission uses the exported-but-internal `PromptOptions.preflightResult` RPC hook and relies on 0.80.6 calling it immediately before model work (or with `false` on preflight failure). Treat a Pi upgrade as a compatibility review, not an assumed-safe update.
- Child prompts use the parent's configured model and can incur normal model cost. Automated tests use controlled local providers and make no network requests.

If extension/provider interference or runtime non-fidelity is unacceptable, close or uninstall BTW.

## Troubleshooting

- **Unsupported Pi version:** install/use Pi 0.80.6 for this package version. BTW refuses to register under other host versions rather than relying on an unverified internal prompt hook.
- **No active parent model:** select or configure a model in the parent session, then run `/btw` again.
- **Missing inherited tools or model/thinking/cwd mismatch:** BTW fails visibly instead of opening with silently reduced capabilities. Close the pane, reload/restart Pi, and retry after confirming the parent tools and model are available from installed resources. Runtime-only SDK tool overrides may require using the parent session instead.
- **Overlay or child startup failure:** the error notification names the failing stage. Run `/btw done` if a pane remains, then `/reload` or restart Pi. If a stateful provider/extension conflicts with the in-process child, uninstall BTW rather than relying on that combination.
- **Temporary residue after a hard kill:** after confirming no Pi process or BTW pane is using it, remove stale directories named `pi-btw-*` from the OS temporary directory (`$TMPDIR` on macOS, otherwise the platform temp directory). Normal close removes these automatically.

## Verify

From this package directory:

```bash
npm run verify
```

This runs strict TypeScript checks and deterministic Node tests covering compaction-aware forks, parent-update pulls, child lifecycle and cleanup, model/tool/cwd inheritance, history isolation, shared-workspace effects, prompt serialization and cancellation, recursion filtering, TUI rendering and overlay behavior, and mouse parsing/cleanup.

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
