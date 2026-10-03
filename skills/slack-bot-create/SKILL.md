---
name: slack-bot-create
description: Create a new Slack bot for hoobot from nothing — Slack app via the slack CLI, runtime folder, tokens, invite, first message. Use when asked to "create a Slack bot", "add a new bot", "make a bot named X in Slack", or when starting a bot that has no app yet. Runs bot-slack to create and install the app, writes the .env and the checks, and says exactly which browser steps only the user can do.
---

# Create a Slack bot

The order matters and it is not a style choice: **Slack first, then the
manager, then Slack again to confirm.** The Slack app is the source of truth
for the bot's identity, its scopes and its icon; the manager is only the
record of how to run it here. A bot configured before its app exists is a
bot with guessed ids and dead tokens.

`slack-bot-create` is the whole job. The app half is `bot-slack`.

## 0. Read `bot-slack` first

It owns the Slack CLI, the pty trick, the manifest and the repair table.
Do not re-derive any of it.

## 1. Slack: create and install the app

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it
# once, then read a path with: HOO_PATHS selftest
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }

S="$(HOO_PATHS skills)/bot-slack/scripts"

# the face comes first, so it can go up with the app
bun "$(HOO_PATHS avatar-png)" --name hee --style pet --shape squircle \
  --palette rose --size 512 --out /tmp/hee.png

bun "$S/slack-app.ts" create hee \
  --description "hoo's little companion owl 🦉💗" \
  --long-description "hee is hoo's companion. Mention @hee in a channel …" \
  --background-color "#f79ab8" \
  --icon /tmp/hee.png
```

That creates the app from a Socket Mode manifest, installs it to the team,
uploads the icon, and prints `app_id` and `bot_user_id`. There is no browser
step here and no manifest to paste — that was the old way.

## 2. Manager: the .env

Copy the existing bot's `.env` as the template and change:

| Key | Value |
|---|---|
| `HOO_INSTANCE` | `<name>` |
| `HEALTH_PORT` | next free one (8788, 8789…) |
| `LINKS_FILE` | its own file — never share |
| `HOO_WORKDIR` | shared, if it should see another bot's files |
| `HOO_AVATAR_*` | seed, shape, style, palette from the avatar above |
| `PEER_BOT_IDS` | leave empty until step 5 |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | `xoxb-` / `xapp-PLACEHOLDER`; step 3 replaces both |
| `HOO_SURFACES` | `slack`, so the manager draws the Slack boxes |

`chmod 600`. The manager rewrites it in place and keeps comments.

## 3. Slack again: fetch the tokens

```sh
bun "$S/slack-app.ts" tokens <name> --write
```

Both tokens, fetched from Slack and written into the `.env` above — no
browser, no copy-paste. Confirm it worked before going further:

```sh
bun "$S/slack-app.ts" verify <name>
```

`installed=yes` and a bot user id. If it says no, fix it now rather than
after the tokens are written; they would be minted for nothing.

## 4. Manager: start, invite, wire the peers

- Restart the bot (manager Restart, or `runtime.sh restart <name>`).
- `/invite @<name>` in a channel. Without it the bot sees nothing, and
  `channels:join` is what lets it follow itself in.
- Companions only: on **both** bots set `PEER_BOT_IDS` to the *other* bot's
  id, which `slack-app.ts token <name>` prints. One direction is not a
  companion.
- Restart both.

## 5. Prove it answers

```sh
bash "$(HOO_PATHS selftest)" <name>
```

Then, in Slack: `/invite @<name>`, mention it, and **wait for the reply**.
A green health check is not the gate — a real answer is. For a companion,
mention both in one message and check that each replied and that each saw
the other.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_auth` | tokens swapped (`xapp-` in `SLACK_BOT_TOKEN`) | swap them back |
| `account_inactive` | app uninstalled or token reset | `bot-slack`: `sync`, then new tokens |
| Bot never responds | never `/invite`d, or not in `ALLOWED_USER_IDS` | invite; add the member id |
| No replies to mentions | missing `app_mentions:read` | `sync`, reinstall, re-copy tokens |
| Connects then drops | `xapp-` missing `connections:write` | regenerate with that scope |
| Icon did not change | Slack caches app icons | wait a minute, re-check |
| Manager shows "no chat yet" | `HOO_SURFACES` unset on a token-less bot | set it to `slack` |