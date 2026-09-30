# 17 — Architecture review: which option, and why

Status: **decided 2026-09-30: B+** (R15–R18).
This review checks the rethink (16) against the first design (A) and
against the other options we could find.

## The options

| # | Option | In short | Verdict |
|---|---|---|---|
| A | Hub in hoobot (first design) | `hoobotd` owns threads and safety, and starts one hoocode per session | Works, but has a safety gap and speaks the protocol twice |
| A′ | Thin hub in hoobot | Engine, policy and a stdio app-server in hoocode; the daemon in hoobot passes messages through | Sound; the fallback if B turns out too heavy |
| **B** | **hoocode is the server** (rethink) | hoocode serves the Codex protocol to all clients; hoobot is one of them | **Chosen, as B+** |
| C | Library | hoobot loads `AgentSession` in its own process | A dead end: no isolation, no Codex clients |
| D | Real Codex as the engine | hoobot talks to `codex app-server` | Drops hoocode; kept as a **test target** |
| E | Status quo plus | Keep `--mode rpc` per thread and add Slack inside hoobot | A stopgap only |
| F | ACP | Editor protocol | Wrong shape: one client, no fan-out |

## A vs B, point by point

| Question | A: hub in hoobot | B: hoocode is the server |
|---|---|---|
| Size of hoocode | ✅ small | ❌ grows a lot |
| Following pi-mono upstream | ✅ easier | ❌ harder (**doesn't matter: hoocode has gone its own way**) |
| Changing hoobot quickly | ✅ one repo | ➖ often both repos (**fine: you own both**) |
| Safety covers the terminal UI and Codex CLI | ❌ only turns through the hub | ✅ everywhere |
| Codex CLI or IDE works with no hoobot running | ❌ | ✅ (**you want this**) |
| Terminal UI shares a thread with a bot | ❌ | ✅ (**you want this, eventually**) |
| Where the protocol is spoken | ❌ both hub and hoocode | ✅ once |
| Same shape as Codex itself | ❌ | ✅: `app-server` + `app-server-daemon`, with the Codex TUI and `exec` as clients |
| A crash affects | the hub, so all bots | the daemon, so all bots |

## What decided it

Once policy lives in hoocode's core and hoocode speaks the protocol over
stdio, A′ and B differ in only one way: **which repo holds the daemon**.
Your answers settled that:

1. **You want to use hoocode's server without hoobot.** That rules out a
   daemon inside hoobot.
2. **You want the terminal UI to share threads with bots, eventually.**
   Then the terminal UI becomes a client of the daemon, as the Codex TUI
   already is. The daemon must be part of hoocode.
3. **You rarely or never merge from upstream.** The main argument for
   keeping hoocode small doesn't apply.
4. **You're fine releasing hoocode often.**

## B+: the three changes to B

### R15: profiles and policy live in hoocode's core

They don't live in the server layer. Tool grants, always-allow rules and
the folder allowlist apply to every way of running hoocode:

- the interactive terminal UI;
- `--mode rpc`;
- `--mode print`;
- the app-server.

This makes "the same safety everywhere" true, not just true for the server.

### R16: hoocode has four layers

```
L4  daemon          socket + WS · fan-out · approval routing · supervisor
                    one worker per (profile, folder)
L3  app-server      Codex protocol over stdio · one client · one process
L2  policy core     profiles · grants · always-allow · workspace allowlist
L1  engine          AgentSession, tools, sessions (exists today)
```

- Each layer can be tested on its own.
- A daemon worker is an L3 process, so the daemon only relays messages
  and supervises processes.
- L3 alone is already useful: `codex --remote`-style tools and tests
  can drive it over stdio.
- This matches how Codex is split up.

### R17: hoobot sticks to the standard Codex protocol

- hoobot uses only standard Codex methods, plus **one optional field**: a
  profile id on `thread/start`.
- If that field is missing, the server uses its default profile.
- hoobot's tests also run against the real `codex app-server`. That keeps
  both sides honest, and keeps option D open as a fallback.

### R18: the terminal UI becomes a daemon client (later)

This is a goal for later, not part of the first build.
When it lands, a thread started on Discord can be opened in the hoocode
terminal UI, live.

## Why workers are separate processes

hoocode falls back to `process.cwd()` in about 14 places in its core code.
Running several folders inside one process would be risky.
Separate workers per (profile, folder) avoid that and isolate crashes.

## Risks that remain

- **hoocode carries most of the work.** The daemon, fan-out and supervisor
  are all new.
- **The daemon is a single point of failure.** If it dies, every bot stops.
  launchd restarts it and threads resume from JSONL. A turn that was
  running is lost; clients see it as interrupted.
- **Codex protocol churn.** Pinning helps, but updating to newer versions
  is ongoing work.

## If B turns out too heavy

Fall back to **A′**: keep L1–L3 in hoocode and move L4 into hoobot. Both
sides of L4 speak the Codex protocol, so the move doesn't touch hoobot's
adapters or hoocode's engine.
