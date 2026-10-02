# 20 — The bot manager: bots you can see, name and start

Status: **decided and built, 2026-10-02** (lands with #9).
Follows [19](19-run-layout-and-desktop.md); the web-UI-first decision there
is what this doc executes.

## What it is

One page on `127.0.0.1:8790`, served by hoobot itself:

```
bun run manager --open
```

It lists your bots with a face, a status dot and the chats they serve;
creates new ones from a name, a generated avatar and a choice of chat;
starts, stops and restarts them; edits every setting; and shows what each
bot's own `/healthz` says plus the tail of its log.

Not in this first version: chat in the UI (hoocode owns threads and
approvals, R8), per-thread steering, and a phone app. This is the
"everything else" surface — the part you need before any of that.

## The decisions that shaped it

**1. The `.env` file is the database.** `runtime/<name>/.env` is the only
state the manager keeps. There is no registry, no JSON manifest, no second
copy of a port number. Someone who has never opened this UI can edit that
file, and the UI will show it — and someone who has never touched it can
never make it disagree. Comments and hand-tuned keys survive an edit:
`writeInstance` rewrites the *last* occurrence of a key and drops the
duplicates above it, because that is the one `parseEnv` would have read.

**2. `scripts/runtime.sh` stays the supervisor.** Start and stop from the
UI are `sh scripts/runtime.sh start <name>`, the same line you would type.
No second implementation of pid handling, no launchd race with the script,
and a bot started by hand and a bot started by a click are the same bot.
Failure is surfaced verbatim: the script's last log lines are what the UI
shows, which is the only useful thing to show when a bot won't boot.

**3. No framework, no build step.** `web/` is three files the browser reads
as-is: `index.html`, `app.js`, `style.css`. Everything a bot shows comes
from JSON over loopback, so the page has no build-time knowledge of bots at
all. `tsc` excludes `web/`; the one thing that would catch a typo there is
`bun build web/app.js`, which is why there is a test that checks every
element id in the script exists in the page.

**4. Avatars are generated from a seed, not stored.** `HOO_AVATAR_SEED` →
an inline SVG with a gradient tile and a mirrored dot constellation
(`src/avatar.ts`). Same seed, same face, forever, with nothing on disk but
a number — so a bot keeps its face across restarts and there is no image to
lose, re-upload or gitignore. Shape (circle / squircle) and palette are
three more keys. The new-bot sheet previews the exact SVG it will save, by
asking the server for it, so what you see is what you get.

**5. Tokens never reach the browser.** The API masks them
(`xoxb••••cdef`); a field the user didn't touch is sent back as
`__unchanged__`, and anything containing `•` is treated as a mask rather
than a value. This is deliberate and tested: the first version of the patch
handler wrote the mask into `.env` and produced a bot with a token that
looked almost right, which is the worst possible failure.

**6. Loopback, no auth, but not a browser-shaped hole.** `MANAGER_PORT`
(default 8790) binds `127.0.0.1`, and any request whose `Host` or `Origin`
isn't loopback gets a 403. Without that, any page you have open could
drive your bots through your browser (DNS rebinding). This is the same
trust model as the app-server socket (R11): every process running as you
already owns the box.

## How it fits together

```
browser  ──GET /api/manager──▶  manager (src/manager.ts, :8790)
   ▲                              │  reads runtime/<name>/.env
   │                              │  asks each bot's /healthz (:8787+, :8788…)
   └── PATCH /api/instances/…     │  POST …/start|stop|restart ──▶ scripts/runtime.sh
                                  ▼
                            runtime/<name>/.env ──▶ bun src/index.ts ──▶ Discord / Slack
```

| Piece | Where | What it owns |
|---|---|---|
| Manager server | `src/manager.ts` | HTTP, routing, the loopback guard, calling the supervisor script |
| Instance state | `src/instances.ts` | read/write `.env`, list, create, delete, name and port rules |
| Faces | `src/avatar.ts` | seed → SVG |
| Page | `web/` | list, detail, settings, the new-bot sheet |
| Supervision | `scripts/runtime.sh` | pids, logs, start/stop (unchanged, plus `HOOBOT_RUNTIME_DIR`) |

### The API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/manager` | instances + live health + the field definitions |
| GET | `/api/names/suggest?seed=` | a free name; the same seed gives the same name |
| GET | `/api/avatar.svg?seed=&shape=&palette=&name=` | a face before the bot exists |
| POST | `/api/instances` | `{name, surfaces, workdir, avatarSeed, secrets}` |
| PATCH | `/api/instances/:name` | `{config: {…}}` or `{secrets: {…}}` |
| DELETE | `/api/instances/:name` | stopped bots only |
| POST | `/api/instances/:name/{start,stop,restart}` | via `scripts/runtime.sh` |
| GET | `/api/instances/:name/logs?lines=` | tail of that bot's log |
| GET | `/api/instances/:name/avatar.svg` | the saved face |
| POST | `/api/instances/:name/avatar` | `{seed}` — shuffle |

## The new-bot flow

One sheet, three blocks, no wizard. The user asked for OpenAI-dots /
Grok-bots / Muse calm: few moving parts, obvious next action.

1. **Identity** — a suggested name (`wren`, `pepper`, …) with a Shuffle
   button, a 56px preview of the avatar, shape and colour pickers, another
   Shuffle for the face. Name validation is inline and specific ("lowercase
   letters, numbers and dashes, starting with a letter"), not a red border.
2. **Chats** — Slack and/or Discord as toggles; the token boxes for the
   chosen chats appear underneath, each with one sentence of where to get
   it. Tokens may be left empty: a bot can be created first and set up
   second, and the UI says so.
3. **Workspace** — the working folder, pre-filled with
   `runtime/shared/workspace` so a new bot joins the shared folder the way
   `hoo` and `hee` already share one, and can be pointed somewhere private
   instead.

Create writes the folder and `.env`, assigns the next free health port
(8787, 8788, …) and selects the bot. Nothing is started automatically:
starting a bot that has no token yet just fails, and a red dot on a bot you
made ten seconds ago is not a good first impression.

### Which boxes are shown

`fieldsFor(surfaces)` hides a platform's token box unless the bot is set up
for that platform — an empty box reads as "fill this in", and a filled one
that does nothing is worse. A brand-new bot has no token, so "configured
for" comes from `HOO_SURFACES` (written at creation, editable in the Chat
group as two toggles), unioned with whatever tokens the bot actually has.
Without that key a new bot would have no token box to paste a token into —
the chicken-and-egg problem this key exists to solve. It changes nothing
about how the bot connects: `config.ts` still decides from tokens.

## What is deliberately not here

- **Not a database, not a registry.** See decision 1.
- **Not a second supervisor.** See decision 2.
- **Not Electron.** See [19](19-run-layout-and-desktop.md) §"the fast path
  is not Electron". The seam is clean: the page only knows `/api/*`. A
  menu-bar item that shows "2 bots, 1 disconnected" and opens this URL is
  a small shell around it whenever that's wanted.
- **Not a build step.** Decision 3.
- **Not a chat client.** hoocode owns threads and approvals (R8).

## Open questions

1. Shared vs per-instance workspace. The manager defaults new bots to the
   shared folder (today's hoo/hee setup) but the concurrency hazard noted in
   [19](19-run-layout-and-desktop.md) is unchanged; a per-instance default
   plus a "share this folder" toggle is the obvious next move.
2. A trash can for deleted bots. Delete is `rm -rf` on the folder today,
   with a confirm that says so.
3. Logs: tail text now. Structured `--json` events would make the Activity
   card a real event list instead of a text box.
4. Whether the manager itself should be a launchd service (start at login)
   or stay a command you run when you want to look at your bots.

## Decision log addition

| Date | Decision | Why |
|---|---|---|
| 2026-10-02 | P4 (landed): the bot manager is a hoobot-served web UI on `127.0.0.1:8790`, `web/` has no build step | Fastest thing that can be iterated by editing a file and reloading |
| 2026-10-02 | P5 (landed): `.env` is the only state; `scripts/runtime.sh` is the only supervisor | The UI and the terminal can never disagree about a bot |
| 2026-10-02 | P6 (landed): avatars are generated from `HOO_AVATAR_SEED`, never stored as images | A bot keeps its face with nothing to migrate, back up or gitignore |
| 2026-10-02 | P7 (landed): tokens are masked in the API and a mask is never written back | A near-valid token is worse than none |
| 2026-10-02 | P8 (landed): the manager refuses non-loopback `Host`/`Origin` | Otherwise any web page can drive your bots through your browser |
| 2026-10-03 | P9: `hoobot manager [--open]` from npm; the package ships `scripts/`, and an installed manager keeps bots in `~/.hoobot/runtime` | A reinstall replaces the package folder; tokens must not live in it |
| 2026-10-03 | P10: token boxes start empty with the mask beside them, save on leave, clear by button; PATCH reports refused keys | Editing a pre-filled mask made "Saved" lie |
