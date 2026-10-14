import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

type MouseHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

/**
 * Observe left clicks that Pi routes to the main screen while an overlay is open.
 *
 * Pi's fullscreen renderer sends a click to the overlay under the pointer, or else
 * to the main layout; an overlay never hears about clicks outside it, and extension
 * terminal-input listeners run only after Pi's viewport has consumed the mouse
 * sequence. The main screen's top-level components (`tui.children`) cover every
 * cell outside overlays, so a delegating `handleMouse` on each sees exactly the
 * clicks Pi routes to main. The wrapper returns the original handler's result, so
 * Pi's own handling of the click — editor focus, links, text selection — is unchanged.
 *
 * Returns a disposer. A wrapper another extension stacked on top is left in place;
 * ours then just stops reporting.
 */
export function observeMainClicks(tui: TUI, onClick: () => void): () => void {
  let active = true;
  const restores: Array<() => void> = [];
  for (const component of tui.children) {
    const hadOwnHandler = Object.prototype.hasOwnProperty.call(component, "handleMouse");
    const original: MouseHandler | undefined = component.handleMouse;
    const wrapper: MouseHandler = (event) => {
      if (active && event.type === "click" && event.button === "left") onClick();
      return original?.call(component, event);
    };
    const target = component as Component & { handleMouse?: MouseHandler };
    target.handleMouse = wrapper;
    restores.push(() => {
      if (target.handleMouse !== wrapper) return;
      if (hadOwnHandler && original) target.handleMouse = original;
      else delete target.handleMouse;
    });
  }
  return () => {
    if (!active) return;
    active = false;
    for (const restore of restores) restore();
  };
}
