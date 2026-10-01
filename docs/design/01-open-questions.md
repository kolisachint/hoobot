# 01 — Open questions

We go through these **one topic at a time**.
When a question is settled, its answer moves into a decision doc and
the README decision log.

## T1 — What is a "bot"? ✅ decided → [10-bot-model.md](10-bot-model.md)

## T2 — Desktop app ✅ decided → [11-desktop-app.md](11-desktop-app.md)

## T3 — Topology + protocol ✅ decided → [12-protocol.md](12-protocol.md)

## T4 — Sessions and workspaces ✅ decided → [13-sessions-workspaces.md](13-sessions-workspaces.md)

## T5 — Users and safety ✅ decided → [14-users-safety.md](14-users-safety.md)

## T6 — Scope ✅ decided → [15-scope-roadmap.md](15-scope-roadmap.md)

## Rethink R1–R14 ✅ decided → [16-roles.md](16-roles.md)

The protocol, server, sessions and policy moved from a hoobot hub into
hoocode. Docs 10–15 were revised in place.

## Architecture review ✅ decided: B+ → [17-architecture-review.md](17-architecture-review.md)

## Current step ✅ decided → [18-current-step.md](18-current-step.md)

Rust hoocode only, MIT only, hoobot stays on `--mode rpc`. B+ waits.

## T7 — Before B+ resumes (from 18)

To settle before the app-server work starts:

1. Do stock Codex clients (CLI, IDE) stay a goal? This sets how much of the
   protocol `cortexcode-app-server-protocol` covers.
2. May we read Codex's Rust source for behaviour, or only its docs and
   recorded messages?
3. Does "MIT only" cover dependencies? Can we take "MIT OR Apache-2.0"
   crates as MIT, and what about Apache-only ones?
4. Does hoobot stay TypeScript on Bun, or move to Rust and use the
   protocol crate?
5. hoocode RPC approvals: mark warm subagent workers as "no prompts" with an
   internal env var or a CLI flag? (hoocode `docs/design/rpc-approvals.md`)

## Remaining detail questions

Collected from the "Still open" sections of each doc.

| From | Question |
|---|---|
| 10 | Profile fields; matching Codex permission profiles; routing conflicts |
| 11 | Swift menu-bar app: Xcode or not; signing identity |
| 12 | How to follow upstream Codex; how much experimental API to support |
| 12 | hoocode daemon commands, launchd, socket path |
| 13 | Idle timeout; worker cap; delete vs archive |
| 14 | Linking surface accounts (pairing code?); always-allow syntax; WS token |
| 15 | Default bot; logs; adapter tests; where the menu-bar app lives |
| 17 | Daemon crash: how clients learn a turn was interrupted; restart policy |
| 17 | How policy in core surfaces approvals in the terminal UI vs the server |
| 18 | See T7 above |
