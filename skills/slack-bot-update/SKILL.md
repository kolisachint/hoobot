---
name: slack-bot-update
description: Update a running bot safely — env keys, tokens, model, peer bots, workdir, avatar, ports, restarts. Use when asked to update a bot, change its settings, restart it, roll back a bad change, or when a config edit needs to reach the live bot. Covers the order of operations (config is read once at startup), the published-build rule, and what can and cannot be changed without a restart.
---

# Update a bot

## Which end first

Ask what the change touches, because the two ends disagree and one of them
is authoritative:

| The change is… | Do this, in order |
|---|---|
| Only local — model, port, workdir, peers, `ALLOWED_USER_IDS` | manager `.env` → restart → verify |
| The Slack app — name, description, icon, scopes, events | **Slack (`bot-slack`) → manager → Slack `verify` → restart → selftest** |

The second row is the one that goes wrong. The app in Slack is where the
bot's identity, scopes and face actually live; the `.env` is only a record
of how to run it here. Changing the icon or a scope in the manifest and
stopping there leaves Slack holding the old one — and a new scope does
nothing at all until the app is reinstalled and the tokens re-copied.

So: **Slack first, manager second, Slack again to confirm, then the bot.**

## The one rule

**Config is read once, at startup.** An edited `.env` changes nothing until
the bot restarts. So the order is always: edit → restart → verify → report.
Never tell a user a change is live before the restart.

## Edit

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it
# once, then read a path with: HOO_PATHS runtime
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }
```

`$(HOO_PATHS runtime)/<name>/.env`. Keys in use:

| Key | Note |
|---|---|
| `PEER_BOT_IDS` | Ids of bots allowed to mention this one: Slack `U…` and Discord digits, one list for both chats. Read at startup. |
| `PEER_TURNS` | Answers a peer gets per thread before asking a human. Default 2. |
| `ALLOWED_USER_IDS` | Mixed Discord digits and Slack `U…` ids. Empty = won't start. |
| `MODEL` | Per bot default; `!model` overrides per thread. **Never leave it empty to "use the default":** that default belongs to a subscription that can lapse, and the bot then sits busy forever on a model call that never answers — while `/healthz` still reports `ok`. Pin a model with working credentials. |
| `HOOCODE_ARGS` | Passed to `hoocode app-server`. `--thinking high` is the effort knob (off, minimal, low, medium, high, xhigh). Only used when `APP_SERVER` is empty. |
| `LINKS_FILE` | **One per bot.** Sharing it makes two bots fight over the same threads. |
| `HOO_WORKDIR` | Share it between bots on purpose — that's how skills propagate. |
| `HEALTH_PORT` | Unique per bot (8787, 8788…). `off` disables. |
| `HOO_AVATAR_*` | `SEED` `SHAPE` `STYLE` `PALETTE`. See `bot-avatar`. |
| `HOO_SURFACES` | What the manager draws boxes for. Never decides what connects. |

Keep comments and `chmod 600`. Edit by hand or through the manager — both
write the same file, and the manager preserves comments too.

Prefer a targeted `sed` on one key over rewriting the file, so a hand-tuned
note never disappears:

```sh
env="$(HOO_PATHS runtime)/hoo/.env"
cp "$env" "$env.bak.$(date +%Y%m%d-%H%M%S)"
python3 - "$env" <<'EOF'
import sys
p, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(p).read().splitlines()
out = [f"{key}={val}" if l.split("=")[0].strip() == key else l for l in lines]
if not any(l.split("=")[0].strip() == key for l in lines):
    out.append(f"{key}={val}")
open(p, "w").write("\n".join(out) + "\n")
EOF
```

## Restart

From the manager (`hoobot manager`, then Restart) or:

```sh
HOOBOT_RUNTIME_DIR="$HOME/.hoobot/runtime" RUN_FROM_NPM=1 \
  sh "$(HOO_PATHS runtime-script)" restart <name>
```

**`RUN_FROM_NPM=1` is not optional for a normal update.** Without it the bot
runs the working tree, and a `src/` edit that was never published silently
becomes live behaviour. With it, `bun add -g` picks up the latest release —
which is the only thing worth verifying against.

Confirm what actually ran:

```sh
ps -p "$(cat "$(HOO_PATHS runtime)/<name>/<name>.pid")" -o command=
```

It must name `node_modules/@kolisachint/hoobot/src/index.ts`. If it names
`a hoobot checkout/…`, put it back on the published build.

## Verify

```sh
bash "$(HOO_PATHS selftest)" <name>
curl -s http://127.0.0.1:<port>/healthz
tail -20 "$(HOO_PATHS runtime)/<name>/<name>.log"
```

If the change touched the Slack app, verify that end too — the selftest
reads the token, not the app's settings:

```sh
bun "$(HOO_PATHS skills)/bot-slack/scripts/slack-app.ts" verify <name>
```

The log's startup lines matter: `Slack: peer bots @x, @y (2 turns per
thread)` is proof the peers resolved. Silence there means `PEER_BOT_IDS`
didn't take.

## Changing source

Editing `a hoobot checkout/src/` does **not** change a running bot. The order
is: edit → `bun test` → commit → tag + publish → `bun add -g` → restart →
verify. Say which of those happened; never imply a live fix from a local
edit.

## Rollback

The `.env.bak.<timestamp>` next to the file is the undo. Stop, restore,
restart, re-run the self-test. For source, `git revert` the commit rather
than editing on top — a bot that works badly is easier to reason about than
one patched twice.

## Changing a token

Tokens are secrets: write them with `chmod 600` kept, never echo them into
chat, never put them in the repo. If a token is revoked (`account_inactive`,
`token_revoked`), only the user can mint a replacement — see
`slack-bot-create`, and tell them plainly rather than retrying.