/**
 * Discord surface: turns mentions and replies into calls (src/core.ts) and
 * Discord channels and threads into `ChatSpace`s.
 *
 * Everything Slack can do, Discord can too:
 * - A space is a channel or a thread, each with its own conversation.
 * - Mention the bot (or its auto-created role), or reply to it, to call it.
 * - Files, `!` commands, approval buttons and the model menu (src/core.ts).
 * - Peer bots answer each other on a per-thread budget (src/peers.ts), and
 *   `@name` in an answer becomes a real mention of the other bot.
 * - A reconnect replays the mentions the gateway never delivered.
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
  type AnyThreadChannel,
  type Channel,
  type Guild,
  type Message,
  type TextChannel,
} from "discord.js";
import { config, workdirFor } from "./config.ts";
import { authorName, gatherContext, toContext, type SpaceLike } from "./context.ts";
import type { ChatSpace, Choice, Picked, Posted } from "./chat.ts";
import { handleCall, helpText } from "./core.ts";
import { linkMentions, TurnBudget } from "./peers.ts";

const HELP = helpText("Discord", "a list");

/** Discord hard limit. */
const MAX_LENGTH = 2000;

/** A channel the bot works in: a guild text channel, or a thread in one. */
type WorkChannel = TextChannel | AnyThreadChannel;

/**
 * Discord's snowflake epoch: `id = (ms - epoch) << 22`. Message ids carry
 * their own timestamp, which is what makes a catch-up possible at all.
 */
const EPOCH = 1420070400000n;

/** The id Discord gives a message sent at `ms`. */
export function snowflakeAt(ms: number): bigint {
  return (BigInt(Math.floor(ms)) - EPOCH) << 22n;
}

/** When the message with this id was sent, in ms (0 when it isn't an id). */
export function snowflakeTime(id: string): number {
  return /^\d+$/.test(id) ? Number((BigInt(id) >> 22n) + EPOCH) : 0;
}

/**
 * Is this message from a peer bot? `peerIds` is PEER_BOT_IDS.
 *
 * Discord's own `bot` flag decides, which is what keeps a person who ends up
 * in PEER_BOT_IDS a person: their messages are never peers. Bots that aren't
 * peers are ignored (`"ignore"` = drop).
 */
export function peerCall(author: { id: string; bot: boolean }, peerIds: Set<string>): boolean | "ignore" {
  if (!author.bot) return false;
  return peerIds.has(author.id) ? true : "ignore";
}

/** The parts of a discord.js Message the call test reads. */
export type CallableMessage = {
  id: string;
  content: string;
  author: { id: string; bot: boolean };
  mentions: {
    users: { has(id: string): boolean };
    roles: { has(id: string): boolean };
    repliedUser?: { id: string } | null;
  };
};

/**
 * Is this message a call the bot owes an answer to?
 *
 * The same test for a live message and a replayed one: someone other than us
 * mentioning us — the bot user, or the role Discord's autocomplete picks — or
 * replying to one of our messages. Bots only count when they're a confirmed
 * peer, so our own messages and every other bot are left out.
 */
export function isCall(m: CallableMessage, botId: string, peerIds: Set<string>, botRoleId?: string | null): boolean {
  if (!m.author || m.author.id === botId) return false;
  if (peerCall(m.author, peerIds) === "ignore") return false;
  if (m.mentions.users.has(botId)) return true;
  if (botRoleId && m.mentions.roles.has(botRoleId)) return true;
  return m.mentions.repliedUser?.id === botId;
}

/** Remove the bot's mention and its role from the text. */
export function stripMention(text: string, botId: string, botRoleId?: string | null): string {
  return text
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .replace(botRoleId ? new RegExp(`<@&${botRoleId}>`, "g") : /$^/, "")
    .trim();
}

/**
 * Which calls a reconnect has to replay, oldest first.
 *
 * The gateway is a live connection, not a queue. discord.js resumes it when
 * it can, but a resume only replays from the sequence it kept, and when the
 * session is too old to resume the bot re-identifies and gets nothing. So
 * this picks the calls newer than `floor` that haven't been handled and puts
 * them back in the order they happened.
 */
export function toReplay<T extends { id: string }>(calls: T[], isSeen: (id: string) => boolean, floor: bigint, limit: number): T[] {
  return calls
    .filter((m) => /^\d+$/.test(m.id) && BigInt(m.id) > floor)
    .filter((m) => !isSeen(m.id))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))
    .slice(0, limit);
}

