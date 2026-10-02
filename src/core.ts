/**
 * What every chat surface shares: one app-server per work folder, one
 * session per space, calls handled one at a time per space, the `!`
 * commands, and turning a call (text, context, files) into a prompt.
 * Surfaces (src/discord.ts, src/slack.ts) only turn their events into a
 * `Call` and their channels into a `ChatSpace`.
 */
import { config } from "./config.ts";
import { CodexClient } from "./codex-client.ts";
import { LinkStore } from "./links.ts";
import { ThreadSession } from "./session.ts";
import { buildPrompt, type ContextMessage } from "./context.ts";
import type { ChatSpace } from "./chat.ts";
import {
  clearSpace,
  formatAttachments,
  imageInputs,
  saveAttachments,
  type AttachmentLike,
  type Fetcher,
  type SavedFile,
  type SkippedFile,
} from "./inbound.ts";

const links = new LinkStore(config.linksFile);
const sessions = new Map<string, ThreadSession>();

/** `unix://PATH`, or `hoocode app-server` over stdio in the work folder. */
function endpoint(): string {
  if (config.appServer) return config.appServer;
  return `stdio:${config.hoocodeBin} app-server ${config.hoocodeArgs.join(" ")}`;
}

/** One app-server per folder, started on first use. */
const apps = new Map<string, Promise<CodexClient>>();

/** The app-server for `workdir`; reconnects after it drops. */
function appServer(workdir: string): Promise<CodexClient> {
  let app = apps.get(workdir);
  if (app) return app;
  app = (async () => {
    // A stdio server runs in the work folder; a socket server has its own.
    const client = await CodexClient.connect(endpoint(), { name: "hoobot", version: "0.1.0" }, { cwd: workdir });
    console.log(`Connected to app-server ${client.endpoint} in ${workdir}`);
    client.on("close", (reason: string) => {
      console.error(`app-server for ${workdir} closed: ${reason}`);
      apps.delete(workdir);
      // Its sessions hold the old client; drop them. Threads resume on the next message.
      for (const s of [...sessions.values()]) if (s.workdir === workdir) s.close();
    });
    return client;
  })().catch((err) => {
    console.error(`Can't reach app-server for ${workdir}: ${err instanceof Error ? err.message : String(err)}`);
    apps.delete(workdir);
    throw err;
  });
  apps.set(workdir, app);
  return app;
}

async function getSession(space: ChatSpace, workdir: string): Promise<ThreadSession> {
  const client = await appServer(workdir);
  const key = `${space.surface}:${space.id}`;
  let s = sessions.get(key);
  if (!s) {
    s = new ThreadSession(space, client, links, () => sessions.delete(key), workdir);
    sessions.set(key, s);
  }
  return s;
}

