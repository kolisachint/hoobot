import { expect, test } from "bun:test";
import { buildPrompt, formatContext, gatherContext, selectSince, type MessageLike, type SpaceLike } from "../src/context.ts";

const BOT = "999";
let clock = Date.UTC(2026, 9, 1, 10, 0);

function msg(id: number, author: string, text: string, opts: { bot?: boolean; authorId?: string; type?: number } = {}): MessageLike {
  return {
    id: String(id),
    type: opts.type ?? 0,
    author: { id: opts.authorId ?? author, bot: !!opts.bot, username: author },
    member: null,
    cleanContent: text,
    attachments: new Map(),
    embeds: [],
    createdTimestamp: (clock += 60_000),
  };
}

/** A channel whose history is `all`; fetch returns up to `limit` before `before`, newest first like Discord. */
function space(id: string, all: MessageLike[], extra: Partial<SpaceLike> = {}): SpaceLike {
  return {
    id,
    name: "dev",
    isThread: () => false,
    messages: {
      fetch: async ({ before, limit }) =>
        new Map(
          all
            .filter((m) => BigInt(m.id) < BigInt(before))
            .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))
            .slice(0, limit)
            .map((m) => [m.id, m]),
        ),
    },
    ...extra,
  };
}

test("selectSince keeps messages after the cursor, newest N, oldest first", () => {
  const ms = [3, 1, 5, 4, 2].map((i) => ({ id: String(i), author: "a", text: `m${i}`, at: 0 }));
  expect(selectSince(ms, "2").map((m) => m.id)).toEqual(["3", "4", "5"]);
  expect(selectSince(ms, null, 2).map((m) => m.id)).toEqual(["4", "5"]);
});

test("first call in a channel: last 30, everyone's, minus the bot's own and commands", async () => {
  const history = [
    msg(1, "alice", "too old"),
    ...Array.from({ length: 29 }, (_, i) => msg(10 + i, "bob", `note ${i}`)),
    msg(50, "hoo", "my earlier answer", { authorId: BOT, bot: true }),
    msg(51, "ci", "build failed on main", { bot: true }),
    msg(52, "alice", "!status"),
  ];
  const ctx = await gatherContext({ space: space("c1", history), before: "60", botId: BOT, linked: false, seen: null });
  expect(ctx).toContain('<discord-context where="#dev"');
  expect(ctx).toContain("ci (bot): build failed on main");
  expect(ctx).not.toContain("my earlier answer");
  expect(ctx).not.toContain("!status");
  expect(ctx).not.toContain("too old"); // only the last 30 fetched
  expect(ctx.split("\n").filter((l) => l.startsWith("[")).length).toBe(28); // 30 fetched − own reply − !status
});

test("later calls: only messages since the last read", async () => {
  const history = [msg(1, "alice", "already read"), msg(2, "bob", "new since then"), msg(3, "carol", "me too")];
  const ctx = await gatherContext({ space: space("c1", history), before: "10", botId: BOT, linked: true, seen: "1" });
  expect(ctx).not.toContain("already read");
  expect(ctx).toContain("bob: new since then");
  expect(ctx).toContain("carol: me too");
});

test("nothing new → no block; a conversation from before tracking gets none", async () => {
  const history = [msg(1, "alice", "old")];
  expect(await gatherContext({ space: space("c1", history), before: "10", botId: BOT, linked: true, seen: "1" })).toBe("");
  expect(await gatherContext({ space: space("c1", history), before: "10", botId: BOT, linked: true, seen: null })).toBe("");
});

test("first call in a thread: parent lead-up (with the bot's channel replies) + starter + thread so far", async () => {
  const parentHistory = [
    msg(100, "alice", "deploy is failing"),
    msg(101, "hoo", "it's the migration", { authorId: BOT, bot: true }),
    msg(102, "bob", "let's fix it in a thread"),
    msg(300, "dave", "after the thread opened"),
  ];
  const parent = space("p1", parentHistory);
  const threadHistory = [msg(201, "bob", "here's the log")];
  const thread = space("200", threadHistory, {
    isThread: () => true,
    parent: { ...parent, name: "dev" },
    fetchStarterMessage: async () => msg(200, "bob", "fix the migration"),
  });
  const ctx = await gatherContext({ space: thread, before: "250", botId: BOT, linked: false, seen: null });
  expect(ctx).toContain('where="#dev, before this thread started"');
  expect(ctx).toContain("hoo (bot): it's the migration");
  expect(ctx).toContain("bob: fix the migration");
  expect(ctx).not.toContain("after the thread opened");
  expect(ctx).toContain('where="this thread"');
  expect(ctx.indexOf("deploy is failing")).toBeLessThan(ctx.indexOf("here's the log"));
});

test("unreadable history means no context, not an error", async () => {
  const broken = space("c1", []);
  broken.messages.fetch = async () => {
    throw new Error("Missing Access");
  };
  expect(await gatherContext({ space: broken, before: "10", botId: BOT, linked: false, seen: null })).toBe("");
});

test("the size cap keeps the newest messages", () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), author: "a", text: "x".repeat(1400), at: 0 }));
  const out = formatContext(big, "here");
  const lines = out.split("\n").filter((l) => l.startsWith("["));
  expect(lines.length).toBeLessThan(30);
  expect(out.length).toBeLessThan(13_000);
});

test("the prompt names the sender and quotes a reply", () => {
  const p = buildPrompt({
    context: "<discord-context>…</discord-context>",
    replyTo: { id: "1", author: "bob", text: "logs say column exists", at: 0 },
    author: "sachin",
    text: "fix this",
  });
  expect(p).toBe('<discord-context>…</discord-context>\n\n(in reply to bob: "logs say column exists")\n\nsachin: fix this');
});

test("buildPrompt puts sent files between the reply and the request", () => {
  expect(
    buildPrompt({
      replyTo: { id: "1", author: "bob", text: "here", at: 0 },
      attachments: "<discord-attachments>\n- x\n</discord-attachments>",
      author: "alice",
      text: "look",
    }),
  ).toBe('(in reply to bob: "here")\n\n<discord-attachments>\n- x\n</discord-attachments>\n\nalice: look');
});
