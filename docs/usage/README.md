# Using hoobot and hoocode

How the pieces fit, how to run them, how to swap either side, and how to
check that a swap worked.

## Design in one picture

```
 surface            glue                    wire protocol               engine + server
┌─────────┐   ┌──────────────────┐   ┌──────────────────────────┐   ┌──────────────────────┐
│ Discord │ ⇄ │ hoobot           │ ⇄ │ Codex app-server protocol │ ⇄ │ hoocode app-server   │
│ (users, │   │ - capture msgs   │   │ JSON-RPC, no "jsonrpc"    │   │   or                 │
│ buttons)│   │ - thread links   │   │ stdio:  or  unix://       │   │ codex app-server     │
└─────────┘   │ - render replies │   └──────────────────────────┘   └──────────────────────┘
              └──────────────────┘                ⇅
                                          other clients, e.g.
                                          Codex TUI (codex --remote)
```

**hoobot is only glue.** It:

- captures Discord and Slack messages (mentions, replies to it on Discord, `!` commands, button clicks)
  and what others said since it last read a channel or thread (`src/context.ts`);
- maps each Discord or Slack channel or thread to one app-server thread (`src/links.ts`, stored
  in `LINKS_FILE`);
- turns server notifications into one status line and a final answer with a
  footer (`src/session.ts`, `src/summary.ts`), and approval requests into
  **Allow once / Deny** buttons.

**The app-server does the work.** It owns threads, sessions on disk, the
model, tools and approvals. hoobot never runs a tool itself.

**The contract between them is the Codex app-server protocol.** hoobot uses
only standard methods, so either side can be replaced:

| Direction | Methods |
|---|---|
| hoobot → server | `initialize`, `initialized`, `thread/start`, `thread/resume`, `thread/unsubscribe`, `turn/start`, `turn/steer`, `turn/interrupt`, `model/list` |
| server → hoobot (notifications) | `thread/started`, `turn/started`, `turn/completed`, `item/started`, `item/completed` |
| server → hoobot (requests) | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (any other request is declined) |

Two transports (`src/codex-client.ts`):

| `APP_SERVER` value | What happens |
|---|---|
| empty | hoobot spawns `hoocode app-server` in `HOO_WORKDIR` (and one more per `WORKSPACES` folder), talks over stdio |
| `stdio:CMD ARGS` | hoobot spawns `CMD ARGS` in `HOO_WORKDIR`, talks over stdio |
| `unix:///full/path.sock` | hoobot connects to an already running server (WebSocket over a Unix socket). The bare `unix://` is not accepted; give the full path |

With stdio, the server belongs to hoobot alone. With a Unix socket, the
server is shared: every client on a thread sees its events and its
approvals, and the first answer to an approval wins.

## Basic use

```sh
bun install
cp .env.example .env      # set DISCORD_TOKEN and/or SLACK_BOT_TOKEN + SLACK_APP_TOKEN, ALLOWED_USER_IDS
bun start                 # prints "Discord: logged in as hoo#1234" / "Slack: logged in as @hoo in ..."
```

In Discord or Slack:

- `@hoo list the files here`: starts a turn and answers in place.
- Mention it or reply to it to continue; doing so while it is busy steers.
- `!status` shows model, busy, thread id and **which server** (`Server:` line).
- `!stop`, `!new`, `!model [number or part of name] [effort]`, `!effort [level]`, `!verbose`, `!help`.
- `!model` uses `model/list` with `includeHidden: false`. hoocode marks models
  outside your `enabledModels` as `hidden`; they are never offered. The list is
  numbered, with each model's effort and, when hoocode provides it, its
  category (Discord allows 25 in a dropdown, Slack 100). The pick is sent as `model` on `turn/start` and saved
  in `LINKS_FILE`, with `effort` when one was set.
- Effort: each scoped model's own effort applies unless set. `!effort <level>`
  overrides it for the space (sent as `effort` on `turn/start`, only when set).
  `HOOCODE_ARGS=--thinking …` is not needed and overrides every model's effort.
  Effort selection needs hoocode ≥ 0.1.12; older servers ignore it.
- hoocode upgrades: the bot restarts its app-server automatically once it is idle.

To keep it running after the terminal closes (nohup, restart on crash),
see [background.md](background.md).

## How to swap

Swapping is a config change only. No code changes on either side.

1. Edit `APP_SERVER` (and optionally `HOOCODE_BIN`, `HOOCODE_ARGS`, `MODEL`) in `.env`.
2. **Use a separate `LINKS_FILE` per server.** Thread ids belong to the
   server that made them. If you keep one links file, old Discord threads
   will fail to resume on the new server; the bot says
   "Couldn't reopen the earlier conversation… Starting a new one." That is
   safe, but separate files let you swap back and keep your history.
   Use a full path: `~` is not expanded.
3. Restart: `bun start`, or `scripts/service.sh restart` if it runs as a service.

### Approvals differ per server

hoobot does not set an approval policy; the server decides when to ask.

- **hoocode:** on start hoobot writes
  `HOO_WORKDIR/.cortexcode/hoo-config.json`, a `discord` mode. With
  `APPROVALS=auto` (default) `bash`, `edit` and `write` run without asking;
  with `APPROVALS=ask` only `read` does and the rest become buttons.
- **Codex:** that file and `APPROVALS` mean nothing to Codex. Codex uses its
  own config (`~/.codex/config.toml`, `approval_policy` and sandbox
  settings). Set `approval_policy = "untrusted"` if you want buttons, or
  commands will run without one. Check this before pointing a shared
  Discord server at Codex.

