/**
 * The instance data layer for the bot manager.
 *
 * An *instance* is a folder under `runtime/` with its own `.env`, log and
 * pid — the same shape `scripts/runtime.sh` supervises. The manager has no
 * database: **the `.env` file is the state**. Anything the UI can show or
 * change is a key in it, which means the file stays hand-editable and the
 * two tools can never disagree.
 *
 * Nothing here imports `./config.ts`: that module exits the process when a
 * token is missing, which would make it unusable from a manager that is
 * looking at bots it isn't running. The parsing below deliberately
 * duplicates a little of it — the cost of being able to read a bot's config
 * without being that bot.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hashSeed, type AvatarShape, type AvatarStyle } from "./avatar.ts";

/** Folder names under `runtime/` that are not bots. */
/** Folders in the runtime dir that are not bots. `slack` holds the Slack
 *  CLI projects the `bot-slack` skill creates; it is not an instance. */
const RESERVED = new Set(["shared", "manager", "workspace", "node_modules", "logs", "slack"]);

export function repoRoot(): string {
  return resolve(import.meta.dir, "..");
}

/** True when this code runs from an installed package, not a checkout. */
export function isInstalled(root = repoRoot()): boolean {
  return /[\\/]node_modules[\\/]/.test(root);
}

/**
 * `runtime/` in a checkout, `~/.hoobot/runtime` when installed from npm (a
 * reinstall replaces the package folder, and tokens must not live in it), or
 * `HOOBOT_RUNTIME_DIR` so tests (and a second checkout) can work somewhere
 * harmless. `dir` wins over all of them: callers that were handed a folder
 * use it rather than guessing.
 */
export function runtimeDir(dir?: string): string {
  if (dir) return resolve(dir);
  const env = process.env.HOOBOT_RUNTIME_DIR?.trim();
  if (env) return resolve(env);
  const root = repoRoot();
  return isInstalled(root) ? join(homedir(), ".hoobot", "runtime") : join(root, "runtime");
}

// ---------------------------------------------------------------- env files

/**
 * `NAME=value` lines; `#` comments and blanks skipped, quotes stripped,
 * last value wins. Tolerant on purpose — people edit these by hand and the
 * manager must never refuse to open a file with a stray comment in it.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

export function parseLists(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Write `text` to `path` via a temp file in the same folder, then rename. */
function writeAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// ----------------------------------------------------------------- secrets

export function isSecretKey(key: string): boolean {
  return /TOKEN|SECRET|KEY/.test(key);
}

/**
 * What the browser is allowed to see of a token: enough to recognise which
 * one it is, never enough to use it. Loopback with no auth already assumes
 * every local process is the owner, but a token echoed into a screenshot
 * or a devtools panel is a different risk, so the real value never leaves
 * this process.
 */
