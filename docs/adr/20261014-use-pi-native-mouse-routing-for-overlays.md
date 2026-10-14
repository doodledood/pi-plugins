# ADR: Use Pi's native fullscreen mouse routing for overlays and observe main-screen clicks through Pi's own handlers

## Status
Accepted

## Context
BTW and the `/cache` report scrolled with the mouse wheel by turning on SGR mouse reporting themselves (`\x1b[?1000h` / `\x1b[?1006h`), parsing raw sequences in `onTerminalInput`, and sharing the reporting mode through a process-global cooperative lease so overlapping overlays would not switch it off under each other. BTW also used those raw clicks to move focus between its pane and the main session.

Pi 1.0 added a fullscreen renderer (`TuiAltScreen`, the default `tuiMode`) that owns the mouse: it enables reporting, parses every event, and routes it to `Component.handleMouse` — the overlay under the pointer first, then the main layout — with `wheelDelta` already scaled by the `fullscreenWheelScrollLines` setting. It registers its own input listener before any extension's, and that listener consumes every mouse sequence. Under Pi 1.2 this broke BTW in the field: the wheel scrolled the main transcript instead of the pane, and clicks did not move focus, so a message typed "in" BTW landed in the main editor.

Two Pi behaviours shape a replacement. An overlay hears nothing about clicks outside its bounds, and Pi has no outside-click hook. And Pi treats focus moving from an overlay back to the component it was opened over (the main editor) as temporary: the next keystroke returns focus to the overlay unless the overlay is released with `handle.unfocus()`.

## Decision
Overlays implement `handleMouse` and never write terminal mouse modes. BTW scrolls its transcript on `wheel` and takes focus on a left `click`; it leaves press and drag unhandled so Pi's text selection still works over the pane. The `/cache` report scrolls on `wheel`. The lease modules, the raw parsing, and the cross-package mouse integration test are deleted, and both packages require Pi 1.0.0 or newer.

For "click on main hands focus back", BTW wraps `handleMouse` on each of Pi's top-level main-screen components (`tui.children`) while the pane is open. Together they cover every cell outside overlays, so the wrapper sees exactly the clicks Pi routes to main. It returns Pi's own result unchanged, calls `handle.unfocus()` when BTW holds focus (which also clears Pi's pending focus restore), and is removed on close. A real `TuiAltScreen` test drives raw terminal input through a layout shaped like Pi's `createChatViewport` to hold the behaviour in place.

## Alternatives Considered
- **Keep the raw SGR lease** — rejected: extension input listeners run after Pi's fullscreen listener has consumed the mouse sequence, so they cannot see the wheel or clicks at all in the default mode.
- **Accept Pi's native focus model only (click the main editor, or Esc / `/main`)** — rejected: clicks on the transcript would leave focus in BTW, and a click on the editor would snap back on the next key; the user explicitly wanted clicking anywhere on main to focus main.
- **Patch Pi's private dispatch (`dispatchMouseToLayout`) or reorder its input listeners** — rejected: depends on private members that can change in any release; wrapping the public `Component.handleMouse` contract on public `tui.children` keeps Pi's behaviour intact and fails soft.
- **Upstream an outside-click hook in Pi** — the right long-term seam, but not in our control; the wrapper can be replaced by it when one exists.

## Consequences

### Positive
- The wheel scrolls whatever is under the pointer, at the user's configured speed, and focus follows clicks both ways and stays put.
- No extension touches the terminal's mouse modes, so overlays cannot disable reporting for each other or leave it on after a crash.
- About 500 lines of lease, parsing and integration-test code are gone.

### Negative
- No mouse in Pi's regular screen mode; keyboard controls remain.
- The main-click observer relies on Pi mounting its main screen as plain top-level components without their own layout nodes. A Pi layout change could make it miss clicks, and the fullscreen test is the tripwire.
- Older Pi (0.80.x) is no longer supported by these packages.

## Source
- Session: BTW "nicer" work — Pi 1.2.0 in Warp, wheel and submit bugs, click-to-focus regression.
- Related: 20261014-fork-btw-without-parent-extension-state, 20261014-keep-btw-read-only-with-one-relay-to-main
