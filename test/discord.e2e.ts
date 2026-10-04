// End-to-end: the real Discord surface (src/discord.ts), a real session and
// a real app-server connection, with a fake gateway standing in for the
// websocket — so no Discord token is needed.
//
//   bun test/discord.e2e.ts
//
// Runs against test/fixtures/echo-app-server.ts, which answers a turn with
// whatever the prompt asked for: deterministic, offline, no credits. Point it
// at a real model to check that too (then only "an answer arrived" is
// asserted, since the wording is the model's):
//
//   APP_SERVER="stdio:hoocode app-server" bun test/discord.e2e.ts
//
// Checks: a mention is answered in its own channel with the channel's context;
// a peer bot is answered on a budget, and asking past it posts the
// "allow more turns?" buttons instead of answering; a mention missed while the
// gateway was down is replayed on reconnect, in the order it was said.
import { mkdirSync, readFileSync, rmSync } from "node:fs";

process.env.DISCORD_TOKEN = "x";
// Bun loads .env first; never run in the bot's real folder or link store.
process.env.HOO_WORKDIR = process.env.E2E_WORKDIR ?? "/tmp/hoo-discord-e2e";
process.env.LINKS_FILE = "/tmp/hoo-discord-e2e-links.json";
process.env.GUILD_ID = "";
process.env.CHANNEL_IDS = "";
process.env.WORKSPACES = "";
process.env.APPROVALS = "auto";
// The stand-in app-server unless a real one is named.
process.env.APP_SERVER ??= `stdio:${Bun.which("bun")} ${import.meta.dir}/fixtures/echo-app-server.ts`;
const OWNER = process.env.E2E_OWNER_ID ?? "111";
const PEER = process.env.E2E_PEER_ID ?? "222";
process.env.ALLOWED_USER_IDS = OWNER;
process.env.PEER_BOT_IDS = PEER;
process.env.PEER_TURNS = "1";
process.env.CATCHUP_MINUTES = "60";
process.env.CATCHUP_MAX = "20";
process.env.ECHO_PROMPT_LOG = "/tmp/hoo-discord-e2e-prompts.txt";
rmSync(process.env.LINKS_FILE, { force: true });
rmSync(process.env.ECHO_PROMPT_LOG, { force: true });
rmSync(process.env.HOO_WORKDIR, { recursive: true, force: true });
mkdirSync(process.env.HOO_WORKDIR, { recursive: true });

const { config, prepareWorkspace } = await import("../src/config.ts");
prepareWorkspace();
const { Discord, snowflakeAt } = await import("../src/discord.ts");
const realModel = !config.appServer.includes("echo-app-server");
console.log(`app-server: ${config.appServer || `stdio:${config.hoocodeBin} app-server ${config.hoocodeArgs.join(" ")}`}`);

const BOT = "999";
const log: string[] = [];
// Real snowflakes around now: a catch-up only replays ids inside its window.
const base = Date.now() - 10 * 60_000;
const at = (n: number) => snowflakeAt(base + n * 60_000).toString();

/** A Discord message, in the parts src/discord.ts and src/context.ts read. */
function fakeMessage(id: string, author: string, content: string, opts: { bot?: boolean; channel?: any } = {}) {
  const channel = opts.channel;
  return {
    id,
    content,
    type: 0,
    author: { id: author, bot: !!opts.bot, username: opts.bot ? "hee" : "sachin", globalName: null },
    member: { displayName: opts.bot ? "hee" : "sachin" },
    cleanContent: content,
    embeds: [],
    createdTimestamp: Number(id),
    channel,
    guild: { id: "G1", members: { me: { roles: { botRole: { id: "R1" } } } } },
    reference: null,
    attachments: { values: () => new Map().values() },
    mentions: {
      users: new Set(content.includes(`<@${BOT}>`) ? [BOT] : []),
      roles: new Set<string>(),
      repliedUser: null,
    },
    reply: async (t: string) => void log.push(`REPLY ${t}`),
  };
}

