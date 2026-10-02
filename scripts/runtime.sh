#!/bin/sh
# Run a hoobot instance out of this repo (design doc 19).
#
#   scripts/runtime.sh init <name> [env-file]   create runtime/<name> from a template
#   scripts/runtime.sh list                    the instances and whether they run
#   scripts/runtime.sh start   <name>          start (or restart) it in the background
#   scripts/runtime.sh stop    <name>          stop it
#   scripts/runtime.sh restart <name>          stop, then start
#   scripts/runtime.sh status  <name>          pid, uptime, /healthz
#   scripts/runtime.sh health  <name>          the health JSON
#   scripts/runtime.sh logs    <name> [n]      last n log lines (default 40)
#
# Each instance is a folder under runtime/: its own .env, log and pid. The
# bot runs from this working tree (`bun src/index.ts`), not from npm, so an
# edit is one `restart` away from the chat. Set RUN_FROM_NPM=1 to run the
# published build instead.
#
# runtime/ is gitignored: it holds tokens, logs and working folders, never code.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$REPO/runtime"
EXAMPLE="$REPO/.env.example"

die() { echo "runtime: $*" >&2; exit 1; }
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

# Bot env vars are cleared before each start, so an instance only ever sees
# its own .env — not the ones a parent shell (or another instance) exported.
clear_bot_env() {
  for v in DISCORD_TOKEN GUILD_ID SLACK_BOT_TOKEN SLACK_APP_TOKEN ALLOWED_USER_IDS \
    CHANNEL_IDS WORKSPACES HOO_WORKDIR APP_SERVER HOOCODE_BIN HOOCODE_ARGS MODEL \
    LINKS_FILE APPROVALS APPROVAL_TIMEOUT_MINUTES IDLE_TIMEOUT_MINUTES DEBUG \
    PEER_BOT_IDS PEER_TURNS HOO_INSTANCE HEALTH_PORT; do
    unset $v 2>/dev/null || true
  done
}

instance_dir() { [ -n "${1:-}" ] || die "which instance? try: scripts/runtime.sh list"; echo "$RUNTIME/$1"; }
pidfile() { echo "$1/$2.pid"; }
logfile() { echo "$1/$2.log"; }

# Set from the instance .env without running it: NAME=value lines only.
read_env() {
  env_value() {
    sed -n "s/^[[:space:]]*$2=\(.*\)/\1/p" "$1" | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/'
  }
  HEALTH_PORT="$(env_value "$1" HEALTH_PORT)"
  HOO_INSTANCE="${2:-$(basename "$1")}"
  [ -n "$HEALTH_PORT" ] || HEALTH_PORT=8787
}

alive() {
  pf="$(pidfile "$1" "$2")"
  [ -f "$pf" ] || return 1
  kill -0 "$(cat "$pf")" 2>/dev/null
}

do_init() {
  name="${1:-}"
  [ -n "$name" ] || die "usage: scripts/runtime.sh init <name> [env-file]"
  src="${2:-$EXAMPLE}"
  [ -f "$src" ] || die "no env file at $src"
  if [ -e "$RUNTIME/$name/.env" ]; then die "runtime/$name/.env already exists"; fi
  mkdir -p "$RUNTIME/$name"
  cp "$src" "$RUNTIME/$name/.env"
  chmod 600 "$RUNTIME/$name/.env"
  echo "created runtime/$name/.env from $src"
  echo "fill in the tokens, then: scripts/runtime.sh start $name"
}

do_start() {
  dir="$(instance_dir "${1:-}")"; name="$(basename "$dir")"
  [ -f "$dir/.env" ] || die "no runtime/$name/.env — run: scripts/runtime.sh init $name"
  if alive "$dir" "$name"; then do_stop "$name"; fi
  clear_bot_env
  read_env "$dir/.env" "$name"
  cd "$dir" # Bun loads ./.env from here: the instance's own config, nothing else
  if [ "${RUN_FROM_NPM:-0}" = "1" ]; then
    bun add -g @kolisachint/hoobot@latest @kolisachint/hoocode@latest >/dev/null 2>&1 ||
      echo "runtime: npm update failed; starting the installed version"
    cmd="hoobot"
  else
    cmd="bun $REPO/src/index.ts"
  fi
  HOO_INSTANCE="$name" HEALTH_PORT="$HEALTH_PORT" nohup $cmd >>"$(logfile "$dir" "$name")" 2>&1 &
  echo $! >"$(pidfile "$dir" "$name")"
  sleep 5
  if ! alive "$dir" "$name"; then
    echo "runtime: $name failed to start; last lines of $(logfile "$dir" "$name"):"
    tail -n 20 "$(logfile "$dir" "$name")" >&2
    exit 1
  fi
  echo "$name started: pid $(cat "$(pidfile "$dir" "$name")"), health port $HEALTH_PORT"
  do_status "$name"
}

do_stop() {
  dir="$(instance_dir "${1:-}")"; name="$(basename "$dir")"
  pf="$(pidfile "$dir" "$name")"
  if [ ! -f "$pf" ]; then
    echo "$name isn't running (no $pf)"
    # Same sweep as the old start.sh/stop.sh: a bot whose pidfile was lost.
    pkill -f "$REPO/src/index.ts" 2>/dev/null || true
    return 0
  fi
  pid="$(cat "$pf")"
  kill -CONT "$pid" 2>/dev/null || true   # a paused bot never sees SIGTERM
  kill -TERM "$pid" 2>/dev/null || true
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do i=$((i + 1)); sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  rm -f "$pf"
  echo "$name stopped (pid $pid)"
}

do_status() {
  dir="$(instance_dir "${1:-}")"; name="$(basename "$dir")"
  read_env "$dir/.env" "$name"
  if alive "$dir" "$name"; then
    pid="$(cat "$(pidfile "$dir" "$name")")"
    echo "$name: running (pid $pid)"
    curl -fsS --max-time 3 "http://127.0.0.1:$HEALTH_PORT/healthz" 2>/dev/null ||
      echo "health: no answer on port $HEALTH_PORT"
  else
    echo "$name: not running"
    return 1
  fi
}

do_health() {
  dir="$(instance_dir "${1:-}")"; name="$(basename "$dir")"
  read_env "$dir/.env" "$name"
  curl -fsS --max-time 3 "http://127.0.0.1:$HEALTH_PORT/api/bots"
  echo
}

do_list() {
  printf '%-14s %-9s %-7s %s\n' INSTANCE STATE HEALTH ENV
  for d in "$RUNTIME"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    [ -f "$d/.env" ] || continue
    read_env "$d/.env" "$name"
    if alive "$d" "$name"; then state=running; else state=stopped; fi
    printf '%-14s %-9s %-7s %s\n' "$name" "$state" "$HEALTH_PORT" "runtime/$name/.env"
  done
}

do_logs() {
  dir="$(instance_dir "${1:-}")"; name="$(basename "$dir")"
  tail -n "${2:-40}" "$(logfile "$dir" "$name")"
}

cmd="${1:-}"
[ $# -gt 0 ] && shift || true
case "$cmd" in
  init) do_init "${1:-}" "${2:-}" ;;
  start | stop | status | health | logs) do_"$cmd" "${1:-}" "${2:-}" ;;
  restart) do_stop "${1:-}"; do_start "${1:-}" ;;
  list | "") do_list ;;
  -h | --help | help) usage ;;
  *) die "unknown command '$cmd' (try: scripts/runtime.sh --help)" ;;
esac
