# 02 — Architecture options

Status: **superseded** — see [12-protocol.md](12-protocol.md).
Chosen: topology B; Codex app-server protocol as-is (not our own).
Kept for the record of the options we looked at.

## Protocol candidates

| Candidate | Wire format | Pros | Cons |
|---|---|---|---|
| hoocode RPC as-is | Line JSON, `type`/`id` | Zero translation, already works | Not JSON-RPC 2.0; each surface re-implements session + approval logic |
| Codex app-server | JSON-RPC 2.0, thread/turn/item | Good model; approvals are server→client requests | hoocode doesn't speak it; translation layer tracks two moving targets |
| ACP (Agent Client Protocol) | JSON-RPC 2.0 over stdio | Zed, Neovim, JetBrains clients exist | Editor-centric; less fit for chat surfaces |
| Own JSON-RPC 2.0 (Codex-inspired) | JSON-RPC 2.0 over local socket | Fits hoobot exactly; versioned by us | We own the spec and its maintenance |

**Leaning:** borrow Codex's *shape* (threads, turns, items,
server-initiated approval requests) for our own JSON-RPC 2.0 surface.
Keep ACP as a possible extra front door for editors.

## Topology candidates

### A — Adapters talk to hoocode directly

```
discord adapter ─┐
slack adapter   ─┼─► hoocode --mode rpc × N
qt app          ─┘
```

Simplest. But policy, sessions and the allowlist are duplicated per adapter.

### B — Central hub daemon (`hoobotd`)

```
            ┌── discord adapter
            ├── slack / telegram / matrix adapter
hoobotd ◄───┼── Qt desktop app (manager + chat)
 (hub)      ├── github adapter
            └── editor (via ACP, later)
   │
   └── hoocode --mode rpc × N   (one per session)
```

One place for sessions, approvals, identity and policy.
Adapters become thin translators.

### C — B plus an ACP front door

Same as B; the hub also speaks ACP so editors attach without custom code.

**Leaning:** B, built so C can be added later.

## Cross-cutting concerns

- **Safety:** every surface is a new way to run `bash` on this Mac.
  Policy must live in the hub, not in each adapter.
- **Identity:** one person, several surface IDs — map or not?
- **Secrets:** bot tokens in macOS Keychain, not `.env`.
- **Qt on macOS:** signing, notarization, LGPL compliance, accessibility.
- **Two languages:** C++ (Qt) + TypeScript (adapters) — the protocol is the
  contract and must be versioned.
