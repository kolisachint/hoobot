# 15 — Scope and roadmap

Status: **decided, revised 2026-09-30** (T6 → R7, R13, R16–R18).
Change: most of the work moves to the **hoocode** repo. hoobot becomes
one client process.

## Decisions

1. **Surfaces after Discord: Slack, then GitHub.**
2. **Same Mac only.** No remote server.
3. **hoobot is one process** that hosts every adapter and a bot manager.
   It's written in TypeScript on Bun, with one module per surface.
4. **Build order:** hoocode app-server first, then profiles and policy,
   then hoobot.
5. **Later goal (R18):** the hoocode terminal UI becomes a client of the
   daemon, so it can open a bot's thread live.

## Phases

### Phase 1: hoocode app-server (hoocode repo)

- Copy in the Codex protocol types and schemas, pinned to a commit.
- Map sessions to threads, prompts to turns, events to items.
- Map tool confirms to Codex approvals, and dialogs to `requestUserInput`.
- **L3 first:** the Codex protocol over stdio, one client.
- **Then L4, the daemon:** Unix socket and WebSocket, fan-out to many
  clients, and a supervisor with one worker (an L3 process) per
  (profile, workspace).
- Conformance: drive it with the stock Codex CLI and the Codex test client.
- `--mode rpc` stays as it is.

### Phase 2: profiles and policy (hoocode repo, in core: L2)

Policy lives in core, not in the server, so the terminal UI, rpc and
print modes enforce it too.

- A general "profile" concept: prompt, model, tools, folders.
- Requested vs granted tools, with grants asked for at install.
- Always-allow rules per (profile, workspace).
- Workspace allowlist.
- `hoocode/*` methods to manage profiles and policy.

Until this lands, the server runs with hoocode's current settings, and
every approval is asked.

### Phase 3: hoobot client and the Discord port (this repo)

- A small shared Codex client module that uses only standard Codex
  methods (R17). Test it against hoocode and the real `codex app-server`.
- The Discord adapter talks to hoocode's socket instead of spawning
  `--mode rpc`.
- A store linking surface threads to hoocode threads, plus surface identity.
- Migrate the old `discord-sessions/`.
- launchd: one service for `hoocode app-server`, one for `hoobot`.

### Phase 4: UIs and the menu-bar app

- hoocode web UI: threads, approvals, profiles, policy.
- hoobot web UI: bots, surfaces, links, registry.
- Swift menu-bar app: status for both, links to open each UI,
  approval notifications.
- Registry repo plus CI; app releases through GitHub Releases.

### Phase 5: new surfaces

- Slack.
- GitHub.

## Surface notes

| Surface | Connects by | A thread is | Approvals |
|---|---|---|---|
| Discord | Gateway (outbound) | a Discord thread | Buttons |
| Slack | Socket Mode (outbound) | a Slack thread | Block Kit buttons |
| GitHub | Polling with `gh` | an issue or PR | **Never on GitHub**: answered from another client |

## hoobot repo layout (sketch)

```
hoobot/
  docs/design/
  src/
    codex-client/   shared client for hoocode's socket
    adapters/
      discord/
      slack/
      github/
    bots/           routing, bot manifests, registry client
    links/          surface ↔ thread store, identity
    web/            bot-manager UI
  tray/             Swift menu-bar app (may live elsewhere)
```

## Still open

- Which bot answers a message that doesn't address one.
- Where logs go, and how they rotate.
- How to test adapters (a fake Codex server?).
- Where the Swift menu-bar app lives: in hoobot, in hoocode, or its own repo.
