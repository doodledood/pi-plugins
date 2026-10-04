# tool-activity-renderer

Graphite-style rows for Pi's built-in tools (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`), plus a live working line above the editor. Brightness carries the hierarchy: what is happening now is bright, and what already happened recedes.

```text
 ● Explored  3 files · 1 search   ctrl+o to expand                        1.2s

 ● Edited    packages/app/src/footer.ts                             +1  −1  0.3s
   181   const costStr = formatTreeCost(runtime.cost);
   182 − const cacheSignal = cacheStats.visible ? format(cacheStats) : undefined;
   182 + const cacheSignal = cacheStats.visible ? format(cacheStats, { latest: true }) : undefined;

 ● Running   $ npm test -w simple-statusline                                 1.4s
   ✔ renders the session rate
   ✔ renders the latest-turn rate
```

## What it draws

- **Rows.** Each row shows a state glyph, a verb, the target, and a right-aligned result column with the duration. When a path does not fit, its leading directories collapse to `…/` before the file name is touched. While a tool runs, the glyph breathes and a highlight sweeps across the present-tense verb (Reading, Searching, Running). When the tool lands, the verb turns past tense (Read, Searched, Ran) and the result appears: lines, matches, files, entries, `+A −R`, `exit N`.
- **Temporal depth.** A finished row starts bright and recedes to the muted tones over about two seconds. Failures stay bright. Rows restored from session history render already receded.
- **Exploratory runs.** Two or more consecutive `read`/`grep`/`find`/`ls` calls from one assistant message draw as one packed block, with no blank lines between rows. Once they all succeed, they fold into one `Explored …` line. A failure keeps the run unfolded with the error shown. `ctrl+o` (expand) shows every row on its own with its output.
- **Diffs.** `edit` and `write` results draw as tinted bands under the row. When a removed line pairs with an added line, only the span that changed gets the stronger tint. Collapsed diffs show the first 12 lines, then a `… N more lines` expand hint.
- **Working line.** While pi works, the indicator above the editor is a breathing dot, followed by what pi is doing now (Thinking, Reading, Running, Writing; Working for other tools) and the run's elapsed time.

Every color comes from the active theme's tokens (`text`, `muted`, `dim`, `borderMuted`, `accent`, `success`, `error`, `warning`, `toolDiff*`, `toolSuccessBg`, `toolErrorBg`), blended through `theme.colors`. That requires Pi 0.99.0 or newer. The [`graphite`](../../themes/graphite) theme is tuned for it.

## Modes

`/tool-render compact|default` switches between these rows (`compact`, the default) and Pi's built-in tool rendering. The choice persists in `~/.pi/agent/tool-activity-renderer.json`. The working line stays on in both modes.

## Development

This package typechecks and tests against Pi 1.0.2 through its own `devDependencies`, because it needs `theme.colors` and `theme.style` (Pi 0.99.0+). The rest of the workspace still builds against the root's Pi `^0.80.8`. Once the root moves to 0.99.0 or newer, drop this package's own Pi `devDependencies`.

## Cost

Running and receding rows redraw every 100 ms until they settle. In Pi's default fullscreen TUI mode that only repaints what is on screen. In `tuiMode: "regular"`, a row that scrolls above the viewport while it is still animating makes Pi redraw the whole screen.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/tool-activity-renderer
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/tool-activity-renderer/extensions/tool-activity-renderer.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration

See `config/` for safe example config and `setup/configs/` for Aviram's current non-secret defaults.
