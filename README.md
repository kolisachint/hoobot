# hoo-discord-bot

Use **hoocode** from Discord.

```
Discord  ⇄  this bot (Bun + discord.js)  ⇄  hoocode --mode rpc
```

Each Discord thread gets its own hoocode process and session.

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

- Service file: `~/Library/LaunchAgents/com.hoo.discord-bot.plist`
- Log: `~/.local/state/hoo-discord-bot/bot.log`

The Mac must be awake and logged in for the bot to answer.

## Using it

- **Start:** in any channel, mention the bot with a request,
  e.g. `@hoo list the files here`. It opens a thread.
- **Continue:** type in that thread. No mention needed.
- **Steer:** typing while it's busy redirects the current run.

### Commands (inside a thread)

| Command | What it does |
|---|---|
| `!stop` | Stop the current run |
| `!new` | Forget the conversation |
| `!status` | Model, busy or not, folder |
| `!model <name>` | Switch model |
| `!help` | Show help |

## Safety

- Only user IDs in `ALLOWED_USER_IDS` can use it.
  The bot won't start if that list is empty.
- `bash`, `edit` and `write` show **Allow once / Deny** buttons.
  No click within 10 minutes means denied.
- There is no "Always" button. It would change your
  global `~/.hoocode/hoo-config.json`.

How the approvals work: on first start the bot writes
`workspace/.hoocode/hoo-config.json`, which puts that folder in a
custom `discord` mode. In that mode only `read` runs without asking.
Your normal `build` mode, which skips approvals, is not used here.

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | Discord side: mentions, threads, commands |
| `src/session.ts` | One hoocode per thread; events → messages, buttons → approvals |
| `src/rpc.ts` | JSONL client for `hoocode --mode rpc` |
| `src/format.ts` | Splits long replies to fit Discord's 2000-character limit |
| `workspace/` | hoocode's working folder and saved sessions (git-ignored) |

## Tests

```sh
bun test                    # message splitting
bun test/session.e2e.ts     # real hoocode, fake Discord (uses API credits)
bun run typecheck
```
