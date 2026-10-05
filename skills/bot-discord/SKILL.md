---
name: bot-discord
description: Create, verify, invite, re-icon and delete a hoobot bot's Discord app with the Discord API and the bot's own token. Use when creating a Discord bot, adding Discord to a bot that is Slack-only, when a bot's DISCORD_TOKEN is dead, when a companion bot never answers on Discord, when someone needs the id for PEER_BOT_IDS or the invite URL with the right permissions. Everything except making the application itself, which is the one browser step Discord has no CLI for.
---

# The Discord half of a bot

Slack has a CLI, so `bot-slack` can create the app, install it, mint both
tokens and upload the icon without a browser. **Discord has no equivalent.**
An application is made in the developer portal by a person, and no script
gets around that. Everything after it is here, because each of those steps
was another portal visit:

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it
# once, then read a path with: HOO_PATHS skills
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }

D="$(HOO_PATHS skills)/bot-discord/scripts"
```

`paths.sh` lives with `bot-slack` and every skill shares it — see
hoobot's `AGENTS.md`: skills are copied between machines, so none of them
hard-codes a path.

## The one step a person has to do

```
discord.com/developers/applications → New Application → name it
  → Bot → Reset Token          → copy the token
  → Bot → Privileged Gateway Intents → Message Content Intent  ON
```

**Message Content Intent is not optional.** It is a privileged intent, off by
default, and with it off the bot receives message events with an empty
`content` — so it sees the mention and has nothing to answer. Nothing this
skill can read tells you it is off; the symptom is the only sign.

Then everything else:

```sh
# the face comes first, so it goes up with the bot
bun "$(HOO_PATHS avatar-png)" --name hee --style pet --shape squircle \
  --palette rose --size 512 --out /tmp/hee.png

# 1. save the token, get the id PEER_BOT_IDS needs and the invite URL back
bun "$D/discord-app.ts" write hee --token <token> --guild <guild-id>

# 2. put the avatar on the bot itself
bun "$D/discord-app.ts" avatar hee --icon /tmp/hee.png

# 3. the user opens the invite URL and picks the server

# 4. prove it: gateway, guild, peers, both directions
bun "$D/discord-app.ts" verify hee
bash "$(HOO_PATHS selftest)" hee
```

## The id, and why Discord's does not go stale

A Discord token is `base64(application_id).timestamp.hmac`, so the
application id is in the first segment and no request is needed to read it.
The bot's user id **is** the application id, so `PEER_BOT_IDS` takes either:

```sh
bun "$D/discord-app.ts" id hee      # decoded, no network
bun "$D/discord-app.ts" token hee   # the same id, asked of Discord
```

`id` cannot lie about a dead token; `token` cannot lie about a token that
does not work. Use `token` before wiring a peer, `id` when you already trust
the file.

A Discord bot's id survives a rename and a token reset. A Slack one does
not: it changes every time the app is recreated. That is why the Slack
`peer-sync.ts` resolves ids over the network and this one does not need to —
and why a stale Discord id is almost always a bot that was deleted or a typo,
not an app that was rebuilt.

## One list, two chats

`PEER_BOT_IDS` holds both chats in one comma-separated list: Discord ids are
digits, Slack member ids start with `U`. `discord-app.ts` splits them rather
than asking Discord about a `U…` — which answers **400 Invalid Form Body**,
not "unknown user", and reads like a broken id.

So a Slack companion mesh does not carry over. If `heo` and `hee` answer each
other on Slack and you add Discord, each bot's `PEER_BOT_IDS` needs the
other's Discord application id *as well*:

```sh
bun "$D/discord-app.ts" peers hee   # says what is missing, both directions
```

It matches an id to an instance folder by token, not by username, because the
portal calls the bot `hoo-bot` and the manager calls it `hoo`.

## What `verify` checks

| Line | Means when it is wrong |
|---|---|
| `bot_id`, `bot_name`, `is_bot=true` | a person's token in `DISCORD_TOKEN` |
| `application_id` ≠ `bot_id` | the token belongs to a different app than the one in the portal |
| `guilds=(none)` | never added to a server — open the invite URL |
| `GUILD_ID` set, bot not in it | the bot answers nowhere |
| `gateway=FAILED` | healthy in the manager, dead to Discord; a reconnect loop looks identical |
| peer lines | a person, a stale id, or a one-way peer |

## Commands

| Command | What it does |
|---|---|
| `id <bot>` | the application id, decoded from the token |
| `token <bot>` | the same id, verified through Discord |
| `invite <bot>` | the OAuth URL, carrying every permission the bot needs |
| `write <bot> --token …` | save the token (and `GUILD_ID`), print the invite URL |
| `avatar <bot> --icon png` | set the bot's own avatar |
| `verify <bot>` | everything above, plus peers in both directions |
| `peers <bot>` | just the peer check; exit 1 if a peer is wrong |

## The permissions in the invite URL

`invite` asks for exactly what `src/discord.ts` uses, and no more:

| Permission | For |
|---|---|
| `view_channel` | seeing the channel at all |
| `send_messages` | answering |
| `read_message_history` | context, and the catch-up after a dropped gateway |
| `send_messages_in_threads` | threads are gated separately; without it every thread is ignored |
| `attach_files` | files in and out (`inbound.ts`) |
| `embed_links` | links in answers |

Administrator is **not** requested and should not be: it is the difference
between a bot that can post in a channel and a bot that can delete the
channel. Discord can add permissions later; it can only widen an invite.

## Deleting

There is no delete here, on purpose. Removing a Discord application needs the
owner's credentials in the portal, and a script that could delete one would
be a script that could delete the wrong one. Say so and stop.

## Repair

- 401 from any command → the token was reset or the app deleted. Only the
  portal can mint a new one.
- `400 Invalid Form Body` on `/users/<id>` → a Slack id in `PEER_BOT_IDS`.
- Bot connected, no replies, mention text empty → Message Content Intent off.
- Answers in channels but not threads → `send_messages_in_threads` missing.
- Answers, but not what was said before a reconnect → `read_message_history`
  missing; the catch-up reads history and gives up quietly per channel.