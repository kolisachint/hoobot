/**
 * Slack surface, over Socket Mode (an outbound WebSocket: no public URL).
 *
 * - A space is a channel (top-level messages) or a thread in it
 *   (`<channel>/<thread ts>`); each has its own conversation, as on Discord.
 * - Mention the bot to call it. Slack has no message replies, so replying
 *   to the bot isn't a call; mention it in a thread instead.
 * - Context, files, `!` commands, approval buttons and the model menu work
 *   as on Discord (src/core.ts, src/session.ts). Text is converted to Slack
 *   mrkdwn on the way out (src/mrkdwn.ts).
 */
import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { readFileSync } from "node:fs";
import { config, workdirFor } from "./config.ts";
import { gatherContext, type MessageLike, type SpaceLike } from "./context.ts";
import type { ChatSpace, Choice, Picked, Posted } from "./chat.ts";
import { handleCall, helpText } from "./core.ts";
import { fromMrkdwn, toMrkdwn as mrkdwn } from "./mrkdwn.ts";
import { linkMentions, TurnBudget } from "./peers.ts";
import type { AttachmentLike, Fetcher } from "./inbound.ts";
import { log, error, warn } from "./log.ts";

const HELP = helpText("Slack", "a menu");

/**
 * Slack takes 40k characters but cuts long messages off behind "Show more";
 * and a section block holds 3000. Text is split before conversion, which
 * adds a little (escaping, links).
 */
const MAX_LENGTH = 2900;

/** A Slack message as the Web API returns it (the fields read here). */
export type SlackMessage = {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  subtype?: string;
  text?: string;
  files?: SlackFile[];
};

export type SlackFile = {
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
};

/** Message subtypes that are someone talking (others: joins, topic changes, ...). */
const USER_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast", "bot_message", "me_message"]);

export function slackFiles(files: SlackFile[] | undefined): AttachmentLike[] {
  return (files ?? [])
    .filter((f) => f.url_private_download || f.url_private)
    .map((f) => ({
      name: f.name ?? f.title ?? null,
      url: (f.url_private_download ?? f.url_private)!,
      size: f.size ?? 0,
      contentType: f.mimetype ?? null,
    }));
}

/**
 * Which mentions a reconnect has to replay, oldest first.
 *
 * A dropped socket loses events: Slack doesn't replay them, so a mention
 * that arrived while the websocket was flapping is simply gone. This picks
 * the ones a reconnect owes an answer to — a mention of us, from someone
 * else, newer than `since`, that we haven't already handled.
 *
 * `isSeen` is asked about `<channel>:<ts>` so a mention that *did* arrive
 * (or that a previous catch-up already answered) isn't answered twice.
 */
export function toReplay(
  messages: SlackMessage[],
  channel: string,
  botUserId: string,
  isSeen: (key: string) => boolean,
  since: number,
  limit: number,
): SlackMessage[] {
  return messages
    .filter((m) => Number(m.ts) > since)
    .filter((m) => USER_SUBTYPES.has(m.subtype))
    .filter((m) => !!m.user && m.user !== botUserId)
    .filter((m) => stripMention(m.text ?? "", botUserId) !== null)
    .filter((m) => !isSeen(`${channel}:${m.ts}`))
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .slice(0, limit);
}

/** A space id: the channel, or `<channel>/<thread ts>` for a thread. */
export function slackSpaceId(channel: string, threadTs?: string | null): string {
  return threadTs ? `${channel}/${threadTs}` : channel;
}

/** Remove the bot's mention; `null` when the text doesn't mention it. */
export function stripMention(text: string, botUserId: string): string | null {
  const re = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");
  if (!re.test(text)) return null;
  return text.replace(re, "").trim();
}

/**
 * Is this message from a peer bot? `botIds` holds PEER_BOT_IDS that Slack
 * confirmed are bots, so a person listed there by mistake stays a person.
 * Bots that aren't peers are ignored (`true` = drop).
 */
export function peerCall(event: { user?: string; bot_id?: string }, botIds: Set<string>): boolean | "ignore" {
  const peer = !!event.user && botIds.has(event.user);
  if (!!event.bot_id && !peer) return "ignore";
  return peer;
}

