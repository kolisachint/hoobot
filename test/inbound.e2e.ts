// End-to-end: files sent on Discord reach a real app-server. Uses API credits.
//
//   bun test/inbound.e2e.ts
//   APP_SERVER="stdio:codex app-server" bun test/inbound.e2e.ts
//
// Files are served over real HTTP (as Discord's CDN would), saved with
// saveAttachments and put in the prompt the way src/index.ts does. Checks:
// a small text file is pasted (the model answers from it), a big one is only
// named (the model reads it from the path with a tool), and neither is sent
// back as an attachment.
import { rmSync } from "node:fs";

process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
process.env.APPROVALS = "auto";
const workdir = process.env.E2E_WORKDIR ?? "/tmp/hoo-bot-e2e-inbound";
process.env.HOO_WORKDIR = workdir;
process.env.LINKS_FILE = "/tmp/hoo-bot-e2e-inbound-links.json";
rmSync(process.env.LINKS_FILE, { force: true });
rmSync(workdir, { recursive: true, force: true });

const { config, prepareWorkspace } = await import("../src/config.ts");
const { CodexClient } = await import("../src/codex-client.ts");
const { LinkStore } = await import("../src/links.ts");
const { ThreadSession } = await import("../src/session.ts");
const { buildPrompt } = await import("../src/context.ts");
const { formatAttachments, imageInputs, saveAttachments, INLINE_FILE_BYTES } = await import("../src/inbound.ts");
prepareWorkspace();

// A small note (pasted) and a big CSV (only named). The last row's value is
// only in the file, so the model has to open it.
const note = "The codeword is PELICAN-42.\n";
const rows = ["id,value"];
for (let i = 1; rows.join("\n").length < INLINE_FILE_BYTES * 2; i++) rows.push(`${i},${i % 7}`);
rows.push("999999,TANGERINE");
const csv = rows.join("\n") + "\n";
const files: Record<string, { body: string; type: string }> = {
  "/note.txt": { body: note, type: "text/plain; charset=utf-8" },
  "/data.csv": { body: csv, type: "text/csv" },
};
const cdn = Bun.serve({
  port: 0,
  fetch: (req) => {
    const f = files[new URL(req.url).pathname];
    return f ? new Response(f.body, { headers: { "content-type": f.type } }) : new Response("no", { status: 404 });
  },
});
const base = `http://localhost:${cdn.port}`;

const { saved, skipped } = await saveAttachments({
  workdir,
  spaceId: "e2e-space",
  messageId: "1001",
  author: "alice",
  attachments: Object.entries(files).map(([path, f]) => ({
    name: path.slice(1),
    url: base + path,
    size: Buffer.byteLength(f.body),
    contentType: f.type,
  })),
});
cdn.stop(true);
const block = formatAttachments(saved, skipped);
if (!block.includes("PELICAN-42")) throw new Error("note.txt was not pasted");
if (block.includes("TANGERINE")) throw new Error("data.csv was pasted but should be too big");

const prompt = buildPrompt({
  attachments: block,
  author: "alice",
  text: "Reply in one line: the codeword from note.txt, then the value in the last row of data.csv (open the file to find it).",
});
console.log(`app-server: ${config.appServer || config.hoocodeBin + " app-server"}\nworkdir: ${workdir}\n--- prompt (first 600 chars) ---\n${prompt.slice(0, 600)}\n---`);

const log: string[] = [];
const uploads: string[] = [];
const thread = {
  id: "e2e-inbound",
  send: async (c: any) => {
    const text = typeof c === "string" ? c : c.content;
    for (const f of c?.files ?? []) uploads.push(f.name);
    log.push(`SEND  ${text}`);
    return { edit: async () => {}, delete: async () => {}, awaitMessageComponent: async () => Promise.reject(new Error("no approvals")) };
  },
  sendTyping: async () => {},
};

const endpoint = config.appServer || `stdio:${config.hoocodeBin} app-server ${config.hoocodeArgs.join(" ")}`;
const client = await CodexClient.connect(endpoint, undefined, { cwd: workdir });
const session = new ThreadSession(thread, client, new LinkStore(config.linksFile), () => {}, workdir);
await session.prompt(prompt, imageInputs(saved));
const t0 = Date.now();
await Bun.sleep(500);
while (session.busy) {
  if (Date.now() - t0 > 180_000) {
    console.log(log.join("\n"));
    throw new Error("timed out");
  }
  await Bun.sleep(300);
}
await Bun.sleep(500);
session.close();
client.close();
console.log(log.join("\n"));

const answer = log.filter((l) => !l.startsWith("SEND  ⏳")).join("\n");
const fail = (msg: string) => {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
};
if (!answer.includes("PELICAN-42")) fail("the pasted note didn't reach the model");
if (!answer.includes("TANGERINE")) fail("the model didn't read data.csv from the work folder");
if (uploads.length) fail(`files sent on Discord were sent back: ${uploads.join(", ")}`);
console.log("\nOK (pasted file answered directly; big file read from its path; nothing echoed back)");
process.exit(0);
