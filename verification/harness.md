---
ask-first: ask
---
- Everything runs locally from the repository root after `npm install`; there is no service to
  start, so no control commands are declared.
- Package tests that drive a real Pi use fake provider keys and intercept every request; they
  spend nothing.
- Recipes marked ask-first call real model providers and need their credentials in the
  environment.
