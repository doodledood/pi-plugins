# advisor-consult

An independent **second-opinion advisor** the model can consult on risky, uncertain, or high-leverage work.

`advisor_consult` runs a fresh, high-capability `pi` agent in its own subprocess — it can read files, run read-only commands, and search — then returns advice for the calling ("parent") model to weigh. The subprocess is invisible to the user, never asks the user anything, and makes no durable or external changes. The parent tool row remains visible so you can inspect what was sent and which settings were requested.

## Why this exists

On hard calls — validating a plan, adversarially reviewing your own reasoning, a subtle diagnosis, getting unstuck when you're looping on a blocker you can't fix, a final gut-check before an expensive or irreversible step — a genuinely independent read is worth more than the model second-guessing itself in the same context. `advisor_consult` gives the parent that read on demand:

- **Independent** — its own process, its own (by default higher-capability) model, no shared context to anchor on. It treats the parent's brief as a hypothesis to test, not a conclusion to confirm.
- **Broad but bounded** — it keeps the parent's normal tool surface (files, search, MCP, scratch space) so it can gather evidence, but a small hard denylist keeps the invisible advisor from recursing, questioning the user, or orchestrating other agents.
- **Honest about uncertainty** — a timeout or failure returns an explicit "no reliable advice" result, never partial advice dressed up as an answer.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/advisor-consult
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/advisor-consult/extensions/advisor-consult/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Once published to npm: `pi install npm:@doodledood/pi-advisor-consult`.

After updating an installed Git package with `pi update git:github.com/doodledood/pi-plugins@main`, run `/reload` or start a new Pi process so the active session instantiates the new extension code.

## Tool API

```ts
advisor_consult({
  query: string,            // required: a context-rich neutral advisory brief
  model?: string,           // optional: Pi model pattern, or "inherit"
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  timeout_ms?: number,      // optional: clamped to configured bounds
})
```

- **`query`** — a full advisory brief, not a one-line question: the objective, the key facts and evidence, the parent's current read or plan, the tensions and alternatives, and the decision being weighed — separating observation from interpretation. A leading or thin brief gets a weaker read.
- **`model`** — defaults to the configured high-capability advisor model. Pass `inherit` to run on the parent session's current model.
- **`thinking`** — Pi-native reasoning levels only. Defaults to the configured level (`xhigh`).
- **`timeout_ms`** — per-call override, clamped into `[minTimeoutMs, maxTimeoutMs]`. Defaults to ~10 minutes.

The result is advice for the parent to weigh, prefixed with a compact `[advisor · model: … · duration]` header. It is **not** an action taken on the user's behalf.

### Invocation display

The tool row shows invocation details before the advisor returns:

- **Collapsed:** a width-bounded model/effort/timeout summary and one-line query preview.
- **Expanded:** labeled values with their provenance (`requested`, `configured default`, or `clamped`) and the complete multiline query.

Configured defaults are a renderer-time preview, not a claim about the subprocess's eventual model. `inherit` is shown as `parent model`; the completed result header remains authoritative for the model that actually ran and surfaces any requested/actual mismatch.

The query is visible in the local transcript and stored with the tool call, so do not put credentials or other secrets in an advisory brief. The renderer visibly escapes terminal control and bidirectional override characters instead of executing or silently hiding them; it does not heuristically redact ordinary text.

### Example queries

A good `query` is a full brief. Two shapes that work well:

Plan validation before committing:

```ts
advisor_consult({
  query: `Objective: migrate the sessions table to the new partitioned schema with zero downtime.
