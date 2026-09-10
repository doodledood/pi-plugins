---
name: telegram
description: Send the user a one-way Telegram message or phone notification through their configured bot, including requested alerts, work completion, blockers, and decisions needing attention. Also set up the bot connection.
---

# Telegram

Send a concise, useful message to the user's configured private Telegram chat. Use the notification authority granted in the current task; this skill supplies delivery, not a standing instruction to notify after every task. It does not listen for replies or wake an idle agent.

Run the helper relative to this skill's directory:

```sh
python3 scripts/telegram.py status
python3 scripts/telegram.py send --text 'Your report is ready.'
```

For multiline text, use `send` with standard input from a safely quoted heredoc or a file. Text is sent literally, with notifications enabled and link previews disabled. Keep it within 4,096 UTF-16 units. The destination is fixed during setup; sending accepts no recipient override.

## Message presentation

Format for a phone screen. Lead with a short line naming the task and outcome or action needed, then separate supporting detail with a blank line. Use short paragraphs or `•` bullets for distinct points; keep a simple alert to one or two sentences. For an escalation, make the specific question and recommendation easy to find.

The helper sends plain text. Use actual line breaks, not literal `\n`, and avoid Markdown or HTML markup that would appear as raw punctuation. Put each useful URL on its own line with a short label above it. Skip tables and dense logs; link to the full report. An optional single status emoji can help scanning without decorating every line.

Example:

```text
✅ Telegram notifications — ready

Agents can now notify you when:
• A decision needs your attention
• A PR is merged
• Substantial work is complete

Policy PR
https://github.com/owner/repo/pull/123
```

A successful result means Telegram accepted the message, not that the phone displayed it or the user read it. On an uncertain send result, report uncertainty and do not automatically retry: Telegram has no send idempotency key.

If unconfigured, have the user run `python3 scripts/telegram.py setup` in their own interactive terminal. The helper privately prompts for a BotFather token, verifies the bot, prints a pairing phrase to send to that bot, and saves the matching private chat. It sends no test message automatically. Then send a user-authorized test and check the API result.

Credentials live in `~/.config/telegram-notify/config.json` with owner-only permissions, outside the skill. Keep tokens out of chat, command arguments, logs, and repositories. Use `status` to inspect configuration without displaying the token.

This local skill requires Python 3 and network access to `api.telegram.org`. It is usable by local agents that discover user-level skills; it does not install a tool into ordinary ChatGPT conversations.
