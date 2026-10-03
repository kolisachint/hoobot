#!/usr/bin/env bun
/**
 * The `hoobot` command.
 *
 *   hoobot                   run the bot (reads ./.env)
 *   hoobot manager [--open]  the bot manager page on 127.0.0.1:8790
 *   hoobot path [key|--list] the paths on this machine
 *
 * `hoobot path` exists because the bundled skills are copied between
 * machines, so a skill that hard-codes a path would be wrong everywhere
 * except where it was written. It asks the one thing that always knows.
 *
 * The bot is loaded only when it is the one asked for: `./config.ts` exits
 * when a token is missing, and the manager must start without any.
 */
const [command, ...args] = process.argv.slice(2);

if (command === "manager") {
  (await import("./manager.ts")).runManager(args);
} else if (command === "path") {
  const { hoobotPaths, isPackageInstall } = await import("./skills.ts");
  const paths = hoobotPaths();
  const key = args[0];
  if (!key || key === "--list") {
    for (const [k, v] of Object.entries(paths)) console.log(`${k}=${v}`);
    console.log(`installed=${isPackageInstall()}`);
  } else if (key in paths) {
    console.log(paths[key]);
  } else {
    console.error(`hoobot path: no such key. One of: ${Object.keys(paths).join(", ")}`);
    process.exit(2);
  }
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`hoobot                   run the bot (reads ./.env)
hoobot manager [--open]  the bot manager page on http://127.0.0.1:8790
hoobot path [key|--list]  where things live on this machine
  keys: package runtime workdir skills selftest avatar-png runtime-script manager`);
} else {
  await import("./index.ts");
}
