# tool-activity-renderer

Graphite-style rows for Pi's built-in tools (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`), plus a live working line above the editor and quieter reasoning. Brightness carries the hierarchy: what is happening now is bright, what already happened recedes, and the reply stays above the reasoning behind it.

```text
 ● Explored  3 files · 1 search   ctrl+o to expand                        1.2s

 ● Edited  packages/app/src/footer.ts                               +1  −1  0.3s
   181   const costStr = formatTreeCost(runtime.cost);
   182 − const cacheSignal = cacheStats.visible ? format(cacheStats) : undefined;
   182 + const cacheSignal = cacheStats.visible ? format(cacheStats, { latest: true }) : undefined;

 ● Running  $ npm test -w simple-statusline                                 1.4s
   ✔ renders the session rate
   ✔ renders the latest-turn rate
```

## What it draws

- **Rows.** Each row shows a state glyph, a verb, the target, and a right-aligned result column with the duration. When a path does not fit, its leading directories collapse to `…/` before the file name is touched. The target sits two spaces after the verb; rows in a packed run share one column so their targets line up. While a tool runs, the glyph breathes and a highlight sweeps across the present-tense verb (Reading, Searching, Running). When the tool lands, the verb turns past tense (Read, Searched, Ran) and the result appears: lines, matches, files, entries, `+A −R`, `exit N`.
- **Temporal depth.** A finished row starts bright and recedes to the muted tones over about two seconds. Failures stay bright. Rows restored from session history (resume, `/reload`, a branch switch) render already receded and without durations, because pi does not store tool timings.
- **Exploratory runs.** Two or more consecutive `read`/`grep`/`find`/`ls` calls from one assistant message draw as one packed block, with no blank lines between rows. Once they all succeed, they fold into one `Explored …` line. A run that includes an image read stays as ordinary rows, so the image sits under its own row. Clicking a packed or folded run opens it into ordinary rows, each then expandable on its own. A failure keeps the run unfolded with the error shown. `ctrl+o` (expand) shows every row on its own with its output. An HTML `/export` draws every row on its own, settled with its result or error, and leaves the live transcript's folded runs alone.
- **Diffs.** `edit` and `write` results draw as tinted bands under the row. When a removed line pairs with an added line, only the span that changed gets the stronger tint. Collapsed diffs show the first 12 lines, then a `… N more lines` expand hint.
- **Full arguments.** When a row's head line had to shorten its command, pattern or path, or the command spans several lines, the expanded row shows the whole argument under it.
- **Working line.** While pi works, the indicator above the editor is a breathing dot, followed by what pi is doing now (Thinking while reasoning; a built-in tool's present-tense verb such as Reading, Searching or Editing while it runs; Writing while the reply streams; Working otherwise) and the run's elapsed time. While only built-in tools run, their compact rows already breathe, name the tool and time it right above, so the line gives way: its dot eases to rest and only the run's elapsed time stays, leaving one live thing on screen that says what is running. When another extension's tool runs beside them, the line names that one instead (Working), since no row of this renderer does. With `/tool-render default`, where pi draws the tool rows, the line names the tool as before.
- **Thinking stays beneath the reply.** Inline code in a thinking block (`` `foo.ts` ``) draws as plain text in the block's own italic thinking tone, instead of the bright code color the reply uses, so file names in the reasoning no longer pull the eye away from the answer. Only thinking changes: replies and your own messages keep their code color, and code blocks inside thinking keep theirs. Each rewrite is checked against pi's own Markdown renderer: a span becomes plain text only if the thinking block then shows exactly the same characters and links, both at the terminal's width and where nothing wraps (lines longer than about 2,000 characters still wrap in that second view, which only keeps more spans as code). Where a line wraps only shifts, because the code color no longer starts and stops, that still counts as the same. Where it would not, for example inside math, next to a link, or at the start of a line with leading spaces, the span keeps its code color. Spans that break across a line in the source also stay code, and so do any still undecided once a long thinking block has used up the check's budget, which keeps the check cheap while thinking streams: a few milliseconds per update for typical thinking, more for very long blocks or math that spans paragraphs. This is on in both `/tool-render` modes. The thinking tone itself comes from the theme's `thinkingText` token; Graphite sets it one step below the tool-output tone.
- **Narration stays beneath the reply too.** Text the model writes in a message that also calls a tool — the running commentary between tool calls, which often reads like reasoning — draws in the same italic thinking tone as thinking blocks, so only the final reply (the text of the message that calls no tool) reads at full brightness. Live, a streaming text turns quiet the moment its tool call shows up; restored history draws it quiet from the start. Inline code in narration follows the thinking rule above. Pi gives extensions no style for assistant text, so the tone is written into the text's Markdown as an escape sequence at each word, and the same kind of check guards it: a block keeps the tone only if pi then shows exactly the same lines, spaces included; otherwise that block stays as it was. Links keep their link color, and code blocks theirs. Texts are matched by content, so a text that was also a reply stays bright. This is on in both `/tool-render` modes. Why it works this way: [`docs/adr/20261014-quiet-narration-through-checked-source-tone.md`](../../../docs/adr/20261014-quiet-narration-through-checked-source-tone.md).

Every color comes from the active theme's tokens (`text`, `muted`, `dim`, `borderMuted`, `accent`, `success`, `error`, `warning`, `toolDiff*`, `toolSuccessBg`, `toolErrorBg`), blended through `theme.colors`. That requires Pi 0.99.0 or newer. The [`graphite`](../../themes/graphite) theme is tuned for it.

## Modes

`/tool-render compact|default` switches between these rows (`compact`, the default) and Pi's built-in tool rendering. The choice persists in `~/.pi/agent/tool-activity-renderer.json`. The working line, the quieter thinking and the quieter narration stay on in both modes.

## Development

This package typechecks and tests against Pi 1.0.2 through its own `devDependencies`, because it needs `theme.colors` and `theme.style` (Pi 0.99.0+). The rest of the workspace still builds against the root's Pi `^0.80.8`. Once the root moves to 0.99.0 or newer, drop this package's own Pi `devDependencies`.

## Cost

All live motion (the working line's dot and highlight, running rows, receding rows) shares one 30-frames-a-second clock, so it moves smoothly and in step, one repaint per frame. The clock stops once every row has settled and pi is idle. Before this, each animation ran on its own 8–10-frames-a-second timer, and out of step they already forced 18–28 repaints a second, so the smoother motion costs little: up to about 2 percentage points of one core more in measured runs. In Pi's default fullscreen TUI mode only what is on screen reaches the terminal, but Pi asks every row in the transcript for its lines on every frame, so a row that has stopped moving (settled, or failed) hands back the drawing it already made; only running and receding rows, and the exploratory run they belong to, paint each frame. In `tuiMode: "regular"`, a row that scrolls above the viewport while it is still animating makes Pi redraw the whole screen.

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
