# 13 — Sessions, workspaces, processes

Status: **decided, revised 2026-09-30** (T4 → R6, R10).
Change: all of this now lives **in hoocode's server**, not in a hoobot hub.

## Decisions

1. **Threads belong to hoocode's server.** Any client can list and open
   any thread (`thread/list`, `thread/resume`).
   Start a thread on Discord, then continue in the web UI or the Codex CLI.
2. **Workspaces:** each profile has a default folder. A thread may pick a
   project folder from the profile's **allowlist**. hoocode rejects any
   other path.
3. **Processes:** `hoocode app-server` is a thin supervisor. It runs one
   **worker process per (profile, workspace)**, and each worker hosts many
   threads. A crash only affects that pair.
4. **Idle unload:** threads unload after N minutes idle, and a worker exits
   when it has no threads loaded. Threads resume from their JSONL file.
5. **The link between surface threads and hoocode threads lives in hoobot**,
   in its own small store. hoocode never learns about Discord.

## Picture

```
hoocode app-server   (socket · ws · fan-out · approvals · policy)
 ├─ worker: reviewer @ ~/github/hoobot   → threads t1, t4
 ├─ worker: reviewer @ ~/github/other    → thread  t2
 └─ worker: helper   @ <helper's folder> → thread  t3
```

## hoobot's link store

```jsonc
// ~/.local/share/hoobot/links.json (or SQLite)
{
  "discord:1234567890": { "threadId": "t1", "botId": "reviewer" },
  "slack:C01/1700000000.1234": { "threadId": "t1", "botId": "reviewer" }
}
```

- Two surface threads can point to the same hoocode thread.
- hoobot tells hoocode who spoke with a short label in the message text,
  for example `[discord: sachin]`. hoocode stores it as ordinary text.

## Rules when several clients show one thread (enforced by hoocode)

- **One turn at a time.** A message sent during a run becomes
  `turn/steer`, whichever client sent it.
- **Events go to every subscribed client.** Each client decides how much
  to show. Discord shows a summary plus the final text; the web UI shows
  the full stream.
- **Approvals go to every subscribed client.** The first answer wins, and
  the others see it resolved.
- **Session files are stored by hoocode**, for example under
  `~/.local/share/hoocode/sessions/<profile>/<threadId>.jsonl`, not inside
  the workspace.

## Migration

The old `workspace/.hoocode/discord-sessions/<id>` folders are imported
into hoocode as threads of the default profile. hoobot then writes a
`discord:<id>` link for each one.

## Still open

- Default idle timeout (today: 30 min).
- Maximum number of workers.
- Delete vs archive (Codex `thread/delete` removes the file).
