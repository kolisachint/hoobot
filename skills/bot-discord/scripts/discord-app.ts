#!/usr/bin/env bun
/**
 * The Discord half of a hoobot bot, driven by the Discord API with the bot's
 * own token.
 *
 * Slack has a CLI, so `slack-app.ts` can create the app, install it and mint
 * both tokens without a browser. Discord has no equivalent: an application
 * is made in the developer portal by a person, and that is the one step this
 * script cannot do. Everything after it — the id `PEER_BOT_IDS` needs, the
 * invite URL with exactly the permissions this bot uses, the icon, the live
 * check — is here, because each of those used to be another browser trip.
 *
 *   discord-app.ts id     hee            # application id, for PEER_BOT_IDS
 *   discord-app.ts token  hee            # the same id, verified as a bot
 *   discord-app.ts invite hee            # the OAuth URL, permissions included
 *   discord-app.ts avatar hee --icon /tmp/hee.png
 *   discord-app.ts write  hee --token …  # save the token into the .env
 *   discord-app.ts verify hee            # what Discord actually has now
 *   discord-app.ts peers  hee            # every PEER_BOT_IDS entry, resolved
 *
 * Every command reads and writes `<runtime>/<bot>/.env`, never Discord state
 * it cannot reach: this bot's own token is the only credential there is, and
 * an application belongs to whoever made it in the portal.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const API = "https://discord.com/api/v10";

/**
 * The permissions this bot needs, and why each one is here.
 *
 * `view_channel`, `send_messages` and `read_message_history` are the obvious
 * three; the rest are what the surface in src/discord.ts actually reaches for
 * and nothing else. Threads are listed separately because Discord gates them
 * separately: a bot that can talk in a channel still cannot answer in one of
 * its threads without `send_messages_in_threads`, and the failure looks like
 * "it ignores every thread" rather than a permission error.
 */
export const PERMISSIONS: Record<string, bigint> = {
  view_channel: 1n << 10n,
  send_messages: 1n << 11n,
  embed_links: 1n << 14n,
  attach_files: 1n << 15n,
  read_message_history: 1n << 16n,
  send_messages_in_threads: 1n << 38n,
};

/** Every permission above, as one integer — what the invite URL asks for. */
export function permissionInt(): bigint {
  return Object.values(PERMISSIONS).reduce((all, bit) => all | bit, 0n);
}

/**
 * The application id, straight out of the token.
 *
 * A Discord token is `base64(application_id).timestamp.hmac`, so the id is in
 * the first segment and needs no request to read. That matters because the id
 * is what `PEER_BOT_IDS` wants and the portal is where a person would
 * otherwise go to copy it — and it is the bot's user id too, which is why a
 * Discord bot's id never changes when the app is renamed or re-issued, unlike
 * a Slack one.
 */
export function appIdFromToken(token: string): string {
  const first = token.trim().split(".")[0] ?? "";
  let decoded = "";
  try {
    decoded = Buffer.from(first, "base64url").toString("utf8");
  } catch {
    decoded = "";
  }
  // Discord ids are snowflakes: 17 to 20 digits, nothing else. The length is
  // checked because a short run of digits can come out of decoding something
  // that is not a token at all (`MTIzNDU2` decodes to "123456"), and wiring a
  // peer to a number Discord has never heard of is the exact quiet failure
  // this whole skill exists to prevent.
  if (!/^\d{17,20}$/.test(decoded)) {
    throw new Error("that is not a Discord bot token (the first segment is not an application id)");
  }
  return decoded;
}

/**
 * The OAuth URL that adds the bot to a server with the right permissions.
 *
 * `disable_guild_select` is what makes the user pick a server rather than the
 * bot's picker choosing one, and `applications.commands` is included because
 * a bot that ever grows a slash command should not need a second visit.
 */
export function inviteUrl(appId: string, guildId?: string): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("permissions", permissionInt().toString());
  if (guildId) url.searchParams.set("guild_id", guildId);
  return url.toString();
}

// ── the bot's own folder ────────────────────────────────────────────────────

function runtimeDir(): string {
  const fromEnv = process.env.HOOBOT_RUNTIME_DIR?.trim();
  if (fromEnv) return fromEnv.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  const out = spawnSync("hoobot", ["path", "runtime"], { encoding: "utf8" });
  const line = out.stdout?.trim();
  if (out.status === 0 && line?.startsWith("/")) return line;
  return join(process.env.HOME ?? "~", ".hoobot", "runtime");
}

const argv = process.argv.slice(2);
const command = argv[0];
const name = argv[1];

