#!/usr/bin/env bun
/**
 * hoobot: talk to hoocode from Discord.
 *
 * - Every channel and thread is a shared space with its own hoocode conversation.
 * - Mention the bot (or reply to it) → it reads what was said since it last
 *   looked (up to 30 messages) and answers right there.
 * - Commands inside a thread: !stop  !new  !status  !model [name]  !verbose  !help
 * - Each channel in WORKSPACES works in its own folder with its own app-server.
 */
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { allWorkdirs, config, prepareWorkspace, workdirFor } from "./config.ts";
import { CodexClient } from "./codex-client.ts";
import { LinkStore } from "./links.ts";
import { ThreadSession } from "./session.ts";
import { authorName, buildPrompt, gatherContext, toContext, type ContextMessage, type SpaceLike } from "./context.ts";

for (const dir of allWorkdirs()) prepareWorkspace(dir);

const links = new LinkStore(config.linksFile);
const sessions = new Map<string, ThreadSession>();

/** `unix://PATH`, or `hoocode app-server` over stdio in the work folder. */
function endpoint(): string {
  if (config.appServer) return config.appServer;
  return `stdio:${config.hoocodeBin} app-server ${config.hoocodeArgs.join(" ")}`;
}

/** One app-server per folder, started on first use. */
const apps = new Map<string, Promise<CodexClient>>();

/** The app-server for `workdir`; reconnects after it drops. */
function appServer(workdir: string): Promise<CodexClient> {
  let app = apps.get(workdir);
  if (app) return app;
  app = (async () => {
    // A stdio server runs in the work folder; a socket server has its own.
    const client = await CodexClient.connect(
      endpoint(),
      { name: "hoobot", version: "0.1.0" },
      { cwd: workdir },
    );
    console.log(`Connected to app-server ${client.endpoint} in ${workdir}`);
    client.on("close", (reason: string) => {
      console.error(`app-server for ${workdir} closed: ${reason}`);
      apps.delete(workdir);
      // Its sessions hold the old client; drop them. Threads resume on the next message.
      for (const s of [...sessions.values()]) if (s.workdir === workdir) s.close();
    });
    return client;
  })().catch((err) => {
    console.error(`Can't reach app-server for ${workdir}: ${err instanceof Error ? err.message : String(err)}`);
    apps.delete(workdir);
    throw err;
  });
  apps.set(workdir, app);
  return app;
}
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
  "**Call me:** mention me, or reply to one of my messages. I answer right here.",
  "Every channel and thread is a shared space: anyone can talk, and when I'm called",
  "I read what was said since I last looked (up to 30 messages).",
  "Open a thread for a side task; it has its own conversation in the same folder.",
  "",
  "**Commands** (for this channel or thread)",
  "- `!stop`: stop the current run",
  "- `!new`: start a fresh conversation here (for everyone)",
  "- `!status`: model, busy or not, folder",
  "- `!model`: pick the model here from a list (from the next message; the conversation carries on)",
  "- `!model <part of name>`: pick it directly, e.g. `!model kimi`",
  "- `!verbose`: show every step here (again to turn off)",
  "- `!help`: this message",
  "",
  "Calling me while I'm busy steers the current run.",
  "While I work you see one status line; then the answer with a short",
  "summary (PR, commits, files, steps, time, model).",
  ...(config.approvals === "ask" ? ["Commands that change files or run shell ask for approval with buttons."] : []),
].join("\n");

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Working folder: ${config.workdir}`);
  for (const [channel, dir] of config.workspaces) console.log(`  channel ${channel} → ${dir}`);
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
  if (channel.type !== ChannelType.GuildText && !channel.isThread()) return;
  const parentId = channel.isThread() ? channel.parentId : channel.id;
  if (config.channelIds.size && (!parentId || !(config.channelIds.has(parentId) || config.workspaces.has(parentId)))) return;

  // Called by a mention (the bot user, or its auto-created role that Discord's
  // autocomplete often picks), or by replying to one of the bot's messages.
  const botRoleId = message.guild?.members.me?.roles.botRole?.id;
  const called =
    message.mentions.users.has(client.user.id) ||
    (!!botRoleId && message.mentions.roles.has(botRoleId)) ||
    message.mentions.repliedUser?.id === client.user.id;
  if (!called) return;
  console.log(`[msg] ${message.author.username} (${message.author.id}) in ${channel.id}: ${message.content.slice(0, 80)}`);

  // Only allowed users can call the bot (everyone's messages still count as context).
  if (!config.allowedUserIds.has(message.author.id)) {
    await message.reply("Sorry, you're not on this bot's allow list.");
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

  // Commands.
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  if (cmd?.toLowerCase() === "!help") {
    await message.reply(HELP);
    return;
  }
  const space = channel as TextChannel | ThreadChannel;
  let session: ThreadSession;
  try {
    session = await getSession(space, workdirFor(parentId));
  } catch (err) {
    await message.reply(`**Can't reach hoocode:** ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  switch (cmd?.toLowerCase()) {
    case "!stop":
      return session.abort();
    case "!new":
      return session.newSession();
    case "!status":
      return session.status();
    case "!verbose":
      return session.toggleVerbose();
    case "!model":
      return session.chooseModel(arg);
  }

  // One call at a time per space, so read positions advance in order.
  await inOrder(space.id, async () => {
    // What was said here since the conversation last read, plus the message replied to.
    const { linked, seen } = await session.readState();
    const [context, replyTo] = await Promise.all([
      gatherContext({ space: space as unknown as SpaceLike, before: message.id, botId: client.user!.id, linked, seen }),
      fetchReplyTo(message, client.user!.id),
    ]);
    const prompt = buildPrompt({
      context,
      replyTo,
      author: authorName(message),
      text: text || "(see attached image)",
    });
    if (await session.prompt(prompt, images, message)) session.markSeen(message.id);
  });
}

/** Per-space promise chains. */
const lanes = new Map<string, Promise<unknown>>();
function inOrder(key: string, fn: () => Promise<unknown>): Promise<unknown> {
  const next = (lanes.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  lanes.set(key, tail);
  tail.then(() => lanes.get(key) === tail && lanes.delete(key));
  return next;
}

/** The message `message` replies to, unless it's the bot's own (already in the conversation). */
async function fetchReplyTo(message: Message, botId: string): Promise<ContextMessage | null> {
  if (!message.reference?.messageId || message.mentions.repliedUser?.id === botId) return null;
  try {
    return toContext(await message.fetchReference(), botId);
  } catch {
    return null;
  }
}

async function getSession(space: TextChannel | ThreadChannel, workdir: string): Promise<ThreadSession> {
  const client = await appServer(workdir);
  let s = sessions.get(space.id);
  if (!s) {
    s = new ThreadSession(space, client, links, (id) => sessions.delete(id), workdir);
    sessions.set(space.id, s);
  }
  return s;
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
  for (const app of apps.values()) app.then((c) => c.close()).catch(() => {});
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(config.token);
