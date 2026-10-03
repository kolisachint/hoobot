---
name: bot-companion
description: Make or repair a companion bot for this one (a second Slack/Discord bot that the two mention each other). Use when asked to "add a companion", "create hee", "make bot X talk to bot Y", or when one bot's PEER_BOT_IDS is empty, the two never answer each other, or a companion is missing from the hoobot manager. Covers creating the Slack app, the runtime folder, the avatar, peer wiring in both directions, and the end-to-end check.
---

# Bot companion

Two bots work together when each one's Slack user ID is in the *other's*
`PEER_BOT_IDS`. One direction is not enough — Slack only delivers a bot's
message to a bot that has explicitly allowed it.

## Where things live

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it
# once, then read a path with: HOO_PATHS runtime
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }
```

| Thing | Path |
|---|---|
| Runtime folder (the manager reads this) | `$(HOO_PATHS runtime)/<name>/` |
| The `.env` — **this is the state** | `$(HOO_PATHS runtime)/<name>/.env` |
| Shared working folder (both bots see these files) | `$(HOO_PATHS workdir)` |
| Per-bot conversation links (never share these) | `~/.local/share/hoobot/<name>-links.json` |
| Manager page | `hoobot manager` → `$(HOO_PATHS manager)` |

A bot in `a hoobot checkout/runtime/` is **invisible to the manager** — that
folder is the checkout's scratch dir. If the manager can't see a bot that
exists, it lives in the wrong folder. That is the first thing to check.

## Steps

1. **Does it already exist?** `curl -s http://127.0.0.1:8790/api/manager`
   lists every bot the manager knows. If the companion is there, skip to
   wiring and repair instead of creating a second one.
2. **Slack app.** `slack-bot-create` runs `bot-slack`, which creates and
   installs the app and uploads the icon without a browser. Only the two
   token strings need the user.
3. **Runtime folder + `.env`.** Copy `$(HOO_PATHS runtime)/hoo/.env` as the
   template, then set `HEALTH_PORT` to the next free one (8788, 8789…),
   `HOO_INSTANCE=<name>`, `LINKS_FILE` to its own file, and give it its own
   `HOO_AVATAR_SEED`. Leave `PEER_BOT_IDS` for step 5.
4. **Shared workdir.** Set `HOO_WORKDIR` to the *same* folder the other bot
   uses. That is what makes "add a skill and both of you have it" true.
5. **Peer wiring, both ways.** Get each ID with
   `curl -s -H "Authorization: Bearer $(grep '^SLACK_BOT_TOKEN=' <env> | cut -d= -f2-)" https://slack.com/api/auth.test | grep user_id`.
   Put each bot's ID in the other's `PEER_BOT_IDS`.
6. **Verify** — `scripts/bot-selftest.sh <name>` from this skill's folder.
   It is the gate; do not report success without it passing.
7. **Restart** with the manager (`hoobot manager`, Restart) or
   `HOOBOT_RUNTIME_DIR=$(HOO_PATHS runtime) sh "$(HOO_PATHS runtime-script)" restart <name>`.

## Repair checklist

- Manager doesn't list it → wrong runtime folder, or no `.env` in it.
- `Slack: peer bots @x` missing from the log → `PEER_BOT_IDS` empty, or the
  ID isn't a bot (`auth.test` says `is_bot:false` → a person; fix the list).
- `PEER_BOT_IDS: <id> is not a bot` in the log → same.
- Bot answers once then goes quiet → turn budget spent. Raise `PEER_TURNS`
  or let an allowed user click Yes.
- Both bots silent after any edit → they didn't restart; `PEER_BOT_IDS` is
  read once at startup.
- Editing `src/` in the checkout changes nothing live. Only the published
  build runs (see `the hoobot package's own AGENTS.md`).

## Notes that save time

- `SLACK_BOT_TOKEN` starting `xoxb-` is the bot token; `xapp-` is the
  app-level token with `connections:write`. Swapping them fails with
  `invalid_auth`.
- `auth.test` returning `account_inactive` means the app was uninstalled or
  the token reset. `bot-slack` reinstalls it; only the two token strings are
  then the user's to copy.
- A bot must be invited to a channel (`/invite @name`) before it sees
  anything. `users.conversations` with an empty list means never invited.
- `ALLOWED_USER_IDS` is per bot; a person who can talk to hoo can't
  necessarily talk to hee.