const flag = (key: string): string | undefined => {
  const i = argv.indexOf(`--${key}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const runtime = flag("runtime")?.replace(/^~(?=\/|$)/, process.env.HOME ?? "~") ?? runtimeDir();

/** Folders in the runtime dir that are not bots. `slack/` holds Slack CLI
 *  projects, not instances. */
const RESERVED = new Set(["shared", "manager", "workspace", "node_modules", "logs", "slack"]);

/** Folders in the runtime dir that hold a bot. */
const namesInRuntime: string[] = existsSync(runtime)
  ? readdirSync(runtime, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !RESERVED.has(e.name) && existsSync(join(runtime, e.name, ".env")))
      .map((e) => e.name)
      .sort()
  : [];

/** The bot's folder, or a clear complaint — never a half-written .env. */
function botDir(): string {
  const dir = join(runtime, name!);
  if (!existsSync(join(dir, ".env"))) {
    fail(`no .env at ${dir}/.env. Create the bot first: discord-bot-create`);
  }
  return dir;
}

/** Read a key out of an .env without sourcing it. */
function envValue(path: string, key: string): string {
  if (!existsSync(path)) return "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    if ((line.split("=")[0] ?? "").trim() === key) return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

/** Set keys in the .env in place, so comments and ordering survive. */
function writeEnvKeys(path: string, keys: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(keys)) {
    const line = `${key}=${value}`;
    const at = lines.findIndex((l) => (l.split("=")[0] ?? "").trim() === key);
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  writeFileSync(path, lines.join("\n").replace(/\n+$/, "\n"));
  // A token just went in. `mode` on writeFileSync only applies when the file
  // is created, so an existing .env keeps whatever mode it had — and the
  // manager's default is not the 600 a token needs.
  chmodSync(path, 0o600);
}

/** The bot's token, from --token or the .env. Never printed in full. */
function tokenFor(): string {
  const token = (flag("token") ?? envValue(join(botDir(), ".env"), "DISCORD_TOKEN")).trim();
  if (!token) fail(`no DISCORD_TOKEN. Pass --token, or run: discord-app.ts write ${name} --token …`);
  return token;
}

/** The DISCORD_TOKEN in a .env, if there is one. Used to match ids. */
function tokenForOf(envPath: string): string | undefined {
  const token = envValue(envPath, "DISCORD_TOKEN").trim();
  if (!token) return undefined;
  try {
    appIdFromToken(token);
    return token;
  } catch {
    return undefined; // a placeholder, not a real token
  }
}

/**
 * Which instance in the runtime folder *is* this Discord bot.
 *
 * Matched by token, because a bot's Discord username is not its folder name:
 * the portal says "hoo-bot" and the manager says "hoo", and looking for a
 * folder by username is how a peer check ends up reporting a bot that is
 * there under a different name as missing.
 */
export function instanceFor(appId: string, names?: string[], dir: string = runtime): string | undefined {
  const candidates = names ?? namesInRuntime;
  for (const n of candidates) {
    const token = tokenForOf(join(dir, n, ".env"));
    if (!token) continue;
    try {
      if (appIdFromToken(token) === appId) return n;
    } catch {
      // not a token; skip
    }
  }
  return undefined;
}

function fail(message: string): never {
  console.error(`discord-app.ts: ${message}`);
  process.exit(1);
}

// ── the API ─────────────────────────────────────────────────────────────────

type Me = { id: string; username: string; global_name?: string | null; bot?: boolean };
type Guild = { id: string; name: string };

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  if (!res.ok) {
    const detail = (json as { message?: string; code?: number }) ?? {};
    throw new Error(`${path} → ${res.status}${detail.message ? ` ${detail.message}` : ""}`);
  }
  return json as T;
}

/** Discord says what is wrong; a dead token has to read as a dead token. */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/401|Unauthorized/i.test(message)) {
    return "Discord rejected the token. It was reset in the portal, or the app was deleted — mint a new one (Developer portal → your app → Bot → Reset Token).";
  }
  return message;
}

// ── commands ────────────────────────────────────────────────────────────────

/**
 * Every Discord peer in `PEER_BOT_IDS`, resolved and checked in both
 * directions.
 *
 * One list holds both chats' ids: a Discord id is digits, a Slack member id
 * starts with `U`. Asking Discord about a `U…` answers 400, not "unknown
 * user", so the two are split here — a Slack-only id is not a broken Discord
 * peer, and reporting it as one sends you fixing a wiring that is fine.
 */
export function splitPeerIds(value: string): { discord: string[]; other: string[] } {
  const discord: string[] = [];
  const other: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const id = raw.trim();
    if (!id) continue;
    // A Discord id is a snowflake: digits only. Anything else is the other
    // chat's (Slack's `U…`) or a word like `off`, and neither is an id
    // Discord can answer for.
    (/^\d+$/.test(id) ? discord : other).push(id);
  }
  return { discord, other };
}

async function peers(): Promise<number> {
  const dir = botDir();
  const token = tokenFor();
  const me = await api<Me>(token, "/users/@me").catch((e) => fail(describe(e)));
  const { discord: ids, other } = splitPeerIds(envValue(join(dir, ".env"), "PEER_BOT_IDS"));
  if (other.length) console.log(`  (${other.length} Slack id(s) in PEER_BOT_IDS — not looked up here)`);
  if (!ids.length) {
    console.warn(`PEER_BOT_IDS lists no Discord bot — ${name} ignores every other bot on Discord.`);
    console.warn("A bot that is not listed is dropped even though it is a bot, and the failure is silence.");
    console.warn(`Add the other bot's application id: discord-app.ts id <other>`);
    return 0;
  }
  let problems = 0;
  const owners: string[] = [];
  for (const id of ids) {
    if (id === me.id) continue;
    let user: Me;
    try {
      user = await api<Me>(token, `/users/${id}`);
    } catch (e) {
      console.error(`  peer ${id}: ${describe(e)}`);
      problems++;
      continue;
    }
    // Discord's own `bot` flag decides, so a person listed here stays a
    // person — the same rule src/discord.ts applies to a live message.
    if (!user.bot) {
      console.error(`  peer ${id}: ${user.username} is a person, not a bot — it stays a person, remove it from PEER_BOT_IDS`);
      problems++;
      continue;
    }
    console.log(`  peer @${user.username} (${id})`);
    // A bot's Discord username is not its instance folder ("hoo-bot" vs
    // "hoo"), so the folder is found by which token is *this* bot's id —
    // the one thing about the pair that is actually stable.
    const owner = instanceFor(id);
    if (!owner) {
      console.warn(`  no bot in ${runtime} has this application id — no instance folder to check against`);
    } else {
      const back = splitPeerIds(envValue(join(runtime, owner, ".env"), "PEER_BOT_IDS")).discord;
      if (back.includes(me.id)) console.log(`    ${owner} lists us back (${me.id})`);
      else {
        console.error(`    ${owner} does not list ${me.id} — one-way peers never answer each other`);
        problems++;
      }
    }
    owners.push(user.username);
  }
  if (owners.length) console.log(`\n${name} answers @${owners.join(", @")} on Discord, ${envValue(join(dir, ".env"), "PEER_TURNS") || "2"} turns per thread.`);
  return problems;
}

