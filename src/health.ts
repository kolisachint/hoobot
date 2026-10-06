/**
 * A small read-only HTTP server on 127.0.0.1, so a UI or a script can tell
 * whether this bot is alive and what it is doing (design doc 19).
 *
 * - `GET /healthz` → liveness: ok, uptime, pid, surface states.
 * - `GET /api/bots` → the same plus the config and live sessions.
 *
 * Loopback only and no auth, like the app-server socket: any process running
 * as you is the owner (R11). Turn it off with `HEALTH_PORT=off`.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { allWorkdirs, config, surfaces } from "./config.ts";
import { error, log } from "./log.ts";
import { subagentStats } from "./subagents.ts";

const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export type SurfaceState = "connecting" | "connected" | "error";

export type SurfaceStatus = {
  name: string;
  state: SurfaceState;
  /** Set when the surface failed: the reason. */
  detail?: string;
  /** When it reached its current state (ISO). */
  since: string;
  /** Last chat message seen on this surface (ISO). */
  lastMessageAt: string | null;
};

/** One live conversation, for `/api/bots`. Provided by src/core.ts. */
export type SessionStatus = {
  key: string;
  surface: string;
  id: string;
  workdir: string;
  busy: boolean;
  /** How long the running turn has been going, in ms. 0 when idle. */
  turnAgeMs?: number;
  /** How long the running turn has gone without an event, in ms. 0 when idle. */
  turnStalledMs?: number;
  /** True when the running turn has been silent for `config.turnStuckMs`. */
  stuck?: boolean;
};

/**
 * Whether a turn is stuck: busy, and silent for `stuckMs`.
 *
 * Measured from the last event, not the start. Age is the wrong signal: a
 * long review or a cargo build streams events for an hour and is perfectly
 * healthy, and when age was used the supervisor restarted the bot at the
 * 20-minute mark, killing every conversation on it mid-work. Silence is what
 * a wedged turn actually looks like.
 */
export function isStuck(busy: boolean, turnStalledMs: number, stuckMs = config.turnStuckMs): boolean {
  return busy && turnStalledMs >= stuckMs;
}

/**
 * What the bot is doing, kept by whoever is running it: the surfaces
 * (src/index.ts) report their state, calls mark activity (src/core.ts).
 */
export class HealthState {
  readonly startedAt = Date.now();
  readonly surfaces = new Map<string, SurfaceStatus>();
  lastMessageAt: number | null = null;

  constructor(readonly instance: string = process.env.HOO_INSTANCE?.trim() || basename(process.cwd())) {
    const now = new Date().toISOString();
    for (const name of surfaces()) {
      this.surfaces.set(name, { name, state: "connecting", since: now, lastMessageAt: null });
    }
  }

  private set(name: string, state: SurfaceState, detail?: string) {
    const current = this.surfaces.get(name) ?? { name, state, since: new Date().toISOString(), lastMessageAt: null };
    this.surfaces.set(name, { ...current, state, detail, since: new Date().toISOString() });
  }

  /** The surface connected and is listening. */
  connected(name: string) {
    this.set(name, "connected");
  }

  /** The surface failed to start; it won't be retried. */
  failed(name: string, reason: string) {
    this.set(name, "error", reason);
  }

  /** A chat message arrived (any surface, or a known one). */
  message(surface?: string) {
    const now = new Date().toISOString();
    this.lastMessageAt = Date.now();
    if (!surface) return;
    const current = this.surfaces.get(surface);
    if (current) this.surfaces.set(surface, { ...current, lastMessageAt: now });
  }

  /** Up is every surface connected. A bot with no surface is never up. */
  get ok(): boolean {
    const list = [...this.surfaces.values()];
    return list.length > 0 && list.every((s) => s.state === "connected");
  }

