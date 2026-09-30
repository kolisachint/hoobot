#!/bin/sh
# Run hoo-discord-bot as a macOS background service (launchd).
#
#   scripts/service.sh install    start now + at every login, restart on crash
#   scripts/service.sh uninstall  stop and remove the service
#   scripts/service.sh restart    restart (e.g. after editing .env or code)
#   scripts/service.sh status     is it running?
#   scripts/service.sh logs       follow the log
set -eu

LABEL="com.hoo.discord-bot"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/hoo-discord-bot"
LOG="$LOG_DIR/bot.log"
DOMAIN="gui/$(id -u)"

BUN="$(command -v bun || true)"
NODE_DIR="$(dirname "$(command -v node || echo /usr/local/bin/node)")"

# launchd starts with a bare PATH. hoocode needs node (its shebang),
# bun, and its own helper binaries (rg, fd, embsearch) in ~/.hoocode/bin.
SERVICE_PATH="$NODE_DIR:$(dirname "${BUN:-/usr/local/bin/bun}"):$HOME/.hoocode/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

write_plist() {
  [ -n "$BUN" ] || { echo "bun not found on PATH"; exit 1; }
  [ -f "$REPO/.env" ] || { echo "Missing $REPO/.env (copy .env.example)"; exit 1; }
  mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$SERVICE_PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
}

is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

case "${1:-}" in
  install)
    write_plist
    is_loaded && launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed and started."
    echo "  Service: $PLIST"
    echo "  Log:     $LOG"
    ;;
  uninstall)
    is_loaded && launchctl bootout "$DOMAIN/$LABEL" || true
    rm -f "$PLIST"
    echo "Stopped and removed. (Log kept at $LOG)"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Restarted."
    ;;
  status)
    if is_loaded; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*(state|pid|last exit code) =" | sed 's/^\s*/  /'
    else
      echo "  not installed"
    fi
    ;;
  logs)
    tail -n 50 -f "$LOG"
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
