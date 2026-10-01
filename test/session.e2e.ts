// End-to-end: a real app-server, a fake Discord thread. Uses API credits.
//
//   bun test/session.e2e.ts                      # hoocode app-server (stdio)
//   APP_SERVER="stdio:codex app-server" bun test/session.e2e.ts   # real Codex
//   APP_SERVER=unix:///path/to.sock bun test/session.e2e.ts       # running server
//
// Checks: a turn answers; bash asks for approval and the button click runs
// it; a restarted bot resumes the same thread.
import { mkdirSync, rmSync } from "node:fs";

process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
// Bun loads .env first; never run in the bot's real folder or link store.
process.env.HOO_WORKDIR = process.env.E2E_WORKDIR ?? "/tmp/hoo-bot-e2e";
process.env.LINKS_FILE = "/tmp/hoo-bot-e2e-links.json";
rmSync(process.env.LINKS_FILE, { force: true });
mkdirSync(process.env.HOO_WORKDIR, { recursive: true });

const { config, prepareWorkspace } = await import("../src/config.ts");
const { CodexClient } = await import("../src/codex-client.ts");
const { LinkStore } = await import("../src/links.ts");
const { ThreadSession } = await import("../src/session.ts");
prepareWorkspace();

const endpoint = config.appServer || `stdio:${config.hoocodeBin} app-server ${config.hoocodeArgs.join(" ")}`;
console.log(`app-server: ${endpoint}`);

const log: string[] = [];
let clicks = 0;
const fakeMsg = () => ({
  edit: async (c: any) => void log.push(`EDIT  ${typeof c === "string" ? c : c.content}`),
  awaitMessageComponent: async () => {
    clicks++;
    return {
      customId: "ui:0", // Allow once
      user: { username: "tester" },
      update: async (c: any) => void log.push(`CLICK ${c.content}`),
    };
  },
});
const thread = {
  id: "e2e-thread",
  send: async (c: any) => {
    log.push(`SEND  ${typeof c === "string" ? c : c.content + "  [buttons]"}`);
    return fakeMsg();
  },
  sendTyping: async () => {},
};

async function waitFor(what: string, pred: () => boolean, ms = 120_000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) {
      console.log(log.join("\n"));
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(300);
  }
}

const links = new LinkStore(config.linksFile);
const connect = () => CodexClient.connect(endpoint, undefined, { cwd: config.workdir });
let client = await connect();
let session = new ThreadSession(thread, client, links, () => {});

// 1. Bash needs approval (the workspace's `discord` mode asks).
await session.prompt(
  "Run exactly this shell command with your shell tool: echo hello-discord. Then reply with one sentence saying what it printed.",
);
await waitFor("approval buttons", () => log.some((l) => l.includes("Approval needed") && l.includes("[buttons]")));
await waitFor("reply after approval", () =>
  log.some((l) => l.startsWith("SEND") && !l.includes("[buttons]") && !l.includes("running") && l.includes("hello-discord") && !l.includes("Approval")),
);
await waitFor("turn end", () => !session.busy);
const threadId = links.get("discord:e2e-thread")?.threadId;
if (!threadId) throw new Error("no link written");

// 2. Restart: a new client and session pick the same thread up again.
session.close();
client.close();
client = await connect();
session = new ThreadSession(thread, client, links, () => {});
const before = log.length;
await session.prompt("What exact word did the command print after 'hello-'? Answer with just that word.");
await waitFor("reply in resumed thread", () => log.slice(before).some((l) => l.startsWith("SEND") && /discord/i.test(l)));
await waitFor("turn end", () => !session.busy);
if (links.get("discord:e2e-thread")?.threadId !== threadId) throw new Error("resume started a new thread");

session.close();
client.close();
console.log(log.join("\n"));
console.log(`\nOK (${clicks} approval click(s), thread ${threadId})`);
process.exit(0);
