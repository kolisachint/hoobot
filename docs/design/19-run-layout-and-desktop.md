# 19 — Run layout (merge `hoobot-run`?) + desktop UI plan

Status: **decided, 2026-10-02** (landed in `feat/runtime-layout`).
**Open:** the desktop UI itself — the web UI on `127.0.0.1` is served by
hoobot, and `/api/bots` is its first endpoint. See "What landed" below.

## What landed (2026-10-02)

- `scripts/runtime.sh` — `init | list | start | stop | restart | status |
  health | logs`, one parameterised script instead of the copy-pasted pair in
  `hee/`. It starts the bot from this working tree (`bun src/index.ts`) with
  the instance folder as the cwd, so Bun loads that instance's `.env` and
  nothing else. `RUN_FROM_NPM=1` runs the published build instead.
- `src/health.ts` — `GET /healthz` and `GET /api/bots` on `127.0.0.1`,
  enabled by `HEALTH_PORT` (default 8787, `off` disables). Wired to real
  state: surfaces report connected/failed, `handleCall` marks activity,
  `/api/bots` lists live sessions. A busy port logs a warning and never
  stops the bot.
- `runtime/` is gitignored; `hoo` (8787) and `hee` (8788) were migrated from
  `../hoobot-run` with their own `.env`, sharing
  `runtime/shared/workspace/`. The old folder is untouched and still works as
  a fallback.
- Verified: unit tests (59, `bun run check`), `test/session.e2e.ts` against a
  real hoocode app-server, a live Discord turn through the migrated
  credentials (`test/live.ts`), both instances booting from source with
  Discord + Slack connected and answering `/healthz`.

## The question

Should `../hoobot-run` (runtime folder) live inside the `hoobot` repo?

## What each folder actually is

| | `hoobot/` | `hoobot-run/` |
|---|---|---|
| Kind | source repo, published npm package `@kolisachint/hoobot` v0.0.6 | local runtime/deployment folder, **not a repo** |
| Git | yes, remote `kolisachint/hoobot`, branch `feat/peer-bots` | none, no `.gitignore` anywhere |
| Code | `src/` (16 TS files), `test/`, `scripts/service.sh` | none |
| Instances | none | `hoo` (root) and `hee/` — two bots, same binary |
| Config | `.env` (gitignored), `.env.example` | `.env` with live tokens, `hee/.env` |
| State | `workspace/` 296 KB | `workspace/` 63 MB (sessions, skills, attachments), logs, pids |
| Supervision | `scripts/service.sh` (launchd, `com.hoo.hoobot`) | `start.sh` / `stop.sh` (nohup + pidfile + `pgrep`) |

**`hoobot-run` is not a fork.** It is config + process control for the
published binary. There is no duplicated implementation anywhere; the only
real duplication is `start.sh`/`stop.sh` copied into `hee/`.

## Recommendation

**Yes, merge — but merge the *shape*, not the data.**

Put runtime under one gitignored `runtime/` directory in the repo:

```
hoobot/
  src/ test/ docs/ scripts/        # source, as today
  runtime/                         # NEW, gitignored
    hoo/    .env  start.sh  stop.sh  hoo.log  hoo.pid
    hee/    .env  start.sh  stop.sh  hee.log  hee.pid
    shared/workspace/              # HOO_WORKDIR for both bots
  .gitignore                       # + runtime/
```

Then:

- `hee/` and the current `hoo` root become two identical `runtime/<name>/`
  instances. One script, parameterised by name — the copy/paste in `hee/`
  disappears.
- Copy `.env`, `*.sh` and the Slack `manifest.json`. **Do not copy
  `workspace/` contents** — leave `runtime/shared/workspace/` empty and let
  the bot regenerate `.cortexcode/hoo-config.json` and the mode system prompt.
  Sessions, skills and attachments are 63 MB of history, not config.
- Keep `../hoobot-run` as-is for a week. Both can run: different cwd, same
  binary. Delete it when the new `runtime/hoo` has served a few real
  conversations. Nothing is moved, so this is free to back out.

### Why this is the right shape

- **One place** for the code you edit and the processes you run — which is
  the actual pain. Today a change means: edit repo, publish or `bun link`,
  restart a folder in another directory.
- **The git boundary is already right.** `.gitignore` already covers
  `.env` and `workspace/`. Adding `runtime/` is one line, and `package.json`
  `files: ["src", "README.md", "LICENSE", ".env.example"]` means nothing
  under `runtime/` can ever reach npm. So publishing risk is nil.