type Pending = { allowed: (userId: string) => boolean; resolve: (p: Picked) => void; choices: Choice[] };

export class Slack {
  readonly web: WebClient;
  private socket: SocketModeClient;
  private botUserId = "";
  private names = new Map<string, Promise<string>>();
  private channelNames = new Map<string, Promise<string>>();
  /** Open buttons and menus, by the id in their action ids. */
  private pending = new Map<string, Pending>();
  /** Recent event ids, so a redelivered event isn't answered twice. */
  private seen = new Set<string>();
  private nonce = 0;
  /** Peer bots by lowercase name → user id, so `@name` in an answer becomes a mention. */
  private peers = new Map<string, string>();
  /**
   * PEER_BOT_IDS that Slack confirms are bots. A person listed there by
   * mistake must stay a person: a peer may not run `!` commands and spends
   * the peer turn budget, so treating an owner as a peer makes their
   * commands vanish.
   */
  private peerBotIds = new Set<string>();
  /** Answers to peer bots per thread (see src/peers.ts). */
  private budget = new TurnBudget(config.peerTurns);
  /** Spaces where "allow more turns?" is already asked. */
  private asking = new Set<string>();
  /** Newest event ts handled, so a reconnect knows the gap it has to fill. */
  private highWater = 0;
  /** Threads this process has seen, so a mention in an old one is still found. */
  private threads = new Set<string>();
  private catchingUp = false;

  constructor(botToken: string, appToken: string) {
    this.web = new WebClient(botToken, { logLevel: LogLevel.ERROR });
    this.socket = new SocketModeClient({ appToken, logLevel: config.debug ? LogLevel.DEBUG : LogLevel.WARN });
  }

  /** Downloads Slack files: they need the bot token. */
  readonly fetcher: Fetcher = (url) =>
    fetch(url, { headers: { Authorization: `Bearer ${config.slackBotToken}` } }).then((res) => {
      // Without `files:read`, Slack answers with its sign-in page instead of the file.
      if (res.ok && res.headers.get("content-type")?.startsWith("text/html") && !/\.html?($|\?)/i.test(url)) {
        throw new Error("Slack sent a web page instead of the file (does the app have the files:read scope?)");
      }
      return res;
    });

  async start(): Promise<void> {
    const auth = await this.web.auth.test();
    this.botUserId = String(auth.user_id);
    for (const id of config.peerBotIds) {
      if (id === this.botUserId) continue;
      const info: any = await this.web.users.info({ user: id }).catch(() => null);
      if (!info) {
        error(`PEER_BOT_IDS: can't look up ${id}`);
        continue;
      }
      if (!info.user?.is_bot) {
        error(`PEER_BOT_IDS: ${id} is ${info.user?.name ?? "not a bot"}, not a bot; ignoring it as a peer.`);
        continue;
      }
      this.peerBotIds.add(id);
      for (const n of [info.user.name, info.user.profile?.display_name, info.user.real_name]) {
        if (n && /^[\w.-]+$/.test(n)) this.peers.set(String(n).toLowerCase(), id);
      }
    }
    this.socket.on("message", (e: any) => this.onEvent(e));
    this.socket.on("interactive", (e: any) => this.onInteractive(e));
    // Every reconnect, not just the first connect: `catchUp` is a no-op
    // until an event has been handled, so the first `connected` does nothing.
    this.socket.on("connected", () => void this.catchUp());
    await this.socket.start();
    log(`Slack: logged in as @${auth.user} in ${auth.team}`);
    if (this.peers.size) log(`Slack: peer bots ${[...new Set(this.peers.keys())].map((n) => "@" + n).join(", ")} (${config.peerTurns} turns per thread)`);
  }

