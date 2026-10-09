/**
 * What every chat surface shares: one app-server per work folder, one
 * session per space, calls handled one at a time per space, the `!`
 * commands, and turning a call (text, context, files) into a prompt.
 * Surfaces (src/discord.ts, src/slack.ts) only turn their events into a
 * `Call` and their channels into a `ChatSpace`.
 */
import { log, error, warn } from "./log.ts";
import { config } from "./config.ts";
import { CodexClient } from "./codex-client.ts";
import { health, isStuck, type SessionStatus } from "./health.ts";
import { LinkStore } from "./links.ts";
import { ThreadSession } from "./session.ts";
import { binaryStamp, shouldRestartServer, spawnedBinary, type BinaryStamp } from "./hoocode-binary.ts";
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

/**
 * One app-server per folder, started on first use. `spawned` is the hoocode
 * binary it was started from (stdio only), so a later upgrade can be seen.
 */
type AppServer = { client: Promise<CodexClient>; spawned: BinaryStamp | null };
const apps = new Map<string, AppServer>();

/** The hoocode binary the stdio server runs from, as it is on disk now. Null when not ours to restart. */
function hoocodeOnDisk(): BinaryStamp | null {
  const bin = spawnedBinary({ appServer: config.appServer, hoocodeBin: config.hoocodeBin });
  return bin ? binaryStamp(bin) : null;
}

/** Start a server for `workdir` and remember what it was started from. */
function startAppServer(workdir: string): AppServer {
  const spawned = hoocodeOnDisk();
  const client: Promise<CodexClient> = (async () => {
    // A stdio server runs in the work folder; a socket server has its own.
    const c = await CodexClient.connect(
      endpoint(),
      { name: "hoobot", version: "0.1.0" },
      { cwd: workdir, requestTimeoutMs: config.requestTimeoutMs },
    );
    log(`Connected to app-server ${c.endpoint} in ${workdir}${spawned ? ` (hoocode ${spawned.path})` : ""}`);
    c.on("close", (reason: string) => {
      // A server replaced on purpose is no longer in `apps`: its sessions were
      // closed by the restart, and nothing else is ours to tear down.
      if (apps.get(workdir)?.client !== client) return;
      error(`app-server for ${workdir} closed: ${reason}`);
      // Say what was still running, so the log explains the silence that
      // follows rather than leaving it to be guessed at.
      for (const s of [...sessions.values()]) {
        if (s.workdir !== workdir) continue;
        if (s.busy) warn(`[${workdir}] dropped a session mid-turn after ${Math.round(s.turnAgeMs / 1000)}s`);
        s.close();
      }
      apps.delete(workdir);
    });
    return c;
  })().catch((err) => {
    error(`Can't reach app-server for ${workdir}: ${err instanceof Error ? err.message : String(err)}`);
    if (apps.get(workdir)?.client === client) apps.delete(workdir);
    throw err;
  });
  return { client, spawned };
}

/**
 * hoocode was upgraded under a running server, so close it and let the next
 * turn start the new build. Only when nothing is in flight on it: a turn
 * keeps the old server until it ends, and the check runs again on the next
 * call. Threads come back through the resume path (the server saved them).
 */
function restartIfStale(workdir: string, app: AppServer): boolean {
  const current = hoocodeOnDisk();
  const idle = ![...sessions.values()].some((s) => s.workdir === workdir && s.inFlight);
  if (!shouldRestartServer({ spawned: app.spawned, current, idle })) return false;
  log(`hoocode changed on disk; restarting the app-server for ${workdir} so the next turn runs the new build`);
  apps.delete(workdir);
  // Unsubscribe each thread first, so the server never sees a client that
  // dropped the connection while still subscribed (that logs a warning).
  const unsubscribed = [...sessions.values()].filter((s) => s.workdir === workdir).map((s) => s.close());
  void Promise.all(unsubscribed)
    .then(() => app.client)
    .then((c) => c.close())
    .catch(() => {});
  return true;
}

/** The app-server for `workdir`; reconnects after it drops. */
function appServer(workdir: string): Promise<CodexClient> {
  let app = apps.get(workdir);
  if (app && restartIfStale(workdir, app)) app = undefined;
  if (!app) {
    app = startAppServer(workdir);
    apps.set(workdir, app);
  }
  return app.client;
}

async function getSession(space: ChatSpace, workdir: string): Promise<ThreadSession> {
  // The server can be replaced while this call waits for it; then take the new one.
  let client: CodexClient;
  let started: Promise<CodexClient>;
  do {
    started = appServer(workdir);
    client = await started;
  } while (apps.get(workdir)?.client !== started);
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
  /** Called by a peer bot (`PEER_BOT_IDS`), not a person: no allow list, no commands. */
  peer?: boolean;
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
    "- `!model <number or part of name> [effort]`: pick it directly, e.g. `!model 2`, `!model kimi`, `!model opus high`",
    "  Only models in hoocode's scope are offered.",
    "- `!effort [level]`: show this space's effort, or set it, e.g. `!effort high`; `!effort default` clears it",
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
  health.message(space.surface);
  // Only allowed users can call the bot (everyone's messages still count as context).
  if (!call.peer && !config.allowedUserIds.has(call.userId)) {
    await call.reply("Sorry, you're not on this bot's allow list.");
    return;
  }
  const text = call.text.trim();
  // Peers talk; they don't run commands or get help.
  if (call.peer && (!text || text.startsWith("!"))) return;
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
    case "!effort":
      return session.chooseEffort(arg);
  }

  // One call at a time per space, so read positions advance in order.
  // Say “working” before the preamble: the turn is only acknowledged after
  // a thread round trip, reading history and saving attachments, and the
  // indicator is the only sign of life until then.
  session.beginCall();
  try {
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
    if (await session.prompt(prompt, imageInputs(saved), {
      id: call.messageId,
      userId: call.peer ? undefined : call.userId,
    })) session.markSeen(call.messageId);
    });
  } finally {
    // When no turn came of it (the preamble threw, or turn/start was
    // refused), nothing else would stop the indicator.
    session.endCall();
  }
}

/** Every live conversation: which space, which folder, busy or not. */
export function sessionStatus(): SessionStatus[] {
  return [...sessions.entries()].map(([key, s]) => ({
    key,
    surface: s.thread.surface,
    id: s.thread.id,
    workdir: s.workdir,
    busy: s.busy,
    turnAgeMs: s.turnAgeMs,
    turnStalledMs: s.turnStalledMs,
    // The session's own stall timer normally clears this first; this is the
    // backstop that lets the supervisor see a bot that never recovered.
    stuck: isStuck(s.busy, s.turnStalledMs),
  }));
}

/** Close every session and app-server. */
export async function closeAll() {
  // Threads are unsubscribed before their server connection is closed.
  const unsubscribed = [...sessions.values()].map((s) => s.close());
  await Promise.all(unsubscribed);
  await Promise.all([...apps.values()].map((app) => app.client.then((c) => c.close()).catch(() => {})));
}