- **It fixes the two current warts.** `workspace/` exists in *both* trees
  today (a merge would collide), and `start.sh`'s `bun add -g
  @kolisachint/hoobot@latest` means the run folder tracks the *published*
  version while the repo tracks your working copy — so the run folder is
  usually behind the code you just wrote.

### The cost, stated plainly

A deployment root that is separate from the source tree is not stupid. It
gives you: no chance of `git status` noise from 63 MB of workspace, no risk
of an editor or a `bun run check` touching live state, and a clean
`npm publish`. We keep all of that via `runtime/` + `.gitignore`, at the
cost of one honest rule: **`runtime/` is state, not source.** Nothing in it
gets committed, and CI never sees it.

## What I would *not* do

- **Do not move the workspace data.** Copy-once means the old folder's
  sessions become invisible to the new instance. Sessions are cheap to
  re-grow; they are not worth a merge conflict.
- **Do not make `runtime/<name>/start.sh` do `bun add -g` any more.** Once
  code and runtime are in one repo, run the tree: `bun src/index.ts`.
  Keep a `HOOBOT_USE_NPM=1` escape hatch if you ever want to run the
  published build for a sanity check.
- **Do not delete `scripts/service.sh`.** launchd and `start.sh` are two
  supervision models; pick one per mode, not both at once (today both
  exist and can fight over one bot).
- **Do not build Electron first.** See below.

## Health check and daemon supervision

Today liveness is "does the pidfile still point at a live pid" (`start.sh`)
and `pgrep -f bin/hoobot` filtered by cwd (`stop.sh`). That is fine for a
hand-run process and useless for a UI.

Minimum for a UI to be honest, in order of value:

1. `GET /healthz` on `127.0.0.1` — `ok`, uptime, pid, connected surfaces,
   last message time, per-bot status. One endpoint, no auth, bound to
   loopback only (same trust model as R11: socket 0600, any local process is
   the owner).
2. `GET /api/bots` — the instance list: name, surfaces connected, model,
   sessions alive, errors.
3. Structured log lines (`--json`) so the UI can render the last N events
   without tailing text.
4. Then supervision: launchd `KeepAlive` + `ThrottleInterval` already gives
   restart-on-crash and boot-at-login for free. Health check is for the
   *UI*, not for keeping the process up.

## Desktop UI — the fast path is not Electron

The existing decision (R8, [11-desktop-app.md](11-desktop-app.md)) is
already the right answer: **hoobot serves a web UI on `127.0.0.1`**,
hoocode serves the thread/approval UI, and a small menu-bar app is a later
thin shim. That is still the fastest thing to build and iterate, because:

- Electron adds ~150 MB, a bundler, a separate build pipeline and code
  signing — to display pages the browser already renders.
- The web UI also works from a phone on the LAN later, and in a normal tab
  during development. Figma-grade iteration is a hot-reload loop, not a
  packaged app.
- Bun already serves HTML; a `bun run ui --watch` loop is minutes, not days.

Electron becomes worth it only when you need something a browser tab
cannot: a native tray item, menu-bar approval notifications
(Allow once / Deny), and login-item installation. Build the web UI first
and keep a clean seam (the UI talks to `/api/*` over loopback, never to
bun internals) so wrapping it in a tray or Electron later is a container
change, not a rewrite.

Proposed UI scope, in order:

1. **Bots screen** — `hoo` and `hee` as cards: connected/disconnected,
   channels served, current model, uptime, last error, start/stop/restart.
2. **Surfaces screen** — Slack/Discord connection state, tokens present
   (masked), reconnect button, adapter log tail.
3. **Threads screen** — read-only link from a chat space to its hoocode
   thread; deep link into the hoocode UI.
4. Approvals and turn streaming stay in hoocode's UI (R8).

## Open questions

1. Run from source (`bun src/index.ts`) everywhere, or keep an
   "installed npm build" mode for prod parity?
2. launchd (`scripts/service.sh`) *or* `runtime/<name>/start.sh` as the one
   supervisor? Pick one; both existing today.
3. `HOO_WORKDIR`: keep one shared workspace for both bots (today) or give
   each instance its own? Sharing means both processes write the same
   `.cortexcode/hoo-config.json` and mode prompt — a real concurrent-write
   hazard that a shared lock or per-instance workspace would fix.
4. Is `workspace/` per-instance or shared in the target layout above?

## Decision log addition (proposed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-02 | P1: runtime lives in `hoobot/runtime/<name>/`, gitignored; shape copied from `hoobot-run`, workspace data regenerated not copied | One place to edit code and run bots, without putting 63 MB of state or live tokens in git or npm |
| 2026-10-02 | P2 (landed): `scripts/runtime.sh` is the single, parameterised supervisor; run from the working tree by default, `RUN_FROM_NPM=1` for the published build | No copy-pasted scripts per instance, and an edit is one `restart` from the chat |
| 2026-10-02 | P3 (landed): `/healthz` + `/api/bots` on 127.0.0.1, `HEALTH_PORT` per instance, `off` to disable | Liveness for a UI and for scripts; a busy port must never stop the bot |
| 2026-10-02 | Desktop UI = hoobot-served web UI on `127.0.0.1` first; Electron/tray only for menu-bar status and approvals | Fastest to iterate; keeps a seam for a native wrapper later |