## Examples

### 1. Discord → hoobot → hoocode (default)

The normal setup. hoobot starts hoocode itself.

```sh
# .env
APP_SERVER=
HOOCODE_BIN=hoocode
HOO_WORKDIR=./workspace
LINKS_FILE=/Users/you/.local/share/hoobot/links-hoocode.json
MODEL=anthropic/claude-sonnet-4-5     # optional
```

```sh
bun start
# Connected to app-server stdio:hoocode app-server
```

### 2. Discord → hoobot → real Codex (swap the server)

Same bot, Codex does the work. Useful to compare behaviour, or to check
that a bug is in hoocode and not in hoobot.

```sh
# .env
APP_SERVER=stdio:codex app-server
HOO_WORKDIR=./workspace
LINKS_FILE=/Users/you/.local/share/hoobot/links-codex.json
MODEL=                                 # leave empty or use a Codex model name
```

```toml
# ~/.codex/config.toml: make Codex ask, so Discord shows buttons
approval_policy = "untrusted"
```

```sh
bun start
# Connected to app-server stdio:codex app-server
```

To swap back, restore `APP_SERVER=` and the hoocode `LINKS_FILE`, then restart.

### 3. Discord + Codex TUI → one shared hoocode server (swap the client)

Run hoocode once on a socket. hoobot and the Codex TUI both connect to it,
so you can start a thread on your phone in Discord and open it at the desk
in the terminal, or the other way round.

```sh
cd workspace
hoocode app-server --listen unix://
# prints the socket path, e.g.
# /Users/you/.cortexcode/app-server-control/app-server-control.sock
```

```sh
# .env
APP_SERVER=unix:///Users/you/.cortexcode/app-server-control/app-server-control.sock
LINKS_FILE=/Users/you/.local/share/hoobot/links-hoocode.json   # same server as example 1, same threads
```

```sh
bun start                                   # hoobot, as one client
codex --remote unix:///Users/you/.cortexcode/app-server-control/app-server-control.sock   # Codex TUI, as another
```

An approval appears in both places. Click **Allow once** in Discord and the
TUI shows it resolved, or answer in the TUI and Discord shows
"Answered elsewhere."

Notes:

- With a socket server, `HOO_WORKDIR` does not set the server's folder; the
  server runs where you started it. Start it in the folder that has the
  `.cortexcode/hoo-config.json` with the `discord` mode, or approvals won't ask.
- The same layout works with Codex as the shared server, if your Codex
  build has `codex app-server --listen unix://`: point `APP_SERVER` and
  `codex --remote` at the socket it prints.

## How to test after a swap

Go from cheapest to most real. Stop at the first failure.

**1. Static checks (no server, no credits)**

```sh
bun run check            # typecheck + unit tests
```

**2. The server starts and answers `initialize`**

```sh
DEBUG=1 bun start        # look for: Connected to app-server <endpoint>
```

`DEBUG=1` also prints a stdio server's stderr, prefixed `[app-server]`.
For a socket, check the server process is still running and the path in
`APP_SERVER` is the full path it printed.

**3. End-to-end with fake Discord (real server, uses API credits)**

Runs a turn that needs a bash approval (it forces `APPROVALS=ask`), clicks Allow, checks the reply,
then restarts the client and checks the same thread resumes. It uses
`/tmp/hoo-bot-e2e` and its own links file, never your real ones.

```sh
bun test/session.e2e.ts                                          # hoocode, stdio
APP_SERVER="stdio:codex app-server" bun test/session.e2e.ts      # Codex, stdio
APP_SERVER=unix:///full/path.sock bun test/session.e2e.ts        # running server
```

Pass ends with `OK (1 approval click(s), thread <id>)`. If it times out on
"approval buttons", the server ran bash without asking: fix the server's
approval config (see "Approvals differ per server").

**4. Live Discord check (real bot, real thread)**

```sh
LIVE_CHANNEL_ID=<channel id> bun test/live.ts
```

Creates a thread, asks for a reply without tools, and exits 0 when
`hoo-bot live test OK` shows up.

Context across messages (others talk, the bot reads only what's new):

```sh
LIVE_CHANNEL_ID=<channel id> bun test/live-context.ts
```

Prints five `ok` lines: first call reads others' messages, the answer
replies to the caller, the next call gets only new messages, and so on.

**5. By hand in Discord**

| Step | Expect |
|---|---|
| `@hoo say hi` | a reply to your message, in the channel |
| others chat, then `@hoo summarise the above` | it knows what they said (names included) |
| reply to the bot's message without a mention | it answers |
| open a thread, `@hoo` in it | it knows the channel messages before the thread |
| `!status` | `Server:` is the endpoint you swapped to |
| ask it to run `echo hi` | `APPROVALS=auto`: runs, final answer with a `-# 1 step · …` footer. `ask`: **Allow once / Deny** buttons first |
| a task over ~4 s | one `⏳ Working · …` line, removed when the answer arrives |
| `!verbose`, then a task | every step and in-between message is shown |
| call it while it is busy | the run is steered, not queued |
| `!stop` | the run stops |
| restart the bot, then call it in the same place | the conversation continues (same `Thread:` in `!status`) |
| example 3 only: open the thread in `codex --remote` | the same history; an approval answered in one place resolves in the other |
