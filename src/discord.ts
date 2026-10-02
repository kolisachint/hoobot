/**
 * Discord surface: turns mentions and replies into calls (src/core.ts) and
 * Discord channels and threads into `ChatSpace`s.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  StringSelectMenuBuilder,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { config, workdirFor } from "./config.ts";
import { authorName, gatherContext, toContext, type SpaceLike } from "./context.ts";
import type { ChatSpace, Choice, Picked, Posted } from "./chat.ts";
import { handleCall, helpText } from "./core.ts";

const HELP = helpText("Discord", "a list");

/** Discord hard limit. */
const MAX_LENGTH = 2000;

function posted(msg: Message): Posted {
  return {
    edit: (text) => msg.edit({ content: text, components: [] }),
    delete: () => msg.delete(),
  };
}

/** A Discord channel or thread as a `ChatSpace`. */
export function discordSpace(channel: TextChannel | ThreadChannel): ChatSpace {
  return {
    id: channel.id,
    surface: "discord",
    label: "Discord",
    maxLength: MAX_LENGTH,
    maxChoices: 25,
    async send(text, opts = {}) {
      const files = opts.files ?? [];
      if (!opts.replyTo && !files.length) return posted(await channel.send(text));
      return posted(
        await channel.send({
          content: text,
          // A reply that doesn't ping; a plain send if that message is gone.
          ...(opts.replyTo
            ? { reply: { messageReference: opts.replyTo, failIfNotExists: false }, allowedMentions: { repliedUser: false } }
            : {}),
          ...(files.length ? { files } : {}),
        }),
      );
    },
    sendTyping: () => channel.sendTyping(),
    async choose(text, kind, choices, timeoutMs, placeholder) {
      const msg = await channel.send({ content: text, components: [components(kind, choices, placeholder)] });
      const pick = msg
        .awaitMessageComponent({
          time: timeoutMs,
          filter: async (i) => {
            if (config.allowedUserIds.has(i.user.id)) return true;
            await i.reply({ content: "Only allowed users can answer this.", ephemeral: true }).catch(() => {});
            return false;
          },
        })
        .then(
          (i): Picked => ({
            value: i.isStringSelectMenu() ? i.values[0]! : choices[Number(i.customId.split(":")[1])]!.value,
            user: i.user.username,
            update: (t) => i.update({ content: t, components: [] }),
          }),
        );
      return { msg: posted(msg), pick };
    },
  };
}

function components(kind: "buttons" | "menu", choices: Choice[], placeholder?: string) {
  if (kind === "menu") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("pick")
      .setPlaceholder(placeholder ?? "Pick one")
      .addOptions(
        choices.map((c) => ({ label: c.label.slice(0, 100), value: c.value.slice(0, 100), description: c.description, default: c.default })),
      );
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    choices.map((c, i) =>
      new ButtonBuilder()
        .setCustomId(`ui:${i}`)
        .setLabel(c.label)
        .setStyle(c.style === "danger" ? ButtonStyle.Danger : c.style === "primary" ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );
}

/** Log in and answer calls. Resolves once connected; returns a stop function. */
export async function startDiscord(): Promise<() => Promise<void>> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Discord: logged in as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await onMessage(client, message);
    } catch (err) {
      console.error("message handler failed", err);
      await message.reply("Something went wrong on my side. Check the bot's terminal.").catch(() => {});
    }
  });

  await client.login(config.token);
  return async () => {
    await client.destroy();
  };
}

async function onMessage(client: Client, message: Message) {
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
  console.log(`[discord] ${message.author.username} (${message.author.id}) in ${channel.id}: ${message.content.slice(0, 80)}`);

  const botId = client.user.id;
  const text = message.content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .replace(botRoleId ? new RegExp(`<@&${botRoleId}>`, "g") : /$^/, "")
    .trim();
  const space = channel as TextChannel | ThreadChannel;
  await handleCall(
    {
      space: discordSpace(space),
      userId: message.author.id,
      author: authorName(message),
      messageId: message.id,
      text,
      files: [...message.attachments.values()],
      workdir: workdirFor(parentId),
      reply: (t) => message.reply(t),
      context: ({ linked, seen }) =>
        gatherContext({ space: space as unknown as SpaceLike, before: message.id, botId, linked, seen }),
      replyTo: () => fetchReplyTo(message, botId),
    },
    HELP,
  );
}

/**
 * The message `message` replies to, unless it's the bot's own (already in the
 * conversation, and its files are already in the work folder).
 */
async function fetchReplyTo(message: Message, botId: string) {
  if (!message.reference?.messageId || message.mentions.repliedUser?.id === botId) return null;
  try {
    const ref = await message.fetchReference();
    if (ref.author.id === botId) return null;
    return {
      context: toContext(ref, botId),
      message: { id: ref.id, author: authorName(ref), files: [...ref.attachments.values()] },
    };
  } catch {
    return null;
  }
}