/** Per-space promise chains. */
const lanes = new Map<string, Promise<unknown>>();
export function inOrder(key: string, fn: () => Promise<unknown>): Promise<unknown> {
  const next = (lanes.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  lanes.set(key, tail);
  tail.then(() => lanes.get(key) === tail && lanes.delete(key));
  return next;
}

/** A message on a chat that has files. */
export type FileMessage = { id: string; author: string; files: AttachmentLike[] };

/** One call to the bot: a mention, a reply to it, or a DM. */
export interface Call {
  space: ChatSpace;
  /** Who called: their chat user id (checked against ALLOWED_USER_IDS) and name. */
  userId: string;
  author: string;
  /** The calling message's id (read position, and what the answer replies to). */
  messageId: string;
  /** The text without the bot's mention. */
  text: string;
  /** The calling message's files. */
  files: AttachmentLike[];
  /** The folder this space works in. */
  workdir: string;
  /** Answer outside the conversation (help, errors). */
  reply(text: string): Promise<unknown>;
  /** What was said in the space since `seen` (see src/context.ts). */
  context(state: { linked: boolean; seen: string | null }): Promise<string>;
  /** The message this one replies to, unless it's the bot's own. */
  replyTo?(): Promise<{ context: ContextMessage | null; message: FileMessage } | null>;
  /** Downloads a file (Slack needs the bot token). */
  fetcher?: Fetcher;
}

export function helpText(label: string, menu: string): string {
  return [
    `**hoo: hoocode in ${label}**`,
    "",
    "**Call me:** mention me, or reply to one of my messages. I answer right here.",
    "Every channel and thread is a shared space: anyone can talk, and when I'm called",
    "I read what was said since I last looked (up to 30 messages).",
    "Open a thread for a side task; it has its own conversation in the same folder.",
    "Attach files (or reply to a message with files): I save them in the work folder and read them.",
    "",
    "**Commands** (for this channel or thread)",
    "- `!stop`: stop the current run",
    "- `!new`: start a fresh conversation here (for everyone; deletes files sent here)",
    "- `!status`: model, busy or not, folder",
    `- \`!model\`: pick the model here from ${menu} (from the next message; the conversation carries on)`,
    "- `!model <part of name>`: pick it directly, e.g. `!model kimi`",
    "- `!verbose`: show every step here (again to turn off)",
    "- `!help`: this message",
    "",
    "Calling me while I'm busy steers the current run.",
    "While I work you see one status line; then the answer with a short",
    "summary (PR, commits, files, steps, time, model).",
    ...(config.approvals === "ask" ? ["Commands that change files or run shell ask for approval with buttons."] : []),
  ].join("\n");
}

/** Handle a call: allow list, help, commands, else a prompt to the space's conversation. */
export async function handleCall(call: Call, help: string): Promise<void> {
  const { space } = call;
  // Only allowed users can call the bot (everyone's messages still count as context).
  if (!config.allowedUserIds.has(call.userId)) {
    await call.reply("Sorry, you're not on this bot's allow list.");
    return;
  }
  const text = call.text.trim();
  if (!text && call.files.length === 0) {
    await call.reply(help);
    return;
  }

  // Commands.
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  if (cmd?.toLowerCase() === "!help") {
    await call.reply(help);
    return;
  }
  let session: ThreadSession;
  try {
    session = await getSession(space, call.workdir);
  } catch (err) {
    await call.reply(`**Can't reach hoocode:** ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  switch (cmd?.toLowerCase()) {
    case "!stop":
      return session.abort();
    case "!new":
      clearSpace(session.workdir, space.id, space.surface);
      return session.newSession();
    case "!status":
      return session.status();
    case "!verbose":
      return session.toggleVerbose();
    case "!model":
      return session.chooseModel(arg);
  }

  // One call at a time per space, so read positions advance in order.
  await inOrder(`${space.surface}:${space.id}`, async () => {
    // What was said here since the conversation last read, plus the message replied to.
    const state = await session.readState();
    const [context, reply] = await Promise.all([call.context(state), call.replyTo?.() ?? null]);
    // Files on the calling message and on the message it replies to are
    // saved in the work folder; small text ones are pasted in too.
    const saved: SavedFile[] = [];
    const skipped: SkippedFile[] = [];
    const self: FileMessage = { id: call.messageId, author: call.author, files: call.files };
    for (const m of [reply?.message, self]) {
      if (!m?.files.length) continue;
      const r = await saveAttachments({
        workdir: session.workdir,
        spaceId: space.id,
        messageId: m.id,
        author: m.author,
        attachments: m.files,
        fetcher: call.fetcher,
        surface: space.surface,
      });
      saved.push(...r.saved);
      skipped.push(...r.skipped);
    }
    const prompt = buildPrompt({
      context,
      replyTo: reply?.context,
      attachments: formatAttachments(saved, skipped, space.surface),
      author: call.author,
      text: text || "(see the attached files)",
    });
    if (await session.prompt(prompt, imageInputs(saved), { id: call.messageId })) session.markSeen(call.messageId);
  });
}

/** Close every session and app-server. */
export async function closeAll() {
  for (const s of [...sessions.values()]) s.close();
  await Promise.all([...apps.values()].map((app) => app.then((c) => c.close()).catch(() => {})));
}
