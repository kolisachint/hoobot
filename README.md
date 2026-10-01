# hoobot

Use **hoocode** from Discord.

```
Discord  ⇄  this bot (Bun + discord.js)  ⇄  Codex app-server protocol  ⇄  hoocode app-server
```

Each Discord thread is one app-server thread. The bot speaks only standard
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
```

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

   You should see `Logged in as hoo#1234`.

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

## Using it

- **Start:** in any channel, mention the bot with a request,
  e.g. `@hoo list the files here`. It opens a thread.
- **Continue:** type in that thread. No mention needed.
- **Steer:** typing while it's busy redirects the current run.
- **Model per thread:** `!model` lists hoocode's scoped models (your
  `enabledModels`, set with the model picker in the hoocode TUI). The pick
  applies from the next message, the conversation carries on, and it is
  remembered across bot restarts. `!model <part of name>` also finds models
  outside the scope.
- **One folder per channel:** set `WORKSPACES=<channel id>=<folder>,...`.
  Threads in that channel work in that folder, with its own hoocode
  app-server. Other channels use `HOO_WORKDIR`.
- **Output:** while it works you see one status line
  (`⏳ Working · 4 steps · 1m 20s · bash ...`). When it's done the status
  line is removed and only the final answer is posted, with a short footer:
  PR link, commit, files edited, steps, time and model.
  `!verbose` shows every step and in-between message instead.

### Commands (inside a thread)

| Command | What it does |
|---|---|
| `!stop` | Stop the current run |
| `!new` | Forget the conversation |
| `!status` | Model, busy or not, thread, server |
| `!model` | Pick this thread's model from a dropdown |
| `!model <part of name>` | Pick it directly, e.g. `!model kimi` |
| `!verbose` | Show every step in this thread (again to turn off) |
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
Discord system prompt in `modes/discord/system.md`. It only rewrites
these files while they still hold what it generated; edit them and they
are left alone. With `ask`, the server sends approvals to every client on
the thread; the first answer wins and the others see it resolved.

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | Discord side: mentions, threads, commands |
| `src/session.ts` | One app-server thread per Discord thread; notifications → messages, buttons → approvals |
| `src/codex-client.ts` | Codex app-server client (`unix://` WebSocket or `stdio:`) |
| `src/links.ts` | Discord thread → app-server thread links (`LINKS_FILE`) |
| `src/format.ts` | Splits long replies to fit Discord's 2000-character limit |
| `workspace/` | hoocode's working folder (git-ignored); sessions are saved by hoocode |

## Tests

```sh
bun run test                # message splitting (what CI runs)
bun test/session.e2e.ts     # real app-server, fake Discord (uses API credits)
APP_SERVER="stdio:codex app-server" bun test/session.e2e.ts   # same, real Codex
bun run typecheck
bun run check               # typecheck + unit tests
```

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
