#!/usr/bin/env bun
/**
 * hoobot: talk to hoocode from Discord and Slack.
 *
 * - Every channel and thread is a shared space with its own hoocode conversation.
 * - Mention the bot (or, on Discord, reply to it) → it reads what was said
 *   since it last looked (up to 30 messages) and answers right there.
 * - Commands: !stop  !new  !status  !model [name]  !verbose  !help
 * - Each channel in WORKSPACES works in its own folder with its own app-server.
 * - Discord runs when DISCORD_TOKEN is set; Slack when SLACK_BOT_TOKEN and
 *   SLACK_APP_TOKEN are. Both share the app-servers and the links file.
 */
import { allWorkdirs, config, prepareWorkspace, surfaces } from "./config.ts";
import { closeAll, sessionStatus } from "./core.ts";
import { health, startHealthServer } from "./health.ts";
import { INBOX_DIRS, pruneInbox } from "./inbound.ts";
import { error, log } from "./log.ts";

for (const dir of allWorkdirs()) prepareWorkspace(dir);
// Files sent on a chat are kept a week.
const prune = () => {
  for (const dir of allWorkdirs()) {
    try {
      pruneInbox(dir);
    } catch (err) {
      error(`Can't clean ${dir}/{${Object.values(INBOX_DIRS).join(",")}}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
};
prune();
setInterval(prune, 60 * 60 * 1000).unref();

log(`Working folder: ${config.workdir}`);
for (const [channel, dir] of config.workspaces) log(`  channel ${channel} → ${dir}`);
log(`Allowed users: ${[...config.allowedUserIds].join(", ")}`);

const stops: (() => Promise<void>)[] = [];
const healthServer = startHealthServer(health, sessionStatus);
// Loaded only when used, so a Slack-only bot never loads discord.js and the other way round.
const starters = {
  discord: async () => (await import("./discord.ts")).startDiscord(),
  slack: async () => (await import("./slack.ts")).startSlack(),
};
/** A surface that connected, or the reason it didn't. */
type Start = { name: string; stop: () => Promise<void> } | { name: string; error: string };
const results = await Promise.all(
  surfaces().map(async (name): Promise<Start> => {
    try {
      return { name, stop: await starters[name]() };
    } catch (err) {
      return { name, error: err instanceof Error ? err.message : String(err) };
    }
  }),
);
for (const r of results) {
  if ("error" in r) {
    health.failed(r.name, r.error);
    error(`Can't connect to ${r.name}: ${r.error}`);
  } else {
    stops.push(r.stop);
    health.connected(r.name);
  }
}
if (stops.length === 0) {
  error("No chat connected. Check the tokens in .env.");
  process.exit(1);
}

/**
 * A rejection nobody handled.
 *
 * Without this, one stray rejection could take the whole bot down — and take
 * every conversation it was serving with it, mid-answer, with nothing in the
 * log to say why. A bot that is down is obvious; a bot that vanished is not.
 *
 * So: report it loudly, name the bot, and keep serving. The alternative —
 * exiting on any unhandled rejection — trades a lost answer for a lost
 * channel, which is worse. Anything genuinely fatal still shows up as a failed
 * health check, because the surfaces are watched.
 */
process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  error(`Unhandled rejection (the bot keeps running): ${detail}`);
});

/**
 * A synchronous throw with no handler. Unlike a rejection there is nothing
 * left to salvage at this point — whatever was running was interrupted — so
 * this logs and then leaves, and the supervisor restarts us with clean state.
 * A deliberate `process.exit` never reaches here, so this cannot loop.
 */
process.on("uncaughtException", (err) => {
  error(`Uncaught exception, exiting for the supervisor to restart: ${err.stack ?? err.message}`);
  process.exit(1);
});

async function shutdown() {
  log("Shutting down…");
  healthServer?.stop();
  await closeAll();
  await Promise.allSettled(stops.map((stop) => stop()));
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