/**
 * Can the bot work in this channel? Guild text channels and their threads
 * only, filtered by GUILD_ID, CHANNEL_IDS and WORKSPACES — a thread counts
 * as its parent channel.
 */
export function usable(channel: Channel | null | undefined): channel is WorkChannel {
  if (!channel || (channel.type !== ChannelType.GuildText && !channel.isThread())) return false;
  if (config.guildId && channel.guildId !== config.guildId) return false;
  const parentId = channel.isThread() ? channel.parentId : channel.id;
  if (config.channelIds.size && (!parentId || !(config.channelIds.has(parentId) || config.workspaces.has(parentId)))) return false;
  return true;
}

function posted(msg: Message, link: (text: string) => string): Posted {
  return {
    edit: (text) => msg.edit({ content: link(text), components: [] }),
    delete: () => msg.delete(),
  };
}

/**
 * A Discord channel or thread as a `ChatSpace`. `link` turns `@peer` in the
 * text into a real mention of another bot.
 */
export function discordSpace(channel: WorkChannel, link: (text: string) => string = (t) => t): ChatSpace {
  return {
    id: channel.id,
    surface: "discord",
    label: "Discord",
    maxLength: MAX_LENGTH,
    maxChoices: 25,
    async send(text, opts = {}) {
      const files = opts.files ?? [];
      if (!opts.replyTo && !files.length) return posted(await channel.send(link(text)), link);
      return posted(
        await channel.send({
          content: link(text),
          // A reply that doesn't ping; a plain send if that message is gone.
          ...(opts.replyTo
            ? { reply: { messageReference: opts.replyTo, failIfNotExists: false }, allowedMentions: { repliedUser: false } }
            : {}),
          ...(files.length ? { files } : {}),
        }),
        link,
      );
    },
    sendTyping: () => channel.sendTyping(),
    async choose(text, kind, choices, timeoutMs, placeholder) {
      const msg = await channel.send({ content: link(text), components: [components(kind, choices, placeholder)] });
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
            update: (t) => i.update({ content: link(t), components: [] }),
          }),
        );
      return { msg: posted(msg, link), pick };
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

