#!/usr/bin/env bun
/**
 * The bot manager: one local web page that lists your bots, starts and
 * stops them, and edits their settings (design doc 20).
 *
 * It is deliberately a *manager*, not a second runtime. Every start and
 * stop goes through `scripts/runtime.sh`, the same script that works from
 * the terminal, so there is one supervisor and one place where a bot's pid
 * is decided. The manager holds no state of its own: `runtime/<name>/.env`
 * is the config, `pidFor()` is the truth about whether a bot runs, and each
 * bot's own `/healthz` is the truth about how it is doing.
 *
 * - `GET  /api/manager`               every instance with its live health, and
 *                                    whether this Mac is being kept awake
 * - `GET  /api/names/suggest?seed=`   a free bot name (the re-roll button)
 * - `POST /api/instances`             create a bot
 * - `PATCH /api/instances/:name`      change settings (comments survive)
 * - `DELETE /api/instances/:name`     remove a stopped bot
 * - `POST /api/instances/:name/start|stop|restart`
 * - `GET  /api/instances/:name/logs?lines=`
 * - `GET  /api/avatar.svg?seed=&shape=&palette=`  a face for a bot that
 *   doesn't exist yet (the new-bot sheet previews before saving)
 * - `GET  /api/instances/:name/avatar.svg`
 * - `POST /api/instances/:name/avatar {seed}`  re-roll the face
 * - `GET  /`                          the UI (static files from `web/`)
 *
 * Loopback only, no auth: every process running as you already owns this
 * box (R11), and a token in the URL would just end up in a shell history.
 * Requests whose `Host`/`Origin` isn't loopback are refused, so a page on
 * the open internet can't drive your bots through your browser.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { avatarSvg, AVATAR_SHAPES, AVATAR_STYLES, hashSeed, PALETTES, type AvatarStyle } from "./avatar.ts";
import { powerState } from "./power.ts";
import {
  createInstance,
  deleteInstance,
  expandHome,
  FIELDS,
  GROUPS,
  listInstances,
  maskSecret,
  readInstance,
  repoRoot,
  runtimeDir,
  suggestName,
  UNCHANGED,
  validateName,
  writeInstance,
  type Instance,
} from "./instances.ts";
import { error, log } from "./log.ts";

/** Default port for the manager itself. Bots start at 8787, so nothing collides. */
export const DEFAULT_MANAGER_PORT = 8790;

/** How long a bot's `/healthz` may take before we call it unreachable. */
const HEALTH_TIMEOUT_MS = 2000;

