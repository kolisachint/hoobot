# 18 — Current step: hoobot on Rust hoocode, MIT only

Status: **decided 2026-10-01, design and plan only.** Nothing built yet.
B+ ([17](17-architecture-review.md)) stays the target. This doc says what we
do first, and what changes in the B+ plan now that hoocode is Rust.

## Decisions

1. **hoocode means the Rust build.** TypeScript hoocode (`hoocode-ts`) is
   ignored from here on: not a target, not a reference.
2. **hoobot keeps talking `hoocode --mode rpc`**, one process per Discord
   thread, as today ([00](00-context.md)). The Rust RPC mode already matches
   the commands and flags hoobot uses (`prompt`, `steer`, `follow_up`,
   `abort`, `new_session`, `get_state`, `set_model`, `--session-dir`,
   `--continue`).
3. **One blocker, fixed in hoocode first:** Rust RPC mode never asks for
   approval, so the `discord` mode's "ask before bash/edit/write" doesn't
   hold. Plan: hoocode `docs/design/rpc-approvals.md`. It uses the
   `extension_ui_request` / `extension_ui_response` format hoobot already
   handles, so hoobot shouldn't need changes. No interim workaround: we wait
   for the fix.
4. **MIT only**, in hoocode and hoobot:
   - nothing copied from `../codex` (Apache-2.0): no code, no JSON schemas,
     no generated TS types;
   - hoocode's Codex protocol types will be our own crate,
     `cortexcode-app-server-protocol`, written by us;
   - Codex schemas may be fetched at test time into a build folder to check
     our messages, never checked in;
   - running the real `codex app-server` in tests (R17) is fine.
5. **Waiting:** the app-server (L3, L4), profiles and policy (L2), Slack,
   GitHub and the UIs. Build order R13 is unchanged once we resume.

## What changes in the B+ docs when we resume

| Doc | Today says | Becomes |
|---|---|---|
| [12](12-protocol.md) §4 | Copy Codex TS types + schemas, keep its notice; server in TS | Own MIT crate `cortexcode-app-server-protocol`; server in Rust; Codex schemas only at test time |
| [12](12-protocol.md) "What `../codex` gives us" | Copy in / reference | Reference only; nothing copied |
| [15](15-scope-roadmap.md) Phase 1 | "Copy in the Codex protocol types" | Write the protocol crate |
| [17](17-architecture-review.md) workers | ~14 `process.cwd()` fallbacks (TS) | Rust has 15 `current_dir()` calls in 8 crates; the reason still holds |

## Plan

1. hoocode: RPC approval dialogs (see the hoocode doc).
2. hoobot on Rust hoocode, checked by hand on Discord: start a thread,
   continue, steer while busy, `!stop`, `!new`, `!model`, approve, deny,
   approval timeout, bot restart resumes the thread.
   Fix in hoobot only what that check turns up.
3. hoobot: add an MIT `LICENSE` (there is none today).

## Open questions (for when B+ resumes)

- Do stock Codex clients stay a goal? That sets how much of the protocol
  the crate covers (about 20 methods for hoobot alone, far more for the
  Codex CLI and IDE).
- May we read Codex's Rust source for behaviour, or only its docs and
  recorded messages?
- Does "MIT only" cover dependencies? Most Rust crates are "MIT OR
  Apache-2.0", which we can take as MIT; a few may be Apache-only.
- Does hoobot stay TypeScript on Bun, or move to Rust and use the protocol
  crate directly?
