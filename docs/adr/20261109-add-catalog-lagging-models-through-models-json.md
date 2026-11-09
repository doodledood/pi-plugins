# ADR: Add models Pi's catalog does not ship yet through models.json, not alias fields

## Status
Accepted

## Area
setup

## Decided by
An agent, with no review of this record. The user asked to move the Fable slot to Claude Fable 5.2 and to push the change; how the model enters the profile was the agent's call.

## Context

Anthropic released `claude-fable-5-2` on 2026-11-09, and Pi 1.5.0's catalog did not carry it, even after `pi update --models`. Every alias in `setup/configs/model-aliases.json` inherits its metadata from Pi's catalog record for its target, so an alias for a missing model has nothing to inherit.

When Fable 5.1 hit the same gap (commit 6c1d3af), its aliases spelled out `api`, `baseUrl`, `reasoning`, `input`, `maxTokens`, `cost` and `compat` themselves. That approach has three faults now:

- The alias config has no `promptCache` or `inputLimits`, and Pi warms only cache tiers with a known lifetime, so the most expensive model in the cycle loses cache warming.
- It also left out `thinkingLevelMap`, which Pi needs before it allows `xhigh` or `max`, and the cycle runs Fable at `max`.
- A pinned `baseUrl` sends the model straight to the vendor, bypassing any route the provider has, such as a local relay set in `models.json`.

Pi's own mechanism for a model it does not ship is a `models` entry under the provider in `models.json`. It accepts every field of a catalog record, and the model keeps the provider's route.

The structure check used to require `setup/models.example.json` to be empty. Its reason was that operating windows live in one place, `model-aliases.json`. An entry that adds a whole model, with the same window as the vendor's, does not touch that reason.

## Decision

A model the profile uses before Pi's catalog ships it goes into `setup/models.example.json` as a full catalog-style record under its provider, copied from the nearest sibling in Pi's catalog with the vendor's published price. The alias stays the same plain shape as every other alias and inherits from that record. The entry has no `baseUrl` and the provider has no overrides. The entry is deleted once Pi ships the model.

## Alternatives Considered

- **Spell the fields out in the alias, as for Fable 5.1.** Rejected for the three faults above.
- **Teach model-aliases to pass through `promptCache` and `inputLimits`, and to fall back to the provider's route.** Rejected: it mirrors Pi's model schema in a second place, and every field Pi adds later would need mirroring again. `models.json` already carries the whole schema.
- **Wait for Pi's catalog.** Rejected: the user wanted the model now, and the catalog has lagged weeks before.

## Consequences

### Positive

- A model the catalog lacks behaves exactly like a catalog model: price, thinking levels, prompt-cache warming and routing.
- The next model bump follows the same steps, and the structure check states them.

### Negative

- `models.example.json` is no longer empty, so installs merge it, and the entry needs deleting once Pi ships the model. Nothing fails when that is forgotten; a stale entry only overrides Pi's own record with a copy.

## Enforced by
partly — `scripts/verify-structure.mjs` allows only `models` entries in `setup/models.example.json`, each an alias target with `api`, `cost`, `contextWindow`, `maxTokens` and `promptCache`, and none with a `baseUrl`. Deleting an entry once Pi ships the model stays judgment, because the structure check runs without Pi installed.

## Source
- Session: Fable 5.2 switch, 2026-11-09
- Related: commit 6c1d3af (Fable 5.1 spelled out in the alias)
