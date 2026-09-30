# 14 — Users, approvals, safety

Status: **decided, revised 2026-09-30** (T5 → R4, R11, R15).
Change: grants, always-allow rules and approval routing now live **in
hoocode**, so every client gets the same safety.

## Decisions

1. **Single owner.** Only you use this, across all surfaces.
   **hoobot** links each surface account (Discord ID, Slack ID…) to you
   and ignores messages from unlinked IDs.
2. **Only you approve**, from any client subscribed to the thread.
   hoocode routes the request, and the first answer wins.
3. **A profile's tools are granted, not trusted.** A package *requests*
   tools. When you install it, hoocode asks you to grant them. hoocode
   starts the profile's worker with only the granted tools.
4. **"Always allow"** rules live in **hoocode policy, per (profile,
   workspace)**. They are never global.
5. **Server access:** any process running as your user is the owner
   (socket mode 0600). WebSocket clients need a token.
6. **ChatGPT mobile relay:** later, opt-in, off by default.
7. **Policy lives in hoocode's core (R15), not in the server layer.**
   Grants, always-allow rules and the workspace allowlist apply to the
   interactive terminal UI, `--mode rpc`, `--mode print` and the app-server.

## Protection layers

| # | Layer | Lives in | Stops |
|---|---|---|---|
| 1 | Surface filter | hoobot | Strangers in a shared server |
| 2 | Socket permissions / WS token + Origin check | hoocode | Other users, other websites |
| 3 | Profile grants → worker tool list | hoocode | A bot using tools it wasn't given |
| 4 | Approval gate + always-allow rules | hoocode | Unapproved bash / edit / write |
| 5 | Workspace allowlist | hoocode | Escaping to other folders |

Layers 2–5 protect every client: hoobot, the Codex CLI, the IDE and web UIs.
Layers 3–5 also protect hoocode when you run it in the terminal.

## How an approval travels

```
worker ──needs approval──► hoocode app-server
                             │ always-allow rule for (profile, folder)? ─ yes ─► accept
                             │ no
                             ▼
               send to every subscribed client
     (hoobot → Discord buttons · web UI · Codex CLI · menu-bar notification)
                             │ first answer wins
                             ▼
               accept / accept for session / decline
                 (no answer in 10 min → decline)
```

## Policy record (hoocode-side, sketch)

```jsonc
// ~/.config/hoocode/profiles/reviewer.json (or inside hoo-config.json)
{
  "id": "reviewer",
  "requested": ["read", "bash", "edit"],
  "granted":   ["read", "bash"],
  "workspaces": ["~/github/hoobot", "~/github/other"],
  "alwaysAllow": {
    "~/github/hoobot": ["bash:git status", "bash:bun test"]
  }
}
```

Always-allow rules are narrow, for example a tool plus a command prefix.
They never mean "all bash".

## Secrets

- Surface tokens (Discord, Slack, GitHub) go in the macOS Keychain,
  **owned by hoobot**.
- Model provider keys stay where hoocode already keeps them.

## Still open

- How to link surface accounts: a one-time pairing code
  (`/hoo link 1234`, shown in hoobot's UI) or manual config.
- Syntax for always-allow rules.
- Where hoocode's WebSocket token comes from (a file under
  `~/.local/state/hoocode/`, read by the menu-bar app?).
