# hoobot

Use **hoocode** from Discord and Slack.

```
Discord ─┐
         ├⇄  this bot (Bun)  ⇄  Codex app-server protocol  ⇄  hoocode app-server
Slack ───┘
```

Each Discord or Slack channel or thread is one shared app-server thread.
Run Discord, Slack or both from one process: each starts when its tokens
are in `.env`. The bot speaks only standard
Codex app-server methods, so the server is swappable: `hoocode app-server`
(default), or the real `codex app-server`, set with `APP_SERVER` in `.env`.
By default the bot starts `hoocode app-server` itself, in `HOO_WORKDIR`.

To share threads with other clients (e.g. the Codex TUI with
`codex --remote unix://PATH`), run one server and point everyone at it:

```sh
cd workspace && hoocode app-server --listen unix://   # prints the socket path
# .env: APP_SERVER=unix:///Users/you/.cortexcode/app-server-control/app-server-control.sock
```

## Install from npm

Needs [Bun](https://bun.sh). The bot reads `.env` from the folder you start it in.

```sh
bun add -g @kolisachint/hoobot
curl -o .env https://raw.githubusercontent.com/kolisachint/hoobot/main/.env.example   # then fill it in
hoobot
hoobot manager --open   # the bot manager page: http://127.0.0.1:8790
```

Installed this way, the manager keeps its bots in `~/.hoobot/runtime`
(`HOOBOT_RUNTIME_DIR` to move it), outside the package folder a reinstall
replaces.

## Setup

1. Install dependencies:

   ```sh
   bun install
   ```

2. Create your settings file:

   ```sh
   cp .env.example .env
   ```

3. Open `.env` and paste the bot token after `DISCORD_TOKEN=`.

4. In the developer portal, on the **Bot** page,
   turn on **Message Content Intent**.

5. Start the bot:

   ```sh
   bun start
   ```

   You should see `Discord: logged in as hoo#1234`.

## Slack setup

Slack uses Socket Mode: the bot opens the connection, so it needs no
public URL. Discord can stay on or off; set only the Slack tokens for a
Slack-only bot.

1. At [api.slack.com/apps](https://api.slack.com/apps), **Create New App** →
   **From an app manifest**, pick your workspace and paste:

   ```yaml
   display_information:
     name: hoo
   features:
     bot_user:
       display_name: hoo
       always_online: true
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - channels:history
         - groups:history
         - channels:read
         - groups:read
         - chat:write
         - files:read
         - files:write
         - users:read
   settings:
     event_subscriptions:
       bot_events:
         - message.channels
         - message.groups
     interactivity:
       is_enabled: true
     socket_mode_enabled: true
   ```

2. **Basic Information → App-Level Tokens → Generate Token**, add the
   `connections:write` scope. Put the `xapp-…` token in `SLACK_APP_TOKEN=`.
3. **Install App** to the workspace. Put the **Bot User OAuth Token**
   (`xoxb-…`) in `SLACK_BOT_TOKEN=`.
4. Add your Slack member ID to `ALLOWED_USER_IDS` (profile → ⋮ → **Copy
   member ID**, e.g. `U0123ABCD`). Discord and Slack IDs go in the same list.
5. Invite the bot to a channel (`/invite @hoo`), then `bun start`. You
   should see `Slack: logged in as @hoo in <workspace>`.

`CHANNEL_IDS` and `WORKSPACES` take Slack channel IDs too (channel details
→ bottom of the **About** tab, e.g. `C0123ABCD`).

## Run in the background (macOS)

Runs at login and restarts itself if it crashes.

```sh
scripts/service.sh install     # start + enable at login
scripts/service.sh status      # running? pid?
scripts/service.sh logs        # follow the log
scripts/service.sh restart     # after editing .env or code
scripts/service.sh uninstall   # stop + remove
```

- Service file: `~/Library/LaunchAgents/com.hoo.hoobot.plist`
- Log: `~/.local/state/hoobot/bot.log`

The Mac must be awake and logged in for the bot to answer.

## Several bots from one checkout

`scripts/runtime.sh` runs one or more instances out of this repo, each with
its own `runtime/<name>/` folder (`.env`, log, pid). Nothing in `runtime/`
is committed.

```sh
scripts/runtime.sh init hee            # create runtime/hee/.env from .env.example
scripts/runtime.sh list                # instances, running or not, health port
scripts/runtime.sh start hoo           # run it from this working tree
scripts/runtime.sh status hee          # pid + /healthz
scripts/runtime.sh health hee          # the JSON, for a UI or a script
scripts/runtime.sh restart hee         # after editing .env or code
scripts/runtime.sh logs hee 100        # last 100 log lines
scripts/runtime.sh stop hee
```

The bot runs `bun src/index.ts` from the repo, so an edit is one `restart`
from the chat. `RUN_FROM_NPM=1 scripts/runtime.sh start hoo` runs the
published build instead. `scripts/service.sh` (launchd, above) is the other
way to keep one instance alive at login; use one supervisor per instance.

## The bot manager (UI)

```sh
bun run manager --open     # http://127.0.0.1:8790 (from npm: hoobot manager --open)
```

A local page that lists your bots, and lets you make more:

- **New bot** — a suggested name, a generated avatar (shape and colour, both
  changeable), which chat or chats it joins, its tokens and its working
  folder. It doesn't start on its own: add a token, press Start.
- **Start / Stop / Restart** — the same `scripts/runtime.sh` commands you'd
  type. If a bot won't boot, you get the last lines of its log, not a
  spinner.
- **Settings** — every `.env` key, grouped and explained, saved as you type
  (a running bot picks them up on Restart; the page says so). A token is
  saved when you leave its box, shows only as a mask, and is never sent back
  to the page; clearing one is its own button.
- **Status** — each bot's own `/healthz`: which chats are connected, its
  model, approvals, pid, uptime, live threads, and a tail of its log.
- **Sleeping Mac** — on a Mac, if a bot is running and nothing is holding the
  machine awake, the page says so. A sleeping Mac doesn't stop a bot, it
  silences it: Slack delivers no messages to a socket nobody is reading, and
  the silence looks exactly like a bot nobody is talking to. Bots started with
  `scripts/runtime.sh` are wrapped in `caffeinate -i`, so they hold the Mac
  awake themselves; Amphetamine or any other sleep keeper also counts.
  Closing the lid still sleeps a Mac — no assertion overrides that.
- **Keys** — `n` new bot, `j`/`k` (or arrows in the list) to move, `s`
  start/stop, `r` restart. The address names the bot, so a reload stays put.

There is no database: `runtime/<name>/.env` *is* the configuration, so the
UI and your editor can never disagree, and comments in the file survive an
edit from the page. Avatars are generated from a seed (`HOO_AVATAR_SEED`),
so a bot keeps its face with no image stored anywhere.

`MANAGER_PORT=off` disables it; the page is served from `web/` with no build
step. Design: [docs/design/20-bot-manager-ui.md](docs/design/20-bot-manager-ui.md).

## Skills

Some instructions are worth shipping with the bot rather than retyping on
every machine: how to create a Slack app, how to update an instance, how to
make a good avatar, how to check that everything still works. Those live in
[`skills/`](skills) and ship inside the npm package, so

```sh
bun add -g @kolisachint/hoobot
```

is the whole install — the bot seeds them into `<workdir>/.cortexcode/skills`
on its first boot and the agent can already do the things they describe.

The rule is the same one the config and the system prompt use, and it exists
for the same reason: **a skill hoobot wrote is hoobot's to update; a skill
you wrote is yours.** Each seeded file's hash is recorded in
`.cortexcode/skills/.generated.json`, so upgrading hoobot refreshes the
bundled files and leaves a local edit exactly as you wrote it. Startup says
which of the two happened:

```
Seeded 12 skill file(s) into …/.cortexcode/skills
Kept 2 locally edited skill file(s): bot-selftest/SKILL.md, …
```

Skills are copied between machines, so none of them hard-codes a path. The
one place that knows where things are is:

```sh
hoobot path            # every path, one per line
hoobot path selftest   # just that one
```

`package`, `runtime`, `workdir`, `skills`, `manager`, `runtime-script`,
`selftest`, `avatar-png`.

### Bots are Slack apps, and the Slack CLI does that part

The `bot-slack` skill creates, updates, verifies and deletes a bot's Slack
app with Slack's own CLI — the manifest, the install, the scopes and the
app icon. It exists because the CLI only runs from a terminal: `slack-pty.sh`
gives it a pty and presses Enter, so one command does what used to be a
browser flow.

```sh
bun "$(hoobot path skills)/bot-slack/scripts/slack-app.ts" create hee \
  --description "hoo's companion" --icon /tmp/hee.png
```

That prints the app id and the bot's user id — the latter is what
`PEER_BOT_IDS` needs, so a companion bot does not have to be guessed at.

Both tokens come from Slack too, in one call, and go straight into the bot's
`.env`:

```sh
bun "$(hoobot path skills)/bot-slack/scripts/slack-app.ts" tokens hee --write
```

`apps.developerInstall` returns the `xoxb-` bot token and the `xapp-`
app-level token together — the same endpoint `slack api --app <id>` and
`slack run` use. Two details that are easy to get wrong: send `bot_scopes`,
or Slack hands back a token that answers `account_inactive` on a healthy app;
and check `socket_mode=ok`, because a token that cannot open a websocket
produces a bot that looks fine until someone mentions it. The bot also joins
a channel by itself with `channels:join`, so it needs telling *which*
channel, not being invited.

The order for any bot change is **Slack → manager → Slack again to confirm →
restart → selftest**. See the `bot-slack`, `slack-bot-create` and
`slack-bot-update` skills.

## Health

Every instance serves a read-only HTTP server on `127.0.0.1` (`HEALTH_PORT`,
8787 by default, `off` to disable). The bot manager is built on it, and so
can be your own scripts.

```sh
curl -s localhost:8787/healthz   # ok, uptime, pid, surfaces, last message
curl -s localhost:8787/api/bots  # + work folders, links file, live sessions
```

## Using it

Every channel and every thread is a shared space where people and the bot
work together. Each has its own hoocode conversation, model and settings.

- **Call it:** mention the bot (`@hoo fix what we discussed above`) or,
  on Discord, reply to one of its messages. Only `ALLOWED_USER_IDS` can
  call it. It answers right there (on Discord as a reply to your message).
- **Context:** when called, it reads everyone's messages in that space
  since it last looked (up to 30, ~12k characters, newest kept), with
  names, as background. The first call reads the last 30. It never sends
  a message twice; messages sent while it was offline go with the next call.
  Replying to someone's message includes that message too.
- **Threads:** open a thread for a side task. It gets its own
  conversation in the same folder; its first call also reads the channel
  messages that led up to it. Results stay in the thread.
- **Two bots talking (Slack):** set `PEER_BOT_IDS` to another bot's
  member ID (e.g. a companion hoobot) and it can call this one by
  mentioning it; `@name` of a peer in an answer becomes a real mention.
  To stop loops, a peer gets `PEER_TURNS` (default 2) answers per thread;
  then an allowed user gets **Yes / No** buttons for 2 more. A person
  calling the bot in that thread starts the count over. Peers can't run
  `!` commands. Other bots are still ignored.
- **Steer:** calling it while it's busy redirects the current run.
- **Needs** the **Read Message History** permission in those channels
  (Slack: the bot must be in the channel); without it, it works with no
  context (and logs why).
- **Model per space:** `!model` lists hoocode's scoped models (your
  `enabledModels`, set with the model picker in the hoocode TUI). The pick
  applies from the next message, the conversation carries on, and it is
  remembered across bot restarts. `!model <part of name>` also finds models
  outside the scope.
- **One folder per channel:** set `WORKSPACES=<channel id>=<folder>,...`.
  That channel and its threads work in that folder, with its own hoocode
  app-server. Two runs in one folder (channel and a thread) are allowed;
  coordinate as you would with two developers. Other channels use `HOO_WORKDIR`.
- **Output:** while it works you see one status line
  (`⏳ Working · 4 steps · 1m 20s · bash ...`). When it's done the status
  line is removed and only the final answer is posted, with a short footer:
  PR link, commit, files edited, steps, time and model.
  `!verbose` shows every step and in-between message instead.
- **Files:** files it writes in the work folder (`.html`, images, `.pdf`,
  `.md`, `.txt`, `.csv`, `.json`, Office files, `.zip`), creates with a shell
  command, or names in its answer are attached to the answer. Source code isn't; nothing outside the work
  folder is. Up to 10 files and ~9.5 MB per answer. HTML arrives as a
  download; Discord doesn't render it.
  A channel and its threads share a folder. When two of them are working at
  the same time, each answer only gets the files it wrote or names, so a
  file isn't posted in both places. A file nobody names is left out rather
  than guessed.
- **Sending files:** files on the message that calls it, and on the message
  it replies to (Discord), are saved in the work folder under
  `.discord/<channel>/<message>/` (Slack: `.slack/…`) and the prompt says where they are, so it
  can read, run or edit them. Text files up to 32 KB are pasted into the
  prompt too; images are also shown to the model as images. Up to 25 MB a
  file. `.discord/` and `.slack/` are git-ignored, cleared by `!new`, and files are deleted
  after 7 days. Files in other people's earlier messages are only named.

### Commands (in a channel or thread, after the mention)

| Command | What it does |
|---|---|
| `!stop` | Stop the current run |
| `!new` | Start a fresh conversation here, for everyone (deletes files sent here) |
| `!status` | Model, busy or not, folder, thread, server |
| `!model` | Pick this space's model from a dropdown |
| `!model <part of name>` | Pick it directly, e.g. `!model kimi` |
| `!verbose` | Show every step here (again to turn off) |
| `!help` | Show help |

## Safety

- Only user IDs in `ALLOWED_USER_IDS` can use it.
  The bot won't start if that list is empty.
- `APPROVALS=auto` (default): `bash`, `edit` and `write` run without
  asking, so the bot can finish a task end to end. Anyone on the allow
  list can run any command on this Mac through it.
- `APPROVALS=ask`: they show **Allow once / Deny** buttons instead.
  No click within 10 minutes means denied. There is no "Always" button;
  it would change your global `~/.hoocode/hoo-config.json`.

How it works: on start the bot writes
`workspace/.cortexcode/hoo-config.json`, which puts that folder in a
custom `discord` mode (`auto_allow` follows `APPROVALS`), plus a short
chat system prompt in `modes/discord/system.md` (it names Slack when Slack
runs; the mode keeps the name `discord` so existing folders stay in it). It only rewrites
these files while they still hold what it generated; edit them and they
are left alone. With `ask`, the server sends approvals to every client on
the thread; the first answer wins and the others see it resolved.

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | Starts Discord and/or Slack, whichever have tokens |
| `src/core.ts` | Shared by both: app-servers per folder, sessions, allow list, commands, prompt building |
| `src/chat.ts` | The `ChatSpace` interface a session talks to |
| `src/discord.ts` | Discord side: mentions and replies → calls; channels and threads → spaces; buttons, menus |
| `src/slack.ts` | Slack side (Socket Mode): mentions → calls; channels and threads → spaces; Block Kit buttons, menus |
| `src/peers.ts` | Peer bots: turns per thread, `@name` → Slack mention |
| `src/skills.ts` | The bundled `skills/`, seeded into a work folder without clobbering local edits; `hoobot path` |
| `src/mrkdwn.ts` | Markdown → Slack mrkdwn, and Slack text → plain text |
| `src/context.ts` | What people said since the bot last read a space |
| `src/session.ts` | One app-server thread per channel or thread; notifications → messages, buttons → approvals |
| `src/codex-client.ts` | Codex app-server client (`unix://` WebSocket or `stdio:`) |
| `src/links.ts` | Channel/thread → app-server thread, model, last read message (`LINKS_FILE`) |
| `src/attachments.ts` | Picks written files to attach to the answer |
| `src/inbound.ts` | Saves files sent on Discord or Slack into the work folder for the prompt |
| `src/format.ts` | Splits long replies to fit the chat's message limit |
| `src/health.ts` | `/healthz` and `/api/bots` on 127.0.0.1: liveness, config, live sessions |
| `src/cli.ts` | The `hoobot` command: the bot, or `hoobot manager [--open]` |
| `src/manager.ts` | The bot manager: its API, and the page from `web/` on 127.0.0.1:8790 |
| `src/instances.ts` | `runtime/<name>/.env` read/write, list, create, delete; the fields the UI shows |
| `src/power.ts` | On a Mac: whether anything is keeping it awake, so the UI can warn ([design](docs/design/21-sleeping-on-a-mac.md)) |
| `src/avatar.ts` | A seed → an inline SVG avatar (circle or squircle, dots or pet, six palettes) |
| `web/` | The manager page: `index.html`, `app.js`, `style.css` — no build step |
| `scripts/runtime.sh` | `init`/`start`/`stop`/`restart`/`status`/`health`/`logs` for one instance in `runtime/<name>/` |
| `workspace/` | hoocode's working folder (git-ignored); sessions are saved by hoocode |
| `runtime/` | Local instances: `.env`, logs, pids, shared work folder (git-ignored) |

## Tests

```sh
bun run test                # unit tests (what CI runs)
bun test/session.e2e.ts     # real app-server, fake chat (uses API credits)
bun test/attachments.e2e.ts # real app-server writes files; checks they're attached
bun test/inbound.e2e.ts     # files sent to it reach a real app-server
APP_SERVER="stdio:codex app-server" bun test/session.e2e.ts   # same, real Codex
bun run typecheck
bun run check               # typecheck + unit tests
```

The manager's page is plain browser JavaScript, so `tsc` does not check it;
`bun build web/app.js --target=browser` does.

## Releasing

Releases are driven by PR labels. `package.json`'s `version` is owned by CI;
don't edit it by hand.

| Label | On merge |
|---|---|
| `npm:patch` | 0.1.0 → 0.1.1 |
| `npm:minor` | 0.1.0 → 0.2.0 |
| `npm:major` | 0.1.0 → 1.0.0 |
| none | no release |

- `.github/workflows/ci.yml`: typecheck, unit tests and `npm pack --dry-run`
  on every PR and on `main`.
- `.github/workflows/pr-labels.yml`: fails a PR with more than one `npm:*`
  label.
- `.github/workflows/release.yml`: on merge to `main`, reads the merged PR's
  label, bumps `package.json`, pushes `chore(release): vX.Y.Z` plus the tag
  `vX.Y.Z` to `main`, creates the GitHub release, publishes to npm
  (`NPM_TOKEN` secret) and comments on the PR. It can also be run by hand
  (Actions → Release → Run workflow, pick a bump).

Workflow:

1. `/pr minor` (or `patch` / `major`; plain `/pr` for no release): branches,
   runs `bun run check`, commits everything, pushes, opens the PR and
   labels it `npm:minor`.
2. Merge the PR on GitHub.
3. `/postmerge`: waits for the release workflow, checks the tag, GitHub
   release and npm version, then switches to `main`, pulls and deletes the
   merged branch.

The commands live in `.cortexcode/prompts/`. `NPM_TOKEN` must be an npm
*Automation* (or granular publish) token. The bot pushes the release commit
straight to `main`, so if you add branch protection, let GitHub Actions
bypass it. If a release half-fails, re-run it: the release commit records
`Release-PR: #N`, so a re-run finishes that version instead of bumping again.
