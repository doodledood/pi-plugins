# Architecture Decision Records

| Date | ADR | Status | Area |
|------|-----|--------|------|
| 2026-06-23 | [Ship each extension and theme as its own installable package](20260623-ship-each-resource-as-its-own-package.md) | Accepted | packaging |
| 2026-06-23 | [Use session-navigation context for goal checking](20260623-use-session-navigation-checker-context.md) | Accepted | goal-controller |
| 2026-06-24 | [Allow new goals over stopped goals](20260624-allow-new-goals-over-stopped-goals.md) | Accepted | goal-controller |
| 2026-06-24 | [Keep goal statusline rendering separate from goal-controller](20260624-keep-goal-statusline-separate.md) | Accepted | simple-statusline |
| 2026-06-24 | [Use a single audit-only goal checker profile](20260624-use-audit-only-goal-checker-profile.md) | Accepted | goal-controller |
| 2026-06-29 | [Resume completed goals as historical reactivation](20260629-resume-completed-goals.md) | Accepted; narrowed by [20261022-resume-budget-limited-goals-into-a-fresh-budget-window](20261022-resume-budget-limited-goals-into-a-fresh-budget-window.md) (budgets on a budget-limited resume apply to a fresh window) | goal-controller |
| 2026-07-06 | [Layered cache-efficiency observability (footer signal + /cache attribution)](20260706-cache-efficiency-observability.md) | Accepted | cache-optimization |
| 2026-07-06 | [cache-optimization extension (keeper + keepalive) and head-stable goal reminders](20260706-cache-optimization-extension.md) | Accepted | cache-optimization |
| 2026-07-06 | [Install from main and publish no release tags](20260706-track-main-for-installs-without-release-tags.md) | Accepted | packaging |
| 2026-07-07 | [Use captured-provider-payload replay for adaptive-thinking TTL keepalive](20260707-adaptive-thinking-ttl-keepalive.md) | Accepted | cache-optimization |
| 2026-07-07 | [Cache-optimization second wave](20260707-cache-optimization-second-wave.md) | Accepted | cache-optimization