export function maskSecret(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 4)}${"•".repeat(Math.min(16, v.length - 8))}${v.slice(-4)}`;
}

/** The placeholder a masked field shows when the user hasn't touched it. */
export const UNCHANGED = "__unchanged__";

// ------------------------------------------------------------------- names

export function isValidName(name: string): boolean {
  return validateName(name) === null;
}

/** `null` when the name is usable, otherwise why it isn't (shown in the UI). */
export function validateName(name: string, dir?: string): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return "Give the bot a name.";
  if (n.length > 24) return "Keep it to 24 characters or fewer.";
  if (!/^[a-z][a-z0-9-]*$/.test(n)) return "Use lowercase letters, numbers and dashes, starting with a letter.";
  if (RESERVED.has(n)) return `“${n}” is reserved by the runtime folder.`;
  if (existsSync(join(dir ?? runtimeDir(), n, ".env"))) return `“${n}” already exists.`;
  return null;
}

/** Two-syllable, easy to say out loud — a bot you talk to in a channel. */
const NAMES = [
  "momo", "pepper", "wren", "juno", "kiko", "nova", "tuft", "plum", "quill", "fern",
  "otter", "basil", "mango", "sable", "clove", "ember", "fable", "gizmo", "harbor", "iris",
  "jelly", "kelp", "lark", "maple", "nimbus", "opal", "pip", "quartz", "reef", "sugar",
  "tango", "umber", "velvet", "willow", "yarrow", "zephyr", "cedar", "dune", "echo", "flint",
];

/**
 * A name nobody is using. `seed` makes it deterministic, so the UI can
 * re-roll by passing a new seed and get a different suggestion for the same
 * click instead of the same one twice.
 */
export function suggestName(existing: string[], seed?: string): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const start = seed === undefined ? Math.floor(Math.random() * NAMES.length) : hashSeed(seed) % NAMES.length;
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[(start + i) % NAMES.length]!;
    if (!taken.has(name)) return name;
  }
  for (let i = 2; i < 100; i++) {
    const name = `${NAMES[start % NAMES.length]}-${i}`;
    if (!taken.has(name)) return name;
  }
  return `bot-${Date.now().toString(36).slice(-4)}`;
}

/** First free port at or above `from`, so each bot gets its own health port. */
export function nextPort(taken: number[], from = 8787): number {
  const used = new Set(taken);
  for (let port = from; port < 65535; port++) if (!used.has(port)) return port;
  return from;
}

// ----------------------------------------------------------------- surfaces

/** Which chats a bot is configured for. Mirrors `surfaces()` in config.ts. */
export function surfacesFor(env: Map<string, string>): ("discord" | "slack")[] {
  const out: ("discord" | "slack")[] = [];
  if (env.get("DISCORD_TOKEN")?.trim()) out.push("discord");
  if (env.get("SLACK_BOT_TOKEN")?.trim() && env.get("SLACK_APP_TOKEN")?.trim()) out.push("slack");
  return out;
}

/**
 * The chats the *manager* should offer settings for: whatever the bot has
 * tokens for, plus whatever `HOO_SURFACES` says it is going to be.
 *
 * Without the second part a brand-new bot has no token, so no surface, so
 * no token box to paste one into — the UI could never set up the bot it
 * just made. `HOO_SURFACES` records the intent; it changes nothing about
 * how the bot connects (config.ts still decides from tokens) and only
 * tells the manager which boxes to draw.
 */
export function chatSurfaces(env: Map<string, string>): ("discord" | "slack")[] {
  const out = new Set<"discord" | "slack">(surfacesFor(env));
  for (const one of parseLists(env.get("HOO_SURFACES"))) {
    if (one === "discord" || one === "slack") out.add(one);
  }
  return (["discord", "slack"] as const).filter((s) => out.has(s));
}

// ------------------------------------------------------------------- fields

export type FieldKind = "text" | "secret" | "number" | "list" | "toggle" | "select" | "multi";

export type Field = {
  key: string;
  label: string;
  kind: FieldKind;
  group: string;
  hint?: string;
  placeholder?: string;
  choices?: string[];
  min?: number;
  max?: number;
};

/** Group order in the UI. */
export const GROUPS = ["Chat", "People", "Workspace", "Model", "Approvals", "Advanced", "Look"] as const;

/**
 * Every setting the UI can edit, in display order. `hint` is the one
 * sentence a person actually needs — the long explanation stays in
 * `.env.example`, which is where someone reads when they want the why.
 */
export const FIELDS: Field[] = [
  { key: "DISCORD_TOKEN", label: "Discord bot token", kind: "secret", group: "Chat", hint: "Developer portal → your app → Bot → Reset Token." },
  { key: "SLACK_BOT_TOKEN", label: "Slack bot token", kind: "secret", group: "Chat", hint: "OAuth & Permissions, starts with xoxb-.", placeholder: "xoxb-…" },
  { key: "SLACK_APP_TOKEN", label: "Slack app token", kind: "secret", group: "Chat", hint: "App-Level Tokens with connections:write, starts with xapp-.", placeholder: "xapp-…" },
  {
    key: "HOO_SURFACES",
    label: "Chats",
    kind: "multi",
    group: "Chat",
    choices: ["slack", "discord"],
    hint: "Which chats this bot is set up for. Each one connects once its tokens are filled in.",
  },

  { key: "ALLOWED_USER_IDS", label: "Allowed users", kind: "list", group: "People", hint: "Everyone else is ignored. Discord IDs are digits, Slack member IDs look like U0123ABCD.", placeholder: "758289752645959720" },
  { key: "PEER_BOT_IDS", label: "Companion bots", kind: "list", group: "People", hint: "Slack member IDs of bots allowed to mention this one. Empty = bots are ignored." },
  { key: "PEER_TURNS", label: "Turns per thread", kind: "number", group: "People", min: 1, max: 20, hint: "Answers a companion bot gets before asking you for more." },
  { key: "GUILD_ID", label: "Discord server ID", kind: "text", group: "People", hint: "Leave empty to answer in any server the bot is in." },
  { key: "CHANNEL_IDS", label: "Only these channels", kind: "list", group: "People", hint: "Empty = every channel." },

  { key: "HOO_WORKDIR", label: "Working folder", kind: "text", group: "Workspace", hint: "Where hoocode reads and writes. Shared folders let bots see each other's files." },
  { key: "WORKSPACES", label: "Per-channel folders", kind: "list", group: "Workspace", hint: "channel-id=folder, comma-separated. Not with a shared app-server." },
  { key: "APP_SERVER", label: "App-server", kind: "text", group: "Workspace", hint: "Empty = start hoocode's own. Or a unix socket / stdio command.", placeholder: "stdio:hoocode app-server" },
  { key: "HOOCODE_BIN", label: "hoocode command", kind: "text", group: "Workspace", hint: "Used when no app-server is given.", placeholder: "hoocode" },
  { key: "HOOCODE_ARGS", label: "Extra flags", kind: "text", group: "Workspace", hint: "Passed to the app-server only.", placeholder: "--thinking high" },

  { key: "MODEL", label: "Model", kind: "text", group: "Model", hint: "Leave empty and the bot takes whatever hoocode defaults to — a subscription that can lapse, leaving it busy on a call that never answers. Also settable per thread with !model.", placeholder: "opencode-go/space-bunny-free" },
  { key: "LINKS_FILE", label: "Conversation file", kind: "text", group: "Model", hint: "Keeps chat threads matched to app-server threads. One per bot." },
  { key: "DEBUG", label: "Print app-server errors", kind: "toggle", group: "Model", hint: "Noisier logs; useful when a tool call misbehaves." },

  { key: "APPROVALS", label: "Tool approvals", kind: "select", group: "Approvals", choices: ["auto", "ask"], hint: "auto runs shell and file edits without asking; ask shows Allow / Deny buttons." },
  { key: "APPROVAL_TIMEOUT_MINUTES", label: "Approval timeout", kind: "number", group: "Approvals", min: 1, max: 120, hint: "Minutes to wait for an Allow / Deny click." },
  { key: "IDLE_TIMEOUT_MINUTES", label: "Idle timeout", kind: "number", group: "Approvals", min: 1, max: 1440, hint: "Minutes of silence before the bot lets go of a thread." },

  { key: "HEALTH_PORT", label: "Health port", kind: "number", group: "Advanced", min: 1024, max: 65535, hint: "This bot's own port on 127.0.0.1. The manager reads its status from here." },
  { key: "HOO_INSTANCE", label: "Instance name", kind: "text", group: "Advanced", hint: "Shown in /healthz. Set from the folder name." },

  { key: "HOO_AVATAR_SEED", label: "Avatar seed", kind: "number", group: "Look", min: 0, hint: "The same seed always draws the same avatar." },
  { key: "HOO_AVATAR_SHAPE", label: "Avatar shape", kind: "select", group: "Look", choices: ["circle", "squircle"], hint: "Circle reads as a chat avatar; a rounded square as an app icon." },
  { key: "HOO_AVATAR_STYLE", label: "Avatar style", kind: "select", group: "Look", choices: ["dots", "pet"], hint: "Dots is the plain tile; pet is a cartoonish face cropped into the shape." },
  { key: "HOO_AVATAR_PALETTE", label: "Avatar colour", kind: "select", group: "Look", choices: ["amber", "teal", "violet", "rose", "slate", "lime"], hint: "Empty picks one from the seed." },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** Keys whose fields only make sense for one chat platform. */
const DISCORD_ONLY = new Set(["DISCORD_TOKEN", "GUILD_ID"]);
const SLACK_ONLY = new Set(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]);

/**
 * Only the fields that apply. A Slack-only bot should never be shown a
 * Discord token box: an empty box reads as "fill this in" and a filled one
 * that does nothing is worse.
 */
export function fieldsFor(surfaces: string[]): Field[] {
  const wanted = new Set(surfaces);
  return FIELDS.filter((f) => {
    if (DISCORD_ONLY.has(f.key)) return wanted.has("discord");
    if (SLACK_ONLY.has(f.key)) return wanted.has("slack");
    return true;
  });
}

// ---------------------------------------------------------------- instances

export type Instance = {
  name: string;
  dir: string;
  envPath: string;
  port: number;
  running: boolean;
  pid: number | null;
  surfaces: ("discord" | "slack")[];
  /** The chats it has tokens for: these can't be unticked, only emptied. */
  tokenSurfaces: ("discord" | "slack")[];
  /** Visible settings, keys only. */
  config: Record<string, string>;
  /** Token fields, masked; "" means not set. */
  secrets: Record<string, string>;
  fields: Field[];
  avatarSeed: number;
  avatarShape: AvatarShape;
  avatarStyle: AvatarStyle;
  avatarPalette: string;
  workdir: string;
};

function dirFor(name: string, dir?: string): string {
  return join(dir ?? runtimeDir(), name);
}

/** Reject anything that could escape the runtime folder before it hits a path. */
function safeDir(name: string, dir?: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(trimmed) || RESERVED.has(trimmed)) {
    throw new Error(`“${name}” isn't a usable instance name.`);
  }
  const base = resolve(dir ?? runtimeDir());
  const full = resolve(base, trimmed);
  if (dirname(full) !== base) throw new Error(`“${name}” is outside the runtime folder.`);
  return full;
}

