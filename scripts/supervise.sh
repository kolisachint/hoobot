#!/bin/sh
# Keep the bot manager and every supervised bot running in the background
# (macOS launchd), checking health rather than only "is the pid alive".
#
#   scripts/supervise.sh start [name...]  install the agent, start it, start
#                                        the named bots (default: all) and
#                                        mark them supervised
#   scripts/supervise.sh stop  [name...]  unmark and stop the named bots
#                                        (default: all) and stop the agent,
#                                        which takes the manager with it
#   scripts/supervise.sh restart           the agent (so the manager) and
#                                        every supervised bot, in place
#   scripts/supervise.sh status             what is running and how healthy
#   scripts/supervise.sh logs [n]           the supervisor's own log
#   scripts/supervise.sh uninstall          stop everything and remove the agent
#
# ## Where the pieces live
#
# This script is the code, so it lives in the repo and ships with the npm
# package like `runtime.sh`. The machine-specific parts are generated, never
# committed: the agent in `~/Library/LaunchAgents/`, and one marker file per
# bot in its runtime folder. Editing the repo is how you change behaviour;
# re-running `install`/`start` is how you change the machine.
#
# ## Why a marker file
#
# The manager's UI has a Stop button, and a supervisor that restarts
# everything would quietly undo it. So `start <name>` writes
# `<runtime>/<name>/supervised` and `stop <name>` removes it: the marker is
# the record of an *intent* to keep a bot up, which no pidfile can be. A bot
# you stopped from the browser comes back only after you run
# `scripts/supervise.sh start <name>`.
#
# ## What it does on a loop (default every 30s)
#
# - manager: `/api/manager` must answer; otherwise restart it.
# - bot: its pid must be live *and* its own `/healthz` must say `ok`, for
#   `FAILS` consecutive checks, before it is restarted. A bot whose Slack
#   socket dropped is not a crashed bot, so one bad check never restarts
#   anything, and `COOLDOWN` spaces out repeated attempts at a bot that
#   cannot start (a bad token, say) instead of thrashing it.
#
# launchd's `KeepAlive` covers the one process it owns — this loop — and
# `caffeinate -i` (design doc 21) holds idle sleep for as long as the loop
# runs, so Slack is not talking to a socket on a sleeping Mac. Bots started
# by `runtime.sh` are wrapped in their own `caffeinate -i` already.
set -eu

LABEL="com.hoobot.supervisor"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="${HOOBOT_RUNTIME_DIR:-$HOME/.hoobot/runtime}"
# The published build is what runs in Slack (AGENTS.md); set
# RUN_FROM_NPM=0 to supervise this working tree instead.
RUN_FROM_NPM="${RUN_FROM_NPM:-1}"
INTERVAL="${HOOBOT_INTERVAL:-30}"        # seconds between checks
FAILS="${HOOBOT_FAILS:-2}"               # unhealthy checks before a restart
COOLDOWN="${HOOBOT_COOLDOWN:-120}"       # seconds between attempts at one bot
MANAGER_PORT="${MANAGER_PORT:-8790}"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
STATE="$RUNTIME/manager"                 # a reserved folder, never an instance
LOG="$STATE/supervisor.log"
MANAGER_LOG="$STATE/manager.log"
# Folders under the runtime dir that are not bots (src/instances.ts RESERVED).
RESERVED="shared manager workspace node_modules logs slack"

HOOBOT_BIN="$(command -v hoobot || true)"
BUN="$(command -v bun || true)"
NODE_DIR="$(dirname "$(command -v node || echo /usr/local/bin/node)")"
SERVICE_PATH="$REPO:$NODE_DIR:$(dirname "${BUN:-/usr/local/bin/bun}"):$HOME/.local/share/bun/bin:$HOME/.hoocode/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

now() { date +%s; }
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
say_log() { say "$*" >>"$LOG"; }
die() { echo "supervise: $*" >&2; exit 1; }

# NAME=value from an instance .env without running it (same rules as
# runtime.sh): NAME=value lines only, quotes stripped, last value wins.
env_value() {
  sed -n "s/^[[:space:]]*$2=\(.*\)/\1/p" "$1" | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/'
}