  uptimeSec(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  surfaceList(): SurfaceStatus[] {
    return [...this.surfaces.values()];
  }
}

/** The JSON body of `/healthz`. */
export function healthBody(state: HealthState, sessions: () => SessionStatus[] = () => []): Record<string, unknown> {
  // Liveness used to mean "the process is up", which a bot with a wedged turn
  // satisfied perfectly — so the supervisor restarted nothing while a thread sat
  // silent for hours. A turn silent for `turnStuckMs` is a real outage for
  // whoever is waiting on it, so it is reported here and the bot says itself
  // unhealthy until the session gives up on its own or recovers.
  const stuck = sessions().filter((s) => s.stuck);
  // Subagent reliability from hoocode's dispatch ledger. `known: false` when
  // there is no ledger yet, which is not the same as "nothing has ever
  // worked" - a reader has to be able to tell those apart.
  const subagents = subagentStats(config.workdir);
  return {
    ok: state.ok && stuck.length === 0,
    ...(stuck.length ? { stuckSessions: stuck.map((s) => s.key) } : {}),
    ...(subagents.known ? { subagents } : {}),
    instance: state.instance,
    pid: process.pid,
    version: VERSION,
    uptimeSec: state.uptimeSec(),
    startedAt: new Date(state.startedAt).toISOString(),
    lastMessageAt: state.lastMessageAt ? new Date(state.lastMessageAt).toISOString() : null,
    surfaces: state.surfaceList(),
  };
}

/** The JSON body of `/api/bots`: everything the desktop UI shows first. */
export function botsBody(state: HealthState, sessions: () => SessionStatus[]): Record<string, unknown> {
  return {
    ...healthBody(state, sessions),
    // The detail view always reports ok: only /healthz is the supervisor's
    // signal, and a stuck session listed below should not fail the UI's fetch.
    ok: state.ok,
    workdir: config.workdir,
    workdirs: [config.workdir, ...config.workspaces.values()],
    channels: Object.fromEntries(config.workspaces),
    linksFile: config.linksFile,
    appServer: config.appServer || `stdio:${config.hoocodeBin} app-server`,
    model: config.model ?? null,
    approvals: config.approvals,
    // One entry per folder the bot can work in: the ledger is per project, so
    // a per-channel workspace has its own reliability and the primary one
    // says nothing about it.
    subagentsByWorkdir: Object.fromEntries(allWorkdirs().map((dir) => [dir, subagentStats(dir)])),
    allowedUserIds: [...config.allowedUserIds],
    peerBotIds: [...config.peerBotIds],
    channelIds: [...config.channelIds],
    sessions: sessions(),
  };
}

/** The state of the bot in this process; src/index.ts and src/core.ts update it. */
export const health = new HealthState();

export type HealthServer = { port: number; url: string; stop(): void };

/**
 * Serve the two endpoints on `127.0.0.1:port`. `port` 0 picks a free port
 * (tests); `HEALTH_PORT=off` never serves. Returns null when the port is
 * taken or health is off — a busy port must not stop the bot.
 */
export function startHealthServer(
  state: HealthState,
  sessions: () => SessionStatus[] = () => [],
  port = Number(process.env.HEALTH_PORT ?? 8787),
): HealthServer | null {
  if (process.env.HEALTH_PORT?.trim().toLowerCase() === "off") return null;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    error(`HEALTH_PORT=${port} isn't a port; not serving health.`);
    return null;
  }
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
        if (path === "/healthz") return Response.json(healthBody(state, sessions));
        if (path === "/api/bots") return Response.json(botsBody(state, sessions));
        if (path === "/") return Response.redirect("/healthz");
        return Response.json({ error: "not found", paths: ["/healthz", "/api/bots"] }, { status: 404 });
      },
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // Losing the port is not harmless, and it used to fail silently: the bot
    // kept working while serving nothing, so supervise.sh's curl failed and it
    // restarted the bot every 120s, all day, for a bot that was completely
    // fine. Without the port this process is indistinguishable from a dead
    // one, so say exactly that — and name the fix.
    error(
      `Health server not started on port ${port}: ${why}. ` +
        `This bot will answer no health checks, so the supervisor will restart it every cycle. ` +
        `Usually another instance still owns ${port} — check with: ` +
        `lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    );
    return null;
  }
  log(`Health: ${server.url}healthz (${state.instance})`);
  return { port: server.port ?? port, url: server.url.href.replace(/\/$/, ""), stop: () => server.stop(true) };
}
