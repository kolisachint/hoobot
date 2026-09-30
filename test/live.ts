// Live test: real Discord thread + real hoocode, same code path as a mention.
// Uses a prompt that needs no approval. Run: bun test/live.ts
import { ChannelType, Client, GatewayIntentBits, type TextChannel } from "discord.js";
const { config, prepareWorkspace } = await import("../src/config.ts");
const { ThreadSession } = await import("../src/session.ts");
prepareWorkspace();

const CHANNEL = process.env.LIVE_CHANNEL_ID ?? "1554149386735325296";
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(config.token);
await new Promise((r) => client.once("clientReady", r));

const channel = (await client.channels.fetch(CHANNEL)) as TextChannel;
const thread = await channel.threads.create({
  name: "hoo-bot live test",
  type: ChannelType.PublicThread,
  autoArchiveDuration: 60,
});
console.log("thread:", thread.url);

let closed!: () => void;
const done = new Promise<void>((r) => (closed = r));
const s = new ThreadSession(thread, () => closed());
const t0 = Date.now();
await s.prompt(
  "Live test from the bot's installer. Without using any tools, reply in two short lines: " +
    "line 1 exactly 'hoo-bot live test OK', line 2 the model you are.",
);

// Wait for the bot's reply to appear in the thread.
let reply = "";
while (!reply && Date.now() - t0 < 120_000) {
  await Bun.sleep(1000);
  const msgs = await thread.messages.fetch({ limit: 10 });
  reply = msgs.find((m) => m.author.id === client.user!.id && m.content.includes("live test OK"))?.content ?? "";
}
console.log(reply ? `reply after ${((Date.now() - t0) / 1000).toFixed(1)}s:\n${reply}` : "NO REPLY within 120s");
s.close();
await done;
await client.destroy();
process.exit(reply ? 0 : 1);