const WEB_DIR = join(import.meta.dir, "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Only these hosts: a page on another site must not drive your bots. */
function isLocalHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** `{ "name": "pepper" }` or anything else that isn't an object. */
async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

// ------------------------------------------------------------------ health

/**
 * One bot's `/api/bots`, or `/healthz` if that's all it serves, or null.
 *
 * `/api/bots` is the richer one — model, approvals and live sessions as well
 * as liveness — so it is the one the UI wants; `/healthz` is the fallback so
 * an older bot still shows as connected rather than as broken.
 */
export async function fetchHealth(port: number): Promise<Record<string, unknown> | null> {
  for (const path of ["/api/bots", "/healthz"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      if (res.status === 404) continue; // older bot: try the next path
      return null;
    } catch {
      if (path === "/healthz") return null; // stopped, booting, or the port is someone else's
    }
  }
  return null;
}

/** An instance plus what its own health endpoint says about it. */
export type LiveInstance = Instance & { health: Record<string, unknown> | null };

/**
 * Every instance with health folded in. Health calls run together so eight
 * bots don't take eight round trips, and a stopped bot is never asked.
 */
export async function liveInstances(dir?: string): Promise<LiveInstance[]> {
  const list = listInstances(dir);
  return Promise.all(
    list.map(async (instance) => ({ ...instance, health: instance.running ? await fetchHealth(instance.port) : null })),
  );
}

/** The whole `/api/manager` body: what the UI needs to draw itself. */
export async function managerBody(dir?: string): Promise<Record<string, unknown>> {
  return {
    ok: true,
    runtimeDir: runtimeDir(dir),
    repoRoot: repoRoot(),
    // Where a new bot works by default: one shared folder, so bots can see
    // each other's files the way hoo and hee do today.
    sharedWorkdir: join(runtimeDir(dir), "shared", "workspace"),
    groups: GROUPS,
    fields: FIELDS,
    palettes: Object.entries(PALETTES).map(([id, p]) => ({ id, label: p.label, from: p.from, to: p.to })),
    shapes: AVATAR_SHAPES,
    styles: AVATAR_STYLES,
    instances: await liveInstances(dir),
    // On a Mac, whether anything is keeping it awake while bots run.
    power: await powerState(),
  };
}

// ------------------------------------------------------------- supervision

/**
 * Run `scripts/runtime.sh <action> <name>` and return its output.
 *
 * The script is the supervisor we already have; re-implementing start and
 * stop in TypeScript would be a second source of truth for pids. It exits
 * non-zero when the bot didn't come up, and the tail of its output is the
 * reason, so the message is worth showing as-is.
 */
export async function runScript(action: string, name: string, dir?: string): Promise<{ ok: boolean; output: string }> {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(name)) return { ok: false, output: `“${name}” isn't a usable instance name.` };
  const runtime = dir ?? runtimeDir();
  // HOOBOT_RUNTIME_DIR so the manager, the script and the tests agree on
  // which folder is the runtime even when it isn't the default one.
  const proc = Bun.spawn(["sh", join(repoRoot(), "scripts", "runtime.sh"), action, name], {
    env: { ...process.env, HOOBOT_RUNTIME_DIR: runtime, RUN_FROM_NPM: process.env.RUN_FROM_NPM ?? "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { ok: code === 0, output: [out.trim(), err.trim()].filter(Boolean).join("\n") };
}

/** The last `lines` lines of a bot's log, newest last. */
export function tailLog(name: string, lines = 80, dir?: string): string {
  const log = join(runtimeDir(dir), name, `${name}.log`);
  if (!existsSync(log)) return "";
  const all = readFileSync(log, "utf8").replace(/\n$/, "").split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

// ------------------------------------------------------------------- writes

/**
 * Apply a settings patch to an instance's `.env`.
 *
 * Secrets arrive masked. A field the user didn't touch is sent as
 * `__unchanged__` and left alone, so the real token is never in the
 * browser and a masked value is never written back as if it were one.
 */
export function applyPatch(name: string, patch: Record<string, unknown>, dir?: string): Instance & { skipped: string[] } {
  const values: Record<string, string> = {};
  // Keys sent but not written, so the page can say so instead of "Saved".
  const skipped: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (key === "config" || key === "secrets") {
      const group = (raw ?? {}) as Record<string, unknown>;
      for (const [gkey, gvalue] of Object.entries(group)) {
        const value = String(gvalue ?? "").trim();
        // The browser never holds a real token, so it sends back either
        // UNCHANGED or the mask it was given. Writing a mask into .env
        // would break the bot with a token that looks almost right.
        if (value === UNCHANGED) continue;
        if (value.includes("•")) {
          skipped.push(gkey);
          continue;
        }
        values[gkey] = value;
      }
      continue;
    }
    values[key] = String(raw ?? "");
  }
  return { ...writeInstance(name, values, { dir }), skipped };
}

/** Create a bot from the UI's form. */
export function createFromForm(body: Record<string, unknown>, dir?: string): Instance {
  const name = str(body.name);
  const problem = validateName(name, dir);
  if (problem) throw new Error(problem);
  const surfaces = Array.isArray(body.surfaces)
    ? body.surfaces.map((s) => str(s).toLowerCase()).filter((s) => s === "discord" || s === "slack")
    : [];
  if (!surfaces.length) throw new Error("Pick at least one chat for the bot.");
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries((body.config ?? {}) as Record<string, unknown>)) config[key] = str(value);
  if (str(body.workdir)) config.HOO_WORKDIR = expandHome(str(body.workdir));
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries((body.secrets ?? {}) as Record<string, unknown>)) {
    const clean = str(value);
    if (clean && clean !== UNCHANGED) secrets[key] = clean;
  }
  if (body.avatarSeed !== undefined) config.HOO_AVATAR_SEED = str(body.avatarSeed);
  if (str(body.avatarShape)) config.HOO_AVATAR_SHAPE = str(body.avatarShape);
  if (str(body.avatarStyle)) config.HOO_AVATAR_STYLE = str(body.avatarStyle);
  if (body.avatarPalette !== undefined) config.HOO_AVATAR_PALETTE = str(body.avatarPalette);
  config.HOO_SURFACES = surfaces.join(",");
  return createInstance({ name, surfaces, workdir: str(body.workdir), config, secrets, dir });
}

// -------------------------------------------------------------------- routes

/** The pieces the router needs, injectable so tests don't touch a disk. */
export type ManagerDeps = {
  dir?: string;
  run?: (action: string, name: string, dir?: string) => Promise<{ ok: boolean; output: string }>;
};

const route = /^\/api\/instances\/([a-z][a-z0-9-]{0,23})(?:\/(start|stop|restart|logs|avatar\.svg|avatar))?$/;

/**
 * Handle an `/api/...` request. Returns null when the path isn't an API
 * path, so the caller can fall through to the static files.
 */
export async function handleApi(req: Request, deps: ManagerDeps = {}): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const dir = deps.dir;
  const run = deps.run ?? runScript;
  const method = req.method.toUpperCase();

  if (path === "/api/manager" && method === "GET") return json(await managerBody(dir));

  if (path === "/api/names/suggest" && method === "GET") {
    const seed = url.searchParams.get("seed") ?? undefined;
    return json({ name: suggestName(listInstances(dir).map((i) => i.name), seed) });
  }

  // A face for a bot that doesn't exist yet: the new-bot sheet shows the
  // exact SVG it will save, not an approximation of it.
  if (path === "/api/avatar.svg" && method === "GET") {
    const wanted = url.searchParams.get("seed");
    const name = url.searchParams.get("name") ?? undefined;
    // No seed means the name decides the face, exactly as a saved bot does.
    const seed = wanted === null || wanted === "" ? hashSeed(name ?? "preview") : Number(wanted);
    const shape = url.searchParams.get("shape") ?? "circle";
    const palette = url.searchParams.get("palette") ?? undefined;
    const style = url.searchParams.get("style") ?? "dots";
    const svg = avatarSvg(Number.isFinite(seed) ? seed : 0, {
      shape: AVATAR_SHAPES.includes(shape as "circle") ? (shape as "circle" | "squircle") : "circle",
      style: AVATAR_STYLES.includes(style as "pet") ? (style as "dots" | "pet") : "dots",
      palette,
      name,
    });
    return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
  }

  if (path === "/api/instances" && method === "POST") {
    try {
      return json(await createFromForm(await readJson(req), dir), 201);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  const match = path.match(route);
  if (!match) return path.startsWith("/api/") ? fail("no such endpoint", 404) : null;
  const name = match[1]!;
  const action = match[2];

  if (!action && method === "GET") {
    const instance = readInstance(name, dir);
    return instance ? json(instance) : fail(`no bot called “${name}”`, 404);
  }

  if (!action && method === "PATCH") {
    try {
      return json(applyPatch(name, await readJson(req), dir));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  if (!action && method === "DELETE") {
    try {
      return json({ deleted: deleteInstance(name, dir) });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  if (action === "avatar.svg") {
    const instance = readInstance(name, dir);
    const seed = Number(url.searchParams.get("seed") ?? instance?.avatarSeed ?? hashSeed(name));
    const shape = (url.searchParams.get("shape") ?? instance?.avatarShape ?? "circle") as "circle" | "squircle";
    const palette = url.searchParams.get("palette") ?? instance?.avatarPalette ?? undefined;
    const style = url.searchParams.get("style") ?? instance?.avatarStyle ?? "dots";
    const svg = avatarSvg(seed, {
      shape: AVATAR_SHAPES.includes(shape) ? shape : "circle",
      style: AVATAR_STYLES.includes(style as AvatarStyle) ? (style as AvatarStyle) : "dots",
      palette,
      name,
    });
    return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
  }

  if (action === "logs") {
    const lines = Math.min(500, Math.max(1, Number(url.searchParams.get("lines") ?? 80)));
    return json({ name, lines: tailLog(name, lines, dir) });
  }

  if (action === "avatar" && method === "POST") {
    const body = await readJson(req);
    const seed = body.seed === undefined ? Math.floor(Math.random() * 1e9) : Number(body.seed);
    if (!Number.isFinite(seed)) return fail("the seed has to be a number");
    try {
      return json(writeInstance(name, { HOO_AVATAR_SEED: String(Math.max(0, Math.trunc(seed))) }, { dir }));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  if (action === "start" || action === "stop" || action === "restart") {
    const result = await run(action, name, dir);
    return json({ ...result, instance: readInstance(name, dir), health: await fetchHealth(Number(readInstance(name, dir)?.port ?? 0)) }, result.ok ? 200 : 500);
  }

  return fail("no such endpoint", 404);
}

/** Serve `web/`, so the manager is one command with nothing to install. */
function serveStatic(path: string): Response | null {
  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  if (!/^[\w./-]+$/.test(rel) || rel.includes("..")) return null;
  const file = Bun.file(join(WEB_DIR, rel));
  const ext = rel.slice(rel.lastIndexOf("."));
  if (!existsSync(join(WEB_DIR, rel))) {
    // Unknown paths fall back to the app: it owns its own routing.
    if (path !== "/" && !rel.includes(".")) return serveStatic("/");
    return null;
  }
  return new Response(file, { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" } });
}

export type ManagerServer = { port: number; url: string; stop(): void };

/**
 * Start the manager. `port` 0 picks a free port (tests);
 * `MANAGER_PORT=off` never serves.
 */
export function startManager(opts: { dir?: string; port?: number } = {}): ManagerServer | null {
  if (process.env.MANAGER_PORT?.trim().toLowerCase() === "off") return null;
  const port = opts.port ?? Number(process.env.MANAGER_PORT ?? DEFAULT_MANAGER_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    error(`MANAGER_PORT=${port} isn't a port; not serving the manager.`);
    return null;
  }
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(req) {
        const url = new URL(req.url);
        if (!isLocalHost(req.headers.get("host"))) return fail("the manager only answers on 127.0.0.1", 403);
        const origin = req.headers.get("origin");
        if (origin && !isLocalHost(new URL(origin).host)) return fail("cross-origin requests are refused", 403);
        const api = await handleApi(req, { dir: opts.dir });
        if (api) return api;
        const file = serveStatic(url.pathname);
        if (file) return file;
        return fail("not found", 404);
      },
    });
  } catch (err) {
    error(`Manager not started on port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  log(`Bot manager: ${server.url.href.replace(/\/$/, "")} (runtime ${runtimeDir(opts.dir)})`);
  return { port: server.port ?? port, url: `http://127.0.0.1:${server.port ?? port}`, stop: () => server.stop(true) };
}

/**
 * The command line: `bun src/manager.ts [--open]` from a checkout, or
 * `hoobot manager [--open]` from npm. `--open` puts the page in front of you.
 */
export function runManager(args: string[]): void {
  const server = startManager();
  if (!server) process.exit(1);
  if (args.includes("--open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try {
      Bun.spawn([opener, server.url], { stdout: "ignore", stderr: "ignore" });
    } catch {
      log(`Open ${server.url} in your browser.`);
    }
  }
}

// `bun src/manager.ts` runs it; importing it (tests, the cli) doesn't.
if (import.meta.main) runManager(process.argv.slice(2));