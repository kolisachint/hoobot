import { expect, test } from "bun:test";

process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
const { Slack, choiceBlocks, peerCall, slackFiles, slackSpaceId, stripMention, toMessageLike, toReplay } = await import("../src/slack.ts");
const { formatContext, idOrder, selectSince, toContext } = await import("../src/context.ts");

test("a call is a message that mentions the bot; the mention is removed", () => {
  expect(stripMention("<@UBOT> fix the build", "UBOT")).toBe("fix the build");
  expect(stripMention("<@UBOT|hoo>  !status", "UBOT")).toBe("!status");
  expect(stripMention("talking about <@UOTHER>", "UBOT")).toBeNull();
});

test("spaces: a channel, or a thread in it", () => {
  expect(slackSpaceId("C1")).toBe("C1");
  expect(slackSpaceId("C1", "1700000000.000100")).toBe("C1/1700000000.000100");
});

test("only confirmed bots are peers: a person in PEER_BOT_IDS stays a person", () => {
  const bots = new Set(["UPEER"]);
  expect(peerCall({ user: "UOWNER" }, bots)).toBe(false);
  expect(peerCall({ user: "UOWNER", bot_id: "B1" }, bots)).toBe("ignore");
  expect(peerCall({ user: "UPEER", bot_id: "B2" }, bots)).toBe(true);
  expect(peerCall({ user: "UOTHER", bot_id: "B3" }, bots)).toBe("ignore");
});

test("Slack timestamps sort as message ids, across seconds and with Discord ids unchanged", () => {
  expect(idOrder("1700000000.000100", "1700000000.000099")).toBe(1);
  expect(idOrder("1699999999.999999", "1700000000.000001")).toBe(-1);
  expect(idOrder("1700000000.000100", "1700000000.000100")).toBe(0);
  expect(idOrder("9", "10")).toBe(-1);
  const ms = ["1700000002.000001", "1700000001.000500", "1700000003.000000"].map((id) => ({ id, author: "a", text: id, at: 0 }));
  expect(selectSince(ms, "1700000001.000500").map((m) => m.id)).toEqual(["1700000002.000001", "1700000003.000000"]);
});

test("Slack messages become context lines; joins and the bot's own are skipped", () => {
  const names = (u: string) => ({ U1: "alice" })[u as "U1"];
  const msg = toMessageLike(
    { ts: "1700000000.000100", user: "U1", text: "see <@U1> &amp; <https://x.y|this>", files: [{ name: "log.txt", url_private: "https://files/x" }] },
    names,
  );
  expect(toContext(msg, "UBOT")).toMatchObject({ id: "1700000000.000100", author: "alice", text: "see @alice & this (https://x.y) (attached: log.txt)" });
  expect(msg.createdTimestamp).toBe(1700000000000);
  expect(toContext(toMessageLike({ ts: "1", user: "U1", subtype: "channel_join", text: "joined" }, names), "UBOT")).toBeNull();
  expect(toContext(toMessageLike({ ts: "1", user: "UBOT", text: "my answer" }, names), "UBOT")).toBeNull();
  const ci = toContext(toMessageLike({ ts: "2", bot_id: "B1", subtype: "bot_message", username: "ci", text: "build failed" }, names), "UBOT");
  expect(ci?.author).toBe("ci (bot)");
  expect(formatContext([ci!], "#dev", "slack")).toStartWith('<slack-context where="#dev"');
});

test("catch-up: mentions of the bot that arrived while the socket was down, oldest first", () => {
  const t0 = Math.floor(Date.now() / 1000);
  const at = (n: number) => `${t0 + n}.000100`;
  const seen = new Set([`C1:${at(5)}`]);
  const pick = (messages: any[], since = t0, limit = 20) => toReplay(messages, "C1", "UBOT", (k) => seen.has(k), since, limit);
  const messages = [
    { ts: at(10), user: "UOWNER", text: "just chatting, no mention" },
    { ts: at(9), user: "UOWNER", text: "<@UBOT> answer me" },
    { ts: at(11), user: "UBOT", text: "<@UOWNER> my own answer" },
    { ts: at(8), user: "UOWNER", subtype: "channel_join", text: "<@UBOT> joined" },
    { ts: at(7), user: "UOWNER", text: "<@UOTHER> not me" },
    { ts: at(5), user: "UOWNER", text: "<@UBOT> already answered" },
    { ts: `${t0}.000000`, user: "UOWNER", text: "<@UBOT> at the high-water mark" },
  ];
  expect(pick(messages).map((m) => m.ts)).toEqual([at(9)]);
  expect(pick(messages, t0 + 8).map((m) => m.ts)).toEqual([at(9)]);
  expect(
    pick([...messages, { ts: at(12), user: "UOWNER", text: "<@UBOT> one" }, { ts: at(13), user: "UOWNER", text: "<@UBOT> two" }], t0, 1).map(
      (m) => m.ts,
    ),
  ).toEqual([at(9)]);
});