  async stop(): Promise<void> {
    await this.socket.disconnect().catch(() => {});
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private async onEvent({ ack, event, envelope_id }: { ack: () => Promise<void>; event: any; envelope_id: string }) {
    // A failed ack means Slack redelivers, so it is worth knowing about: the
    // handler may run twice and the user may see a duplicate answer.
    await ack().catch((err) => warn(`slack ack failed for ${envelope_id}: ${err instanceof Error ? err.message : String(err)}`));
    if (this.seen.has(envelope_id) || this.seen.has(`${event?.channel}:${event?.ts}`)) return;
    this.remember(envelope_id);
    this.remember(`${event?.channel}:${event?.ts}`);
    // Anything that arrives is proof it arrived: the high-water mark is
    // what a reconnect treats as "everything before this was delivered".
    const ts = Number(event?.ts);
    if (Number.isFinite(ts) && ts > this.highWater) this.highWater = ts;
    try {
      await this.onMessage(event);
    } catch (err) {
      error("slack message handler failed", err);
      await this.web.chat
        .postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: "Something went wrong on my side. Check the bot's terminal.",
        })
        .catch(() => {});
    }
  }

  private remember(key: string) {
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
  }

  private async onMessage(event: any) {
    if (!event || !event.user || event.user === this.botUserId) return;
    // Bots are ignored, except confirmed peers (PEER_BOT_IDS). `peerBotIds`
    // holds only ids Slack says are bots, so a person in PEER_BOT_IDS is
    // still a person here.
    const from = peerCall(event, this.peerBotIds);
    if (from === "ignore") return;
    const peer = from;
    if (!USER_SUBTYPES.has(event.subtype)) return;
    // Channels and private channels only, like Discord's text channels.
    if (event.channel_type !== "channel" && event.channel_type !== "group") return;
    const channel: string = event.channel;
    if (config.channelIds.size && !(config.channelIds.has(channel) || config.workspaces.has(channel))) return;

    const text = stripMention(event.text ?? "", this.botUserId);
    if (text === null) return;
    log(`[slack] ${event.user} in ${channel}: ${String(event.text ?? "").slice(0, 80)}`);

    const threadTs: string | undefined = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined;
    if (threadTs) this.threads.add(slackSpaceId(channel, threadTs));
    const space = this.space(channel, threadTs);
    if (!peer) this.budget.reset(space.id);
    else if (!(await this.peerTurn(space))) return;
    const history = this.history(channel, threadTs);
    const author = await this.name(event.user);
    let said = fromMrkdwn(text, (id) => this.cachedName(id));
    if (peer) {
      said += `\n\n(${author} is a bot. To answer it, mention @${author}; leave the mention out to end the conversation.)`;
    }
    await handleCall(
      {
        space,
        userId: event.user,
        author,
        peer,
        messageId: event.ts,
        text: said,
        files: slackFiles(event.files),
        workdir: workdirFor(channel),
        reply: (t) => space.send(t),
        context: async ({ linked, seen }) =>
          gatherContext({ space: await history, before: event.ts, botId: this.botUserId, linked, seen, surface: "slack" }),
        fetcher: this.fetcher,
      },
      HELP,
    );
  }

  /**
   * Use one peer turn here. When they're spent, ask an allowed user
   * (Yes / No) for more; `false` = don't answer.
   */
  private async peerTurn(space: ChatSpace): Promise<boolean> {
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

  /** Slack mrkdwn, with `@peer` turned into a real mention. */
  private toMrkdwn = (md: string) => linkMentions(mrkdwn(md), this.peers);

  // ── Spaces ─────────────────────────────────────────────────────────────────

  /** A Slack channel or thread as a `ChatSpace`. */
  space(channel: string, threadTs?: string): ChatSpace {
    const web = this.web;
    const toMrkdwn = this.toMrkdwn;
    const posted = (ts: string | undefined): Posted => ({
      // No ts (a file upload): reject, so a caller that edits in place falls back to posting.
      edit: (text) =>
        ts ? web.chat.update({ channel, ts, text: toMrkdwn(text), blocks: [] }) : Promise.reject(new Error("no message to edit")),
      delete: () => (ts ? web.chat.delete({ channel, ts }) : Promise.resolve()),
    });
    return {
      id: slackSpaceId(channel, threadTs),
      surface: "slack",
      label: "Slack",
      maxLength: MAX_LENGTH,
      maxChoices: 100,
      async send(text, opts = {}) {
        const files = opts.files ?? [];
        if (files.length) {
          // One message with the text and the files. Upload completes on
          // Slack's side, so there's no message to edit later.
          await web.filesUploadV2({
            channel_id: channel,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            initial_comment: toMrkdwn(text),
            file_uploads: files.map((f) => ({ file: readFileSync(f.attachment), filename: f.name })),
          });
          return posted(undefined);
        }
        const res = await web.chat.postMessage({
          channel,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: toMrkdwn(text),
          unfurl_links: false,
          unfurl_media: false,
        });
        return posted(res.ts);
      },
      // Slack has no typing indicator for bots; the status line shows progress.
      sendTyping: async () => {},
      choose: async (text, kind, choices, timeoutMs, placeholder) => {
        const id = String(++this.nonce);
        const res = await web.chat.postMessage({
          channel,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: toMrkdwn(text),
          blocks: choiceBlocks(id, toMrkdwn(text), kind, choices, placeholder),
        });
        const msg = posted(res.ts);
        const pick = new Promise<Picked>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error("timeout"));
          }, timeoutMs);
          this.pending.set(id, {
            choices,
            allowed: (u) => config.allowedUserIds.has(u),
            resolve: (p) => {
              clearTimeout(timer);
              this.pending.delete(id);
              resolve(p);
            },
          });
        });
        return { msg, pick };
      },
    };
  }

  /**
   * Answer the mentions a dropped socket swallowed.
   *
   * Socket Mode is a live websocket, not a queue: when it drops, the events
   * in the gap are gone, and the reconnect that fixes the socket brings none
   * of them back. So on every reconnect we ask Slack what was said after the
   * high-water mark and put the missed mentions through the same door as a
   * live one.
   */
  private async catchUp(): Promise<void> {
    if (this.catchingUp || !this.highWater || config.catchUpMinutes <= 0) return;
    this.catchingUp = true;
    try {
      const missed = await this.missed();
      if (!missed.length) return;
      log(`[slack] caught up: ${missed.length} mention(s) missed while the socket was down`);
      for (const { channel, channelType, message } of missed) {
        // Marked before the answer, not after: a mention is answered once,
        // however long the answer takes.
        this.remember(`${channel}:${message.ts}`);
        try {
          await this.onMessage({ ...message, channel, channel_type: channelType });
        } catch (err) {
          log(`[slack] caught-up message ${channel}:${message.ts} failed: ${err}`);
        }
      }
    } catch (err) {
      log(`[slack] catch-up failed: ${err}`);
    } finally {
      this.catchingUp = false;
    }
  }

  /** Every mention of us since the high-water mark, oldest first. */
  private async missed(): Promise<Array<{ channel: string; channelType: string; message: SlackMessage }>> {
    const floor = Math.max(this.highWater, (Date.now() - config.catchUpMinutes * 60_000) / 1000);
    const out: Array<{ channel: string; channelType: string; message: SlackMessage }> = [];
    for (const channel of await this.channels()) {
      const channelType = await this.channelType(channel);
      const isSeen = (key: string) => this.seen.has(key);
      const pick = (messages: SlackMessage[]) => {
        for (const message of toReplay(messages, channel, this.botUserId, isSeen, floor, config.catchUpMax)) {
          out.push({ channel, channelType, message });
        }
      };

      const starters = await this.historySince(channel, floor);
      pick(starters);
      // A mention in a thread arrives as a reply and `conversations.history`
      // only returns top-level messages, so each thread in the gap is opened.
      for (const starter of starters) pick((await this.repliesSince(channel, starter.ts, floor)).slice(1));
      // Threads from before the gap aren't in `history`, but a live
      // conversation can still get a mention in one while we're disconnected.
      for (const space of this.threads) {
        const [threadChannel, threadTs] = space.split("/");
        if (threadChannel !== channel || !threadTs) continue;
        pick((await this.repliesSince(threadChannel, threadTs, floor)).slice(1));
      }
    }
    // Channels answer newest-first and a message can be reached twice (a
    // starter, and a reply in an older thread), so order and dedupe once.
    const unique = new Map(out.map((m) => [`${m.channel}:${m.message.ts}`, m]));
    return [...unique.values()].sort((a, b) => Number(a.message.ts) - Number(b.message.ts)).slice(0, config.catchUpMax);
  }

  /** Channels to search: the ones we're in, or the configured allowlist. */
  private async channels(): Promise<string[]> {
    const allowed = [...config.channelIds];
    if (allowed.length) return allowed;
    const res: any = await this.web.users.conversations({ types: "public_channel,private_channel", limit: 500 });
    return res.ok ? ((res.channels ?? []) as Array<{ id: string }>).map((c) => c.id) : [];
  }

  /** `channel` or `group`, for the `channel_type` a live event carries. */
  private async channelType(channel: string): Promise<string> {
    const res: any = await this.web.conversations.info({ channel });
    if (res?.channel?.is_group) return "group";
    if (res?.channel?.is_im || res?.channel?.is_mpim) return "im";
    return "channel";
  }

  /** Top-level messages of a channel sent after `since`. */
  private async historySince(channel: string, since: number): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for (let cursor: string | undefined; out.length < config.catchUpMax * 4; ) {
      const res: any = await this.web.conversations.history({
        channel,
        oldest: since.toFixed(6),
        inclusive: false,
        limit: 200,
        cursor,
      });
      out.push(...((res.messages ?? []) as SlackMessage[]));
      cursor = res.has_more ? res.response_metadata?.next_cursor || undefined : undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** A thread's messages after `since`, the parent first (Slack returns it that way). */
  private async repliesSince(channel: string, ts: string, since: number): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for (let cursor: string | undefined; out.length < config.catchUpMax * 4; ) {
      const res: any = await this.web.conversations.replies({
        channel,
        ts,
        oldest: since.toFixed(6),
        inclusive: false,
        limit: 200,
        cursor,
      });
      out.push(...((res.messages ?? []) as SlackMessage[]));
      cursor = res.has_more ? res.response_metadata?.next_cursor || undefined : undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** Clicks on buttons and menus. */
  private async onInteractive({ ack, body }: { ack: () => Promise<void>; body: any }) {
    await ack().catch(() => {});
    if (body?.type !== "block_actions") return;
    const action = body.actions?.[0];
    const [prefix, id] = String(action?.action_id ?? "").split(":");
    if (prefix !== "hoo" || !id) return;
    const channel = body.channel?.id ?? body.container?.channel_id;
    const ts = body.message?.ts ?? body.container?.message_ts;
    const pending = this.pending.get(id);
    if (!pending) return; // answered, timed out, or from before a restart
    const userId: string = body.user?.id;
    if (!pending.allowed(userId)) {
      await this.web.chat
        .postEphemeral({
          channel,
          user: userId,
          text: "Only allowed users can answer this.",
          ...(body.message?.thread_ts ? { thread_ts: body.message.thread_ts } : {}),
        })
        .catch(() => {});
      return;
    }
    const value: string | undefined = action.selected_option?.value ?? action.value;
    if (value === undefined) return;
    pending.resolve({
      value,
      user: body.user?.username ?? body.user?.name ?? (await this.name(userId)),
      userId,
      update: (text) => this.web.chat.update({ channel, ts, text: this.toMrkdwn(text), blocks: [] }),
    });
  }

  // ── History (context) ──────────────────────────────────────────────────────

  /** The space's history in the shape src/context.ts reads. */
  async history(channel: string, threadTs?: string): Promise<SpaceLike> {
    const name = await this.channelName(channel);
    const channelHistory = {
      id: channel,
      messages: {
        fetch: async ({ before, limit }: { before: string; limit: number }) => {
          const res = await this.web.conversations.history({ channel, latest: before, inclusive: false, limit });
          return this.toLike((res.messages ?? []) as SlackMessage[]);
        },
      },
    };
    if (!threadTs) {
      return { ...channelHistory, name, isThread: () => false };
    }
    return {
      id: slackSpaceId(channel, threadTs),
      isThread: () => true,
      threadStart: threadTs,
      parent: { ...channelHistory, name },
      messages: {
        fetch: async ({ before, limit }) => {
          const replies = (await this.replies(channel, threadTs, before)).filter((m) => m.ts !== threadTs);
          return this.toLike(replies.slice(-limit));
        },
      },
      fetchStarterMessage: async () => {
        const res = await this.web.conversations.replies({ channel, ts: threadTs, limit: 1, inclusive: true });
        const first = (res.messages ?? [])[0] as SlackMessage | undefined;
        if (!first || first.ts !== threadTs) return null;
        return (await this.toLike([first])).get(first.ts) ?? null;
      },
    };
  }

  /** A thread's replies before `before`, oldest first (all pages, up to 1000). */
  private async replies(channel: string, ts: string, before: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await this.web.conversations.replies({ channel, ts, latest: before, inclusive: false, limit: 200, cursor });
      out.push(...((res.messages ?? []) as SlackMessage[]));
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor || !res.has_more) break;
    }
    return out;
  }

  private async toLike(messages: SlackMessage[]): Promise<Map<string, MessageLike>> {
    const out = new Map<string, MessageLike>();
    const ids = [...new Set(messages.map((m) => m.user).filter((u): u is string => !!u))];
    await Promise.all(ids.map((u) => this.name(u)));
    for (const m of messages) out.set(m.ts, toMessageLike(m, (u) => this.cachedName(u)));
    return out;
  }

  // ── Names ──────────────────────────────────────────────────────────────────

  private resolved = new Map<string, string>();

  private cachedName(userId: string): string | undefined {
    return this.resolved.get(userId);
  }

  /** A user's display name (cached); their id when it can't be looked up. */
  name(userId: string): Promise<string> {
    let p = this.names.get(userId);
    if (!p) {
      p = this.web.users
        .info({ user: userId })
        .then((r: any) => {
          const name = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || userId;
          this.resolved.set(userId, name);
          return name;
        })
        .catch(() => userId);
      this.names.set(userId, p);
    }
    return p;
  }

  private channelName(channel: string): Promise<string> {
    let p = this.channelNames.get(channel);
    if (!p) {
      p = this.web.conversations
        .info({ channel })
        .then((r: any) => r.channel?.name ?? channel)
        .catch(() => channel);
      this.channelNames.set(channel, p);
    }
    return p;
  }
}

