# 00 — Where we are today

## Shape

```
Discord ⇄ hoobot (Bun + discord.js) ⇄ hoocode --mode rpc
                                       (one process per thread)
```

About 800 lines of TypeScript in `src/`.

| File | Role |
|---|---|
| `src/rpc.ts` | Spawns `hoocode --mode rpc`, LF-framed JSON, id-correlated requests |
| `src/session.ts` | One `ThreadSession` per Discord thread; maps RPC events → messages, UI requests → buttons |
| `src/index.ts` | discord.js client, allowlist, `!commands` |
| `src/config.ts` | `.env` config; writes a project `hoo-config.json` with a `discord` mode |
| `src/format.ts` | Discord text formatting and splitting |

## Facts worth keeping

- **Protocol is hoocode-native, not JSON-RPC 2.0.**
  Commands have `type` + optional `id`; replies are `type: "response"`;
  everything else is a streamed event.
- **Approvals** arrive as `extension_ui_request` (select / confirm / input /
  editor) and are answered with `extension_ui_response`.
  Fire-and-forget UI (`notify`, `setStatus`, …) needs no answer.
- **Sessions** persist per thread in
  `workspace/.hoocode/discord-sessions/<threadId>/`, resumed with `--continue`.
- **Permissions** rely on a custom hoocode mode (`discord`) that only
  auto-allows `read`, because project config can only *add* to `auto_allow`.
- **Safety gate:** refuses to start with an empty `ALLOWED_USER_IDS`.
- **Coupling:** `session.ts` mixes hoocode-session logic with discord.js
  calls. This is the main blocker for a second surface.

## hoocode extension points already available

| Mechanism | What it is | Source |
|---|---|---|
| Extensions | TS modules: tools, commands, event hooks, `ctx.ui` | `docs/extensions.md` |
| Packages | Bundles of extensions/skills/prompts/themes via npm or git | `docs/packages.md` |
| Plugins | Marketplace-installed bundles; reads Claude Code + Copilot formats | `docs/plugins.md` |
| RPC mode | Headless JSON over stdio | `docs/rpc.md` |
| SDK | `AgentSession` in-process (Node/Bun only) | `docs/sdk.md` |

Paths are relative to the hoocode install's `docs/` folder.
