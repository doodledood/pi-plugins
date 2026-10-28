// A Pi extension for the end-to-end runs: appends every `herdr:blocked` event on Pi's event bus —
// the payload Herdr's Pi integration forwards to Herdr — to the file HERDR_BRIDGE_SPY names.
import { appendFileSync } from "node:fs";

export default function blockedSpy(pi: any): void {
  const file = process.env.HERDR_BRIDGE_SPY;
  if (!file) return;
  pi.events.on("herdr:blocked", (data: unknown) => appendFileSync(file, `${JSON.stringify(data)}\n`));
}
