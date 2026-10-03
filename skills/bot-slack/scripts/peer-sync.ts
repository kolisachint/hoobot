#!/usr/bin/env bun
/**
 * Point every bot's `PEER_BOT_IDS` at the bots it should actually be able to
 * talk to, and restart them so they pick it up.
 *
 * This exists because bot ids are not stable. A bot's Slack user id changes
 * every time its app is recreated — and apps get recreated more often than
 * anyone expects: a revoked token, a renamed bot, a move off the `_local`
 * development name. A stale id is the quietest failure there is. Nothing
 * errors, the bot stays connected, it simply never answers, and the reason
 * is a `U0C…` in a file nobody opened.
 *
 *   peer-sync.ts            # rewire and restart everything
 *   peer-sync.ts --dry-run  # show what would change
 *   peer-sync.ts --no-restart
 *
 * Ids are read from Slack, not from config: each bot's id comes from its own
 * token via `auth.test`. So a bot whose app is dead is reported as dead
 * rather than wired to an id that no longer exists — which is the whole
 * point. And the bot list comes from scanning the runtime folder, not from
 * hoobot's source, because this file gets copied into a work folder and has
 * to keep working from there.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const restart = !args.includes("--no-restart");

/** Folders in the runtime dir that hold no bot. */
const RESERVED = new Set(["shared", "manager", "workspace", "node_modules", "logs", "slack"]);

function runtimeDir(): string {
  const fromEnv = process.env.HOOBOT_RUNTIME_DIR?.trim();
  if (fromEnv) return fromEnv.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  const out = spawnSync("hoobot", ["path", "runtime"], { encoding: "utf8" });
  const line = out.stdout?.trim();
  if (out.status === 0 && line?.startsWith("/")) return line;
  return join(process.env.HOME ?? "~", ".hoobot", "runtime");
}

const runtime = runtimeDir();

/** Read a key out of an .env without sourcing the file. */
function envValue(path: string, key: string): string {
  if (!existsSync(path)) return "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    if ((line.split("=")[0] ?? "").trim() === key) return line.slice(line.indexOf("=") + 1).trim();
  }
  return "";
}

/**
 * hoobot's own `scripts/runtime.sh`, for restarts.
 *
 * Not a relative path: this file is copied into a work folder alongside the
 * other skills, where there is no hoobot checkout to climb back to. paths.sh
 * next door already knows how to find it on an installed hoobot and on an
 * old one, so ask it rather than guessing.
 */
function runtimeScript(): string {
  const out = spawnSync("bash", [join(import.meta.dir, "paths.sh"), "runtime-script"], { encoding: "utf8" });
  const path = out.stdout?.trim();
  if (out.status === 0 && path && existsSync(path)) return path;
  return join(import.meta.dir, "..", "..", "..", "..", "scripts", "runtime.sh");
}

/** Rewrite one key in place, so comments and ordering survive. */
function setKey(path: string, key: string, value: string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  const line = `${key}=${value}`;
  const at = lines.findIndex((l) => (l.split("=")[0] ?? "").trim() === key);
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  writeFileSync(path, lines.join("\n").replace(/\n+$/, "\n"));
}

const names = existsSync(runtime)
  ? readdirSync(runtime, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !RESERVED.has(e.name) && existsSync(join(runtime, e.name, ".env")))
      .map((e) => e.name)
      .sort()
  : [];

if (!names.length) {
  console.error(`peer-sync: no bots found in ${runtime}`);
  process.exit(1);
}

/** Each bot's Slack user id, from its own token. */
type Live = { name: string; id: string; label: string };
const live: Live[] = [];
const dead: string[] = [];

for (const name of names) {
  const token = envValue(join(runtime, name, ".env"), "SLACK_BOT_TOKEN");
  if (!token) {
    dead.push(`${name} (no SLACK_BOT_TOKEN)`);
    continue;
  }
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const d = (await res.json()) as { ok?: boolean; user_id?: string; user?: string; error?: string };
    if (d.ok && d.user_id) live.push({ name, id: d.user_id, label: d.user ?? "" });
    else dead.push(`${name} (${d.error ?? "not ok"})`);
  } catch (e) {
    dead.push(`${name} (${e instanceof Error ? e.message : "no answer"})`);
  }
}

for (const b of live) console.log(`   ${b.name.padEnd(12)} ${b.id}  ${b.label}`);
const byId = new Map(live.map((b) => [b.id, b.name]));
for (const [id, owner] of byId) {
  const twin = live.find((b) => b.id === id && b.name !== owner);
  if (twin) console.log(`!! ${owner} and ${twin.name} share the id ${id} — likely one app copied`);
}

console.log(`\n${live.length} live bot(s) in ${runtime}`);
if (dead.length) {
  console.log(`${dead.length} unreachable — left out, because pointing peers at a dead id is`);
  console.log("the exact failure this exists to prevent:");
  for (const d of dead) console.log(`   ${d}`);
}

// A bot may only be mentioned by other bots, so every live id belongs in
// every other bot's list: a peer mesh, not a ring.
console.log("");
let changed = 0;
for (const name of names) {
  const envPath = join(runtime, name, ".env");
  const want = live.filter((b) => b.name !== name).map((b) => b.id).sort().join(",");
  if (!live.some((b) => b.name === name)) continue;
  const have = envValue(envPath, "PEER_BOT_IDS");
  if (have === want) {
    console.log(`   ${name.padEnd(12)} already ${want || "(none)"}`);
    continue;
  }
  changed++;
  console.log(`   ${name.padEnd(12)} ${have || "(none)"}  ->  ${want || "(none)"}`);
  if (dryRun) continue;
  setKey(envPath, "PEER_BOT_IDS", want);
  if (restart) {
    const out = spawnSync("bash", [runtimeScript(), "restart", name], {
      env: { ...process.env, HOOBOT_RUNTIME_DIR: runtime, RUN_FROM_NPM: "1" },
      encoding: "utf8",
    });
    const last = (out.stdout || out.stderr || "").trim().split("\n").slice(-1)[0] ?? "";
    console.log(`      restart: ${last}`);
  }
}

console.log(
  changed
    ? `\n${dryRun ? "would change" : "changed"} ${changed} bot(s)${restart ? ", restarted" : ""}`
    : "\nnothing to change",
);
if (dead.length && !dryRun) {
  console.log("\nFix the unreachable bots and run this again.");
}

