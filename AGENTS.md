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

## Other notes

- Instances live outside the repo, in `~/.hoobot/runtime/<name>/` (its own
  `.env`, log and pid), not in `runtime/`. Pass `HOOBOT_RUNTIME_DIR` when
  calling `scripts/runtime.sh` by hand, or you will act on a
  non-existent `runtime/`.
- `runtime/` and `workspace/` are gitignored; they hold tokens, logs and
  conversation working folders, never code.
- Test with `bun test`. A change is not done until the full suite passes.
