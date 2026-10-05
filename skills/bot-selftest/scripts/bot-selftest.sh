#!/usr/bin/env bash
# End-to-end check for one hoobot instance. Exit 0 = healthy.
#
#   bot-selftest.sh [name] [more names...]
#
# Catches the failures that are otherwise invisible until someone says
# "the bot's broken": wrong runtime folder, dead token, bot never invited,
# companion not wired back, port taken by someone else, bot running from a
# checkout instead of the published build.
#
# Both chats are checked, and only the ones the bot has tokens for: a Slack
# bot is not asked about Discord. A Discord id and a Slack member id share one
# `PEER_BOT_IDS` list, so each surface checks the peers *it* can answer — a
# `U…` id asked of Discord comes back 400 and reads like a broken wiring.
set -uo pipefail

RUNTIME="${HOOBOT_RUNTIME_DIR:-$HOME/.hoobot/runtime}"
MANAGER="${HOOBOT_MANAGER:-http://127.0.0.1:8790}"
EXPECTED_NPM_GLOBAL="${EXPECTED_NPM_GLOBAL:-1}"
fails=0
names=("$@")
[ ${#names[@]} -eq 0 ] && names=("$HOO_INSTANCE")
[ -z "${names[0]:-}" ] && { echo "usage: bot-selftest.sh <name> [...]"; exit 2; }

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails+1)); }
warn() { printf '  \033[33mnote\033[0m %s\n' "$1"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

for name in "${names[@]}"; do
  section "$name"
  dir="$RUNTIME/$name"
  env_file="$dir/.env"

  # 1. folder + env, in the directory the manager actually reads
  [ -f "$env_file" ] || { fail "no .env at $env_file (wrong runtime dir? HOOBOT_RUNTIME_DIR=$RUNTIME)"; continue; }
  pass ".env present"
  if ! curl -sf "$MANAGER/api/manager" >/dev/null 2>&1; then
    warn "manager not answering on $MANAGER — skipping the manager checks"
  else
    curl -sf "$MANAGER/api/manager" | python3 -c '
import json,sys
d=json.load(sys.stdin)
names={i["name"]: i for i in d["instances"]}
n=sys.argv[1]
i=names.get(n)
print("  \033[32mok\033[0m   manager lists it" if i else "  \033[31mFAIL\033[0m manager does not list it")
if i:
    if i["surfaces"]: print("  \033[32mok\033[0m   surfaces:", ",".join(i["surfaces"]))
    else: print("  \033[33mnote\033[0m no surfaces yet (no tokens, or HOO_SURFACES unset)")
    if not i["running"]: print("  \033[33mnote\033[0m not running")
' "$name"
  fi

  # 2. required config
  get() { sed -n "s/^[[:space:]]*$1=\(.*\)/\1/p" "$env_file" | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'; }
  ALLOWED_USER_IDS="$(get ALLOWED_USER_IDS)"
  [ -n "$ALLOWED_USER_IDS" ] && pass "ALLOWED_USER_IDS set" || fail "ALLOWED_USER_IDS empty — the bot refuses to start without it"

  # 3. process
  pidfile="$dir/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    pass "running (pid $(cat "$pidfile"))"
    cmd="$(ps -p "$(cat "$pidfile")" -o command= 2>/dev/null)"
    if [ "$EXPECTED_NPM_GLOBAL" = "1" ]; then
      # `bun ~/.local/share/bun/bin/hoobot` is a symlink into the global
      # install, so resolve it before judging: the real path is what ran.
      bin="$(printf '%s' "$cmd" | awk '{print $NF}')"
      real="$(readlink -f "$bin" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$bin" 2>/dev/null)"
      case "$real" in
        *node_modules/@kolisachint/hoobot/src/*) pass "running the published build" ;;
        *) fail "not the published build: ${real:-$cmd}" ;;
      esac
    fi
  else
    warn "not running (no live pid) — start it from the manager to test live"
  fi

  # 4. slack token
  bot="$(get SLACK_BOT_TOKEN)"
  app="$(get SLACK_APP_TOKEN)"
  if [ -z "$bot" ] || [ -z "$app" ]; then
    warn "no Slack tokens yet"
  else
    case "$bot" in xoxb-*) ;; *) fail "SLACK_BOT_TOKEN should start with xoxb-, got ${bot:0:8}…";; esac
    case "$app" in xapp-*) ;; *) fail "SLACK_APP_TOKEN should start with xapp-, got ${app:0:8}…";; esac
    auth="$(curl -s --max-time 10 -H "Authorization: Bearer $bot" https://slack.com/api/auth.test)"
    ok="$(printf '%s' "$auth" | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(d["user_id"] if d.get("ok") else "!"+str(d.get("error")))' 2>/dev/null)"
    case "$ok" in
      '!'*) case "${ok#!}" in
             account_inactive|token_revoked|invalid_auth)
               fail "Slack token dead: ${ok#!} — the app was uninstalled or the token reset. Only the user can mint a new one (see slack-bot-create)." ;;
             *) fail "auth.test: ${ok#!}" ;;
           esac ;;
      *)   pass "token live, bot user id ${ok}"
           # 5. invited somewhere?
           convs="$(curl -s --max-time 10 -H "Authorization: Bearer $bot" "https://slack.com/api/users.conversations?user=${ok}&limit=100" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("channels") or []))' 2>/dev/null)"
           [ "${convs:-0}" -gt 0 ] && pass "in ${convs} conversation(s)" || fail "in no conversations — /invite @${name} in a channel" ;;
    esac

    # 6. companions wired both ways
    # Slack peers only. PEER_BOT_IDS is one list shared by both chats, and a
    # Discord id looked up on Slack is not a dead token — it is simply the
    # wrong chat's id, reported as "cannot verify it" and sending you off to
    # re-auth a perfectly good token. The Discord branch below filters the
    # same way; this filters the other half.
    peers="$(get PEER_BOT_IDS | tr ',' '\n' | grep -E '^U' | tr '\n' ' ')"
    if [ -z "$peers" ]; then
      speers="$(get PEER_BOT_IDS | tr ',' ' ')"
      if [ -z "$speers" ]; then
        warn "PEER_BOT_IDS empty — this bot ignores every other bot"
      else
        warn "PEER_BOT_IDS lists no Slack peer on this bot (only Discord ids)"
      fi
    else
      for pid in $peers; do
        # users.info needs a token; with a dead one every lookup fails, which
        # looks like "not a bot" and sends you fixing the wrong thing.
        info="$(curl -s --max-time 10 -H "Authorization: Bearer $bot" "https://slack.com/api/users.info?user=${pid}")"
        read -r pok pname pbot <<EOF
$(printf '%s' "$info" | python3 -c 'import json,sys
r=json.load(sys.stdin); d=r.get("user") or {}
print(str(r.get("ok")).lower(), d.get("name","?"), str(d.get("is_bot",False)).lower())' 2>/dev/null)
EOF
        if [ "$pok" != "true" ]; then
          fail "peer ${pid}: users.info not ok — cannot verify it (is this bot's token dead?)"
          continue
        fi
        [ "$pbot" = "true" ] || { fail "${pname} (${pid}) is a person, not a bot — remove from PEER_BOT_IDS"; continue; }
        pass "peer @${pname} (${pid})"
        # back-link: does the peer list us?
        peer_dir="$RUNTIME/$pname/.env"
        if [ -f "$peer_dir" ]; then
          back="$(sed -n 's/^[[:space:]]*PEER_BOT_IDS=\(.*\)/\1/p' "$peer_dir" | tail -1)"
          case ",${back// /}," in *",${ok},"*) pass "@${pname} lists us back (${ok})" ;;
            *) fail "@${pname} does not list ${ok} in PEER_BOT_IDS — one-way peers never answer each other";; esac
        else
          warn "@${pname} has no instance folder in $RUNTIME — the manager won't show it"
        fi
      done
    fi
  fi

  # 7. Discord
  dtoken="$(get DISCORD_TOKEN)"
  if [ -z "$dtoken" ]; then
    warn "no Discord token yet"
  else
    me="$(curl -s --max-time 10 -H "Authorization: Bot $dtoken" https://discord.com/api/v10/users/@me)"
    read -r dok did dname dbot <<EOF
$(printf '%s' "$me" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("!unparseable"); raise SystemExit
if d.get("id"): print("true", d["id"], d.get("username","?"), str(d.get("bot",False)).lower())
else: print("!"+str(d.get("message") or d.get("error") or "no answer"))' 2>/dev/null)
EOF
    case "$dok" in
      '!'*) case "${dok#!}" in
             Unauthorized|401|"401 Unauthorized")
               fail "Discord token dead: ${dok#!} — it was reset in the portal or the app was deleted. Only the user can mint a new one (see discord-bot-create)." ;;
             *) fail "users/@me: ${dok#!}" ;;
           esac ;;
      *)   pass "token live, ${dname} (${did})"
           # The gateway is the live connection; a bot that cannot open one
           # is connected-looking in the manager and dead to everyone else.
           gw="$(curl -s --max-time 10 -H "Authorization: Bot $dtoken" https://discord.com/api/v10/gateway/bot | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print("ok" if d.get("url") else "!")
except Exception: print("!unparseable")' 2>/dev/null)"
           [ "$gw" = "ok" ] && pass "gateway reachable" || fail "gateway not reachable — the bot will not receive anything"

           # 7b. in a server?
           guild_id="$(get GUILD_ID)"
           guilds="$(curl -s --max-time 10 -H "Authorization: Bot $dtoken" https://discord.com/api/v10/users/@me/guilds | python3 -c 'import json,sys
try: print(" ".join(g["id"] for g in json.load(sys.stdin)))
except Exception: print("")' 2>/dev/null)"
           if [ -z "$guilds" ]; then
             fail "in no servers — open the invite URL from: bun \"\$(hoobot path skills)/bot-discord/scripts/discord-app.ts\" invite ${name}"
           elif [ -n "$guild_id" ]; then
             case " $guilds " in
               *" $guild_id "*) pass "in ${guild_id}, and GUILD_ID names it" ;;
               *) fail "GUILD_ID=${guild_id} but the bot is not in that server (it is in: ${guilds}) — it answers nowhere" ;;
             esac
           else
             pass "in $(echo "$guilds" | wc -w | tr -d ' ') server(s)"
           fi

           # 7c. peers this surface can answer. Discord ids are digits;
           # Slack's start with U and are the other chat's business.
           dpeers="$(get PEER_BOT_IDS | tr ',' '\n' | grep -E '^[0-9]+$' || true)"
           if [ -z "$dpeers" ]; then
             warn "PEER_BOT_IDS lists no Discord bot — this bot ignores every other bot on Discord"
           else
             for pid in $dpeers; do
               [ "$pid" = "$did" ] && continue
               info="$(curl -s --max-time 10 -H "Authorization: Bot $dtoken" "https://discord.com/api/v10/users/${pid}")"
               read -r pok pname pbot <<EOF
$(printf '%s' "$info" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("!unparseable"); raise SystemExit
print("true", d.get("username","?"), str(d.get("bot",False)).lower()) if d.get("id") else print("!"+str(d.get("message") or "unknown"))' 2>/dev/null)
EOF
               if [ "$pok" != "true" ]; then
                 fail "peer ${pid}: Discord cannot look it up (${pok#!}) — stale id, or the app was deleted"
                 continue
               fi
               [ "$pbot" = "true" ] || { fail "${pname} (${pid}) is a person, not a bot — remove from PEER_BOT_IDS"; continue; }
               pass "peer @${pname} (${pid})"
               # The peer's Discord username is not its instance folder
               # ("hoo-bot" vs "hoo"), so match on which token is this id.
               owner=""
               for cand in "$RUNTIME"/*/; do
                 cand="${cand%/}"
                 case "$(basename "$cand")" in shared|manager|workspace|node_modules|logs|slack) continue;; esac
                 ct="$(sed -n 's/^[[:space:]]*DISCORD_TOKEN=\(.*\)/\1/p' "$cand/.env" 2>/dev/null | tail -1 | tr -d '"'"'"'')"
                 [ -n "$ct" ] || continue
                 seg="$(printf '%s' "$ct" | cut -d. -f1)"
                 # base64url, unpadded: BSD base64 silently drops the last
                 # byte without the '=' padding, so the id comes back one
                 # digit short and matches nothing.
                 pad=$(( (4 - ${#seg} % 4) % 4 ))
                 while [ "$pad" -gt 0 ]; do seg="${seg}="; pad=$((pad - 1)); done
                 decoded="$(printf '%s' "$seg" | tr '_-' '/+' | base64 -d 2>/dev/null)"
                 [ "$decoded" = "$pid" ] && { owner="$(basename "$cand")"; break; }
               done
               if [ -z "$owner" ]; then
                 warn "no bot in $RUNTIME has the Discord id ${pid} — nothing to check the back-link against"
               else
                 # Commas on both ends so the first and last id both match `,id,`.
                 back="$(sed -n 's/^[[:space:]]*PEER_BOT_IDS=\(.*\)/\1/p' "$RUNTIME/$owner/.env" | tail -1 | tr ',' '\n' | grep -E '^[0-9]+$' | sed 's/^/,/' | sed 's/$/,/' | tr -d '\n')"
                 case "$back" in *",${did},"*) pass "@${owner} lists us back (${did})" ;;
                   *) fail "@${owner} does not list ${did} in PEER_BOT_IDS — one-way peers never answer each other" ;;
                 esac
               fi
             done
           fi ;;
    esac
  fi

  # 8. health
  port="$(get HEALTH_PORT)"; port="${port:-8787}"
  if [ "$port" != "off" ] && health="$(curl -sf --max-time 5 "http://127.0.0.1:${port}/healthz" 2>/dev/null)"; then
    echo "$health" | python3 -c '
import json,sys
d=json.load(sys.stdin)
ok = d.get("ok")
print("  \033[32mok\033[0m   /healthz ok, up %ss, v%s" % (d.get("uptimeSec"), d.get("version")))
for s in d.get("surfaces") or []:
    mark = "\033[32mok\033[0m  " if s.get("state")=="connected" else "\033[31mFAIL\033[0m"
    print("   %s %s: %s" % (mark, s.get("name"), s.get("state")))
' 2>/dev/null || warn "health on ${port} answered with something unparseable"
  else
    warn "no answer on http://127.0.0.1:${port}/healthz"
  fi

  # 9. shared workdir
  wd="$(get HOO_WORKDIR)"
  if [ -n "$wd" ]; then
    [ -d "$wd" ] && pass "workdir $wd" || fail "HOO_WORKDIR $wd doesn't exist"
  else
    warn "HOO_WORKDIR unset — defaults to ./workspace next to the process"
  fi
done

section "result"
if [ "$fails" -eq 0 ]; then
  echo "  all checks passed"
  exit 0
fi
echo "  $fails check(s) failed"
exit 1