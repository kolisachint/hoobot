#!/usr/bin/env bash
# Run the Slack CLI as if a person were sitting at the terminal.
#
# The Slack CLI asks two questions before it will do anything — which
# environment, and which app — and refuses outright when stdin is not a TTY:
#
#   The input device is not a TTY or does not support interactivity
#
# So a bot driving it gets nothing, and the honest-sounding fallback is to
# tell the user to do it by hand. Running the call in a pty and pressing
# Enter is what makes `slack app install` do the whole job unattended: it
# creates the app from the manifest, installs it to the team, uploads
# assets/icon.png as the app icon, and writes the App ID into
# .slack/apps.dev.json.
#
#   slack-pty.sh slack app install --environment local
#
# Enter is pressed a few times rather than once: the prompts come in
# sequence, and an unanswered one is the same as no TTY at all.
#
# Enter takes whatever the default is, which is right for "pick the only
# app" and wrong for `slack app delete`, whose default is No. So the keys
# are configurable:
#
#   SLACK_PTY_KEYS=y  bash slack-pty.sh slack app delete
set -uo pipefail

# How long to let the command run before giving up on it.
SECS="${SLACK_PTY_TIMEOUT:-240}"
# What to press, once every 3s, up to four times.
KEYS="${SLACK_PTY_KEYS-$(printf '\r')}"

if [ "$#" -eq 0 ]; then
  echo "usage: slack-pty.sh <command> [args…]" >&2
  exit 64
fi

if command -v python3 >/dev/null 2>&1; then
  export SLACK_PTY_SECS="$SECS" SLACK_PTY_KEYS="$KEYS"
  exec python3 -c '
import os, pty, select, sys, time
secs = int(os.environ["SLACK_PTY_SECS"])
keys = os.environ["SLACK_PTY_KEYS"].encode()
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm"
    # argv[1] is the timeout we passed; the command starts at argv[2]
    os.execvp(sys.argv[2], sys.argv[2:])
buf, sent, next_key = b"", 0, time.time() + 3
deadline = time.time() + secs
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
    if sent < 4 and time.time() >= next_key:
        os.write(fd, keys)
        sent += 1
        next_key = time.time() + 3
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
sys.stdout.write(buf.decode("utf8", "replace"))
' "$SECS" "$@"
fi

echo "slack-pty.sh: no python3 on this machine, so the Slack CLI cannot be" >&2
echo "driven without a terminal. Run this yourself:" >&2
printf '  %s\n' "$*" >&2
exit 1