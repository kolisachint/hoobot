#!/usr/bin/env bun
/**
 * The `hoobot` command.
 *
 *   hoobot                   run the bot (reads ./.env)
 *   hoobot manager [--open]  the bot manager page on 127.0.0.1:8790
 *
 * The bot is loaded only when it is the one asked for: `./config.ts` exits
 * when a token is missing, and the manager must start without any.
 */
const [command, ...args] = process.argv.slice(2);

if (command === "manager") {
  (await import("./manager.ts")).runManager(args);
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`hoobot                   run the bot (reads ./.env)
hoobot manager [--open]  the bot manager page on http://127.0.0.1:8790`);
} else {
  await import("./index.ts");
}
