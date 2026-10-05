---
name: discord-bot-create
description: Create a new Discord bot for hoobot — developer portal app, runtime folder, token, icon, invite, peers, first message. Use when asked to "create a Discord bot", "add a bot on Discord", "make a bot named X", or when starting a Discord bot that has no application yet. Runs bot-discord for everything after the one portal step, writes the .env, wires peers in both directions and says exactly which browser steps only the user can do.
---

# Create a Discord bot

The order matters and it is not a style choice: **portal first, then the
manager, then Discord again to confirm.** The application is the source of
truth for the bot's identity, its token and its icon; the manager is only the
record of how to run it here. A bot configured before its application exists
is a bot with a guessed id and no token.

`discord-bot-create` is the whole job. The app half is `bot-discord`.

## 0. Read `bot-discord` first

It owns the Discord API calls, the invite URL, the permissions and the repair
table. Do not re-derive any of it.

## 1. Portal: the one step only the user can do

There is no Discord CLI, so this cannot be scripted. Say exactly this, and
stop for the token:

```
discord.com/developers/applications → New Application
  name it (e.g. hee) → Create
  → Bot → Reset Token → copy it
  → Bot → Privileged Gateway Intents → Message Content Intent  ON
```

Message Content Intent is off by default and the bot cannot see message text
without it. It is the switch people miss, and the symptom is a bot that sees
the mention and answers nothing.

## 2. Manager: the .env

Copy an existing bot's `.env` as the template and change:

| Key | Value |
|---|---|
| `HOO_INSTANCE` | `<name>` |
| `HEALTH_PORT` | next free one (8788, 8789…) |
| `LINKS_FILE` | its own file — never share |
| `HOO_WORKDIR` | shared, if it should see another bot's files |
| `HOO_AVATAR_*` | seed, shape, style, palette from the avatar below |
| `PEER_BOT_IDS` | leave empty until step 5 |
| `DISCORD_TOKEN` | left empty; step 3 writes it |
| `GUILD_ID` | the server's id — from Discord → the server → copy id with Developer Mode on |
| `HOO_SURFACES` | `discord`, so the manager draws the Discord boxes |

`chmod 600`. The manager rewrites it in place and keeps comments.

## 3. Discord: the token, the icon, the invite

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it
# once, then read a path with: HOO_PATHS skills
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }

D="$(HOO_PATHS skills)/bot-discord/scripts"

# the face comes first, so it can go up with the bot
bun "$(HOO_PATHS avatar-png)" --name hee --style pet --shape squircle \
  --palette rose --size 512 --out /tmp/hee.png

# token → .env, and the application id for PEER_BOT_IDS
bun "$D/discord-app.ts" write hee --token <token> --guild <guild-id>
bun "$D/discord-app.ts" avatar hee --icon /tmp/hee.png
```

`write` prints the **invite URL** with every permission the bot needs already
in it. The user opens it and picks the server — that is the second browser
step, and there is nothing else to click.

## 4. Manager: start, wire the peers

- Restart the bot (manager Restart, or `runtime.sh restart <name>`).
- Companions only: put each bot's Discord **application id** in the other's
  `PEER_BOT_IDS`. Discord ids are digits, so they go in the same list as the
  Slack `U…` ids — one list, both chats.
- Restart both. `PEER_BOT_IDS` is read once at startup.

```sh
bun "$D/discord-app.ts" peers hee    # resolves, and checks both directions
```

## 5. Prove it answers

```sh
bash "$(HOO_PATHS selftest)" <name>
bun "$D/discord-app.ts" verify <name>
```

Then, in Discord: mention it, and **wait for the reply**. A green health
check is not the gate — a real answer is. For a companion, mention both bots
in one message and check that each replied and that each saw the other.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| 401 from every command | token reset, or the application deleted | portal → Reset Token; `write` again |
| Bot connected, answers nothing | Message Content Intent off | portal → Privileged Gateway Intents |
| Works in a channel, silent in a thread | `send_messages_in_threads` missing | re-open the invite URL (the permission is in it) |
| `guilds=(none)` | never added to a server | open the invite URL |
| Manager shows "no chat yet" | `HOO_SURFACES` unset | set it to `discord` |
| Peer never answers on Discord | its id is missing from `PEER_BOT_IDS` | `discord-app.ts id <other>`, add it, restart **both** |
| `400 Invalid Form Body` in `peers` | a Slack `U…` id where a Discord id was expected | use `discord-app.ts token <bot>` |