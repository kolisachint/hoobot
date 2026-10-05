import { expect, test } from "bun:test";

// Set outright, not ??=: the shell a bot runs in exports DISCORD_TOKEN (often
// empty) and MODEL, and `??=` would leave those in place.
process.env.DISCORD_TOKEN = "x";
process.env.ALLOWED_USER_IDS = "1";
// Also pinned here, because this file is often the first to load config.ts and
// a module is only evaluated once per process — whichever test file gets there
// first decides the value every later file sees.
process.env.MODEL = "";
process.env.GUILD_ID = "";
process.env.CHANNEL_IDS = "";
process.env.WORKSPACES = "";
process.env.PEER_BOT_IDS = "";
process.env.PEER_TURNS = "2";
process.env.CATCHUP_MINUTES = "1440";
process.env.CATCHUP_MAX = "20";

const { Discord, discordSpace, isCall, peerCall, snowflakeAt, snowflakeTime, stripMention, toReplay, usable } = await import(
  "../src/discord.ts"
);
const { config } = await import("../src/config.ts");
const { linkMentions } = await import("../src/peers.ts");

const BOT = "BOT1";
const PEERS = new Set(["PEER1"]);

/** A message in the shape isCall reads. */
function msg(o: Partial<Parameters<typeof isCall>[0]> & { id?: string } = {}) {
  return {
    id: o.id ?? "1",
    content: o.content ?? "",
    author: o.author ?? { id: "U1", bot: false },
    mentions: o.mentions ?? { users: new Set<string>(), roles: new Set<string>() },
  };
}

const mentionsBot = (id: string) => ({ users: new Set([id]), roles: new Set<string>() });
const mentionsRole = (id: string) => ({ users: new Set<string>(), roles: new Set([id]) });

test("a call is a message that mentions the bot, its role, or replies to it", () => {
  expect(isCall(msg({ mentions: mentionsBot(BOT) }), BOT, PEERS)).toBe(true);
  expect(isCall(msg({ mentions: mentionsRole("R1") }), BOT, PEERS, "R1")).toBe(true);
  expect(isCall(msg({ mentions: mentionsRole("R1") }), BOT, PEERS)).toBe(false);
  expect(isCall(msg({ mentions: { users: new Set(), roles: new Set(), repliedUser: { id: BOT } } }), BOT, PEERS)).toBe(true);
  // Just talking: no mention, no reply.
  expect(isCall(msg({ content: "chatting about the build" }), BOT, PEERS)).toBe(false);
});

test("only confirmed bots are peers: a person in PEER_BOT_IDS stays a person", () => {
  expect(peerCall({ id: "UOWNER", bot: false }, PEERS)).toBe(false);
  expect(peerCall({ id: "UOWNER", bot: true }, PEERS)).toBe("ignore");
  expect(peerCall({ id: "PEER1", bot: true }, PEERS)).toBe(true);
  expect(peerCall({ id: "UOTHER", bot: true }, PEERS)).toBe("ignore");
  // The same rules decide a call: our own message and any other bot are out,
  // a peer bot may call, and a person who is in PEER_BOT_IDS is still a call.
  expect(isCall(msg({ author: { id: BOT, bot: true }, mentions: mentionsBot(BOT) }), BOT, PEERS)).toBe(false);
  expect(isCall(msg({ author: { id: "UOTHER", bot: true }, mentions: mentionsBot(BOT) }), BOT, PEERS)).toBe(false);
  expect(isCall(msg({ author: { id: "PEER1", bot: true }, mentions: mentionsBot(BOT) }), BOT, PEERS)).toBe(true);
  expect(isCall(msg({ author: { id: "UOWNER", bot: false }, mentions: mentionsBot(BOT) }), BOT, PEERS)).toBe(true);
});

test("the mention is removed before the bot reads the text", () => {
  expect(stripMention("<@BOT1> fix the build", BOT)).toBe("fix the build");
  expect(stripMention("<@!BOT1>  !status", BOT)).toBe("!status");
  expect(stripMention("<@&R1> <@BOT1> deploy", BOT, "R1")).toBe("deploy");
  expect(stripMention("talking about <@UOTHER>", BOT)).toBe("talking about <@UOTHER>");
});

test("snowflakes carry their own time, so a gap can be measured in ids", () => {
  const now = Date.now();
  expect(snowflakeTime(snowflakeAt(now).toString())).toBe(Math.floor(now));
  // Ids sort as plain numbers: newest last.
  expect(snowflakeAt(now - 60_000) < snowflakeAt(now)).toBe(true);
  expect(snowflakeTime("not-an-id")).toBe(0);
});

