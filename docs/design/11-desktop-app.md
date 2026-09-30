# 11 — Desktop app (manager + tray host)

Status: **decided, revised 2026-09-30** (T2 → R8).
Change: there's no hub any more, so the UI is **split** between hoocode
and hoobot. One Swift menu-bar app shows both.

## Revised split

| UI | Served by | Shows |
|---|---|---|
| Thread + approval UI | **hoocode** (`127.0.0.1`, token) | Threads, live turns, approvals, profiles, grants, rules |
| Bot manager UI | **hoobot** (`127.0.0.1`) | Bots, surfaces, account linking, registry, adapter logs |
| Swift menu-bar app | its own small app | Status of both, links to open each UI, approval notifications |

The hoocode UI is useful even without hoobot.

_The first-pass notes below still hold where they don't mention the hub._

## Decisions

1. **Role: manager + tray host.** Not a chat window.
   - Install, configure, enable and disable bots and adapters.
   - Start, stop and watch the hub, and show its logs.
   - Show approval prompts on the desktop (Allow once / Deny).
   - Store tokens in the macOS Keychain.
2. **Toolkit: hub-served web UI + a small Swift menu-bar app.**
   C++/Qt dropped. Reason: macOS only, Bun already present, most code
   shared with the hub, browser zoom and VoiceOver work for free.
   - Web UI: served by the hub on `localhost`; plain HTML/TS, light theme,
     large readable text.
   - Swift tray: status icon, start/stop hub, open UI, native approval
     notifications with Allow once / Deny actions.
3. **Platforms: macOS only** for the foreseeable future.
4. **"PR process" means both:**
   - the app ships through GitHub Releases, built by CI from merged PRs;
   - bots are published by opening a PR to a **registry repo** that the
     app browses.

## Toolkit comparison

Machine constraints: macOS, no Homebrew/npm, Bun is present.
The user has low vision: **zoom, contrast and VoiceOver matter.**

| | C++ / Qt | Swift / SwiftUI | Tauri (Rust + webview) | Hub web UI + small tray |
|---|---|---|---|---|
| Platforms | mac, win, linux | **mac only** | mac, win, linux | any browser |
| Tray / menu bar | Yes | Yes, best (`MenuBarExtra`) | Yes | Needs a small native shim |
| Accessibility | OK; QML needs work | **Best** (native VoiceOver, Dynamic Type) | Good (browser a11y + zoom) | **Good** (browser zoom, reader) |
| Toolchain | Qt SDK (large) | Xcode | rustup + a web frontend | Bun only (already here) |
| Code shared with hub (TS) | None | None | UI can be TS | **Most** |
| Signing / notarization | Needed | Needed (easiest) | Needed | Only for the shim |
| Licensing | LGPL / commercial | — | MIT/Apache | — |
| Bundle size | ~40–80 MB | ~5 MB | ~10 MB | ~0 (plus shim) |

### Readings

- **Qt**: only worth it if Windows/Linux desktops are a real target *and*
  you want a single native codebase.
- **SwiftUI**: best mac experience and accessibility, but mac-only.
- **Tauri**: cross-platform with a web UI; adds a Rust toolchain.
- **Hub web UI + tray shim**: the hub already runs on Bun, so it serves
  `http://localhost` pages. A tiny native tray (Swift, ~200 lines)
  opens them and shows approval notifications. Fastest to build;
  the UI also works from a phone on the LAN later.

## Registry repo (sketch)

```
hoobot-registry/
  bots/
    reviewer.json     # name, package source (npm:/git:), version, sha
    helper.json
  adapters/
    slack.json
```

- A PR adds or bumps an entry. CI checks the schema, the package installs,
  and the manifest is valid.
- The app lists entries and installs through `hoocode install <source>`.
- Pinned version + hash so a merged entry can't change under you.

5. **Registry lists bots only.** Adapters ship inside hoobot.
6. **Personal registry:** only the owner merges.

## Still open

- How the web UI authenticates to the hub (local token? socket-only?).
  Revisit in T5.
- Swift tray without Xcode, or with it? Signing identity.
