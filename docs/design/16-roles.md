# 16 — Roles: hoocode vs hoobot

Status: **decided** (R1–R14, rethink of 2026-09-30).
Reviewed against the other options and confirmed as **B+** in
[17-architecture-review.md](17-architecture-review.md).
Replaces the `hoobotd` hub from the first pass.

## The rule

> **hoocode is the engine and the server.**
> **hoobot is bots and surfaces.**
>
> If a feature would be useful to a Codex CLI user with no hoobot
> installed, it belongs in hoocode.

## Who owns what

| Concern | hoocode | hoobot |
|---|---|---|
| Codex app-server protocol (types, schemas, conformance) | **owns** | client only |
| Server: Unix socket + WebSocket, many clients | **owns** | connects |
| Threads, turns, items, session files | **owns** | stores only a surface ↔ thread link |
| Fan-out of events to every subscribed client | **owns** | — |
| Approvals: routing, first-answer-wins | **owns** | renders buttons, sends the answer |
| Profiles (prompt, model, tools, folders) | **owns** | picks a profile id per bot |
| Tool grants + always-allow rules | **owns** | — |
| Workspace allowlist | **owns** | — |
| Worker processes, idle unload, crash isolation | **owns** | — |
| Thread / approval web UI | **owns** | — |
| Surface adapters (Discord, Slack, GitHub) | — | **owns** |
| Surface identity + linking to the owner | — | **owns** |
| Routing a message to a bot (mention, channel, command) | — | **owns** |
| Bot install, registry repo, bot-manager web UI | — | **owns** |
| Surface tokens in Keychain | — | **owns** |
| Swift menu-bar app | shared (shows both) | shared |

## Picture

```
 Discord ─┐
 Slack  ──┼─ hoobot (one process)            Codex CLI / IDE   hoocode web UI
 GitHub ──┘  adapters · routing · identity         │                 │
             bot manager UI · registry             │                 │
                     │                             │                 │
                     └────── Codex app-server protocol ──────────────┘
                              unix socket (0600) / ws://127.0.0.1
                                           │
                            ┌──────────────▼──────────────┐
                            │  hoocode app-server         │
                            │  threads · approvals ·      │
                            │  profiles · policy · fan-out│
                            └──────┬───────────┬──────────┘
                                   │ internal  │
                     worker: reviewer@~/a   worker: helper@~/b
```

## Consequences

- **No `hoobotd`.** hoobot is a normal client, the same as the Codex CLI.
- **One safety model everywhere.** Grants and always-allow rules apply
  whether a turn comes from Discord, the Codex CLI or the web UI.
- **hoobot gets much smaller.** It has no process pool, no policy engine
  and no session store.
- **hoocode gets much bigger.** Most of the work moves to the hoocode repo.
- hoobot can't work until hoocode's server exists. That sets the build order.

## Layers inside hoocode (R16)

```
L4  daemon      socket + WS · fan-out · approval routing · supervisor
L3  app-server  Codex protocol over stdio · one client
L2  policy core profiles · grants · always-allow · workspace allowlist
L1  engine      AgentSession, tools, sessions (exists today)
```

Policy is in L2, so the terminal UI, rpc and print modes enforce it too.
Later, the terminal UI becomes an L4 client (R18).
