---
name: bot-selftest
description: Run the end-to-end check on a hoobot instance and fix what it finds. Use after changing any bot config, tokens, peers, ports or workdirs; after creating or updating a bot; before telling a user "done"; and when a bot seems broken, quiet, or missing from the manager. Catches dead Slack tokens, one-way peer wiring, bots never invited to a channel, wrong runtime folder, and bots running from a checkout instead of the published build.
---

# Bot self-test

One command, exit 0 = healthy:

```sh
bash "$(hoobot path selftest)" hoo hee
```

With no arguments it checks `$HOO_INSTANCE`. **This is the gate.** Do not
report a bot change as done without a passing run — most "it's broken" bugs
are on this list and take ten seconds to find.

## What it checks

1. `.env` exists in `$HOOBOT_RUNTIME_DIR` — the dir the manager reads.
2. The manager's `/api/manager` lists the bot, and its surfaces.
3. `ALLOWED_USER_IDS` is non-empty (the bot refuses to start without it).
4. A live pid, and that the process is the **published** build
   (`node_modules/@kolisachint/hoobot`), not a checkout. Set
   `EXPECTED_NPM_GLOBAL=0` only when deliberately testing a change in place.
5. `auth.test` on the Slack token — and a specific message when it's dead.
6. The bot is in at least one conversation (was it `/invite`d?).
7. Every `PEER_BOT_IDS` entry is a real bot, **and the peer lists this bot
   back**. One-way peers never answer each other, and it is the single most
   common mistake when setting two bots up together.
8. `/healthz` answers and each surface reads `connected`.
9. `HOO_WORKDIR` exists.

`FAIL` means fix it. `note` means "nothing to prove here yet" — fine for a
bot that hasn't been given tokens, not fine for a bot the user says is
running.

This reads the bot's *token*. It cannot see whether the app behind it is
installed, has the scopes you think, or is wearing the right icon. When the
change touched the Slack app, check that end as well:

```sh
bun "$(hoobot path skills)/bot-slack/scripts/slack-app.ts" verify <name>
```

And a passing selftest is not a conversation. The real gate is the bot
answering a mention in Slack.

## Reading the failures

| Output | Meaning | Fix |
|---|---|---|
| `no .env at …` | wrong folder | move it under `$(hoobot path runtime)/<name>/` |
| `Slack token dead: account_inactive` | app uninstalled or token reset | `bot-slack`: `sync` to reinstall, then the user re-copies both tokens |
| `is a person, not a bot` | a human ID in `PEER_BOT_IDS` | remove it |
| `users.info not ok` | the bot's own token is dead, so nothing can be verified | fix the token first |
| `does not list … in PEER_BOT_IDS` | peer wiring is one-way | add the id to the peer's `.env`, then restart **both** |
| `in no conversations` | never invited | `/invite @name` in a channel |
| `not the published build` | running from `a hoobot checkout` | `RUN_FROM_NPM=1` restart; edits to `src/` are not live |
| `workdir … doesn't exist` | `HOO_WORKDIR` typo | create it or fix the path |

## Ordering after a change

1. Edit `.env` (or use the manager page).
2. Restart the bot — config is read **once at startup**, so an edited
   `PEER_BOT_IDS` does nothing until then.
3. Re-run this script.
4. Only then tell the user.

## Two bots, so both

Peer changes never take effect in one bot alone: restart both, then run the
script with both names so the back-link check runs in each direction.