/** A Discord guild text channel: posts, typing and readable history. */
function fakeChannel(id: string) {
  const channel: any = {
    id,
    type: 0,
    guildId: "G1",
    parentId: null,
    isThread: () => false,
    guild: { id: "G1", members: { me: { roles: { botRole: { id: "R1" } } } } },
    history: [] as any[],
    messages: {
      // Discord hands history back newest first, filtered by id.
      fetch: async ({ before, after }: { before?: string; after?: string }) =>
        new Map(
          channel.history
            .filter((m: any) => !before || BigInt(m.id) < BigInt(before))
            .filter((m: any) => !after || BigInt(m.id) > BigInt(after))
            .map((m: any) => [m.id, m]),
        ),
    },
    sendTyping: async () => {},
    send: async (payload: any) => {
      const text = typeof payload === "string" ? payload : payload.content;
      log.push(`SEND [${id}] ${text}`);
      return {
        id: `post-${log.length}`,
        content: text,
        edit: async (p: any) => void log.push(`EDIT [${id}] ${typeof p === "string" ? p : p.content}`),
        delete: async () => {},
        // Nothing clicks the buttons in this test, so the wait runs out.
        awaitMessageComponent: async () => {
          throw new Error("timeout");
        },
      };
    },
  };
  return channel;
}

const d: any = new Discord();
d.botId = BOT;
d.botRoles.clear();
d.botRoles.set("G1", "R1");

/** What the gateway hands the surface. */
const deliver = (message: any) => d.onEvent(message);

async function waitFor(what: string, pred: () => boolean, ms = 180_000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) {
      console.log(log.join("\n"));
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(300);
  }
}
const answers = () => log.filter((l) => l.startsWith("SEND") || l.startsWith("REPLY"));

// ── 1. A person mentions the bot; the channel's context comes with it ────────
const dev = fakeChannel("C1");
const said = fakeMessage(at(1), OWNER, "channel is the weight-loss app, we ship from main", { channel: dev });
dev.history.push(said);
const call = fakeMessage(at(2), OWNER, `<@${BOT}> Reply with exactly: HOOBOT ONLINE`, { channel: dev });
await deliver(call);
await waitFor("the owner's answer", () => answers().length > 0);
if (!realModel && !answers().some((l) => /HOOBOT ONLINE/.test(l))) throw new Error("the answer isn't the one the prompt asked for");
// The prompt the app-server really received carries what the channel said.
const prompt = readFileSync(process.env.ECHO_PROMPT_LOG, "utf8");
if (!prompt.includes('<discord-context where="#this channel"')) throw new Error("no channel context in the prompt");
if (!prompt.includes("channel is the weight-loss app")) throw new Error("the channel's message is missing from the context");

// ── 2. A peer bot calls, and is answered on its own budget ──────────────────
const peerChannel = fakeChannel("C2");
const before2 = answers().length;
const peerCall = fakeMessage(at(3), PEER, `<@${BOT}> Reply with exactly: PEER OK`, { channel: peerChannel, bot: true });
await deliver(peerCall);
await waitFor("the peer's answer", () => answers().length > before2);
if (!realModel && !answers().slice(before2).some((l) => /PEER OK/.test(l))) throw new Error("the peer wasn't answered");
if (d.budget.used("C2") !== 1) throw new Error(`peer budget is ${d.budget.used("C2")}, expected 1`);
if (!d.peers.has("hee")) throw new Error("the peer's name wasn't learned, so @hee can't be mentioned");

// ── 3. Past the budget: ask an allowed user instead of answering ────────────
const before3 = answers().length;
const peerAgain = fakeMessage(at(4), PEER, `<@${BOT}> Reply with exactly: PEER AGAIN`, { channel: peerChannel, bot: true });
await deliver(peerAgain);
await waitFor("the peer-turn question", () => answers().slice(before3).some((l) => /Allow 1 more turns\?/.test(l)));
if (answers().slice(before3).some((l) => /PEER AGAIN/.test(l))) throw new Error("answered a peer past its budget");
await waitFor("the timeout note", () => log.some((l) => /bots stop talking here/.test(l)));

// ── 4. A mention missed while the gateway was down is replayed ──────────────
// Said while the gateway was down: Discord's history has it, we never got the event.
const missedChannel = fakeChannel("C3");
const missed = fakeMessage(at(5), OWNER, `<@${BOT}> Reply with exactly: CAUGHT UP`, { channel: missedChannel });
missedChannel.history.push(missed);
d.channels = async () => [missedChannel];
await d.catchUp();
const before4 = answers().length;
await waitFor("the replayed answer", () => answers().length > before4);
if (d.seen.has(missed.id) === false) throw new Error("the replayed mention wasn't marked as seen");
// Replaying again must not answer twice.
const beforeReplay = answers().length;
await d.catchUp();
if (answers().length !== beforeReplay) throw new Error("a second catch-up answered the same mention twice");

console.log(log.join("\n"));
console.log(`\nOK (${answers().length} message(s) posted; peer budget ${d.budget.used("C2")} used)`);
await d.stop();
process.exit(0);