export function pidFor(name: string, dir?: string): number | null {
  const pidPath = join(dirFor(name, dir), `${name}.pid`);
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null; // stale pidfile: the process is gone
  }
}

function envTemplate(): string {
  const example = join(repoRoot(), ".env.example");
  if (existsSync(example)) return readFileSync(example, "utf8");
  return FIELDS.map((f) => `${f.key}=`).join("\n") + "\n";
}

/** Turn a parsed .env into the shape the UI consumes. */
export function instanceFrom(name: string, env: Map<string, string>, dir?: string): Instance {
  const surfaces = chatSurfaces(env);
  const avatarSeed = Number(env.get("HOO_AVATAR_SEED") ?? "") || hashSeed(name);
  const shape = env.get("HOO_AVATAR_SHAPE")?.trim();
  const port = Number(env.get("HEALTH_PORT") ?? "") || 8787;
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of fieldsFor(surfaces)) {
    const raw = env.get(field.key)?.trim() ?? "";
    if (field.kind === "secret") secrets[field.key] = maskSecret(raw);
    else config[field.key] = raw;
  }
  // Surface tokens count as set or not, never as a value the UI echoes back.
  if (surfaces.includes("discord")) secrets.DISCORD_TOKEN = maskSecret(env.get("DISCORD_TOKEN"));
  if (surfaces.includes("slack")) {
    secrets.SLACK_BOT_TOKEN = maskSecret(env.get("SLACK_BOT_TOKEN"));
    secrets.SLACK_APP_TOKEN = maskSecret(env.get("SLACK_APP_TOKEN"));
  }
  const pid = pidFor(name, dir);
  return {
    name,
    dir: dirFor(name, dir),
    envPath: join(dirFor(name, dir), ".env"),
    port,
    running: pid !== null,
    pid,
    surfaces,
    tokenSurfaces: surfacesFor(env),
    config,
    secrets,
    fields: fieldsFor(surfaces),
    avatarSeed,
    avatarShape: shape === "squircle" ? "squircle" : "circle",
    avatarStyle: env.get("HOO_AVATAR_STYLE")?.trim() === "pet" ? "pet" : "dots",
    avatarPalette: env.get("HOO_AVATAR_PALETTE")?.trim() ?? "",
    workdir: env.get("HOO_WORKDIR")?.trim() ?? "",
  };
}