async function verify(): Promise<void> {
  const dir = botDir();
  const token = tokenFor();
  const me = await api<Me>(token, "/users/@me").catch((e) => fail(describe(e)));
  console.log(`bot_id=${me.id}`);
  console.log(`bot_name=${me.username}`);
  console.log(`is_bot=${me.bot ?? false}`);

  // The id in the token and the id Discord answers with must be the same.
  // When they are not, the token belongs to a different app than the one the
  // user is looking at in the portal — which is how peers get wired to an
  // app that does not exist.
  const fromToken = appIdFromToken(token);
  console.log(`application_id=${fromToken}${fromToken === me.id ? "" : "  ← does not match bot_id!"}`);

  const guilds = await api<Guild[]>(token, "/users/@me/guilds").catch((e) => fail(describe(e)));
  const wanted = envValue(join(dir, ".env"), "GUILD_ID");
  if (!guilds.length) {
    console.log("guilds=(none) — the bot has not been added to a server yet");
  } else {
    console.log(`guilds=${guilds.map((g) => `${g.name} (${g.id})`).join(", ")}`);
    if (wanted && !guilds.some((g) => g.id === wanted)) {
      console.log(`  GUILD_ID=${wanted} but the bot is not in that server — it will answer nowhere`);
    }
  }

  // The gateway is the live connection, so an unusable one produces a bot
  // that looks fine in the manager until someone mentions it.
  const gateway = await api<{ url?: string }>(token, "/gateway/bot").catch(() => null);
  console.log(`gateway=${gateway?.url ? "ok" : "FAILED"}`);

  if (me.bot) {
    // A person whose token is here would answer to any mention; say so.
    console.log("\nintents: Message Content is a privileged intent, so it can only be read from the");
    console.log("portal (Bot → Privileged Gateway Intents). If mentions are seen but empty, that");
    console.log("switch is off — nothing this script can see changes it.");
  }

  const problems = await peers();
  if (problems) {
    console.log(`\n${problems} peer problem(s). Fix them before calling this bot done.`);
    process.exit(1);
  }
}