/** Answer calls on Discord. One instance per process; the sockets live in `client`. */
export class Discord {
  readonly client: Client;
  private botId = "";
  /** The bot's own role in each guild: Discord's autocomplete mentions it instead of the user. */
  private botRoles = new Map<string, string | null>();
  /** Recent message ids, so a redelivered or replayed event isn't answered twice. */
  private seen = new Set<string>();
  /** Peer bots by lowercase name → user id, so `@name` in an answer becomes a mention. */
  private peers = new Map<string, string>();
  /** Answers to peer bots per thread (see src/peers.ts). */
  private budget = new TurnBudget(config.peerTurns);
  /** Spaces where "allow more turns?" is already asked. */
  private asking = new Set<string>();
  /** Newest message id handled, so a reconnect knows the gap it has to fill. */
  private highWater = 0n;
  private catchingUp = false;

  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    });
  }

  async start(): Promise<void> {
    this.client.on(Events.Error, (err) => console.error("discord gateway error", err));
    this.client.on(Events.MessageCreate, (message) => void this.onEvent(message));
    this.client.once(Events.ClientReady, (c) => void this.onReady(c));
    // Every reconnect, not just the first one. A resume replays the gateway's
    // own events (the `seen` set drops any overlap); a re-identify, which is
    // what a session too old to resume turns into, brings none of them. Both
    // fill the gap from history. `ClientReady` itself only fires once per
    // process, so the shard events are what a reconnect announces itself on.
    this.client.on(Events.ShardResume, () => void this.catchUp());
    this.client.on(Events.ShardReady, () => void this.catchUp());
    await this.client.login(config.token!);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async onReady(c: Client): Promise<void> {
    if (!c.user) return;
    this.botId = c.user.id;
    // A re-identify may have happened on another shard or after a guild change.
    this.botRoles.clear();
    console.log(`Discord: logged in as ${c.user.tag}`);
    await this.checkPeers();
    await this.catchUp();
  }

  /**
   * Warn about PEER_BOT_IDS entries that aren't bots, and learn their names so
   * an answer can `@` them. A peer we can't look up is still recognised when
   * it writes (its own message says it's a bot), so a missing user here is a
   * warning, not a reason to ignore it later.
   */
  private async checkPeers(): Promise<void> {
    for (const id of config.peerBotIds) {
      if (id === this.botId) continue;
      const user = await this.client.users.fetch(id).catch(() => null);
      if (!user) {
        console.error(`PEER_BOT_IDS: can't look up ${id}; a peer that writes is still answered.`);
        continue;
      }
      if (!user.bot) {
        console.error(`PEER_BOT_IDS: ${id} is ${user.username}, not a bot; it stays a person here.`);
        continue;
      }
      this.rememberPeer(user.username, id);
    }
    if (this.peers.size) {
      console.log(
        `Discord: peer bots ${[...new Set(this.peers.keys())].map((n) => "@" + n).join(", ")} (${config.peerTurns} turns per thread)`,
      );
    }
  }

  /** Remember a peer's name, so `@name` in an answer becomes a real mention. */
  private rememberPeer(name: string, id: string): void {
    // Only names the mention regex in src/peers.ts can match.
    if (/^[\w.-]+$/.test(name)) this.peers.set(name.toLowerCase(), id);
  }

  /** Discord markdown, with `@peer` turned into a real mention. */
  private link = (md: string) => linkMentions(md, this.peers);

  private space(channel: WorkChannel): ChatSpace {
    return discordSpace(channel, this.link);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private async onEvent(message: Message) {
    // A resumed gateway can redeliver, and a catch-up replays what a live
    // event may also deliver: a mention is answered once.
    if (this.seen.has(message.id)) return;
    this.remember(message.id);
    // Anything that arrives is proof it arrived: the high-water mark is what
    // a reconnect treats as "everything before this was delivered".
    this.mark(message.id);
    try {
      await this.onMessage(message);
    } catch (err) {
      console.error("message handler failed", err);
      await message.reply("Something went wrong on my side. Check the bot's terminal.").catch(() => {});
    }
  }

  private remember(id: string) {
    this.seen.add(id);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
  }

  private mark(id: string) {
    if (!/^\d+$/.test(id)) return;
    const n = BigInt(id);
    if (n > this.highWater) this.highWater = n;
  }

  private async onMessage(message: Message) {
    if (!message.author?.id || message.author.id === this.botId) return;
    // Bots are ignored, except confirmed peers (PEER_BOT_IDS). Discord's own
    // `bot` flag decides, so a person listed there is still a person.
    const from = peerCall(message.author, config.peerBotIds);
    if (from === "ignore") return;
    const peer = from;
    const channel = message.channel;
    if (!usable(channel)) return;
    const space = channel as WorkChannel;
    const roleId = this.botRole(space.guild);
    if (!isCall(message, this.botId, config.peerBotIds, roleId)) return;
    console.log(`[discord] ${message.author.username} (${message.author.id}) in ${space.id}: ${message.content.slice(0, 80)}`);

    const parentId = space.isThread() ? space.parentId : space.id;
    if (peer) this.rememberPeer(message.author.username, message.author.id);
    let text = stripMention(message.content, this.botId, roleId);
    if (!peer) this.budget.reset(space.id);
    else if (!(await this.peerTurn(space))) return;
    if (peer) {
      text += `\n\n(${message.author.username} is a bot. To answer it, mention @${message.author.username}; leave the mention out to end the conversation.)`;
    }
    await handleCall(
      {
        space: this.space(space),
        userId: message.author.id,
        author: authorName(message),
        peer,
        messageId: message.id,
        text,
        files: [...message.attachments.values()],
        workdir: workdirFor(parentId),
        reply: (t) => message.reply(t),
        context: ({ linked, seen }) => gatherContext({ space: space as unknown as SpaceLike, before: message.id, botId: this.botId, linked, seen }),
        replyTo: () => fetchReplyTo(message, this.botId),
      },
      HELP,
    );
  }

  /**
   * Use one peer turn here. When they're spent, ask an allowed user
   * (Yes / No) for more; `false` = don't answer.
   */
  private async peerTurn(channel: WorkChannel): Promise<boolean> {
    const space = this.space(channel);
    if (this.budget.take(space.id)) return true;
    if (this.asking.has(space.id)) return false;
    this.asking.add(space.id);
    try {
      const n = config.peerTurns;
      const { msg, pick } = await space.choose(
        `I've answered the other bot ${this.budget.used(space.id)} times in this thread. Allow ${n} more turns?`,
        "buttons",
        [
          { label: `Yes, ${n} more`, value: "yes", style: "primary" },
          { label: "No, stop", value: "no", style: "danger" },
        ],
        config.approvalTimeoutMs,
      );
      const picked = await pick.catch(() => null);
      if (!picked) {
        await msg.edit("No answer, so the bots stop talking here.").catch(() => {});
        return false;
      }
      if (picked.value !== "yes") {
        await picked.update(`${picked.user} said stop. The bots stop talking here.`).catch(() => {});
        return false;
      }
      await picked.update(`${picked.user} allowed ${n} more turns.`).catch(() => {});
      this.budget.grant(space.id);
      return this.budget.take(space.id);
    } finally {
      this.asking.delete(space.id);
    }
  }

  // ── Catch-up ───────────────────────────────────────────────────────────────

  /**
   * Answer the mentions a dropped gateway swallowed.
   *
   * The gateway is a live connection, not a queue: discord.js resumes it when
   * it can, but only from the sequence it kept, and a session that can't be
   * resumed brings nothing at all. So on every reconnect we ask Discord what
   * was said after the high-water mark and put the missed mentions through
   * the same door as a live one.
   */
  private async catchUp(): Promise<void> {
    if (this.catchingUp || !this.highWater || config.catchUpMinutes <= 0) return;
    this.catchingUp = true;
    try {
      const missed = await this.missed();
      if (!missed.length) return;
      console.log(`[discord] caught up: ${missed.length} mention(s) missed while the gateway was down`);
      for (const message of missed) {
        // Marked before the answer, not after: a mention is answered once,
        // however long the answer takes.
        this.remember(message.id);
        try {
          await this.onMessage(message);
        } catch (err) {
          console.log(`[discord] caught-up message ${message.id} failed: ${err}`);
        }
      }
    } catch (err) {
      console.log(`[discord] catch-up failed: ${err}`);
    } finally {
      this.catchingUp = false;
    }
  }

  /** Every call said since the high-water mark, oldest first. */
  private async missed(): Promise<Message[]> {
    const floor = this.floor();
    const calls: Message[] = [];
    for (const channel of await this.channels()) {
      const roleId = this.botRole(channel.guild);
      for (const m of await this.after(channel, floor)) {
        if (isCall(m, this.botId, config.peerBotIds, roleId)) calls.push(m);
      }
    }
    return toReplay(calls, (id) => this.seen.has(id), floor, config.catchUpMax);
  }

  /** The oldest id worth replaying: the high-water mark, or `CATCHUP_MINUTES` back. */
  private floor(): bigint {
    const back = snowflakeAt(Date.now() - config.catchUpMinutes * 60_000);
    return this.highWater > back ? this.highWater : back;
  }

  /**
   * Channels to search: the configured allowlist, or every guild text channel
   * and thread the bot can see. The list is refetched, because a thread
   * started while the gateway was down isn't in the cache and a mention in it
   * would be missed for good.
   */
  private async channels(): Promise<WorkChannel[]> {
    const out: WorkChannel[] = [];
    const added = new Set<string>();
    const add = (channel: Channel | null | undefined) => {
      if (!usable(channel) || added.has(channel.id)) return;
      added.add(channel.id);
      out.push(channel);
    };
    const allowed = [...config.channelIds];
    if (allowed.length) {
      for (const id of allowed) add(await this.client.channels.fetch(id).catch(() => null));
      return out;
    }
    for (const guild of this.client.guilds.cache.values()) {
      const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
      for (const channel of channels.values()) add(channel);
    }
    return out;
  }

  /**
   * Messages in a channel sent after `floor`, oldest last page first.
   * Unreadable history → none, so one channel we can't read doesn't cost the
   * whole catch-up. Capped like Slack's, so a long outage can't stampede.
   */
  private async after(channel: WorkChannel, floor: bigint): Promise<Message[]> {
    const out: Message[] = [];
    const cap = config.catchUpMax * 4;
    try {
      let after = floor.toString();
      while (out.length < cap) {
        const batch = await channel.messages.fetch({ after, limit: 100 });
        const page = [...batch.values()];
        if (!page.length) break;
        out.push(...page);
        // Newest first, so the oldest id of the page is where the next starts.
        const oldest = page.reduce((a, b) => (BigInt(a.id) < BigInt(b.id) ? a : b));
        if (BigInt(oldest.id) <= floor || batch.size < 100) break;
        after = oldest.id;
      }
    } catch (err) {
      console.log(
        `[discord] can't read history in ${channel.id} (needs Read Message History): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return out;
  }

  private botRole(guild: Guild | null): string | null {
    if (!guild) return null;
    let id = this.botRoles.get(guild.id);
    if (id === undefined) {
      id = guild.members.me?.roles.botRole?.id ?? null;
      this.botRoles.set(guild.id, id);
    }
    return id;
  }
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

/** Log in and answer calls. Resolves once connected; returns a stop function. */
export async function startDiscord(): Promise<() => Promise<void>> {
  const discord = new Discord();
  await discord.start();
  return () => discord.stop();
}