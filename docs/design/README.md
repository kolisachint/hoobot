# hoobot design

Status: **architecture locked (B+, 2026-09-30); first build in progress.**
**Current step (2026-10-01, revised):** build a minimal `hoocode app-server`
(stdio + Unix socket, fan-out), then port hoobot to it. See
[18-current-step.md](18-current-step.md) and hoocode `docs/design/app-server.md`.

## Summary

**hoocode is the engine and the server. hoobot is bots and surfaces.**

hoocode gains `hoocode app-server`, a long-running server that speaks the
Codex app-server protocol. Its types and schemas are copied from `../codex`
and pinned to a commit. It serves a Unix socket and a localhost WebSocket
to many clients at once. It owns:

- threads and sessions;
- sending events and approvals to every client on a thread;
- profiles (personas);
- tool grants and always-allow rules;
- a worker process per (profile, workspace).

hoobot is a single client process. It hosts the surface adapters
(Discord, then Slack and GitHub), routes messages to bots, links surface
accounts to you, and manages bot installs and the registry.

A bot is a hoocode profile plus hoobot routing. The same safety rules
apply to every client, whether it's hoobot, the Codex CLI or a web UI.

Inside hoocode there are four layers: engine → policy core → stdio
app-server → daemon. Policy lives in core, so the terminal UI is covered
too. Why this option and not the others:
[17-architecture-review.md](17-architecture-review.md).

## Documents

**Reading copy:** [design.html](design.html) is one page with everything
below, plus a contents list, a text-size switch and review checkboxes.
The Markdown files are the source of truth.

| # | File | Topic | Status |
|---|---|---|---|
| 00 | [00-context.md](00-context.md) | Where the project is today | done |
| 01 | [01-open-questions.md](01-open-questions.md) | Questions still to settle | living |
| 02 | [02-architecture-options.md](02-architecture-options.md) | Protocol + topology options | superseded |
| 03 | [03-surfaces.md](03-surfaces.md) | Candidate surfaces | reference |
| 10 | [10-bot-model.md](10-bot-model.md) | What a bot is | revised |
| 11 | [11-desktop-app.md](11-desktop-app.md) | Desktop app + registry | revised |
| 12 | [12-protocol.md](12-protocol.md) | Protocol + server | revised |
| 13 | [13-sessions-workspaces.md](13-sessions-workspaces.md) | Sessions, workspaces, processes | revised |
| 14 | [14-users-safety.md](14-users-safety.md) | Users, approvals, safety | revised |
| 15 | [15-scope-roadmap.md](15-scope-roadmap.md) | Scope + roadmap | revised |
| 16 | [16-roles.md](16-roles.md) | **Roles: hoocode vs hoobot** | decided |
| 17 | [17-architecture-review.md](17-architecture-review.md) | **Options A–F, why B+** | decided |
| 18 | [18-current-step.md](18-current-step.md) | **Current step: Rust hoocode, MIT only** | decided |
| 19 | [19-run-layout-and-desktop.md](19-run-layout-and-desktop.md) | Runtime folder merge + desktop UI plan | decided |

## Decision log

Each entry gives the date, the decision and why. Newest is last.
Superseded rows are kept and struck through, with the row that replaces them.

