---
name: hoobot-health-report
description: Check the bots, the manager and their Slack and Discord apps, then tell the user in one short message what is wrong and what only they can do about it. Use when the user asks "how are the bots", "is anything broken", "check the bots", on a slow or quiet bot, before a restart, or proactively when idle and something needs the user. Also use to hand back a list of fixes after any bot change.
---

# Health report

A short, honest status line — not a wall of output. The point is the user
knows what needs **them**, because most of it only they can do.

## Run

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it
# once, then read a path with: HOO_PATHS selftest
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }

bash "$(HOO_PATHS selftest)" <name> [<name>…]
```

That is the whole diagnosis. Add, only if a check was inconclusive:

```sh
curl -s http://127.0.0.1:8790/api/manager | python3 -m json.tool | head -40   # what the manager knows
tail -30 "$(HOO_PATHS runtime)/<name>/<name>.log"                                 # what it said at startup
```

## What the user must do vs what we can do

Say it in two groups, and never pad the first with the second.

**Only the user** (a decision, not a limitation — everything mechanical is
ours to do):
- Which channel (Slack) or which server (Discord) the bot should work in.
- The first mention, because only a person types it.
- Discord's application and its bot token, and Message Content Intent — the
  portal, every time, because Discord has no CLI. See `discord-bot-create`.

`slack login` is only theirs if the CLI is not logged in.

Everything else we do ourselves: creating the Slack app, changing its scopes,
reinstalling it, uploading its icon, fetching both tokens (`bot-slack`), and
everything on Discord after the portal step — token, icon, invite URL with
the right permissions, `PEER_BOT_IDS` (`bot-discord`).

**Us** (just do it, then report it done):
- `.env` keys, ports, peer wiring, workdirs, restarts, avatar seeds.
- Moving a bot into `~/.hoobot/runtime` so the manager sees it.
- Re-rolling a face and exporting the PNG.

## When to reach out unprompted

Idle, and one of these is true:
- A bot's Slack or Discord token is dead, or a surface isn't `connected` for
  more than a few minutes. Silence looks exactly like "nobody is talking to
  me".
- A Discord bot that is in no server, or whose `GUILD_ID` names a server it
  is not in — it answers nowhere, and looks alive.
- A Discord bot receiving mentions but never answering: that is Message
  Content Intent being off, and it is the user's switch.
- A bot is missing from the manager, or the manager isn't running.
- A peer is wired one-way, or wired on Slack and not on Discord.
- A `.env` references a path that doesn't exist.

Do **not** reach out about: a bot being idle, a thread timing out, a build
being unpublished, or anything the checklist above already covers. One
message, the problem, the fix, done. Not a status report nobody asked for.

## Shape of the message

Short. Worst thing first. Slack, not a document — unless there's enough to
justify a page, in which case use `mobile-deliverable`.

```
hee is down: its Slack token is dead (account_inactive — the app was
uninstalled or reset). I can't mint a new one.
→ api.slack.com/apps → hee → Install App → paste both tokens

Everything else is fine. hoo is connected and the two are wired to each
other both ways.
```

Rules:
- No checkmarks, no green ticks, no "✅".
- Say plainly what you could not do, and why it isn't a code problem.
- Don't apologise for the bot's own state; report it.
- Numbers, not adjectives: "3 bots, 1 down", not "mostly healthy".