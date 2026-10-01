// Live check of shared-space context: real Discord thread, real hoocode.
// "Other people" are messages the bot posts as "name: text"; the context
// reader is told a different bot id so it doesn't skip them. Run from the
// bot's folder (needs Read Message History):
//   LIVE_CHANNEL_ID=<id> bun ~/github/hoobot/test/live-context.ts
import { ChannelType, Client, GatewayIntentBits, type TextChannel } from "discord.js";
const { config, prepareWorkspace } = await import("../src/config.ts");
const { ThreadSession } = await import("../src/session.ts");
const { CodexClient } = await import("../src/codex-client.ts");
const { LinkStore } = await import("../src/links.ts");
const { gatherContext, buildPrompt } = await import("../src/context.ts");

prepareWorkspace();
const app = await CodexClient.connect(
  config.appServer || `stdio:${config.hoocodeBin} app-server ${config.hoocodeArgs.join(" ")}`,
  undefined,
  { cwd: config.workdir },
);
const links = new LinkStore(`/tmp/hoobot-live-context-${Date.now()}.json`);
const CHANNEL = process.env.LIVE_CHANNEL_ID ?? "1554149386735325296";
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
await client.login(config.token);
await new Promise((r) => client.once("clientReady", r));
const botId = client.user!.id;

const channel = (await client.channels.fetch(CHANNEL)) as TextChannel;
const space = await channel.threads.create({ name: "hoobot context test", type: ChannelType.PublicThread, autoArchiveDuration: 60 });
console.log("thread:", space.url);
const say = (name: string, content: string) => space.send(`${name}: ${content}`);
const READER_ID = "0"; // count the bot's posts as other people's for this test
/** The test reader sees the bot's answers too; drop those lines to judge only "people". */
const people = (ctx: string) => ctx.split("\n").filter((l) => /\(bot\): \w+: /.test(l)).join("\n");

const s = new ThreadSession(space, app, links, () => {});
async function call(text: string) {
  const anchor = await say("sachin", `@hoo ${text}`);
  const { linked, seen } = await s.readState();
  const context = await gatherContext({ space: space as any, before: anchor.id, botId: READER_ID, linked, seen });
  const ok = await s.prompt(buildPrompt({ context, author: "sachin", text }), [], anchor);
  if (ok) s.markSeen(anchor.id);
  const t0 = Date.now();
  await Bun.sleep(1000);
  while (s.busy && Date.now() - t0 < 120_000) await Bun.sleep(500);
  await Bun.sleep(1500);
  const msgs = await space.messages.fetch({ limit: 10 });
  const reply = msgs.find((m) => m.author.id === botId && m.reference?.messageId === anchor.id);
  return { context, reply: reply?.content ?? "" };
}

let failed = false;
const check = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

await say("alice", "The deploy failed: the migrations step says column `email_verified` already exists.");
await say("bob", "Agreed, the secret word for this test is PELICAN.");
const r1 = await call("Without tools: what column did alice mention, and what is bob's secret word? One line.");
check("first call reads others' messages", r1.context.includes("alice: The deploy failed") && r1.context.includes("PELICAN"));
check("answer is a reply to the caller and knows the context", /email_verified/.test(r1.reply) && /PELICAN/i.test(r1.reply));

await say("carol", "New info: the secret word is now OSPREY.");
const r2 = await call("Without tools: what is the secret word now? One word.");
check("second call sends only new messages", people(r2.context).includes("OSPREY") && !people(r2.context).includes("secret word for this test"));
check("answer uses the new message", /OSPREY/i.test(r2.reply));

const r3 = await call("Without tools: reply with just: ok");
check("nothing new from people → none sent", people(r3.context) === "");

console.log(`replies:\n1: ${r1.reply}\n2: ${r2.reply}`);
console.log(`context 2:\n${r2.context}\ncontext 3:\n${r3.context}`);
s.close();
await space.setArchived(true).catch(() => {});
app.close();
await client.destroy();
process.exit(failed ? 1 : 0);
