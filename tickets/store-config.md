# Ticket store config

**Venue: GitHub Issues on `doodledood/pi-plugins`.** Work for this repo is tracked there — read this before asking where tickets live, and emit new ones there.

The mapping onto issues — labels, effort front files, dependency edges, how a ticket closes — is `references/GITHUB_STORE.md` in the `ticket-up` skill. It is not restated here, so the two can never drift apart.

This directory holds this file and nothing else. There are no `tickets/<effort>/` directories and there should never be any: the store is GitHub, not the file system.

## Unattended runs

- **Automation identity:** not configured. Unattended runs — `orchestrate`, and `run-ticket` with no person present — claim Tickets and write records as one account that must be distinguishable from the person who receives escalations. No such account is provided yet, so unattended runs start nothing. A run a person starts by hand writes as that person.
- **Escalation recipient:** the repository owner.
- **Designated evidence:** this repository's issues, pull requests and Actions runs. Notification routes stay in the owner's private instructions, never here.
