---
name: bot-slack
description: Create, update, verify and delete a bot's Slack app with Slack's own CLI (slack) instead of a browser. Use when creating a bot, changing its name, description, icon, scopes or events, when a bot's Slack token is dead or its app needs reinstalling, when asked what app a bot has, or when a bot must be removed from Slack. Everything up to the two token strings is automated; this is also the step every other bot skill runs first.
---

# The Slack half of a bot

A hoobot bot *is* a Slack app. It needs an app, a bot user, a manifest of
scopes and events, and an icon. Slack's CLI (`slack`, v4) can do all of it —
**but only from a terminal.** Run without a TTY it refuses outright:

```
The input device is not a TTY or does not support interactivity
```

which is why bot work used to end with "ask the user to do this in a
browser". `slack-pty.sh` runs the CLI in a pty and presses Enter for you,
and that is the whole trick.

## Check the CLI first

```sh
slack --version        # v4.8.0 or newer
slack auth list        # you must be logged in; if not: slack login
```

If `slack` is missing, say so and stop — the rest of this cannot run. If
`slack auth list` is empty, `slack login` is a browser step only the user
can do.

## The flow

Run these in order. Each step's output is the next step's input, and the
last one is the only place you stop and ask.

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it
# once, then read a path with: HOO_PATHS skills
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }

S="$(HOO_PATHS skills)/bot-slack/scripts"

# 1. Slack: create the app from the manifest, install it, upload the icon
bun "$S/slack-app.ts" create hee --description "hoo's companion" --icon /tmp/hee.png

# 2. fetch both tokens and write them into the bot's .env
bun "$S/slack-app.ts" tokens hee --write

# 3. Slack: prove the app is really there and really installed
bun "$S/slack-app.ts" verify hee

# 4. start the bot and prove it answers
bash "$(HOO_PATHS selftest)" hee
```

Steps 1–3 are unattended. Step 4 needs someone to type a mention in Slack,
because that is the only real test of a bot.

Step 1 prints:

```
app_id=A0C00000000
bot_user_id=U0C00000000
team_id=T0000000000
```

**Keep `bot_user_id`.** That is what goes in `PEER_BOT_IDS` on the *other*
bot. Guessing it is how companion bots end up mentioning nobody.

## The tokens come from Slack, not from a browser

This is the part that used to be the user's job, and it is not any more.

```sh
bun "$S/slack-app.ts" tokens hee --write
```

```
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-1-…
bot_user_id=U0C00000000
socket_mode=ok
```

One call, `apps.developerInstall`, returns the bot token and the app-level
token together. It authenticates with the token `slack login` already stored,
and it is the same endpoint the CLI uses when you run `slack api --app <id>`
or `slack run` — so this is not a private back door, it is how the official
CLI does it. Nothing else returns these in full: the app's OAuth page shows
them to a human, but a program has no other way to get them.

Two things that are easy to get wrong:

- **`bot_scopes` is not optional.** Leave it out and Slack still hands over a
  token — one that answers every call with `account_inactive`, which is the
  shape of a revoked token on a perfectly healthy app. It sends you off to
  reinstall something that was never broken.
- **`socket_mode=ok` is printed, not assumed.** A token that cannot open a
  Socket Mode websocket produces a bot that looks healthy until someone
  mentions it.

`--write` sets the keys in place, so comments and ordering survive, and
chmods the file to 600.

## Joining a channel

The bot does not need to be invited: `channels:join` lets it add itself.

```sh
curl -X POST https://slack.com/api/conversations.join \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" -d "channel=C0C4XDWM19V"
```

So the only thing still asked of a person is *which* channel.

## Commands

| Command | What it does |
|---|---|
| `create <bot>` | Project + manifest, install, upload icon, print ids |
| `tokens <bot>` | Fetch both tokens; `--write` saves them into the `.env` |
| `sync <bot>` | Push manifest edits and a new icon to the existing app |
| `verify <bot>` | App id, bot user id, installed?, scopes Slack really has |
| `token <bot>` | Just the bot user id, for `PEER_BOT_IDS` |
| `id <bot>` | Just the App ID |
| `delete <bot>` | Uninstall and delete the app (there is no undo) |
| `peer-sync.ts` | Rewire every bot's `PEER_BOT_IDS` from Slack, and restart |

## The name will get a `_local` on it

Slack calls a development install `<name> (local)`, and its bot user
`<name>_local`. It is not cosmetic: the bot is `@hee_local` in every
mention, `users.info` disagrees with your manifest, and nothing you write in
`display_information.name` changes it.

It comes from installing into the `local` environment. `create` installs
into **`deployed`** for exactly this reason, and costs nothing — hoobot runs
the app itself, not Slack's runtime. `local` is only for developing against
Slack's own runtime, via `slack run`.

If a bot is already stuck with the suffix, its app has to be recreated: the
name is fixed at install time and no edit will move it. Create the new app,
fetch its tokens, and rewire the peers to the new bot id — see below.

## Peers, and why they go stale

A bot's Slack user id changes **every time its app is recreated**. A stale
id is the quietest failure there is: no error, the bot stays connected, it
simply never answers, and the reason is a `U0C…` in a file nobody opened.

So never hand-write an id. Resolve them all from Slack:

```sh
bun "$S/peer-sync.ts" --dry-run   # show what would change
bun "$S/peer-sync.ts"             # rewire and restart
```

Every bot goes in every other bot's list — a peer mesh, not a ring — and a
bot that cannot authenticate is reported as unreachable rather than wired
in, because pointing peers at a dead id is the exact failure this prevents.

Both directions, always. One-way peers never answer each other.

Useful flags: `--description`, `--long-description`, `--display-name`,
`--background-color`, `--icon <png>`, `--runtime <dir>`.

Where things live:

| Thing | Path |
|---|---|
| The Slack CLI project | `$(HOO_PATHS runtime)/slack/<bot>/` |
| App id, team id | `…/slack/<bot>/.slack/apps.dev.json` |
| The manifest Slack is given | `…/slack/<bot>/manifest.json` |
| The uploaded icon | `…/slack/<bot>/assets/icon.png` |
| These scripts | `$(HOO_PATHS skills)/bot-slack/scripts/` |

`slack/` is a reserved folder in the runtime dir, so the manager never
mistakes a Slack project for a bot.

## The manifest

`create` writes it from the bot's name plus the flags, so you rarely edit it
by hand. It is the standard Socket Mode shape:

- `socket_mode_enabled: true` — no public URL, no request URLs to paste
- `always_online: true` — a bot that reads as offline does not get mentioned
- bot scopes: `app_mentions:read`, `channels:history`, `groups:history`,
  `channels:read`, `groups:read`, `chat:write`, `files:read`, `files:write`,
  `users:read`, `channels:join`
- events: `message.channels`, `message.groups`
- `interactivity.is_enabled: true`

`channels:join` is what lets a bot add itself to a channel it has been
invited to but is not yet in. Without it `/invite @hee` appears to do
nothing.

## Changing something

Edit, then push, then check — in that order, and never skip the check:

```sh
# HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }
S="$(HOO_PATHS skills)/bot-slack/scripts"