test("catch-up: finds the mentions history and replies don't hand over on their own", async () => {
  const t0 = Math.floor(Date.now() / 1000);
  const at = (n: number) => `${t0 + n}.000100`;
  const slack: any = new Slack("xoxb-x", "xapp-x");
  slack.botUserId = "UBOT";
  slack.highWater = t0;
  slack.threads.add(`C1/${at(-100000)}`);
  const calls: string[] = [];
  const replies: Record<string, any[]> = {
    // A thread from long before the gap: only this process knows it exists.
    [at(-100000)]: [
      { ts: at(-100000), user: "UOWNER", text: "old" },
      { ts: at(20), user: "UOWNER", thread_ts: at(-100000), text: "<@UBOT> missed in an old thread" },
    ],
    [at(10)]: [
      { ts: at(10), user: "UOWNER", text: "new thread" },
      { ts: at(11), user: "UOWNER", thread_ts: at(10), text: "<@UBOT> missed in a new thread" },
      { ts: at(12), user: "UOWNER", thread_ts: at(10), text: "no mention here" },
    ],
  };
  slack.web = {
    users: { conversations: async () => ({ ok: true, channels: [{ id: "C1" }, { id: "C2" }] }) },
    conversations: {
      info: async () => ({ ok: true, channel: { id: "C1" } }),
      history: async ({ channel, oldest }: any) => {
        calls.push(`history ${channel} ${oldest}`);
        const messages = channel === "C1" ? [{ ts: at(10), user: "UOWNER", text: "<@UBOT> missed at top level" }] : [];
        return { ok: true, messages };
      },
      replies: async ({ channel, ts, oldest }: any) => {
        calls.push(`replies ${ts} ${oldest}`);
        return { ok: true, messages: channel === "C1" ? (replies[ts] ?? []) : [] };
      },
    },
  };
  const missed: Array<{ channel: string; channelType: string; message: any }> = await slack.missed();
  expect(missed.map((m) => m.message.ts)).toEqual([at(10), at(11), at(20)]);
  expect(missed.every((m: any) => m.channel === "C1" && m.channelType === "channel")).toBe(true);
  expect(calls).toContain(`history C1 ${t0.toFixed(6)}`);
  expect(calls).toContain(`replies ${at(-100000)} ${t0.toFixed(6)}`);
});

test("files: private download URLs, names and types", () => {
  expect(
    slackFiles([
      { name: "a.csv", mimetype: "text/csv", size: 8, url_private_download: "https://files.slack.com/d/a.csv", url_private: "https://files.slack.com/a.csv" },
      { title: "shot", mimetype: "image/png", size: 3, url_private: "https://files.slack.com/shot" },
      { name: "external.doc" },
    ]),
  ).toEqual([
    { name: "a.csv", url: "https://files.slack.com/d/a.csv", size: 8, contentType: "text/csv" },
    { name: "shot", url: "https://files.slack.com/shot", size: 3, contentType: "image/png" },
  ]);
});

test("approval buttons and the model menu as Block Kit", () => {
  const buttons = choiceBlocks("7", "*Approval needed*", "buttons", [
    { label: "Allow once", value: "accept", style: "primary" },
    { label: "Deny", value: "decline", style: "danger" },
  ]);
  expect(buttons[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: "*Approval needed*" } });
  expect(buttons[1].elements.map((e: any) => [e.action_id, e.value, e.style])).toEqual([
    ["hoo:7:0", "accept", "primary"],
    ["hoo:7:1", "decline", "danger"],
  ]);
  const menu = choiceBlocks("8", "pick", "menu", [
    { label: "Opus 5", value: "a/opus-5", description: "a/opus-5" },
    { label: "Kimi", value: "go/kimi", default: true },
  ]);
  const select = menu[1].elements[0];
  expect(select.action_id).toBe("hoo:8:menu");
  expect(select.options.map((o: any) => o.value)).toEqual(["a/opus-5", "go/kimi"]);
  expect(select.initial_option.value).toBe("go/kimi");
});
