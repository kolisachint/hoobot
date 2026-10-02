# 21 — Sleeping on a Mac

## The question

A bot daemon is a process the user forgets about for days. What happens to it
when the Mac it lives on goes to sleep?

## What actually happens

Sleep suspends processes. It does not kill them.

- The bot survives. Its pid, its pidfile and its `.env` are all still there,
  so the manager keeps showing it as running.
- Nothing runs while it sleeps, so nothing is lost *internally*: a turn in
  flight is paused mid-request, not aborted.
- Timers do not queue up. Measured with a `SIGSTOP`/`SIGCONT` pair — the same
  thing sleep does to a process — a one-second interval fired 3 times across a
  4-second freeze rather than catching up. A freeze costs elapsed time, it
  does not cost work.
- **The network is the real damage.** The chat socket is gone for the duration.
  Slack's Socket Mode does not replay events it could not deliver, so every
  message sent while the Mac slept was addressed to a socket nobody was
  reading. On wake the socket reconnects and the bot carries on, having missed
  everything in between.
- Idle timers, approvals and `uptimeSec` all use the wall clock, so they
  simply count the sleep as uptime.

So the failure is not a crash. It is silence, and silence is
indistinguishable from a bot nobody is talking to. That is the shape of bug
worth designing against.

Two things no amount of assertion fixes:

- **Closing the lid still sleeps the Mac.** `caffeinate` holds *idle* sleep,
  not a closed lid. A clamshell setup (power plus external display) is the
  only way a bot survives in a closed laptop.
- **Battery dies.** A sleeping Mac on battery is a dead Mac by morning.

## Decision

`scripts/runtime.sh` wraps every bot it starts:

    caffeinate -i bun src/index.ts

`-i` holds idle *system* sleep and nothing else — the display still dims, the
lid still closes, and the assertion cannot hold a battery awake. This is
deliberately the smaller claim: a bot should not be the reason a laptop stays
open and hot.

`caffeinate -i CMD` execs `CMD` rather than forking it, so the pidfile still
holds the bot's own pid, `Stop` still signals the bot directly, and there is
no wrapper process to go missing. The assertion cannot outlive the bot: when
the bot exits, `caffeinate` exits, and the assertion is dropped.

This only covers bots started through `scripts/runtime.sh`. A bot supervised
some other way — launchd via `scripts/service.sh`, say — is not wrapped, so the
manager has to say something. `src/power.ts` reads `pmset -g assertions` and
the UI shows a warning when a bot is running on a Mac that nothing is holding
awake.

## Which assertions count

`pmset -g assertions` lists several that keep a Mac up for Apple's own
reasons, and they are always on:

- `powerd` — while the display is on.
- `sharingd` — Handoff.
- `runningboardd` — for a moment, on behalf of a system service.
- `dasd` — while a disk spins up.

Counting any of those would mean the warning could never appear on any Mac,
which is the wrong way round: a bot that silently sleeps is the exact failure
this exists to prevent. So a holder counts only when its binary lives
somewhere a person put it — `/usr/bin` included, because that is where Apple
ships `caffeinate`, the one that matters here.

This errs towards warning when uncertain, which is the safe direction: a
banner that appears needlessly is an annoyance, a banner that never appears
is a bot that has been quiet for eight hours.

## Testing

`parseAssertions` and `awakeKeepers` are pure functions over a real assertion
dump, so the rules are tested against every case this Mac produced over time —
each system daemon listed above, `caffeinate`, Amphetamine, and the display-only
assertions that must not count. `bun -e 'import {powerState} from
"./src/power.ts"; console.log(await powerState())'` reports the live machine.
