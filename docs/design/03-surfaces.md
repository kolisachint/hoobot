# 03 — Candidate surfaces

Status: **draft**. Constraint for now: everything runs on **one PC**.

"Outbound" means the surface connects out from this Mac —
no open ports or tunnels needed.

| Group | Surface | Connection | Notes |
|---|---|---|---|
| Chat | Discord | Outbound gateway | **Done** |
| Chat | Slack | Outbound (Socket Mode) | |
| Chat | Telegram | Outbound (long polling) | Very easy bot API |
| Chat | Matrix | Outbound | Self-hostable, E2EE optional |
| Chat | Mattermost | Outbound (websocket) | |
| Chat | Microsoft Teams | Needs inbound / Azure | Hardest |
| Personal | iMessage | Local (macOS only) | Fragile, unofficial |
| Personal | Signal | Local (`signal-cli`) | Unofficial |
| Personal | WhatsApp | Unofficial libs | Against ToS, ban risk |
| Dev | GitHub PR / issue comments | Polling or `gh`; webhooks need inbound | |
| Dev | GitHub Actions | Runs in CI, not on this PC | Different trust model |
| Dev | Gitea | Webhooks / polling | |
| Local | Qt tray / menu-bar app | Local socket | Also the manager UI? |
| Local | Localhost web UI | Local HTTP | |
| Local | Raycast / Alfred | Local | |
| Local | macOS Shortcuts / Siri | Local | |
| Local | CLI client | Local socket | |
| Editor | VS Code | Extension | |
| Editor | Neovim / Zed | ACP | |
| Automation | Cron / scheduled | Local | |
| Automation | Email (IMAP) | Outbound | |
| Automation | File watcher | Local | |
| Automation | Home Assistant | Local network | |

Priority order: **Discord (done) → Slack → GitHub**, plus the web UI
and the Swift tray. See [15-scope-roadmap.md](15-scope-roadmap.md).
