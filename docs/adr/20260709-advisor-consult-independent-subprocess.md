# ADR: Advisor Consult Uses an Independent Subprocess

## Status
Accepted

## Context
We want a Pi advisor capability that the parent model can invoke when a stronger independent read could materially improve a risky or uncertain answer. The intended use cases include validating plans, architecture/design trade-offs, debugging hypotheses, diagnosis reads, security or edge-case concerns, final completion checks, and requests that call for an independent derivation, fresh read, adversarial review, confidence calibration, or second opinion.

Anthropic's native advisor tool is conceptually related, but implementing that path in Pi would require provider-layer support for beta headers, server-side advisor tool definitions, `server_tool_use` / `advisor_tool_result` stream blocks, continuation semantics, and advisor-specific usage accounting. A simple provider-payload extension would not be enough.

The advisor also needs to be general across local Pi setups. It should be able to use installed tools and extensions, including web/search/file tools and temporary scratch artifacts, because useful advice may require inspecting context beyond the parent model's current wording. At the same time, the advisor runs on an invisible autonomous surface: only the parent model sees its answer. It must not ask the user or perform durable/external actions on the user's behalf.

## Decision
Build `advisor_consult` as a self-contained Pi extension using the same broad execution pattern as `goal-controller`'s checker runner: launch an independent Pi subprocess, select the configured advisor model and thinking level, run a purpose-built advisor system prompt, parse the subprocess output, and return the advice to the parent as the tool result.

The tool API will stay minimal. Its core field is `query`, defined as a neutral advisory brief rather than a one-line question. The parent model should include the objective, relevant context, observed evidence, current leading read or plan if any, known uncertainties or tensions, alternatives considered, and the decision it needs help with. It should separate observed facts from interpretations and invite the advisor to challenge the framing.

The advisor will default to a Fable-family model where available and Pi's highest public thinking level, `xhigh`. The advisor run will be bounded by a configurable timeout, defaulting around ten minutes, with a per-call `timeout_ms` override subject to configured bounds.

The subprocess should have a broad tool/extension surface by default, but with a small hard denylist for capabilities that are unsafe or incoherent on an invisible advisory surface. At minimum, deny recursive advisor calls and user-question tools such as `ask_user_question`. Session orchestration tools such as goal/subagent controls should be denied by default and configurable. Durable and external side-effect restrictions are primarily enforced by the advisor prompt: the advisor may inspect and use temporary scratch artifacts, but should recommend durable project changes, user-visible communications, releases, deployments, ticket/PR/Slack actions, and session lifecycle changes to the parent rather than executing them.

Do not pass the parent transcript path to the advisor by default. The parent-authored advisory brief is the context channel. The advisor may inspect files, docs, web sources, and other available evidence when that could materially change the recommendation, but it should treat the parent brief as a crux to examine rather than a conclusion to confirm.

## Alternatives Considered
- **Anthropic-native advisor tool injection**: Closest to Anthropic's same-turn advisor semantics, but Pi does not currently expose enough provider/stream/session support to make a payload-only plugin safe. It would risk dropped advisor blocks, incorrect replay, and missing cost accounting.
- **Depend on `@gotgenes/pi-subagents`**: Provides child agents, background runs, steering, resume, custom agent types, and UI, but the advisor is a bounded consultation primitive rather than a general delegated agent. Depending on subagents would add unnecessary surface area and coupling.
- **Reuse goal-controller's read-only checker profile**: Safer by hard capability restriction, but too narrow for a general advisor. Good advice may require extension tools, web research, file inspection, or temporary scratch work. We borrow the independent subprocess pattern, not the audit-only tool cap.
- **Expose structured fields instead of one `query` field**: Fields such as `facts`, `current_read`, and `uncertainties` could reduce anchoring, but they make invocation clunky and may discourage natural proactive use. A single advisory-brief field keeps the API easy while preserving the needed context contract.
- **Pass the full parent transcript or transcript path by default**: Maximizes raw context, but can bury the crux, leak unnecessary session details, and encourage the advisor to audit conversation mechanics rather than answer the advisory brief. The parent should supply a neutral, context-rich brief instead.

## Consequences

### Positive
- Keeps the advisor package self-contained and installable without subagents.
- Gives the parent model a simple, general-purpose second-read primitive it can invoke proactively from any skill or workflow.
- Preserves high-quality advice by defaulting to a high-capability model and `xhigh` thinking.
- Allows broad local tool use across many Pi setups while keeping invisible-surface hazards explicit.
- Avoids prematurely depending on provider-specific Anthropic advisor semantics.

### Negative
- Does not reproduce Anthropic's native same-turn advisor behavior; the advisor is an out-of-band subprocess consult.
- Prompt-governed side-effect boundaries are softer than a strict tool allowlist, so the prompt and default denylist must be sharp.
- The parent model must write a good advisory brief; omitted context can still lead to weaker advice.
- Broad extension/tool inheritance may expose locally risky tools unless the denylist is configured for that setup.

## Source
- Session: figure-out log `/Users/aviram.kofman/.manifest-dev/logs/figure-out-log-20260709-080151.md`
- Manifest: `/Users/aviram.kofman/.manifest-dev/manifests/manifest-20260709-090540.md`
- Related: `packages/extensions/goal-controller` checker subprocess pattern
