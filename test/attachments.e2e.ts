// End-to-end: a real app-server writes files; they come back as attachments
// on a fake Discord thread. Uses API credits.
//
//   bun test/attachments.e2e.ts
//   APP_SERVER="stdio:codex app-server" bun test/attachments.e2e.ts
//
// Checks: a file written with the write tool and a file written by a shell
// command are both attached to the final answer; a file outside the work
// folder is not.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
process.env.APPROVALS = "auto";
// Bun loads .env first; never run in the bot's real folder or link store.
const workdir = process.env.E2E_WORKDIR ?? "/tmp/hoo-bot-e2e-attach";
process.env.HOO_WORKDIR = workdir;
process.env.LINKS_FILE = "/tmp/hoo-bot-e2e-attach-links.json";
rmSync(process.env.LINKS_FILE, { force: true });
rmSync(workdir, { recursive: true, force: true });
mkdirSync(workdir, { recursive: true });
const outside = "/tmp/hoo-bot-e2e-outside.html";
writeFileSync(outside, "<p>outside</p>");

const { config, prepareWorkspace } = await import("../src/config.ts");
const { CodexClient } = await import("../src/codex-client.ts");
const { LinkStore } = await import("../src/links.ts");
const { ThreadSession } = await import("../src/session.ts");
prepareWorkspace();

const endpoint = config.appServer || `stdio:${config.hoocodeBin} app-server ${config.hoocodeArgs.join(" ")}`;
console.log(`app-server: ${endpoint}\nworkdir: ${workdir}`);

const log: string[] = [];
const uploads: string[][] = [];
const fakeMsg = () => ({
  edit: async () => {},
  delete: async () => {},
  awaitMessageComponent: async () => {
    throw new Error("no approvals expected with APPROVALS=auto");
  },
});
const thread = {
  id: "e2e-attach",
  send: async (c: any) => {
    const text = typeof c === "string" ? c : c.content;
    if (c?.files?.length) uploads.push(c.files.map((f: any) => f.name));
    log.push(`SEND  ${text}${c?.files?.length ? `  [files: ${c.files.map((f: any) => f.name).join(", ")}]` : ""}`);
    return fakeMsg();
  },
  sendTyping: async () => {},
};

const client = await CodexClient.connect(endpoint, undefined, { cwd: workdir });
const session = new ThreadSession(thread, client, new LinkStore(config.linksFile), () => {}, workdir);

await session.prompt(
  [
    "Do exactly these two steps, nothing else:",
    "1. Use your write tool to create the file page.html containing: <h1>hello from hoobot</h1>",
    "2. Run this shell command: printf 'a,b\\n1,2\\n' > data.csv",
    "Then reply with one short sentence. Do not mention any file names.",
  ].join("\n"),
);
const t0 = Date.now();
await Bun.sleep(500);
while (session.busy) {
  if (Date.now() - t0 > 180_000) {
    console.log(log.join("\n"));
    throw new Error("timed out waiting for the turn to end");
  }
  await Bun.sleep(300);
}
await Bun.sleep(500);
session.close();
client.close();
console.log(log.join("\n"));

const fail = (msg: string) => {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
};
if (!existsSync(`${workdir}/page.html`)) fail("the model didn't write page.html");
if (!existsSync(`${workdir}/data.csv`)) fail("the model didn't write data.csv");
const names = uploads.flat();
if (uploads.length !== 1) fail(`expected one message with files, got ${JSON.stringify(uploads)}`);
if (!names.includes("page.html")) fail(`page.html not attached: ${JSON.stringify(names)}`);
if (!names.includes("data.csv")) fail(`data.csv (shell-written) not attached: ${JSON.stringify(names)}`);
if (names.includes("hoo-bot-e2e-outside.html")) fail("a file outside the work folder was attached");
console.log(`\nOK (attached: ${names.join(", ")})`);
process.exit(0);
