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

Socket Mode is a live websocket, not a queue: when it drops, Slack does not
replay the events said in the gap, and a mention in that gap is simply gone.
So after every reconnect the bot asks Slack what was said after the last event
it handled and answers the mentions it missed — in thread, oldest first, once
each. `CATCHUP_MINUTES` (default 1440) bounds how far back it looks,
`CATCHUP_MAX` (default 20) the most it replays at once; `CATCHUP_MINUTES=0`
turns it off.

Discord works the same way. Its gateway is live too, and a session too old to
resume makes the bot re-identify, which delivers nothing — so on every
reconnect the Discord bot also asks history what it missed after the last
message it handled and answers those mentions, oldest first, once each. Both
surfaces read the same `CATCHUP_MINUTES` / `CATCHUP_MAX`.

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

## Checking the package

`files` in package.json decides what reaches a machine, not the source tree,
and a forgotten entry ships a bot whose skills silently do not exist.

```sh
bun run verify:pack
```

It reads what `npm pack` would actually produce and asserts the bot's runtime
needs are in there — `src/skills.ts`, `scripts/runtime.sh`, every bundled
skill with usable frontmatter, and the scripts those skills run. It runs in
CI, and in the release workflow via `bun run check`.

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

## Running in the background (supervisor)

One command for the manager *and* every bot, kept up in the background:

```sh
scripts/supervise.sh start      # agent installed, manager up, every bot up
scripts/supervise.sh status     # what is running and whether it is healthy
scripts/supervise.sh stop       # every bot down and the agent unloaded
scripts/supervise.sh restart    # the manager and every supervised bot
scripts/supervise.sh logs       # the supervisor's own log
scripts/supervise.sh uninstall  # stop everything and remove the agent
```

`start` writes a launchd agent (`~/Library/LaunchAgents/com.hoobot.supervisor.plist`)
that comes up at login and holds the Mac awake with `caffeinate -i` for as
long as it runs. Every 30 seconds it checks the manager's `/api/manager` and
each bot's own `/healthz`, and restarts what is not answering — a crashed bot
and a silently wedged one are the same problem to a chat. The script lives in
the repo and ships with the package; only the generated plist and one
`supervised` marker per bot are machine-local.

On a laptop, the shell profile usually gets you a shorter name — this machine
has `hoobot-supervise start` (aliased `hsv`, with completion) in
`~/.config/zsh/.zshrc`, calling this script by its path in the checkout.

The marker is the point: the manager page has a Stop button, and a supervisor
that restarted everything would quietly undo it. `start <name>` writes the
marker and `stop <name>` removes it, so a bot you stopped from the browser
stays stopped. Knobs, all optional: `HOOBOT_INTERVAL` (check every N seconds,
default 30), `HOOBOT_FAILS` (unhealthy checks before a restart, default 2),
`HOOBOT_COOLDOWN` (base seconds between attempts at one bot, default 120 —
it doubles on each further failure up to `HOOBOT_BACKOFF_MAX`, default 1800),
`HOOBOT_LOOP_MAX` (failed starts inside `HOOBOT_LOOP_WINDOW`, default 5 in
900s, after which it stops retrying and says so in its log rather than
relaunching a broken bot all afternoon),
`MANAGER_PORT`, `HOOBOT_RUNTIME_DIR`, and `RUN_FROM_NPM` (default 1, so the
published build is what answers in Slack).

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

Apps install into the **deployed** environment, not `local`. A local install
is a development app, and Slack says so in the name it gives everybody else:
the app becomes `hee (local)` and its bot user `hee_local`, so the bot is
`@hee_local` in every mention and no edit to `display_information.name`
moves it. The deployed environment gives the plain name and costs nothing,
since hoobot runs the app itself rather than Slack's runtime.

### Peers

A bot's Slack user id changes every time its app is recreated — a revoked
token, a rename, a move off the `_local` name. A stale id is the quietest
failure there is: no error, the bot stays connected, it simply never
answers. So no id is ever written by hand:

```sh
bun "$(hoobot path skills)/bot-slack/scripts/peer-sync.ts" --dry-run
bun "$(hoobot path skills)/bot-slack/scripts/peer-sync.ts"
```

Every bot goes in every other bot's list — a peer mesh, not a ring — and a
bot that cannot authenticate is reported rather than wired in, because
pointing peers at a dead id is precisely what this prevents. Discord ids are
stable, so this re-resolution is a Slack-side concern.

The order for any bot change is **Slack → manager → Slack again to confirm →
restart → selftest**. See the `bot-slack`, `slack-bot-create` and
`slack-bot-update` skills.

### Discord has no CLI, so the portal is one step and the rest is a skill

Slack's CLI can make the app; Discord has no equivalent, so a Discord bot
starts as a person doing three things in the developer portal — **New
Application**, **Bot → Reset Token**, and **Message Content Intent ON** — and
`bot-discord` does everything after that:

```sh
bun "$(hoobot path skills)/bot-discord/scripts/discord-app.ts" write hee --token <token> --guild <guild-id>
bun "$(hoobot path skills)/bot-discord/scripts/discord-app.ts" avatar hee --icon /tmp/hee.png
bun "$(hoobot path skills)/bot-discord/scripts/discord-app.ts" verify hee
```

`write` saves the token and prints the **invite URL** with every permission
the bot needs already in it, so being added to a server is opening one link
rather than ticking fifteen boxes. `avatar` sets the bot's icon through the
API, because a bot may change its own avatar.

