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
| | While seated, HQ watches the queue and wakes itself when a packet arrives behind it, so work that lands after you sat down still reaches you. |
| `/fleet` | Show or hide the fleet card. |
| `/hq_send_off [what to do next]` | Hand the session you are in to HQ. Run it in any session, in your own words — talk the work through, then send it off and pick it up at the desk. |
| `/hq_graduate <domain>` | Grant HQ authority to answer that domain from doctrine. Confirms first. |
| `/hq_revoke <domain>` | Take the domain back. |

`/hq_send_off` is the other way in. Everything HQ manages, it started — a session
carries `HQ_MANAGED=1` in its environment or it is yours. A session HQ did not start
is left alone entirely: it is not on the board, gets no title worker and is never
triaged, so the fleet card is only ever HQ's own fleet. Sending a session off flips that marker in the live session,
so its own reporter records the stop and HQ triages it from there. HQ then works on a
**fork** of the session rather than resuming it: your tab may still be open, and two
pi processes appending to one transcript would corrupt both readings of it. Leave the
tab or close it — either way the work carries on and reaches you at the desk.

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

Taking the seat prunes HQ's own bookkeeping — dead session rows, finished stop
records, and worker logs older than two weeks. Packets, rulings, audits, defects,
and doctrine are never pruned; they are yours.

`HQ_PI_BIN` overrides which `pi` binary workers are spawned with — the escape
hatch when spawning fails.

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

## How an ask looks

The decision and its question at the top, then the blast radius, reversibility and what
would change the answer, then a row per option with its price on its own line under it.
The packet bar makes options carry a price, and the ask is the moment that price is
worth reading — a title-and-labels dialog hid the very thing that lets you decide
without opening the session. The recommendation is marked, the rows are numbered so a
digit picks one, and the last three are always there: ask something first, rule in your
own words, or record that you had to open the session anyway. The two that need words
open an editor in place rather than throwing a second dialog at you.

A batch is **one dialog, one decision at a time** — `◉ ■ □` shows where you are and
what is still open, ←→ moves, and the last screen lists every decision by its whole title
with the ruling you are about to give. Nothing is applied until you submit, so moving
around costs nothing and Esc from anywhere leaves all of them pending.

Model-written prose is capped so it cannot bury the options: two lines for a price or a
flip condition, with the row you are on shown in full. Everything wraps to two columns
inside the terminal width, so nothing ragged runs off the edge in a narrow window.

The layout is a model and a pure renderer (`ask-ui.ts`), the way the fleet card is, so
what the dialog puts on screen is asserted on in tests rather than eyeballed: that every
option shows its price, that no line overflows the width, that the batch refuses to
submit while a decision is still open.

The rows are built in code from the packet, not written by the model at ask time, and
the ruling is recorded and routed against the option id you picked, refusing if the
packet changed since it was shown. That is the part worth keeping in code: it makes the
ruling log your decision rather than a model's account of it. Non-packet questions —
"which session did you mean?" — need none of this and are just asked in chat.

Where there is no TUI (an RPC client, a headless seat) the same rows come through the
plain selector with each price on the same line.

## Asking about the fleet

When the queue is empty the seat is still a conversation, and it is where you ask
about the work rather than about a decision — what a session is doing, what it
finished, what it will need next, whether it has gone quiet without finishing. It
answers from the board and from the sessions' own transcripts, quoting rather than
characterising, and drills the session itself when reading cannot settle it. Name a
session by its title; the board gives it the id.

## One question, one decision

A session is one line of work, so it has at most one open decision. When a later stop
in the same session produces a presentable packet, the earlier ones are withdrawn: the
session has moved past what they asked — HQ continued it, or you did — so ruling on one
would resume a session that is no longer where the question left it. Nothing is lost.
The withdrawn packet is kept and names what replaced it, and the live packet says which
questions it took the place of when it is put to you, so a question that still matters
can be raised again.

Identical packets are also deduplicated where they are written. A rule proposal is the
same decision whichever session raised it, and deduplicates across all of them. A
question about two different sessions stays two decisions: ruling on one resumes only
that session, so collapsing them would strand the other.

## Developing this while it is installed

Two copies of HQ visible to one session collide: pi refuses the second registration
of `hq_drill` and the session dies before it runs anything. A child that is handed a
working copy with `-e` while also discovering an installed HQ hits exactly that. Set
`HQ_ISOLATE_CHILD_EXTENSIONS=1` and children load only the copy HQ hands them; the
end-to-end harness sets it for every run.

## Reading the change

This shipped as one package rather than stacked slices, deliberately: the appetite
was the whole loop working, there is no pull request to review it in, and 36
independent gates verify it. If you want to read it in stages, take them in the
order the end-to-end runner does — `skeleton` (substrate, reporter, stop, triage,
packet, ruling), `drill` and `tiering` (the two drill tiers), `doctrine` (capture
and ratification), `grammar` (the ruling forms), `graduation` (authority). Each
stage's assertions name what that slice owes.

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
