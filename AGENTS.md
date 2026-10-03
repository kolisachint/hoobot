# Working in this repo

## Always run the bot from the published npm build

Never start a hoobot instance from this working tree. Start it from the
published build, so what runs in Slack is what npm ships:

```sh
HOOBOT_RUNTIME_DIR="$HOME/.hoobot/runtime" RUN_FROM_NPM=1 \
  sh scripts/runtime.sh restart <name>
```

`RUN_FROM_NPM=1` makes `scripts/runtime.sh` `bun add -g
@kolisachint/hoobot@latest` and run the `hoobot` binary from the global
install, instead of `bun src/index.ts`.

**Why:** running from the tree silently diverges from the release. An edit
that isn't published yet never reaches the chat, so a "fix" that tests green
locally leaves the real bot broken — and, worse, makes the live bot behave
like unreleased code. The published build is the only thing worth
verifying against.

**How to apply:**

- `RUN_FROM_NPM=0` (the script's default) is for contributors deliberately
  testing a change in place. Don't leave an instance on it. If a debug
  session needs it, put the instance back on `RUN_FROM_NPM=1` afterwards.
- After `restart`, confirm what actually ran:
  `ps -p "$(cat ~/.hoobot/runtime/<name>/<name>.pid)" -o command=`
  It should name the global install
  (`.../node_modules/@kolisachint/hoobot/src/index.ts`), not
  `/Users/.../github/hoobot/src/index.ts`.
- Editing `src/` does **not** change the running bot. Ship it
  (tag + publish) and `bun add -g` picks it up on the next
  `RUN_FROM_NPM=1` start. Say so plainly rather than implying a live fix.
- The `slack/` folder under the runtime dir holds Slack CLI projects, not
  bots, and is reserved. Instances live in `~/.hoobot/runtime/<name>/`.

## Supervision is `scripts/supervise.sh`

One launchd agent (`com.hoobot.supervisor`) holds the manager and every
supervised bot in the background, checks health, restarts what stops
answering, and keeps the Mac awake with `caffeinate -i`:

```sh
sh scripts/supervise.sh start   # agent + manager + every bot
sh scripts/supervise.sh status  # what is running and healthy
sh scripts/supervise.sh stop    # every bot down, agent unloaded
```

On this Mac it is also on the profile, so `hsv start` (or
`hoobot-supervise status`) works from any directory — the function in
`~/.config/zsh/.zshrc` calls the checkout, so the script is never stale.

It defaults to `RUN_FROM_NPM=1` and `HOOBOT_RUNTIME_DIR=~/.hoobot/runtime`,
so the same rule as above applies to a bot the supervisor restarts. Two
things to know:

- **A bot is supervised only if `~/.hoobot/runtime/<name>/supervised`
  exists.** `start <name>` writes it, `stop <name>` removes it, so the
  manager page's Stop button is not silently undone. Adding the marker by
  hand is fine; deleting it is the way to leave a bot down.
- **The script is the code, the plist is the machine.** Only
  `~/Library/LaunchAgents/com.hoobot.supervisor.plist` and those markers are
  machine-local — nothing about a Mac is committed.

## Skills ship in the package

`skills/` is in the npm tarball, and `prepareWorkspace()` seeds it into
`<workdir>/.cortexcode/skills` on first boot. That is why `bun add -g` is the
whole install on a new machine — the agent can already create bots, update
them and check them.

Two consequences worth knowing before you touch them:

- **Skills cannot hard-code paths.** They are copied between machines, so
  they ask `paths.sh` (next to the bot-slack scripts), which tries
  `hoobot path` and falls back to the documented layout. Use it instead of
  writing a path literally.
- **Never overwrite one.** A skill hoobot wrote is hoobot's to update; a
  skill a person wrote is theirs. `src/skills.ts` keeps hashes in
  `.generated.json` and leaves a changed file alone. Add to `skills/`, or
  put it somewhere else — not over the top.

## Bot ids are not stable

A bot's Slack user id changes every time its app is recreated. After any
`create`, `tokens`, or rename, rewire the mesh rather than editing
`PEER_BOT_IDS`:

```sh
bun "$(…/skills/bot-slack/scripts/peer-sync.ts)" --dry-run
```

It reads every id from Slack via each bot's own token, so a bot whose app is
dead is reported instead of being wired in. Stale ids produce no error at
all — the bot stays connected and simply never answers.

## Other notes

- Instances live outside the repo, in `~/.hoobot/runtime/<name>/` (its own
  `.env`, log and pid), not in `runtime/`. Pass `HOOBOT_RUNTIME_DIR` when
  calling `scripts/runtime.sh` by hand, or you will act on a
  non-existent `runtime/`.
- `runtime/` and `workspace/` are gitignored; they hold tokens, logs and
  conversation working folders, never code.
- Test with `bun test`. A change is not done until the full suite passes.