A Discord bot's id **is** its application id, and it is in the first segment
of the token, so `PEER_BOT_IDS` never has to be guessed:

```sh
bun "$(hoobot path skills)/bot-discord/scripts/discord-app.ts" id hee
bun "$(hoobot path skills)/bot-discord/scripts/discord-app.ts" peers hee   # both directions
```

Unlike Slack's, that id never changes — a rename or a token reset does not
move it — so `peer-sync.ts`'s re-resolve-everything dance is only needed on
the Slack side. `PEER_BOT_IDS` holds both chats in one list: Discord ids are
digits, Slack ids start with `U`.

Message Content Intent is the thing people miss. It is privileged, off by
default, and with it off the bot receives mentions with **empty text** — so
it sees being called and has nothing to answer.

See the `bot-discord` and `discord-bot-create` skills.

## Health

Every instance serves a read-only HTTP server on `127.0.0.1` (`HEALTH_PORT`,
8787 by default, `off` to disable). The bot manager is built on it, and so
can be your own scripts.

```sh
curl -s localhost:8787/healthz   # ok, uptime, pid, surfaces, last message
curl -s localhost:8787/api/bots  # + work folders, links file, live sessions
```

`ok` is not only liveness. A turn that has sent no event for
`TURN_STUCK_MINUTES` is a real outage for whoever is waiting on it, so
`/healthz` reports `ok:false` and lists the session in `stuckSessions` — which
is the signal the supervisor acts on. Silence, not age: a long turn that keeps
streaming progress is never stuck, however long it runs. `/api/bots` keeps reporting `ok:true` so the manager page still loads;
its `sessions` carry `turnAgeMs`, `turnStalledMs` and `stuck`.

### When a turn wedges

A turn is acknowledged at once and then streams events, so the per-call
deadline (`REQUEST_TIMEOUT_SECONDS`) never sees it. A separate watchdog
measures from the **last event**, not the start: a long answer that is still
making progress is never cut off, and only real silence trips it. When it
does, the bot says so in the thread, clears its busy flag, and asks the
server to interrupt — so a wedged turn costs one message instead of the whole
conversation.

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
- **Two bots talking (Discord and Slack):** set `PEER_BOT_IDS` to another
  bot's user id (e.g. a companion hoobot) and it can call this one by
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
  `enabledModels`, set with the model picker in the hoocode TUI), numbered,
  with each one's effort and, when hoocode provides it, its category. Pick from the list, or send
  `!model 2` or `!model kimi`. Models outside the scope are never offered.
  The pick applies from the next message, the conversation carries on, and
  it is remembered across bot restarts.
- **Effort:** each scoped model has its own effort, and that is what runs by
  default. `!effort` shows this space's effort and the choices; `!effort high`
  overrides it, and `!effort default` clears the override. `!model opus high`
  picks a model and its effort at once. Picking a model without an effort
  clears the override. Don't set `--thinking` in `HOOCODE_ARGS`: it overrides
  every model's effort, and the bot warns at startup. Effort selection needs
  hoocode ≥ 0.1.12; older servers ignore it.
- **hoocode upgrades:** before a new turn, if the hoocode binary on disk has
  changed since the bot started its app-server, the bot restarts that server
  automatically once it is idle (nothing running). Conversations resume as before.
- **Login errors:** when hoocode can't authenticate with a provider, the
  reply says so and gives the fix: run `hoocode` on the host and `/login <provider>`.
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
  Each file goes out **once**: a file reachable by two paths (the scratch
  copy the write tool reported and the `out/` copy a shell command made) is
  sent a single time, and dot folders (`.work/`, `.slack/`, ...) are never
  sent at all. When a `.html` page and a `.png` rendered from it are both
  there, **only the page goes out** — the image would just double the
  answer.
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
| `!model` | Pick this space's model from a numbered list (with effort and category) |
| `!model <number or part of name> [effort]` | Pick it directly, e.g. `!model 2`, `!model kimi`, `!model opus high` |
| `!effort [level]` | Show this space's effort and the choices, or set it, e.g. `!effort high`; `!effort default` clears it |
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
| `src/discord.ts` | Discord side: mentions and replies → calls; channels and threads → spaces; buttons, menus; catch-up |
| `src/slack.ts` | Slack side (Socket Mode): mentions → calls; channels and threads → spaces; Block Kit buttons, menus; catch-up |
| `src/peers.ts` | Peer bots: turns per thread, `@name` → Discord/Slack mention |
| `src/skills.ts` | The bundled `skills/`, seeded into a work folder without clobbering local edits; `hoobot path` |
| `src/mrkdwn.ts` | Markdown → Slack mrkdwn, and Slack text → plain text |
| `src/context.ts` | What people said since the bot last read a space |
| `src/session.ts` | One app-server thread per channel or thread; notifications → messages, buttons → approvals |
| `src/codex-client.ts` | Codex app-server client (`unix://` WebSocket or `stdio:`) |
| `src/links.ts` | Channel/thread → app-server thread, model, last read message (`LINKS_FILE`) |
| `src/attachments.ts` | Picks written files to attach to the answer |
| `src/inbound.ts` | Saves files sent on Discord or Slack into the work folder for the prompt |
| `src/format.ts` | Splits long replies to fit the chat's message limit |
| `src/health.ts` | `/healthz` and `/api/bots` on 127.0.0.1: liveness, config, live sessions, stuck turns |
| `src/log.ts` | Timestamped `log`/`warn`/`error`, so every line says when it happened |
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
