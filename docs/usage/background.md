# Run hoobot in the background

Each bot is an *instance*: a folder under `runtime/` with its own `.env`,
log and pid. `scripts/runtime.sh` starts, stops and checks them. `runtime/`
is gitignored — it holds tokens, logs and working folders, never code.

## First time: create an instance

```sh
scripts/runtime.sh init hoo          # copies .env.example -> runtime/hoo/.env (chmod 600)
$EDITOR runtime/hoo/.env             # tokens, user IDs, HEALTH_PORT=8787
```

A second bot is the same with its own name and its own `HEALTH_PORT`, e.g.
`init hee` with `HEALTH_PORT=8788`.

## Run it

```sh
scripts/runtime.sh start hoo     # background; stops a running one first
scripts/runtime.sh status hoo    # pid + /healthz
scripts/runtime.sh restart hoo   # after editing .env or code
scripts/runtime.sh stop hoo
scripts/runtime.sh list          # every instance, state and health port
```

`start` prints the pid and health port, or the last 20 log lines if the bot
died on the way up. The bot runs from this working tree (`bun src/index.ts`),
so an edit is one `restart` away from the chat. `RUN_FROM_NPM=1 scripts/runtime.sh start hoo`
runs the published build instead.

Restart is a kill, not a `SIGUSR2`: it always picks up new code. Bot env vars
are cleared before each start, so an instance only ever sees its own `.env` —
never one a parent shell or another instance exported.

## Check it

```sh
scripts/runtime.sh health hoo    # /api/bots: live sessions, busy flag, workdir
scripts/runtime.sh logs hoo 80   # tail without -f
tail -f runtime/hoo/hoo.log     # follow
```

`/healthz` returns ok plus the last message time and surface state; if it is
null the bot is up but nothing has reached it. Two copies answering every
message means a stale process from an older layout is still alive:

```sh
pgrep -fl 'src/index.ts|bin/hoobot'   # every bot process
```

Kill anything that isn't in `scripts/runtime.sh list`.

## At every login

`scripts/service.sh` runs a single instance as a macOS launchd service
(restarts on crash, starts at login):

```sh
scripts/service.sh install     # needs ./.env at the repo root
scripts/service.sh status
scripts/service.sh restart
scripts/service.sh logs
scripts/service.sh uninstall
```

Use it for one always-on bot. For several named instances, keep the per-instance
`.env` files and `scripts/runtime.sh`, which handles the ports and pids.