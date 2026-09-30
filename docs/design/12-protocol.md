# 12 — Protocol and server

Status: **decided, revised 2026-09-30** (T3 → R1, R3, R9, R11, R16, R17).
Checked against the other options in
[17-architecture-review.md](17-architecture-review.md), which chose **B+**.
The first version put a hub, `hoobotd`, between clients and hoocode.
That is gone: **hoocode is the server.** See [16-roles.md](16-roles.md).

## Decisions

1. **`hoocode app-server` is a full server**, modelled on Codex's
   `codex app-server`:
   - long-running daemon;
   - many threads, many clients at once;
   - events go to every client subscribed to a thread;
   - approvals go to every subscribed client, and the first answer wins.
2. **Protocol: Codex app-server protocol, as-is.** Stock Codex clients
   (CLI, IDE extension) are a real goal.
3. **Transports** (same set as Codex):
   - stdio, for one client and for tests;
   - Unix socket, mode 0600, for hoobot, the menu-bar app and the Codex CLI;
   - WebSocket on `127.0.0.1` with a token, for web UIs.
4. **Using `../codex`:** copy in the **protocol only**.
   - Copy the generated TypeScript types and JSON schemas from
     `codex-rs/app-server-protocol/schema/`.
   - Pin them to a Codex commit, recorded in a `CODEX_PROTOCOL_COMMIT` file.
   - Write the server itself in TypeScript inside hoocode.
   - Treat the Rust `codex-rs/app-server` as a reference for behaviour.
   - Codex is Apache-2.0: keep its notice with the copied files.
5. **Dialogs** (pick-an-option, type-an-answer) use Codex's
   `item/tool/requestUserInput` (experimental). Only the editor dialog
   needs a `hoocode/*` fallback.
6. **Who may connect:** any process running as your user is the owner.
   The socket's file permissions are the authentication.
7. **Extensions** live in a `hoocode/*` namespace, for profiles and policy.
   There are **no `hoobot/*` methods** on the server.
8. **Two layers in hoocode (R16):**
   - **L3, app-server:** the Codex protocol over stdio, one client per process.
   - **L4, daemon:** socket, WebSocket, fan-out, approval routing and the
     supervisor. Each daemon worker is an L3 process, so the daemon only
     relays messages and supervises.
9. **hoobot sticks to the standard Codex protocol (R17).** Its only
   addition is an optional profile id on `thread/start`. hoobot's tests
   also run against the real `codex app-server`.

## What `../codex` gives us

Checked in the local clone (`bcd6d9ab6`, 2026-09-30):

| Piece | Where | Use |
|---|---|---|
| TS types (~640 v2 files) | `app-server-protocol/schema/typescript/` | Copy in, pinned |
| JSON schemas | `app-server-protocol/schema/json/` | Conformance tests |
| Server behaviour | `app-server/src/` | Reference (thread state, fan-out) |
| Unix socket + WS | `app-server-transport/src/transport/` | Reference (socket guarding) |
| Daemon lifecycle | `app-server-daemon/` | Reference (start / stop / version as JSON) |
| Test client | `app-server-test-client/` | Drive hoocode's server in tests |

Things found while reading the code:

- **Fan-out is native.** Codex already tracks which connections are
  subscribed to each thread (`thread_state.rs`) and sends server requests
  to all of them. This is what we need for "approve from any surface".
- **Dialogs are covered.** `ToolRequestUserInputQuestion` has options,
  `isOther` (free text) and `isSecret`.
- **Thread methods:** `thread/start`, `resume`, `fork`, `list`, `read`,
  `archive`, `delete`, `unsubscribe`, `name/set`, `metadata/update`,
  `turn/start`, `turn/steer`, `turn/interrupt` and more.
- **Server requests:** command approval, file-change approval,
  permissions approval, `item/tool/requestUserInput`,
  MCP elicitation, and dynamic tool calls.
- **Permission profiles** already exist in Codex (`[permissions.<id>]`,
  with `extends`). hoocode profiles should line up with them where possible.

## Mapping hoocode onto Codex

| hoocode today | Codex protocol |
|---|---|
| Session (JSONL) | Thread; the JSONL stays the source of truth |
| `prompt` | `turn/start` |
| `steer` / `follow_up` | `turn/steer` |
| `abort` | `turn/interrupt` |
| Tool confirm (`extension_ui_request` confirm) | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` |
| select / input dialogs | `item/tool/requestUserInput` |
| editor dialog | `hoocode/*` extension |
| Streaming text / tool events | `item/*` notifications |

## Wire notes (from pi-codex-app-server and Codex)

- Codex leaves out `"jsonrpc":"2.0"` on the wire.
- Cancelling uses `turn/interrupt`, not `$/cancelRequest`.
- Methods with no hoocode equivalent return **schema-valid neutral
  results**, never "method not found".
- Unlike pi-codex-app-server, **approval settings are really enforced**.

## Still open

- How to follow upstream: bump the pinned commit by hand, or with a script
  plus a schema diff report?
- How much of the experimental API to support (`experimentalApi` opt-in).
- Daemon lifecycle commands (`hoocode app-server daemon start|stop|status`?)
  and the launchd plist.
- Socket path: under `~/.local/state/hoocode/`, to follow the XDG layout.