/** A Slack message in the shape src/context.ts reads. */
export function toMessageLike(m: SlackMessage, name: (userId: string) => string | undefined): MessageLike {
  const bot = !!m.bot_id;
  const username = (m.user && name(m.user)) || m.username || m.bot_profile?.name || m.user || "someone";
  return {
    id: m.ts,
    // 0 = someone talking; 7 (any other) = joins, topic changes, ...
    type: USER_SUBTYPES.has(m.subtype) ? 0 : 7,
    author: { id: m.user ?? m.bot_id ?? "", bot, username },
    member: null,
    cleanContent: fromMrkdwn(m.text ?? "", name),
    attachments: new Map(slackFiles(m.files).map((f, i) => [String(i), { name: f.name }])),
    embeds: [],
    createdTimestamp: Math.round(Number(m.ts) * 1000),
  };
}

/** Block Kit for `choose`: the text, then buttons or a menu. */
export function choiceBlocks(id: string, text: string, kind: "buttons" | "menu", choices: Choice[], placeholder?: string): any[] {
  const plain = (t: string, max: number) => ({ type: "plain_text", text: t.length > max ? t.slice(0, max - 1) + "…" : t, emoji: true });
  const section = { type: "section", text: { type: "mrkdwn", text: text.slice(0, 3000) } };
  if (kind === "buttons") {
    return [
      section,
      {
        type: "actions",
        elements: choices.map((c, i) => ({
          type: "button",
          action_id: `hoo:${id}:${i}`,
          text: plain(c.label, 75),
          value: c.value.slice(0, 2000),
          ...(c.style ? { style: c.style } : {}),
        })),
      },
    ];
  }
  const options = choices.slice(0, 100).map((c) => ({
    text: plain(c.label, 75),
    value: c.value.slice(0, 150),
    ...(c.description ? { description: plain(c.description, 75) } : {}),
  }));
  const initial = choices.findIndex((c) => c.default);
  return [
    section,
    {
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: `hoo:${id}:menu`,
          placeholder: plain(placeholder ?? "Pick one", 150),
          options,
          ...(initial >= 0 && initial < options.length ? { initial_option: options[initial] } : {}),
        },
      ],
    },
  ];
}

/** Connect to Slack and answer calls; returns a stop function. */
export async function startSlack(): Promise<() => Promise<void>> {
  const slack = new Slack(config.slackBotToken!, config.slackAppToken!);
  await slack.start();
  return () => slack.stop();
}
