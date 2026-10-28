---
kind: extension
covers: packages/extensions/panel
ask-first: each scenario calls real model providers, which spends money
---
# Panel against real providers

A real `/panel` run against real providers, with cheap models at low effort; the free `panel`
recipe covers the same package without spending.

## How a user reaches it

- `/panel <question>`.

## Scenarios

### live
Run: `npm run smoke --workspace @doodledood/pi-panel`
Proves: a panel with two cheap panelists answers and the main model consumes the answers.
Workload: varies
Check: read

### cancel
Run: `npm run smoke:cancel --workspace @doodledood/pi-panel`
Proves: cancelling mid-flight aborts both panelists promptly and restores the question as unsent editor text.
Workload: varies

## Gotchas

- `PANEL_SMOKE_MODELS` picks the lineup; never point it at the expensive default lineup.
- Needs provider credentials in the environment.
