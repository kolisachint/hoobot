#!/usr/bin/env bun
/**
 * hoo-discord-bot: talk to hoocode from Discord.
 *
 * - Mention the bot in a channel → it opens a thread and answers there.
 * - Every message in that thread goes to the same hoocode session.
 * - Commands inside a thread: !stop  !new  !status  !model <pattern>  !help
 */
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { config, prepareWorkspace } from "./config.ts";
import { CodexClient } from "./codex-client.ts";
import { LinkStore } from "./links.ts";
import { ThreadSession } from "./session.ts";

prepareWorkspace();

const links = new LinkStore(config.linksFile);
const sessions = new Map<string, ThreadSession>();

/** `unix://PATH`, or `hoocode app-server` over stdio in the work folder. */
function endpoint(): string {
  if (config.appServer) return config.appServer;
  return `stdio:${config.hoocodeBin} app-server ${config.hoocodeArgs.join(" ")}`;
}

let app: Promise<CodexClient> | null = null;

/** The shared app-server connection; reconnects after it drops. */
function appServer(): Promise<CodexClient> {
  app ??= (async () => {
    // A stdio server runs in the work folder; a socket server has its own.
    const client = await CodexClient.connect(
      endpoint(),
      { name: "hoobot", version: "0.1.0" },
      { cwd: config.workdir },
    );
    console.log(`Connected to app-server ${client.endpoint}`);
    client.on("close", (reason: string) => {
      console.error(`app-server connection closed: ${reason}`);
      app = null;
      // Sessions hold the old client; drop them. Threads resume on the next message.
      for (const s of [...sessions.values()]) s.close();
    });
    return client;
  })().catch((err) => {
    console.error(`Can't reach app-server: ${err instanceof Error ? err.message : String(err)}`);
    app = null;
    throw err;
  });
  return app;
}
/** Threads this bot created, so it only listens in its own threads. */
const ownThreads = new Set<string>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const HELP = [
  "**hoo: hoocode in Discord**",
  "",
  "**Start:** mention me with a request. I'll open a thread.",
  "**Continue:** just type in the thread.",
  "",
  "**Commands (inside a thread)**",
  "- `!stop`: stop the current run",
  "- `!new`: forget this conversation, start fresh",
  "- `!status`: model, busy or not, folder",
  "- `!model <name>`: switch model from the next message, e.g. `!model anthropic/claude-sonnet-4-5`",
  "- `!help`: this message",
  "",
  "Typing while I'm busy steers the current run.",
  "Commands that change files or run shell ask for approval with buttons.",
].join("\n");

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Working folder: ${config.workdir}`);
  console.log(`Allowed users: ${[...config.allowedUserIds].join(", ")}`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await onMessage(message);
  } catch (err) {
    console.error("message handler failed", err);
    await message.reply("Something went wrong on my side. Check the bot's terminal.").catch(() => {});
  }
});

async function onMessage(message: Message) {
  if (message.author.bot || !client.user) return;
  if (config.guildId && message.guildId !== config.guildId) return;

  const channel = message.channel;
  const inOwnThread = channel.isThread() && isOwnThread(channel);
  // Discord's autocomplete often picks the bot's auto-created *role* (also
  // named after the bot) instead of the bot user, so accept either.
  const botRoleId = message.guild?.members.me?.roles.botRole?.id;
  const mentioned =
    message.mentions.users.has(client.user.id) ||
    (!!botRoleId && message.mentions.roles.has(botRoleId));

  if (!inOwnThread && !mentioned) return;
  console.log(`[msg] ${message.author.username} (${message.author.id}) in ${channel.id}: ${message.content.slice(0, 80)}`);

  const parentId = channel.isThread() ? channel.parentId : channel.id;
  if (config.channelIds.size && (!parentId || !config.channelIds.has(parentId))) return;

  if (!config.allowedUserIds.has(message.author.id)) {
    if (mentioned) await message.reply("Sorry, you're not on this bot's allow list.");
    return;
  }

  const text = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .replace(botRoleId ? new RegExp(`<@&${botRoleId}>`, "g") : /$^/, "")
    .trim();
  const images = await imageAttachments(message);

  if (!text && images.length === 0) {
    await message.reply(HELP);
    return;
  }

  // Resolve (or create) the thread for this conversation.
  let thread: ThreadChannel;
  if (channel.isThread()) {
    thread = channel;
    ownThreads.add(thread.id);
  } else if (channel.type === ChannelType.GuildText) {
    thread = await message.startThread({
      name: (text || "hoocode").replace(/\s+/g, " ").slice(0, 90),
      autoArchiveDuration: 1440,
    });
    ownThreads.add(thread.id);
  } else {
    await message.reply("Mention me in a normal text channel and I'll open a thread.");
    return;
  }

  // Commands.
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  if (cmd?.toLowerCase() === "!help") {
    await thread.send(HELP);
    return;
  }
  let session: ThreadSession;
  try {
    session = await getSession(thread);
  } catch (err) {
    await thread.send(`**Can't reach hoocode:** ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  switch (cmd?.toLowerCase()) {
    case "!stop":
      await session.abort();
      return;
    case "!new":
      await session.newSession();
      return;
    case "!status":
      await session.status();
      return;
    case "!model":
      if (!arg) await thread.send("Usage: `!model provider/model-id`");
      else await session.setModel(arg);
      return;
  }

  await session.prompt(text || "(see attached image)", images);
}

async function getSession(thread: ThreadChannel): Promise<ThreadSession> {
  const client = await appServer();
  let s = sessions.get(thread.id);
  if (!s) {
    s = new ThreadSession(thread, client, links, (id) => sessions.delete(id));
    sessions.set(thread.id, s);
  }
  return s;
}

/** A thread counts as ours if we created it or already hold a session for it. */
function isOwnThread(thread: ThreadChannel): boolean {
  return ownThreads.has(thread.id) || sessions.has(thread.id) || thread.ownerId === client.user?.id;
}

async function imageAttachments(message: Message) {
  const out: { data: string; mimeType: string }[] = [];
  for (const att of message.attachments.values()) {
    const mime = att.contentType?.split(";")[0] ?? "";
    if (!mime.startsWith("image/") || att.size > 5_000_000) continue;
    const res = await fetch(att.url);
    if (!res.ok) continue;
    out.push({ data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType: mime });
  }
  return out;
}

function shutdown() {
  console.log("Shutting down…");
  for (const s of [...sessions.values()]) s.close();
  app?.then((c) => c.close()).catch(() => {});
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(config.token);
