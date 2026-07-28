# @doodledood/pi-hq

Supervise delegated Pi sessions as one ordered decision queue.

You run ten sessions and you are the bottleneck in all of them. Even when nothing
needs you, part of your attention is permanently allocated to wondering whether
something is stuck or waiting — so the two or three sessions that genuinely need
your judgment get a fragment of you. When one does stop for input, re-entering it
means rebuilding its context, and that switch costs more than the decision.

HQ changes what you attend to. Delegated work runs headless and **ends** at its
stops. Every stop is triaged against your ratified doctrine. Whatever needs you
arrives as a **packet**: the question, the options with what each costs, a
recommendation, what would change it, and how big and reversible it is — enough to
decide without opening the session. Your ruling is recorded and carried back into
the work, and it accretes into doctrine, so the share of stops that reach you
falls over time.

## Install

Installed with the rest of this repo:

```bash
pi install git:github.com/doodledood/pi-plugins@main
```

Just this extension, via a package filter in `settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/hq/extensions/hq/index.ts"],
      "prompts": [],
      "themes": []
    }
  ]
}
```

From a clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/hq
```

Once published to npm: `pi install npm:@doodledood/pi-hq`.

Then create the state root, seed doctrine, and add the doctrine reference line to
your agent instructions (idempotent — run it as often as you like):

```bash
npm run setup --workspace @doodledood/pi-hq
```

Check it took: start a new `pi` session and run `/fleet`. The card appears, and
`~/.pi/hq/sessions/` gains a file for the session you are sitting in.

### Try it against a sandbox first

Nothing needs to touch your real setup:

```bash
cd packages/extensions/hq
mkdir -p /tmp/hq-trial
npm run setup -- --state-root /tmp/hq-trial/state \
  --agent-instructions /tmp/hq-trial/AGENTS.md \
  --config /tmp/hq-trial/hq.json

HQ_HOME=/tmp/hq-trial/state pi -e extensions/hq/index.ts
# /hq to take the seat, /fleet for the card
```

### Uninstall

```bash
npm run setup:uninstall --workspace @doodledood/pi-hq   # removes the reference line
pi config                                               # disable or remove the extension
```

Your state stays where it is, readable and inert. Delete `~/.pi/hq/` when you want
it gone.

## Using it

| Command | What it does |
|---|---|
| `/hq` | Take the seat: sweep unfinished stops, then work the queue. `/hq off` hands it back. |
| `/fleet` | Show or hide the fleet card. |
| `/hq_graduate <domain>` | Grant HQ authority to answer that domain from doctrine. Confirms first. |
| `/hq_revoke <domain>` | Take the domain back. |

From the seat, ask for work to be delegated (`hq_delegate`), and rule on what comes
back. A ruling can be: accept the recommendation, pick an alternative, say it in
your own words, or **defer with a question** — which sends a drill to find the
answer and puts the packet back in the queue annotated, while you carry on with
the next one. You can also ask HQ to drill a packet outright, and it will say so
and move on rather than making you wait.

There is a row on every ask for "I had to open the session to decide". Choosing it
records what the packet should have carried, alongside the ruling you then gave —
that log (`defects.jsonl`) is how the packet format improves.

The card is a glance, not a console:

```
┌─ fleet ──────────────────────┐
│ ◆ HQ · 3 to rule             │
│ ▲ evals        needs ruling  │
│ ✗ pet-clm      failed    3h  │
│ ● car#412      working  40s  │
│ ◐ 2 idle · ✓ 4 done today    │
└──────────────────────────────┘
```

`●` running · `◐` idle · `◔` drilling · `▲` waiting on you · `✗` failed ·
`⚠` claims to be working but has said nothing for a while. That last one is the
signal the card exists for: it is what makes closing the tabs safe.

## Doctrine

Doctrine is plain markdown you own:

- `~/.pi/hq/doctrine/global.md` — Tastes, Doors (one-way vs two-way), Escalation
  rules, Directives, Precedents, and a **Meta** section.
- `~/.pi/hq/doctrine/projects/<slug>.md` — per-project rules, which take
  precedence over global ones.

Rules enter two ways only: you edit the file, or you ratify a proposal HQ queued
after one of your rulings. HQ never infers a rule from watching, and seeding never
overwrites your edits.

The Meta section is HQ's configuration, in the same file as the rules:

```markdown
## Meta

