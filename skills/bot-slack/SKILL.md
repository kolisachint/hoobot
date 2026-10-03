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
S="$(hoobot path skills)/bot-slack/scripts"

# 1. Slack: create the app from the manifest, install it, upload the icon
bun "$S/slack-app.ts" create hee --description "hoo's companion" --icon /tmp/hee.png

# 2. hoobot manager: put the details and the tokens into the bot's .env
#    (the manager API, or its page at $(hoobot path manager))

# 3. Slack: prove the app is really there and really installed
bun "$S/slack-app.ts" verify hee

# 4. start the bot and prove it answers
bash "$(hoobot path selftest)" hee
```

Step 1 prints:

```
app_id=A0C69HXDC6P
bot_user_id=U0C6KF537J8
team_id=T0C5ASK6J4E
```

**Keep `bot_user_id`.** That is what goes in `PEER_BOT_IDS` on the *other*
bot. Guessing it is how companion bots end up mentioning nobody.

## The two things only the user can do

Slack shows these on the app's pages and nowhere else — no API, no CLI, not
even to a workspace admin. Say this plainly, once, and do not repeat it:

| String | Where | Env key |
|---|---|---|
| Bot token `xoxb-…` | OAuth & Permissions → Bot Token Scopes → **Install / Reinstall to workspace** | `SLACK_BOT_TOKEN` |
| App token `xapp-…` | Basic Information → **App-Level Tokens** → Generate | `SLACK_APP_TOKEN` |

The app-level token is only created with the `connections:write` scope.
Without it Socket Mode cannot open and the bot never receives a message,
however healthy the process looks.

## Commands

| Command | What it does |
|---|---|
| `create <bot>` | Project + manifest, install, upload icon, print ids |
| `sync <bot>` | Push manifest edits and a new icon to the existing app |
| `verify <bot>` | App id, bot user id, installed?, scopes Slack really has |
| `token <bot>` | Just the bot user id, for `PEER_BOT_IDS` |
| `id <bot>` | Just the App ID |
| `delete <bot>` | Uninstall and delete the app (there is no undo) |

Useful flags: `--description`, `--long-description`, `--display-name`,
`--background-color`, `--icon <png>`, `--runtime <dir>`.

Where things live:

| Thing | Path |
|---|---|
| The Slack CLI project | `$(hoobot path runtime)/slack/<bot>/` |
| App id, team id | `…/slack/<bot>/.slack/apps.dev.json` |
| The manifest Slack is given | `…/slack/<bot>/manifest.json` |
| The uploaded icon | `…/slack/<bot>/assets/icon.png` |
| These scripts | `$(hoobot path skills)/bot-slack/scripts/` |

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
$EDITOR "$(hoobot path runtime)/slack/hee/manifest.json"
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

`account_inactive` or `invalid_auth` means the app was uninstalled or the
token was reset. The app itself is usually still there:

```sh
bun "$S/slack-app.ts" verify hee        # is the app installed?
bun "$S/slack-app.ts" sync hee          # reinstall it to the workspace
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
| `invalid_auth` on `auth.test` | app-level token missing or wrong | user copies `xapp-…` again |
| `account_inactive` | app uninstalled or token reset | `sync`, then new tokens |
| bot ignores mentions | missing `app_mentions:read`, or events off | `sync`, reinstall, re-copy tokens |
| companion silent | peer id wrong or one-way | `token <bot>` on both, set `PEER_BOT_IDS` both ways |