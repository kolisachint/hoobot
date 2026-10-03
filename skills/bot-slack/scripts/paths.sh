#!/usr/bin/env bash
# The paths, on whatever machine this is — and on whatever version.
#
# Skills are copied between machines, so a skill that hard-codes a path is
# wrong everywhere except where it was written. `hoobot path` is the answer,
# and it ships with the skills in the same package — but only from 0.0.11 on.
# On an older install `hoobot path` is an unknown subcommand that falls
# through to starting the bot, prints nothing useful, and exits 0, so
#
#   bash "$(hoobot path selftest)" hoo      # → bash: : No such file
#
# with the real error scrolled off above it. That is the worst kind of
# failure: a broken path that looks like a missing file.
#
# So every skill calls this instead, which tries `hoobot path` and falls back
# to the documented layout. Source it, or call it:
#
#   . "$(dirname "$0")/paths.sh" && "$SELFTEST" hoo
#   bash "$(…)/paths.sh" selftest
#
# Prints nothing but the path, and exits non-zero when it cannot work one out
# rather than printing an empty string that becomes a broken command.
set -uo pipefail

HOO_RUNTIME="${HOOBOT_RUNTIME_DIR:-$HOME/.hoobot/runtime}"
HOO_WORKDIR_DEFAULT="$HOO_RUNTIME/shared/workspace"

# `hoobot path <key>`, but only if this hoobot actually has it.
_hoobot_path() {
  command -v hoobot >/dev/null 2>&1 || return 1
  local p
  p="$(hoobot path "$1" 2>/dev/null)" || return 1
  # An old build answers with nothing at all; a real path is never empty.
  [ -n "$p" ] || return 1
  printf '%s' "$p"
}

_resolve() {
  local key="$1" p
  if p="$(_hoobot_path "$key")" && [ -n "$p" ]; then
    printf '%s' "$p"
    return 0
  fi
  case "$key" in
    package) p="$(dirname "$(dirname "$(command -v hoobot 2>/dev/null || echo /nonexistent)")")" ;;
    runtime) p="$HOO_RUNTIME" ;;
    workdir) p="${HOO_WORKDIR:-$HOO_WORKDIR_DEFAULT}" ;;
    skills) p="${HOO_WORKDIR:-$HOO_WORKDIR_DEFAULT}/.cortexcode/skills" ;;
    selftest) p="${HOO_WORKDIR:-$HOO_WORKDIR_DEFAULT}/.cortexcode/skills/bot-selftest/scripts/bot-selftest.sh" ;;
    avatar-png) p="${HOO_WORKDIR:-$HOO_WORKDIR_DEFAULT}/.cortexcode/skills/bot-avatar/scripts/avatar-png.ts" ;;
    runtime-script) p="$HOO_RUNTIME/../../share/hoobot/scripts/runtime.sh" ;;
    manager) p="http://127.0.0.1:8790" ;;
    *) return 1 ;;
  esac
  printf '%s' "$p"
}

# Called directly: print one path.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  key="${1:---list}"
  if [ "$key" = "--list" ]; then
    for k in package runtime workdir skills selftest avatar-png runtime-script manager; do
      printf '%s=%s\n' "$k" "$(_resolve "$k")"
    done
    exit 0
  fi
  if ! out="$(_resolve "$key")" || [ -z "$out" ]; then
    echo "paths.sh: no path for \"$key\". Update hoobot: bun add -g @kolisachint/hoobot@latest" >&2
    exit 2
  fi
  printf '%s\n' "$out"
  exit 0
fi

# Sourced: export the ones skills use most.
PACKAGE="$(_resolve package)"
RUNTIME="$(_resolve runtime)"
WORKDIR="$(_resolve workdir)"
SKILLS="$(_resolve skills)"
SELFTEST="$(_resolve selftest)"
AVATAR_PNG="$(_resolve avatar-png)"
RUNTIME_SCRIPT="$(_resolve runtime-script)"
MANAGER="$(_resolve manager)"