- batch-max: 4
- batch-requires-same-project: true
- batch-trivial-only: true
- graduation-consecutive-agreements: 10
- graduation-min-days: 14
- audit-sample-rate: 0.2
- staleness-minutes: 30
```

## Authority

Every packet carries a **shadow ruling** — what HQ would have decided — and your
ruling grades it. Sustained agreement in a domain earns a *proposal*; only
`/hq_graduate` grants anything, and one command takes it back. Even inside a
graduated domain, an irreversible or high-blast decision still reaches you.
Decisions answered without you are sampled for review — `hq_audit` lists them.

## What lives on disk

Everything, under `~/.pi/hq/` (override with `HQ_HOME`; resolved from
`PI_CODING_AGENT_DIR` when set):

| Path | Contents |
|---|---|
| `sessions/<id>.json` | One row per supervised session: state, title, last event. |
| `queue/<id>.json` | One packet per file. This is the queue. |
| `archive/<id>.json` | Packets that have been ruled. |
| `stops/<id>.json` | One record per observed stop, until triage finishes it. |
| `doctrine/` | Your rules. |
| `rulings.jsonl` | Every ruling, append-only. |
| `audit.jsonl` | Every decision answered from doctrine without you. |
| `defects.jsonl` | Every time a packet made you open a session anyway. |
| `drills.jsonl` | Each drill step and which tier answered it. |
| `graduation.json` | Per-domain agreement tallies and grants. |
| `logs/` | stdout of spawned workers, for when one misbehaves. |

Nothing is held in a session's memory: kill the seat mid-queue and a fresh one
picks up exactly where it was. Whole-file writes are atomic; logs are append-only.

Optional mechanical settings live in `~/.pi/agent/hq.json` (see
[`config/hq.example.json`](config/hq.example.json)) — a fast model for titling the
board, and a cap on concurrent workers. Everything else, including the staleness
threshold and the batching and graduation numbers, lives in doctrine's Meta
section, so there is exactly one place to look.

## How it works

- A **reporter** runs in every session. In your own sessions it publishes the
  fleet row and asks for a title, and does nothing else — HQ never triages or
  actuates a session you are sitting in. In a managed session it also records the
  stop and asks triage to look at it.
- **Workers** are child `pi` processes in print mode (`pi -p`, `pi --session … -p`
  to resume, `pi --fork … -p` to drill a copy). A child gets its own environment,
  so the managed marker never leaks onto your seat, and the seat can be killed
  without orphaning work.
- **Triage** decides one of four things: continue (doctrine decides it, the domain
  is graduated, and the step is reversible), packet, close, or respawn. The rules
  that must hold — the reversibility ceiling, graduation, the respawn limit — are
  code, so they hold whatever the model says.
- **Drills** answer questions about a session. Tier 1 reads the transcript; tier 2
  resumes a *copy* and asks it directly — and the copy is told nothing about HQ,
  so the packet it answers comes from the run, not from the model. Answers come back with verbatim quotes,
  because a distilled answer you cannot check is one you have to go and verify.
- A resumed session keeps its session id, so a continuation appears as the same
  fleet row rather than a new one.

## Development

```bash
npm run verify --workspace @doodledood/pi-hq   # typecheck + unit tests
npm run test:e2e --workspace @doodledood/pi-hq # full lifecycle, real sessions
```

The end-to-end runner takes stage names — `skeleton`, `drill`, `tiering`,
`doctrine`, `grammar`, `graduation`, or `all` (the default). `skeleton`, `drill`
and `tiering` spawn real headless sessions and spend tokens; the rest exercise the
substrate with a recording spawner. `tiering` is the behavioural check on the drill
order: one question whose answer is in the transcript verbatim must come back
answered at tier 1 with no copy opened, and one that depends on reasoning the
session never wrote down must escalate to the fork. Everything runs against a temporary state root, and on failure
it keeps that root and prints its path.
