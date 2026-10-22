# message-stash

Single-slot draft stash for Pi input editor with keyboard shortcuts.

Requires Pi 1.4.0 or later.

## Use

- **Ctrl+Option+S** stashes the editor's text and clears the editor, so you can send a temporary message. If a draft is already stashed, it asks before replacing it.
- After the next user message is sent, the draft comes back on its own, into an empty editor. If you have typed something new in the meantime, your new text is left alone and the draft stays stashed; a notice says so. Restoring never opens a dialog, so it never holds up the agent's turn.
- **Option+Shift+S** pops the stash by hand. It asks before replacing text already in the editor.

The stash is one slot per session. It follows you across `/new`, `/resume`, `/fork` and `/reload`, is gone when Pi exits, and another session in the same Pi process (a `/btw` aside, say) neither sees nor clears it.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/message-stash
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/message-stash/extensions/message-stash.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```
