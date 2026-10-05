---
name: bot-selftest
description: Run the end-to-end check on a hoobot instance and fix what it finds. Use after changing any bot config, tokens, peers, ports or workdirs; after creating or updating a bot; before telling a user "done"; and when a bot seems broken, quiet, or missing from the manager. Catches dead Slack or Discord tokens, a bot that never joined a Discord server, missing gateway intents, one-way peer wiring on either chat, bots never invited to a channel, wrong runtime folder, and bots running from a checkout instead of the published build.
---

# Bot self-test

One command, exit 0 = healthy:

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it
# once, then read a path with: HOO_PATHS selftest
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }

bash "$(HOO_PATHS selftest)" hoo hee
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
   common mistake when setting two bots up together. Slack ids and Discord
   ids share one list, so each chat checks the ids that are its own.
8. Discord, when there is a `DISCORD_TOKEN`: the token is live, the gateway
   is reachable, the bot is in a server (`GUILD_ID` names one it is in), and
   each Discord peer is a bot that lists it back.
9. `/healthz` answers and each surface reads `connected`.
10. `HOO_WORKDIR` exists.

A bot is only checked on the chats it has tokens for. A Slack-only bot is
never asked about Discord, and its Discord token being empty is a `note`, not
a `FAIL`.

`FAIL` means fix it. `note` means "nothing to prove here yet" — fine for a
bot that hasn't been given tokens, not fine for a bot the user says is
running.

This reads the bot's *token*. It cannot see whether the app behind it is
installed, has the scopes you think, or is wearing the right icon, and it
cannot read Discord's privileged gateway intents — with Message Content off,
the token is fine and the bot still sees every mention as empty text. When the
change touched the Slack app, check that end as well:

```sh
bun "$(HOO_PATHS skills)/bot-slack/scripts/slack-app.ts" verify <name>
bun "$(HOO_PATHS skills)/bot-discord/scripts/discord-app.ts" verify <name>
```

And a passing selftest is not a conversation. The real gate is the bot
answering a mention — in Slack or on Discord.

## Reading the failures

| Output | Meaning | Fix |
|---|---|---|
| `no .env at …` | wrong folder | move it under `$(HOO_PATHS runtime)/<name>/` |
| `Slack token dead: account_inactive` | app uninstalled or token reset | `bot-slack`: `sync` to reinstall, then the user re-copies both tokens |
| `is a person, not a bot` | a human ID in `PEER_BOT_IDS` | remove it |
| `users.info not ok` | the bot's own token is dead, so nothing can be verified | fix the token first |
| `does not list … in PEER_BOT_IDS` | peer wiring is one-way | add the id to the peer's `.env`, then restart **both** |
| `Discord token dead: Unauthorized` | token reset, or the app deleted | portal → Bot → Reset Token; only the user can do it |
| `gateway not reachable` | healthy in the manager, dead to Discord | check the token; it will receive nothing |
| `in no servers` | never added to a server | open the invite URL: `discord-app.ts invite <name>` |
| `GUILD_ID=… but the bot is not in that server` | invited to the wrong server, or a stale `GUILD_ID` | invite it there, or clear `GUILD_ID` |
| `PEER_BOT_IDS lists no Discord bot` | the mesh was wired for Slack only | `discord-app.ts id <other>`, add it, restart both |
| `… is a person, not a bot` (Discord) | a human id in `PEER_BOT_IDS` | remove it |
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
script with both names so the back-link check runs in each direction. On
Discord the back-link check matches a bot by its token, because the portal
calls it `hoo-bot` and the manager calls it `hoo`.