| Date | Decision | Why |
|---|---|---|
| 2026-09-30 | A bot is a persona; adapters are shared plumbing | Lets one surface token host many bots |
| 2026-09-30 | ~~Bots ship as hoocode packages + `hoobot` manifest~~ → R12 | Reuses `hoocode install` instead of a new format |
| 2026-09-30 | One adapter hosts many bots, routed by mention / channel / command | Fewer tokens and connections to manage |
| 2026-09-30 | ~~Desktop = hub web UI + small Swift tray~~ → R8 | macOS only; reuse Bun; browser accessibility |
| 2026-09-30 | App ships via GitHub Releases from CI on merged PRs | "PR process" for the app |
| 2026-09-30 | Bots published by PR to a personal registry repo; adapters ship in hoobot | "PR process" for bots; keeps untrusted code out |
| 2026-09-30 | ~~Topology B: central hub `hoobotd`~~ → R1 | One place for policy, sessions, routing |
| 2026-09-30 | Codex app-server protocol as-is | Free clients (Codex CLI/IDE); official schemas |
| 2026-09-30 | ~~Unix socket + localhost WS served by the hub~~ → R1 | Same-PC only; file permissions guard the socket |
| 2026-09-30 | ~~Spawn hoocode per session~~ → R6 | Crash isolation |
| 2026-09-30 | Add a Codex app-server inside hoocode | Every tool benefits |
| 2026-09-30 | ~~Extras via `hoobot/*` methods~~ → R7, R10 | Stock Codex clients keep working |
| 2026-09-30 | Stock Codex client support is a real goal | Main reason for picking Codex |
| 2026-09-30 | ~~Threads belong to the hub~~ → R1 | Move between phone and desk |
| 2026-09-30 | Bot default folder + allowlisted project folders (now in hoocode profiles) | Useful, but no arbitrary paths |
| 2026-09-30 | ~~One process per (bot, workspace), in the hub~~ → R6 | Balance of isolation and memory |
| 2026-09-30 | Unload idle threads; resume from JSONL | Keep memory low |
| 2026-09-30 | Single owner; surface IDs linked to them (in hoobot) | Personal tool; simplest trust model |
| 2026-09-30 | Only the owner approves, from any subscribed client | Others may ask; only the owner acts |
| 2026-09-30 | ~~Hub enforces grants via `--tools`~~ → R4 | Read-only bots; no self-granting |
| 2026-09-30 | ~~"Always allow" in hub policy~~ → R4 | Never touches global hoocode config |
| 2026-09-30 | ChatGPT mobile relay: later, opt-in, off by default | Outbound path through a third party |
| 2026-09-30 | Next surfaces: Slack, then GitHub | Chosen by owner |
| 2026-09-30 | Same Mac only | Keeps transport + auth simple |
| 2026-09-30 | Adapters: TS on Bun, in the hoobot repo, one module per surface | Shared client, one toolchain |
| 2026-09-30 | ~~Build order: app-server → hub + Discord → UI → surfaces~~ → R13 | Protocol first |
| **Rethink** | | |
| 2026-09-30 | R1: `hoocode app-server` is a full server (socket + WS, many clients, fan-out). No hub | Codex already does this; clear roles |
| 2026-09-30 | R2: hoocode = engine + server; hoobot = bots + surfaces | Anything useful without hoobot goes in hoocode |
| 2026-09-30 | ~~R3: copy only the Codex protocol (TS types + schemas), pinned; server written in TS~~ → R19, R20 | `../codex` is Rust; hoocode is TS; schemas are the contract |
| 2026-09-30 | R4: grants and always-allow rules enforced in hoocode | Same safety for every client, including stock Codex |
| 2026-09-30 | R5: hoocode gets a general "profile" concept | A persona is useful without hoobot |
| 2026-09-30 | R6: hoocode server = supervisor + worker per (profile, workspace) | Crash isolation, per-folder cwd |
| 2026-09-30 | R7: hoobot = one process hosting all adapters + bot manager | Small, simple, one service |
| 2026-09-30 | R8: UI split: hoocode serves threads/approvals; hoobot serves bots; one menu-bar app | Each UI lives with its data |
| 2026-09-30 | R9: dialogs use Codex `item/tool/requestUserInput`; editor falls back to `hoocode/*` | Already in Codex; stock clients can show them |
| 2026-09-30 | R10: surface ↔ thread links stored in hoobot | hoocode never learns about Discord |
| 2026-09-30 | R11: any process running as your user = owner (socket 0600); WS needs a token | Same-Mac, single-user |
| 2026-09-30 | R12: package: `hoocode.profiles` = persona; `hoobot` = surfaces + routing | Each tool reads its own section |
| 2026-09-30 | R13: build order: app-server → profiles + policy → hoobot Discord → UIs → Slack, GitHub | The server first; hoobot needs it |
| 2026-09-30 | R14: docs 12–15 rewritten in place; this log keeps the history | One current design, with history kept |
| **Architecture review** | | |
| 2026-09-30 | Lock in **B+** over A, A′, C, D, E, F | You want hoocode's server usable without hoobot, and the terminal UI sharing threads; upstream merges are rare |
| 2026-09-30 | R15: profiles and policy live in hoocode's **core**, not the server | Safety covers the terminal UI, rpc and print modes too |
| 2026-09-30 | R16: hoocode layers: engine → policy → stdio app-server → daemon | Each layer can be tested; the daemon only relays and supervises; same split as Codex |
| 2026-09-30 | R17: hoobot uses only standard Codex methods (+ optional profile id); tested against real `codex app-server` | Keeps both sides honest; option D stays a fallback |
| 2026-09-30 | R18 (later): the hoocode terminal UI becomes a daemon client | Open a bot's thread live in the terminal |
| 2026-09-30 | Build order stays R13: daemon and policy before the Discord port | Chosen by owner |
| 2026-09-30 | Fallback if B is too heavy: A′ (move the daemon into hoobot) | Codex protocol on both sides, so the move is cheap |
| **Current step** | | |
| 2026-10-01 | R19: hoocode is the Rust build; TS hoocode is ignored | hoocode is Rust only now |
| 2026-10-01 | R20: MIT only. Nothing copied from Codex; own `cortexcode-app-server-protocol` crate; server in Rust; Codex schemas only at test time | Codex is Apache-2.0 |
| 2026-10-01 | R21: first step is hoobot on Rust `hoocode --mode rpc`; app-server, profiles, Slack wait | Smallest change that keeps hoobot working |
| 2026-10-01 | ~~R22: blocker: RPC approval dialogs in hoocode (outside the migration); no interim workaround~~ → R23 | Rust RPC mode runs gated tools without asking |
| **App-server resumes** | | |
| 2026-10-01 | R23: build the app-server now; hoobot moves to it instead of `--mode rpc` | Owner: "implement app-server, just what we need" |
| 2026-10-01 | R24: goal = swappable clients: Codex-compatible wire format both ways (hoobot ↔ hoocode or real Codex; Codex TUI ↔ hoocode) | Settles T7.1 |
| 2026-10-01 | R25: first build = L3 stdio + single-process daemon on a Unix socket with fan-out; one workspace per server; no workers, TCP WebSocket or profiles yet | Smallest server hoobot can use |
| 2026-10-01 | R26: unimplemented methods → `method not found`, except neutral results for what a recorded `codex --remote` session calls | "Just what we need" while the Codex TUI still connects |
| 2026-10-01 | R27: MIT = our code; deps must be permissive and MIT-compatible; nothing copied from Codex; Codex schemas generated at test time only | Settles T7.2–T7.3 (reading Codex source for behaviour is fine; copying is not) |
| 2026-10-01 | R28: hoobot stays TypeScript on Bun; reaches the socket with `ws+unix://` | Settles T7.4; Bun supports WebSocket over a Unix socket |
| **Run layout** | | |
| 2026-10-02 | P1: runtime lives in `hoobot/runtime/<name>/`, gitignored; copy the *shape* of `hoobot-run`, regenerate the workspace | One place to edit code and run bots; keeps 63 MB of state and live tokens out of git and npm |
| 2026-10-02 | P2: `scripts/runtime.sh` supersedes per-instance start/stop scripts; runs from the working tree (`RUN_FROM_NPM=1` for the published build) | One parameterised supervisor; an edit is one `restart` from the chat |
| 2026-10-02 | P3: `/healthz` + `/api/bots` on 127.0.0.1 per instance (`HEALTH_PORT`) | Liveness for the desktop UI and for scripts; the UI's first endpoint |