test("catch-up: calls newer than the mark that haven't been handled, oldest first", () => {
  const at = (n: number) => (snowflakeAt(1_700_000_000_000 + n * 60_000)).toString();
  const seen = new Set([at(5)]);
  const pick = (calls: Array<{ id: string }>, floor = BigInt(at(0)), limit = 20) =>
    toReplay(calls, (id) => seen.has(id), floor, limit);
  const calls = [
    { id: at(9) },
    { id: at(10) },
    { id: at(7) },
    { id: at(5) }, // already answered
    { id: at(0) }, // at the mark
    { id: at(-1) }, // before the mark
  ];
  expect(pick(calls).map((m) => m.id)).toEqual([at(7), at(9), at(10)]);
  expect(pick(calls, BigInt(at(8))).map((m) => m.id)).toEqual([at(9), at(10)]);
  expect(pick([...calls, { id: at(11) }, { id: at(12) }], BigInt(at(0)), 2).map((m) => m.id)).toEqual([at(7), at(9)]);
});

test("catch-up: finds the calls a reconnect owes, in the order they were said", async () => {
  const d: any = new Discord();
  d.botId = BOT;
  // Real snowflakes around now, or the ids sort before the catch-up window.
  const base = Date.now() - 10 * 60_000;
  const at = (min: number) => snowflakeAt(base + min * 60_000).toString();
  d.highWater = BigInt(at(0));
  d.botRole = () => null;
  const asked: string[] = [];
  const m = (id: string, content = `<@${BOT}> answer`) => msg({ id, content, mentions: mentionsBot(BOT) });
  const text = (id: string, messages: any[]) => ({
    id,
    type: 0,
    guildId: "G1",
    isThread: () => false,
    parentId: null,
    messages: {
      fetch: async ({ after }: { after: string }) => {
        asked.push(`history ${id} after ${after}`);
        return new Map(messages.filter((x) => BigInt(x.id) > BigInt(after)).map((x) => [x.id, x]));
      },
    },
  });
  // Newest first, as Discord hands history back, and one that isn't a call.
  d.channels = async () => [
    text("C1", [m(at(3)), m(at(1)), msg({ id: at(2), content: "no mention" }), m(at(0)), msg({ id: at(-1), content: `<@${BOT}> before the mark` })]),
  ];
  const missed = await d.missed();
  expect(missed.map((x: any) => x.id)).toEqual([at(1), at(3)]);
  expect(asked[0]).toBe(`history C1 after ${d.highWater}`);
  // A channel whose history can't be read is skipped, not fatal.
  d.channels = async () => [{ ...text("C2", []), messages: { fetch: async () => { throw new Error("Missing Access"); } } }];
  expect(await d.missed()).toEqual([]);
});

test("catch-up searches the allowlist, or every guild text channel and thread", async () => {
  const d: any = new Discord();
  const channel = (id: string, thread = false, type = 0) => ({
    id,
    type: thread ? 11 : type,
    guildId: "G1",
    isThread: () => thread,
    parentId: thread ? "C1" : null,
    messages: { fetch: async () => new Map() },
  });
  const guild = {
    id: "G1",
    channels: { fetch: async () => new Map([["C1", channel("C1")], ["T1", channel("T1", true)], ["V1", channel("V1", false, 2)]]) },
  };
  d.client = { channels: { fetch: async () => null }, guilds: { cache: new Map([["G1", guild]]) } };
  expect((await d.channels()).map((c: any) => c.id)).toEqual(["C1", "T1"]);

  // With CHANNEL_IDS set, only those channels are searched.
  const saved = config.channelIds;
  Object.assign(config, { channelIds: new Set(["C9"]) });
  try {
    d.client = { channels: { fetch: async (id: string) => (id === "C9" ? channel("C9") : null) }, guilds: { cache: new Map() } };
    expect((await d.channels()).map((c: any) => c.id)).toEqual(["C9"]);
  } finally {
    Object.assign(config, { channelIds: saved });
  }
});

test("usable: guild text channels and their threads, filtered like a live message", () => {
  const channel = (id: string, extra: any = {}) => ({ id, type: 0, guildId: "G1", isThread: () => false, parentId: null, ...extra });
  expect(usable(channel("C1"))).toBe(true);
  expect(usable(channel("V1", { type: 2 }))).toBe(false); // voice
  expect(usable(channel("T1", { type: 11, isThread: () => true, parentId: "C1" }))).toBe(true);
  expect(usable(null)).toBe(false);
  const saved = { channelIds: config.channelIds, guildId: config.guildId };
  Object.assign(config, { channelIds: new Set(["C1"]), guildId: "G2" });
  try {
    expect(usable(channel("C1"))).toBe(false); // wrong guild
    Object.assign(config, { guildId: undefined });
    expect(usable(channel("C1"))).toBe(true); // allowed
    expect(usable(channel("C2"))).toBe(false); // not on the list
    expect(usable(channel("T1", { type: 11, isThread: () => true, parentId: "C2" }))).toBe(false); // thread of a blocked channel
  } finally {
    Object.assign(config, saved);
  }
});