async function avatar(): Promise<void> {
  const icon = flag("icon");
  if (!icon) fail("which icon? --icon <file.png>");
  if (!existsSync(icon)) fail(`no such icon: ${icon}`);
  const png = readFileSync(icon);
  if (png[0] !== 0x89 || png[1] !== 0x50) {
    fail(`${icon} is not a PNG. Discord takes a PNG data URI here; an SVG or a JPEG is rejected with a 400 and no explanation.`);
  }
  const token = tokenFor();
  const me = await api<Me>(token, "/users/@me").catch((e) => fail(describe(e)));
  // A bot may change its own avatar, which is why the icon is one command
  // here and a portal upload on Slack's side.
  const data = `data:image/png;base64,${png.toString("base64")}`;
  await api<Me>(token, "/users/@me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar: data }),
  }).catch((e) => fail(describe(e)));
  console.log(`avatar updated on @${me.username} (${icon})`);
  console.log("Discord caches avatars for a few minutes; old client apps can keep the old one for longer.");
}

async function write(): Promise<void> {
  const token = (flag("token") ?? "").trim();
  if (!token) fail("--token <the bot token>");
  const dir = botDir();
  appIdFromToken(token); // a token that is not a bot token is caught here
  const guild = flag("guild");
  const keys: Record<string, string> = { DISCORD_TOKEN: token };
  // HOO_SURFACES only decides which boxes the manager draws; the surface
  // connects on its token. Set it anyway, or the manager shows a token-less
  // bot as having no chat at all.
  const surfaces = envValue(join(dir, ".env"), "HOO_SURFACES");
  if (!surfaces.split(",").map((s) => s.trim()).includes("discord")) {
    keys.HOO_SURFACES = [...new Set([...surfaces.split(","), "discord"].map((s) => s.trim()).filter(Boolean))].join(",");
  }
  if (guild) keys.GUILD_ID = guild;
  writeEnvKeys(join(dir, ".env"), keys);
  console.log(`application_id=${appIdFromToken(token)}`);
  console.log(`written to ${join(dir, ".env")} (mode 600)`);
  console.log(`\nAdd the bot to a server — this URL carries every permission it needs:\n\n  ${inviteUrl(appIdFromToken(token), guild ?? envValue(join(dir, ".env"), "GUILD_ID"))}\n`);
  console.log(`Then restart ${name} and check it: bash "$(hoobot path selftest)" ${name}`);
}

async function main(): Promise<void> {
  switch (command) {
    case "id":
      console.log(appIdFromToken(tokenFor()));
      return;
    case "token": {
      // `token` is the id for PEER_BOT_IDS, verified through Discord rather
      // than decoded — a token that is accepted is a token that works.
      const me = await api<Me>(tokenFor(), "/users/@me").catch((e) => fail(describe(e)));
      console.log(me.id);
      return;
    }
    case "invite": {
      const dir = existsSync(join(runtime, name ?? "", ".env")) ? botDir() : undefined;
      const guild = flag("guild") ?? (dir ? envValue(join(dir, ".env"), "GUILD_ID") : "");
      console.log(inviteUrl(appIdFromToken(tokenFor()), guild || undefined));
      return;
    }
    case "avatar":
      await avatar();
      return;
    case "write":
      await write();
      return;
    case "verify":
      await verify();
      return;
    case "peers":
      process.exit(await peers());
      return;
    default:
      console.error(`usage: discord-app.ts <id|token|invite|avatar|write|verify|peers> <bot> [options]

  --token <token>   the bot token, when it is not in the .env yet
  --icon <file.png> avatar: upload the bot's own icon
  --guild <id>      preselect a server in the invite URL, and save GUILD_ID
  --runtime <dir>   the hoobot runtime folder (default: hoobot path runtime)
  --write           write: save the token into the bot's .env

Creating the application is a portal step and stays one:

  discord.com/developers/applications → New Application → name it
  → Bot → Reset Token → copy it
  → Bot → Privileged Gateway Intents → Message Content Intent ON
  → Installation → copy the Install Link, or use \`invite\` above`);
      process.exit(command ? 0 : 64);
  }
}

// Only when run as a command: the tests import the pure helpers above.
if (import.meta.main) await main();