$EDITOR "$(HOO_PATHS runtime)/slack/hee/manifest.json"
bun "$S/slack-app.ts" sync hee --icon /tmp/hee.png
bun "$S/slack-app.ts" verify hee
```

A **new scope** needs a reinstall: sync changes the manifest, but the token
keeps the scopes it was minted with until the app is reinstalled. `verify`
prints the scopes Slack actually has, which is how you catch having
forgotten. Say so rather than reporting success.

The icon is part of the app, not a preference: putting a PNG at
`assets/icon.png` and running `sync` uploads it. No more manual avatar
upload.

## Repairing a dead token

`account_inactive` or `invalid_auth` means the token was revoked or minted
without scopes. Re-fetch it rather than reinstalling anything:

```sh
bun "$S/slack-app.ts" tokens hee --write
```

If the app is gone too, recreate it — but the bot user id changes, so fix
`PEER_BOT_IDS` on both sides afterwards or they will mention nobody.

## Then prove it answers

The gate is a real conversation, not a green health check. Start the bot,
`/invite @<bot>` in a channel, mention it, and wait for the reply. For a
companion, mention both bots in one message and check each answered and
that each saw the other's — that is the whole point of a companion and it
is the only thing that proves the wiring.

## Repair checklist

| Output | Meaning | Fix |
|---|---|---|
| `not a TTY` | the CLI refused | use `slack-app.ts`; it runs the CLI in a pty |
| `your app will not be deleted` | Enter took the default (Cancel) | `delete` sends Down+Enter for you |
| `installation_required` | app exists but is not installed | `sync` reinstalls it |
| `invalid_auth` on `auth.test` | app-level token missing or wrong | `tokens <bot> --write` |
| `account_inactive` | token revoked, or minted without `bot_scopes` | `tokens <bot> --write` |
| bot ignores mentions | missing `app_mentions:read`, or events off | `sync`, reinstall, re-copy tokens |
| companion silent | peer id wrong or one-way | `token <bot>` on both, set `PEER_BOT_IDS` both ways |