export function readInstance(name: string, dir?: string): Instance | null {
  const envPath = join(safeDir(name, dir), ".env");
  if (!existsSync(envPath)) return null;
  return instanceFrom(name.trim().toLowerCase(), parseEnv(readFileSync(envPath, "utf8")), dir);
}

/** Every bot folder in `runtime/`, `hoo` first then alphabetical. */
export function listInstances(dir?: string): Instance[] {
  const base = dir ?? runtimeDir();
  if (!existsSync(base)) return [];
  const out: Instance[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || RESERVED.has(entry.name)) continue;
    const envPath = join(base, entry.name, ".env");
    if (!existsSync(envPath)) continue;
    try {
      out.push(instanceFrom(entry.name, parseEnv(readFileSync(envPath, "utf8")), base));
    } catch {
      // A malformed folder shouldn't take the whole manager down with it.
    }
  }
  return out.sort((a, b) => (a.name === "hoo" ? -1 : b.name === "hoo" ? 1 : a.name.localeCompare(b.name)));
}

/**
 * Update an existing `.env` in place. Comments and untouched keys survive:
 * someone who hand-tuned this file should not lose their notes because they
 * flipped `APPROVALS` in the UI.
 */
export function writeInstance(
  name: string,
  values: Record<string, string>,
  opts: { dir?: string; secrets?: boolean } = {},
): Instance {
  const target = safeDir(name, opts.dir);
  const envPath = join(target, ".env");
  if (!existsSync(envPath)) throw new Error(`No bot called “${name}”.`);
  let text = readFileSync(envPath, "utf8");

  for (const [key, raw] of Object.entries(values)) {
    if (!BY_KEY.has(key)) continue;
    const value = String(raw ?? "").replace(/[\r\n]+/g, " ").trim();
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`);
    const lines = text.split("\n");
    // parseEnv takes the last value, so the last line is the one to rewrite.
    // Duplicates above it are dropped: leaving them would let a stale value
    // win the next time the file is read.
    let last = -1;
    lines.forEach((line, i) => {
      if (pattern.test(line)) last = i;
    });
    const out: string[] = [];
    lines.forEach((line, i) => {
      if (!pattern.test(line)) out.push(line);
      else if (i === last) out.push(`${key}=${value}`);
    });
    if (last === -1) out.push(`${key}=${value}`);
    text = out.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  writeAtomic(envPath, text.endsWith("\n") ? text : `${text}\n`, 0o600);
  return readInstance(name, opts.dir)!;
}

/** Where a new bot works. Sharing one folder is the current hoo/hee setup. */
export function suggestWorkdir(name: string, dir?: string): string {
  const shared = join(dir ?? runtimeDir(), "shared", "workspace");
  return existsSync(shared) ? shared : join(dirFor(name, dir), "workspace");
}

export function createInstance(
  opts: {
    name: string;
    surfaces: string[];
    workdir?: string;
    config?: Record<string, string>;
    secrets?: Record<string, string>;
    dir?: string;
  },
): Instance {
  const name = opts.name.trim().toLowerCase();
  const problem = validateName(name, opts.dir);
  if (problem) throw new Error(problem);
  const target = safeDir(name, opts.dir);
  if (existsSync(join(target, ".env"))) throw new Error(`A bot called “${name}” already exists.`);

  const taken = listInstances(opts.dir).map((i) => i.port);
  const values: Record<string, string> = {
    HOO_INSTANCE: name,
    HOO_SURFACES: opts.surfaces.join(","),
    HOO_WORKDIR: opts.workdir?.trim() || suggestWorkdir(name, opts.dir),
    ALLOWED_USER_IDS: "",
    HEALTH_PORT: String(nextPort(taken)),
    HOO_AVATAR_SEED: String(hashSeed(name)),
    HOO_AVATAR_SHAPE: "circle",
    ...opts.config,
    ...opts.secrets,
  };
  // A surface chosen in the UI but left without a token must not look
  // configured: clear the fields the other surface uses.
  if (!opts.surfaces.includes("discord")) delete values.DISCORD_TOKEN;
  if (!opts.surfaces.includes("slack")) {
    delete values.SLACK_BOT_TOKEN;
    delete values.SLACK_APP_TOKEN;
  }
  if (opts.surfaces.includes("slack") && !opts.surfaces.includes("discord")) {
    // Discord's defaults (the Hoo server) are meaningless without Discord.
    delete values.GUILD_ID;
  }

  mkdirSync(target, { recursive: true });
  let text = envTemplate();
  for (const [key, value] of Object.entries(values)) {
    const clean = String(value).replace(/[\r\n]+/g, " ").trim();
    const line = new RegExp(`^(\\s*)(?:export\\s+)?${key}\\s*=.*$`, "m");
    text = line.test(text)
      ? text.replace(line, `${key}=${clean}`)
      : `${text}\n# added by the bot manager\n${key}=${clean}\n`;
  }
  writeAtomic(join(target, ".env"), text.endsWith("\n") ? text : `${text}\n`, 0o600);
  return readInstance(name, opts.dir)!;
}

/** Remove an instance. Refuses while it is running — stop it first. */
export function deleteInstance(name: string, dir?: string): boolean {
  const target = safeDir(name, dir);
  if (!existsSync(join(target, ".env"))) return false;
  if (pidFor(name, dir) !== null) throw new Error(`“${name}” is still running. Stop it first.`);
  rmSync(target, { recursive: true, force: true });
  return true;
}

/** Expand `~` the way a shell would, for paths typed into the UI. */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export { hashSeed };