- **Date:** 2026-07-07
- **Status:** Accepted
- **Supersedes/corrects:** part of [20260706-cache-optimization-extension](20260706-cache-optimization-extension.md)
- **Related:** [20260706-cache-efficiency-observability](20260706-cache-efficiency-observability.md), [20260624-keep-goal-statusline-separate](20260624-keep-goal-statusline-separate.md) |
| 2026-07-08 | [openai-max-output-floor extension](20260708-openai-max-output-floor-extension.md) | Accepted | openai-max-output-floor |
| 2026-07-09 | [Advisor Consult Uses an Independent Subprocess](20260709-advisor-consult-independent-subprocess.md) | Accepted | advisor-consult |
| 2026-07-28 | [Session-tree cost accounting via persistent parent-linked child sessions](20260728-session-tree-cost-accounting.md) | Accepted; narrowed by [20261104-run-slack-helpers-in-memory](20261104-run-slack-helpers-in-memory.md) (a Slack helper's session file keeps only its own entries, not a copy of its parent's) | cost-accounting |
| 2026-08-03 | [enforce the dual-window alias boundary before provider requests](20260803-enforce-dual-window-alias-boundary.md) | Accepted | model-aliases |
| 2026-08-11 | [Keep workplace material out of the repository with a structure scan](20260811-keep-workplace-material-out-by-a-structure-scan.md) | Accepted | publishing |
| 2026-08-20 | [Split the coding conventions out of setup/AGENTS.md](20260820-split-coding-conventions-from-setup-agents.md) | Accepted | setup |
| 2026-09-23 | [Validate only the goal checker's verdict path in Pi's JSON stream](20260923-validate-only-the-checker-verdict-path.md) | Accepted | goal-controller |
| 2026-10-06 | [Tolerate trailing commas and re-ask once when a goal checker's verdict is badly formatted](20261006-re-ask-format-invalid-checker-verdicts-once.md) | Accepted | goal-controller |
| 2026-10-14 | [Fork BTW without the parent's extension state](20261014-fork-btw-without-parent-extension-state.md) | Accepted | btw |
| 2026-10-14 | [Keep BTW read-only, with `send_to_main` as its one path into the main session](20261014-keep-btw-read-only-with-one-relay-to-main.md) | Accepted; amended by [20261022-steer-main-with-extension-sent-user-messages](20261022-steer-main-with-extension-sent-user-messages.md) (relays steer main's current run instead of queuing as a follow-up) | btw |
| 2026-10-14 | [Draw narration in the thinking tone by writing the tone into its Markdown source, checked against pi's renderer](20261014-quiet-narration-through-checked-source-tone.md) | Accepted | tool-activity-renderer |
| 2026-10-14 | [Use Pi's native fullscreen mouse routing for overlays and observe main-screen clicks through Pi's own handlers](20261014-use-pi-native-mouse-routing-for-overlays.md) | Accepted | btw |
| 2026-10-22 | [Resume budget-limited goals into a fresh budget window](20261022-resume-budget-limited-goals-into-a-fresh-budget-window.md) | Accepted | goal-controller |
| 2026-10-22 | [Steer main with user messages that extensions send on the user's behalf](20261022-steer-main-with-extension-sent-user-messages.md) | Accepted | btw |
| 2026-10-28 | [Host parallel Pi sessions in Herdr and ship a bridge, not a board](20261028-host-pi-in-herdr-and-ship-a-bridge.md) | Accepted | parallel-sessions |
| 2026-11-01 | [Derive the orchestrator role from started sessions, with no command to set it](20261101-derive-the-orchestrator-role-from-started-sessions.md) | Accepted | parallel-sessions |
| 2026-11-01 | [Only a main session orchestrates; a started session knows it was started](20261101-only-a-main-session-orchestrates.md) | Accepted | parallel-sessions |
| 2026-11-04 | [Close the owner's home folder to the Slack helper, except the project and folders he opens](20261104-close-the-home-folder-to-the-slack-helper.md) | Accepted | slack-companion |
| 2026-11-04 | [Give the Slack helper no shell on Linux until its secret denial is complete there](20261104-give-the-slack-helper-no-shell-on-linux-for-now.md) | Accepted | slack-companion |
| 2026-11-04 | [Hold Slack conversations in a read-only fork of the main session, with changes behind the owner's approval](20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md) | Accepted; amended by [20261104-keep-the-owners-own-slack-out-of-the-helpers-reach](20261104-keep-the-owners-own-slack-out-of-the-helpers-reach.md) (private MCP servers' tools only when he lists them) and [20261104-close-the-home-folder-to-the-slack-helper](20261104-close-the-home-folder-to-the-slack-helper.md) (the home folder is closed except the project and opened folders) | slack-companion |
| 2026-11-04 | [Keep the owner's own Slack and browser out of the Slack helper's reach unless he lists their tools](20261104-keep-the-owners-own-slack-out-of-the-helpers-reach.md) | Accepted | slack-companion |
| 2026-11-04 | [Let Slack input only narrow what sessions may do](20261104-let-slack-input-only-narrow-what-sessions-may-do.md) | Accepted | slack-companion |
| 2026-11-04 | [Let the agent carry Slack conversations on by itself, speaking only when addressed or useful](20261104-let-the-agent-carry-slack-conversations-on-by-itself.md) | Accepted | slack-companion |
| 2026-11-04 | [Rule that this repository is also for Pi users beyond the owner](20261104-rule-pi-users-beyond-the-owner-into-the-north-star.md) | Accepted | north-star |
| 2026-11-04 | [Run Slack helpers in memory and keep only what each one adds](20261104-run-slack-helpers-in-memory.md) | Accepted; amended by [20261104-show-slack-activity-in-a-dock-line](20261104-show-slack-activity-in-a-dock-line.md) (exchanges show in one line above the editor and a panel, not in main's transcript) | slack-companion |
| 2026-11-04 | [Run the Slack helper's shell in an OS sandbox with no network](20261104-sandbox-the-slack-helpers-shell.md) | Accepted; amended by [20261104-give-the-slack-helper-no-shell-on-linux-for-now](20261104-give-the-slack-helper-no-shell-on-linux-for-now.md) (on Linux, the helper has no shell) and [20261104-close-the-home-folder-to-the-slack-helper](20261104-close-the-home-folder-to-the-slack-helper.md) (the home folder is closed except the project and opened folders) | slack-companion |
| 2026-11-04 | [Serve anyone in a watched Slack conversation](20261104-serve-anyone-in-a-watched-conversation.md) | Accepted | slack-companion |
| 2026-11-04 | [Show Slack activity in one line above the editor with a panel on demand, not in main's transcript](20261104-show-slack-activity-in-a-dock-line.md) | Accepted | slack-companion |
| 2026-11-04 | [Start watching a Slack conversation when the session messages someone](20261104-start-watching-when-the-session-messages-someone.md) | Accepted | slack-companion |
| 2026-11-04 | [Watch Slack by polling from code through the MCP adapter, behind a swappable backend](20261104-watch-slack-by-polling-through-the-mcp-adapter.md) | Accepted | slack-companion |
| 2026-11-08 | [Embed the coding conventions in the root AGENTS.md, regenerated by one command](20261108-embed-the-coding-conventions-in-the-root-agents-md.md) | Accepted | setup |