health_port() {
  port="$(env_value "$RUNTIME/$1/.env" HEALTH_PORT)"
  [ -n "$port" ] || port=8787
  echo "$port"
}

is_instance() {
  [ -f "$RUNTIME/$1/.env" ] || return 1
  for r in $RESERVED; do [ "$1" = "$r" ] && return 1; done
  return 0
}

# Every instance name, or just the ones named on the command line.
targets() {
  if [ $# -gt 0 ]; then
    for n in "$@"; do is_instance "$n" || die "no instance '$n' (try: scripts/supervise.sh status)"; echo "$n"; done
    return
  fi
  for d in "$RUNTIME"/*; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"
    is_instance "$n" && echo "$n"
  done
}

alive() {
  pf="$RUNTIME/$1/$1.pid"
  [ -f "$pf" ] || return 1
  kill -0 "$(cat "$pf")" 2>/dev/null
}

# A bot is healthy when its own /healthz answers and reports ok:true. The
# endpoint always returns 200, so the body is the signal, not the status.
bot_healthy() {
  body="$(curl -fsS --max-time 5 "http://127.0.0.1:$(health_port "$1")/healthz" 2>/dev/null)" || return 1
  case "$body" in *'"ok":true'*) return 0 ;; *) return 1 ;; esac
}

manager_healthy() {
  curl -fsS --max-time 5 "http://127.0.0.1:$MANAGER_PORT/api/manager" >/dev/null 2>&1
}

runtime_cmd() {
  HOOBOT_RUNTIME_DIR="$RUNTIME" RUN_FROM_NPM="$RUN_FROM_NPM" \
    sh "$REPO/scripts/runtime.sh" "$@"
}

# ---------------------------------------------------------------- the loop

MANAGER_PID=""

start_manager() {
  [ -n "$HOOBOT_BIN" ] || die "hoobot not on PATH (bun add -g @kolisachint/hoobot@latest)"
  mkdir -p "$STATE"
  HOOBOT_RUNTIME_DIR="$RUNTIME" RUN_FROM_NPM="$RUN_FROM_NPM" \
    "$HOOBOT_BIN" manager >>"$MANAGER_LOG" 2>&1 &
  MANAGER_PID=$!
  echo "$MANAGER_PID" >"$STATE/manager.pid"
  say_log "manager started (pid $MANAGER_PID, port $MANAGER_PORT)"
}

stop_manager() {
  [ -n "$MANAGER_PID" ] || return 0
  kill -0 "$MANAGER_PID" 2>/dev/null || return 0
  kill -TERM "$MANAGER_PID" 2>/dev/null || true
  i=0
  while kill -0 "$MANAGER_PID" 2>/dev/null && [ "$i" -lt 20 ]; do i=$((i + 1)); sleep 0.5; done
  kill -0 "$MANAGER_PID" 2>/dev/null && kill -KILL "$MANAGER_PID" 2>/dev/null || true
  say_log "manager stopped (pid $MANAGER_PID)"
  MANAGER_PID=""
  rm -f "$STATE/manager.pid"
}

check_manager() {
  if [ -z "$MANAGER_PID" ] || ! kill -0 "$MANAGER_PID" 2>/dev/null; then
    say_log "manager is not running; starting it"
    start_manager
    return
  fi
  manager_healthy && return
  # Alive but not answering: the UI is the thing that has gone quiet, and a
  # restart is the only way back.
  say_log "manager (pid $MANAGER_PID) isn't answering on $MANAGER_PORT; restarting it"
  stop_manager
  start_manager
}

# $1 instance name. $2 the action to take when it is not healthy.
check_bot() {
  name="$1"
  if alive "$name" && bot_healthy "$name"; then
    echo 0 >"$STATE/$name.fails"
    return 0
  fi
  if ! alive "$name"; then
    say_log "$name is not running"
    action=start
  else
    fails=$(( $(cat "$STATE/$name.fails" 2>/dev/null || echo 0) + 1 ))
    echo "$fails" >"$STATE/$name.fails"
    say_log "$name is unhealthy (check $fails/$FAILS)"
    [ "$fails" -ge "$FAILS" ] || return 0
    echo 0 >"$STATE/$name.fails"
    action=restart
  fi
  # Space out attempts: a bot that cannot start (bad token, port taken) must
  # not be relaunched every 30 seconds for the rest of the afternoon.
  last="$(cat "$STATE/$name.last" 2>/dev/null || echo 0)"
  if [ "$(( $(now) - last ))" -lt "$COOLDOWN" ]; then
    say_log "$name: skipping $action, inside the ${COOLDOWN}s cooldown"
    return 0
  fi
  now >"$STATE/$name.last"
  say_log "$name: $action"
  if runtime_cmd "$action" "$name" >>"$LOG" 2>&1; then
    say_log "$name is up (pid $(cat "$RUNTIME/$name/$name.pid" 2>/dev/null || echo '?'))"
  else
    say_log "$name did not come up; see the lines above and: scripts/runtime.sh logs $name"
  fi
}

check_bots() {
  mkdir -p "$STATE"
  for d in "$RUNTIME"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    is_instance "$name" || continue
    # The marker is the intent to keep it up; without one it is the user's
    # to start and stop (from the manager, or by hand).
    [ -f "$RUNTIME/$name/supervised" ] || continue
    check_bot "$name"
  done
}

do_run() {
  mkdir -p "$STATE"
  trap 'say_log "supervisor stopping"; stop_manager; exit 0' TERM INT
  say_log "supervisor up: runtime $RUNTIME, every ${INTERVAL}s, RUN_FROM_NPM=$RUN_FROM_NPM"
  start_manager
  while :; do
    # `sleep & wait` so a TERM from launchctl is handled at once instead of
    # after the interval — `stop` should stop, not queue.
    sleep "$INTERVAL" &
    wait $! 2>/dev/null || true
    check_manager
    check_bots
  done
}

# ------------------------------------------------------------- the agent

write_plist() {
  [ -f "$REPO/scripts/runtime.sh" ] || die "missing $REPO/scripts/runtime.sh"
  case "$(uname -s)" in Darwin) ;; *) die "launchd supervision is macOS only" ;; esac
  # caffeinate -i execs the loop, so the assertion is held exactly as long as
  # the supervisor runs and can never outlive it (design doc 21).
  WRAP="<string>caffeinate</string><string>-i</string>"
  command -v caffeinate >/dev/null 2>&1 || WRAP=""
  mkdir -p "$(dirname "$PLIST")" "$STATE"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>$WRAP
    <string>/bin/sh</string>
    <string>$REPO/scripts/supervise.sh</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$SERVICE_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>HOOBOT_RUNTIME_DIR</key><string>$RUNTIME</string>
    <key>RUN_FROM_NPM</key><string>$RUN_FROM_NPM</string>
    <key>MANAGER_PORT</key><string>$MANAGER_PORT</string>
  </dict>
  <!-- Start at login, and restart the loop if it ever exits non-zero. The
       loop exits 0 on TERM, so stop really stops. -->
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

load_agent() {
  write_plist
  if is_loaded; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout only *signals* the job: launchd keeps the label registered for
    # a moment afterwards, and bootstrapping into that window fails with
    # "Bootstrap failed: 5: Input/output error". Wait for the label to go.
    i=0
    while is_loaded && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.2; done
    is_loaded && die "$LABEL is still loaded; try: launchctl bootout $DOMAIN/$LABEL"
  fi
  # Same EIO can come from launchd still settling, so one retry is cheap.
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null ||
    launchctl bootstrap "$DOMAIN" "$PLIST" ||
    die "launchd refused $PLIST"
  is_loaded || die "launchd accepted $PLIST but did not load $LABEL"
}

# A manager started by hand (a terminal, a previous session) would hold the
# port the supervised one needs, so the supervised manager replaces it.
kill_stray_managers() {
  for pid in $(pgrep -f "hoobot manager" 2>/dev/null || true); do
    say "stopping the manager already running as pid $pid"
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
}

# ---------------------------------------------------------------- commands

do_start() {
  mkdir -p "$RUNTIME" "$STATE"
  kill_stray_managers
  load_agent
  say "agent $LABEL installed: $PLIST"
  # The agent owns the manager; give it a moment to answer before reporting.
  i=0
  while [ "$i" -lt 20 ]; do
    manager_healthy && break
    i=$((i + 1)); sleep 1
  done
  if manager_healthy; then
    say "manager up: http://127.0.0.1:$MANAGER_PORT"
  else
    say "manager did not answer on $MANAGER_PORT yet; it keeps retrying. Log: $LOG"
  fi
  for name in $(targets "$@"); do
    touch "$RUNTIME/$name/supervised"
    if alive "$name" && bot_healthy "$name"; then
      say "$name already running and healthy (pid $(cat "$RUNTIME/$name/$name.pid")) — left alone"
      continue
    fi
    if runtime_cmd start "$name" >/dev/null 2>&1; then
      say "$name started (port $(health_port "$name"))"
    else
      say "$name failed to start — scripts/runtime.sh logs $name"
    fi
  done
  do_status
}

do_stop() {
  for name in $(targets "$@"); do
    # Unmark first: the marker is what the loop watches, so a bot stopped
    # here stays stopped across restarts and logins.
    rm -f "$RUNTIME/$name/supervised" "$STATE/$name.fails" "$STATE/$name.last"
    runtime_cmd stop "$name" 2>&1 | sed 's/^/  /' || true
  done
  if [ $# -eq 0 ]; then
    if is_loaded; then
      launchctl bootout "$DOMAIN/$LABEL"
      say "agent $LABEL stopped"
    else
      say "agent $LABEL wasn't running"
    fi
    # bootout SIGTERMs the loop, which stops the manager it owns.
    sleep 2
    for pid in $(pgrep -f "hoobot manager" 2>/dev/null || true); do kill -TERM "$pid" 2>/dev/null || true; done
  fi
}

do_restart() {
  if is_loaded; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
    say "agent $LABEL restarted (the manager is back in a few seconds)"
  else
    say "agent $LABEL isn't installed; run: scripts/supervise.sh start"
    return 1
  fi
  for name in $(targets); do
    [ -f "$RUNTIME/$name/supervised" ] || continue
    runtime_cmd restart "$name" >/dev/null 2>&1 || say "$name failed to restart"
    say "$name restarted (port $(health_port "$name"))"
  done
  do_status
}

do_status() {
  if is_loaded; then
    say "agent $LABEL loaded (at login, restart on crash), log $LOG"
  else
    say "agent $LABEL not installed — scripts/supervise.sh start"
  fi
  if manager_healthy; then
    say "manager: up on http://127.0.0.1:$MANAGER_PORT (pid $(cat "$STATE/manager.pid" 2>/dev/null || echo '?'))"
  else
    say "manager: DOWN on port $MANAGER_PORT"
  fi
  printf '%-12s %-8s %-8s %-9s %s\n' BOT SUPERVISED STATE HEALTH PORT
  for name in $(targets); do
    supervised=no
    [ -f "$RUNTIME/$name/supervised" ] && supervised=yes
    if alive "$name"; then state="up($(cat "$RUNTIME/$name/$name.pid"))"; else state=down; fi
    if bot_healthy "$name"; then health=ok; else health="no-answer"; fi
    printf '%-12s %-8s %-8s %-9s %s\n' "$name" "$supervised" "$state" "$health" "$(health_port "$name")"
  done
  if [ "$(uname -s)" = Darwin ]; then
    say "power: $(pmset -g assertions 2>/dev/null | grep -c 'caffeinate' || true) caffeinate assertion(s) held"
  fi
  return 0
}

do_logs() { tail -n "${1:-40}" "$LOG" 2>/dev/null || echo "no log yet at $LOG"; }

do_uninstall() {
  do_stop
  rm -f "$PLIST"
  say "removed $PLIST (log kept at $LOG)"
}

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  run) [ $# -gt 1 ] && shift || true; do_run ;;
  start) shift || true; do_start "$@" ;;
  stop) shift || true; do_stop "$@" ;;
  restart) do_restart ;;
  status) do_status ;;
  logs) do_logs "${2:-40}" ;;
  uninstall) do_uninstall ;;
  install) write_plist; say "wrote $PLIST (start it with: scripts/supervise.sh start)" ;;
  -h | --help | help | "") usage ;;
  *) usage; die "unknown command '$1'" ;;
esac