Plan (my current read): dual-write to old+new for a week, backfill in batches of 10k, then cut reads over behind a flag and drop the old table.
Evidence: the table is ~40M rows; write QPS peaks ~1.2k; there's an FK from events.session_id; the backfill script is idempotent (tested on staging).
Tensions: I'm unsure the dual-write window is long enough given replication lag, and whether the FK forces an ordering constraint I'm missing.
Alternatives considered: online schema-change tool (rejected — no partitioning support), or a maintenance window (rejected — SLA).
Decision I'm weighing: is the dual-write + flag-cutover plan safe, or am I underestimating a failure mode? Challenge the framing.`,
})
```

Hard diagnosis / adversarial review:

```ts
advisor_consult({
  query: `Objective: explain intermittent 504s on POST /checkout (~0.3% of requests, only under load).
What I observed: p99 upstream latency is fine; the 504s cluster on pods right after autoscale-up; no errors in app logs; the LB idle timeout is 60s and the failing requests all sit at ~60.0s.
My current read: the LB 60s timeout is cutting off a slow dependency during cold-start, not the app itself.
Evidence I could NOT get: the downstream payment gateway's own latency traces for those exact requests.
Alternatives: connection-pool exhaustion on cold pods; DNS resolution stalls on new pods.
Decision: is my LB-timeout read right, or is there a more likely cause I'm anchoring past? What would you check next?`,
})
```

## Configuration

Optional config at `~/.pi/agent/advisor-consult.json` (see `config/advisor-consult.example.json`). Missing/partial/malformed files fall back to safe defaults, with a warning for invalid values. The config is re-read on each `advisor_consult` call, so edits take effect on the next consult with no reload.

| Field | Default | Meaning |
|---|---|---|
| `defaultModel` | `anthropic/claude-fable-5-1` | Preferred advisor model (Pi `--model` pattern). `"inherit"` uses the parent's model. |
| `defaultThinking` | `xhigh` | Advisor reasoning effort (Pi-native names only). |
| `defaultTimeoutMs` | `600000` | Default subprocess timeout (10 min). |
| `minTimeoutMs` | `30000` | Lower bound for a per-call `timeout_ms`. |
| `maxTimeoutMs` | `1800000` | Upper bound for a per-call `timeout_ms`. |
| `excludedTools` | `["goal","subagent","get_subagent_result","steer_subagent"]` | Extra tools denied to the advisor, on top of the always-on hard denylist. |

### Model default and portability

The package default prefers a **Fable-family** model because advisor calls are high-leverage and warrant top capability. If that model is not available/enabled in your environment, set `defaultModel` to one you have (or `"inherit"`). When the requested model is not the one the subprocess actually ran on, the result surfaces that mismatch so the advice is never silently produced by a weaker model.

## Safety boundaries (invisible surface)

The advisor is invisible to the user, so its capabilities are deliberately bounded:

- **Always hard-denied** (cannot be re-enabled): `advisor_consult` (no recursion) and `ask_user_question` (never surface a question to the user).
- **Denied by default, configurable** via `excludedTools`: orchestration tools (`goal`, `subagent`, `get_subagent_result`, `steer_subagent`).
- **Prompt-enforced** — the advisor system prompt forbids durable/external changes (edits to real files, commits, pushes, deploys, messages). Disposable scratch files and read-only commands are allowed; durable or external actions are recommended back to the parent instead.

Denied tools are removed from the subprocess registry via `--exclude-tools`. A small child bootstrap (loaded only inside the subprocess via `-e`) broadens the active tool set to the file/search/list built-ins and every extension tool, while leaving MCP-tool schema budgeting to `mcp-tool-loadout` when installed.

## How it works

Each consult spawns `pi --mode json -p` with:

- `--system-prompt` set to the advisor persona (replacing the default coding-agent posture), and `--no-context-files` for a neutral, independent frame;
- `--exclude-tools <denylist>` to remove the hazardous tools;
- `-e <child-bootstrap>` to broaden the active non-MCP tool set after the child's extensions load;
- `--session-dir <parent-session-file-without-.jsonl>/advisor` so the consult's own session persists (see **Local state**);
- `--model` / `--thinking` resolved from config and per-call overrides.

The runner parses JSON-mode output for the advisor's final message, redacts secrets from any diagnostics, and returns a clear result for success, empty output, nonzero exit, timeout, or a model/provider error. Pi reports a failed model call (e.g. an unknown model id) on an assistant message with `stopReason: "error"` while still exiting 0, so the runner surfaces that error explicitly; for model-not-found it points you at `pi --list-models` to see what's available in this environment.

## Tool selection note

`advisor_consult` is a normal (non-MCP) extension tool, so it stays active whenever the extension is installed. `mcp-tool-loadout` only gates **MCP** direct-tool schemas — it does not affect `advisor_consult`, and this tool does not need `alwaysActiveMcpTools`.

Pi's own tool selection can limit *any* tool type — built-in, extension, custom, or MCP — through `--tools` (allowlist), `--exclude-tools`, `--no-tools`, and an extension's `setActiveTools()` call. So `advisor_consult` stays active unless one of those broader limiters excludes it. The advisor subprocess owns its own active-tool policy through the child bootstrap (`setActiveTools()` on the child) rather than inheriting the parent session's set.

If you have an MCP tool whose native direct schema should always be loaded (not left dormant for `load_tools`/`mcp` proxy calls), pin it with `mcp-tool-loadout`'s `alwaysActiveMcpTools` — that is the right home for important MCP tools. `advisor_consult` itself does not belong there, because it is not an MCP tool.

## Rollback

For the Git root bundle, restore the previous implementation in a new commit while keeping release versions monotonic: bump the root and advisor package patch versions, regenerate `package-lock.json`, run `npm run verify`, then push `main` and update the installed rolling package:

```bash
pi update git:github.com/doodledood/pi-plugins@main
```

Run `/reload` or restart Pi afterward. This forward-versioned rollback restores the previous code without disabling the repo's other extensions or theme, reusing an immutable release tag, or regressing package history; package filters remain intact. If advisor-consult was installed as its standalone package instead, remove that package from `settings.json` (or Pi package config). Delete `~/.pi/agent/advisor-consult.json` only if you also want to remove its optional configuration; past consult sessions live under their parent sessions' sidecar directories and are removed by deleting those parent sessions along with the sibling directory of the same name (see **Local state**).

## Decision record

Design rationale — independent subprocess (not subagents, not Anthropic-native advisor injection), query-only API, broad tools with a small hard denylist, no default transcript passing — is recorded in [`docs/adr/20260709-advisor-consult-independent-subprocess.md`](../../../docs/adr/20260709-advisor-consult-independent-subprocess.md).

## Local state

It reads optional config from `~/.pi/agent/advisor-consult.json` and spawns a `pi` subprocess per consult.

Each consult writes its own Pi session file to `<parent-session-file-without-.jsonl>/advisor/`, a directory alongside the parent session file. A consult costs real money, and a run with `--no-session` leaves nothing behind, so its spend cannot be counted and its reasoning cannot be reviewed. Persisting it fixes both: the `simple-statusline` cost surfaces sum these into the session-tree total and `/cost` attributes them, and the transcript stays available for inspection.

Because Pi lists sessions from one directory non-recursively, these nested files never appear in the session list or the `/resume` picker — the consult stays invisible during use. They are retained for the life of the parent session; deleting the parent's `.jsonl` file and the sibling directory of the same name removes them with it. When the parent session is not persisted at all (for example `pi --no-session`), the consult also runs without a session, since there would be nothing to attach its spend to.

No advisory query text, advice, or model output is written anywhere else.