test("a redelivered or replayed event is answered once", async () => {
  const d: any = new Discord();
  const handled: string[] = [];
  d.onMessage = async (message: any) => handled.push(message.id);
  d.onEvent({ id: "1" });
  d.onEvent({ id: "1" });
  d.onEvent({ id: "2" });
  await new Promise((r) => setTimeout(r, 20));
  expect(handled).toEqual(["1", "2"]);
  // The high-water mark is the newest id handled, so a reconnect knows the gap.
  expect(d.highWater).toBe(2n);
  d.mark("10");
  expect(d.highWater).toBe(10n);
  // `seen` is bounded, so a long-lived bot doesn't grow it forever.
  for (let i = 100; i < 3000; i++) d.remember(String(i));
  expect(d.seen.size).toBeLessThanOrEqual(2000);
});

test("answers: a reply doesn't ping, files ride along, and @peer becomes a mention", async () => {
  const posted: any[] = [];
  const channel: any = {
    id: "C1",
    type: 0,
    guildId: "G1",
    isThread: () => false,
    sendTyping: async () => {},
    send: async (payload: any) => {
      posted.push(payload);
      return { edit: async (p: any) => posted.push(["edit", p]), delete: async () => {} };
    },
  };
  const link = (t: string) => linkMentions(t, new Map([["hee", "99"]]));
  const space = discordSpace(channel, link);

  await space.send("hello");
  expect(posted[0]).toBe("hello");

  await space.send("@hee what do you think?", { replyTo: "M1" });
  expect(posted[1]).toEqual({
    content: "<@99> what do you think?",
    reply: { messageReference: "M1", failIfNotExists: false },
    allowedMentions: { repliedUser: false },
  });

  await space.send("here", { files: [{ attachment: "/tmp/a.png", name: "a.png" } as any] });
  expect(posted[2].files).toHaveLength(1);
});

test("approval buttons and the model menu as Discord components", async () => {
  let sent: any;
  // What the user clicking the buttons resolves the wait with.
  let clicked: any = {};
  const interaction = (o: any) => ({
    reply: async (p: any) => sent.replies.push(p),
    update: async (p: any) => sent.updates.push(p),
    user: { id: "1", username: "sachin" },
    ...o,
  });
  const channel: any = {
    id: "C1",
    type: 0,
    guildId: "G1",
    isThread: () => false,
    send: async (payload: any) => {
      sent = { payload, replies: [], updates: [] };
      return {
        edit: async () => {},
        delete: async () => {},
        awaitMessageComponent: async ({ filter }: any) => {
          const i = interaction(clicked);
          if (!(await filter(i))) throw new Error("filtered out");
          return i;
        },
      };
    },
  };
  const space = discordSpace(channel);

  clicked = { isStringSelectMenu: () => false, customId: "ui:1" };
  const buttons = await space.choose(
    "Approval needed",
    "buttons",
    [
      { label: "Allow once", value: "accept", style: "primary" },
      { label: "Deny", value: "decline", style: "danger" },
    ],
    60_000,
  );
  const row = buttons.msg && sent.payload.components[0].toJSON();
  expect(row.type).toBe(1);
  expect(row.components.map((c: any) => [c.label, c.style])).toEqual([
    ["Allow once", 3], // Success
    ["Deny", 4], // Danger
  ]);
  expect((await buttons.pick).value).toBe("decline");
  expect((await buttons.pick).user).toBe("sachin");

  clicked = { isStringSelectMenu: () => true, values: ["a/opus-5"] };
  const menu = await space.choose(
    "pick a model",
    "menu",
    [
      { label: "Opus 5", value: "a/opus-5" },
      { label: "Kimi", value: "go/kimi", default: true },
    ],
    60_000,
  );
  const select = sent.payload.components[0].toJSON().components[0];
  expect(select.options.map((o: any) => o.value)).toEqual(["a/opus-5", "go/kimi"]);
  expect(select.options[1].default).toBe(true);
  expect((await menu.pick).value).toBe("a/opus-5");

  // A user who isn't on the allow list is told no, and doesn't resolve the pick.
  const saved = config.allowedUserIds;
  Object.assign(config, { allowedUserIds: new Set(["2"]) });
  try {
    clicked = { isStringSelectMenu: () => false, customId: "ui:0" };
    const { pick } = await space.choose("Approval needed", "buttons", [{ label: "Allow", value: "accept" }], 60_000);
    await expect(pick).rejects.toThrow("filtered out");
    expect(sent.replies[0]).toEqual({ content: "Only allowed users can answer this.", ephemeral: true });
  } finally {
    Object.assign(config, { allowedUserIds: saved });
  }
});