import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.DISCORD_TOKEN ??= "x";
process.env.SLACK_BOT_TOKEN ??= "xoxb-x";
process.env.SLACK_APP_TOKEN ??= "xapp-x";
process.env.ALLOWED_USER_IDS ??= "1";
process.env.HOO_INSTANCE ??= "test-Instance";
// Set outright, not ??=: a bot running the tests exports its own HEALTH_PORT.
process.env.HEALTH_PORT = "off";

const { HealthState, botsBody, healthBody, startHealthServer } = await import("../src/health.ts");
const { config } = await import("../src/config.ts");

const sessions = () => [{ key: "slack:C1", surface: "slack", id: "C1", workdir: "/tmp/w", busy: true }];

/**
 * A state with both surfaces. `surfaces()` reads the tokens `config` captured
 * when it was first imported, and an earlier test file may have imported it
 * without the Slack ones — so set the parsed values, not process.env.
 */
function stateWithBothSurfaces(instance: string) {
  const saved = { slackBotToken: config.slackBotToken, slackAppToken: config.slackAppToken };
  Object.assign(config, { slackBotToken: "xoxb-x", slackAppToken: "xapp-x" });
  try {
    return new HealthState(instance);
  } finally {
    Object.assign(config, saved);
  }
}

test("a surface is only up once it is connected", () => {
  const state = stateWithBothSurfaces("hoo");
  expect(state.ok).toBe(false);
  expect(state.surfaceList().map((s) => [s.name, s.state])).toEqual([
    ["discord", "connecting"],
    ["slack", "connecting"],
  ]);

  state.connected("discord");
  expect(state.ok).toBe(false);
  state.connected("slack");
  expect(state.ok).toBe(true);

  state.failed("slack", "bad token");
  expect(state.ok).toBe(false);
  expect(state.surfaceList().find((s) => s.name === "slack")?.detail).toBe("bad token");
});

test("a message marks activity on the surface and on the bot", () => {
  const state = stateWithBothSurfaces("hee");
  expect(state.lastMessageAt).toBeNull();
  state.message("slack");
  expect(state.lastMessageAt).not.toBeNull();
  const slack = state.surfaceList().find((s) => s.name === "slack");
  expect(slack?.lastMessageAt).toBe(new Date(state.lastMessageAt!).toISOString());
  expect(state.surfaceList().find((s) => s.name === "discord")?.lastMessageAt).toBeNull();
});

test("healthz says who is running; bots adds config and sessions", () => {
  const state = new HealthState("hoo");
  state.connected("discord");
  state.connected("slack");
  state.message("slack");

  const health = healthBody(state) as Record<string, any>;
  expect(health.ok).toBe(true);
  expect(health.instance).toBe("hoo");
  expect(health.pid).toBe(process.pid);
  expect(typeof health.uptimeSec).toBe("number");
  expect(health.lastMessageAt).toBe(state.lastMessageAt === null ? null : new Date(state.lastMessageAt).toISOString());
  expect(health.surfaces.map((s: { name: string }) => s.name)).toEqual(["discord", "slack"]);

  const bots = botsBody(state, sessions) as Record<string, any>;
  expect(bots.workdir).toBe(config.workdir);
  expect(bots.linksFile).toBe(config.linksFile);
  expect(bots.allowedUserIds).toEqual([...config.allowedUserIds]);
  expect(bots.sessions).toEqual(sessions());
});

test("HEALTH_PORT=off serves nothing; a bad port is reported, not thrown", () => {
  expect(process.env.HEALTH_PORT).toBe("off");
  expect(startHealthServer(new HealthState("x"), sessions, 0)).toBeNull();
});

test("the server answers /healthz and /api/bots, and 404s the rest", async () => {
  const state = new HealthState("hoo");
  state.connected("discord");
  state.connected("slack");
  process.env.HEALTH_PORT = "0"; // any free port
  const server = startHealthServer(state, sessions)!;
  expect(server).not.toBeNull();
  expect(server.port).toBeGreaterThan(0);

  const health = (await fetch(`${server.url}/healthz`).then((r) => r.json())) as Record<string, any>;
  expect(health.instance).toBe("hoo");
  expect(health.ok).toBe(true);

  const bots = (await fetch(`${server.url}/api/bots`).then((r) => r.json())) as Record<string, any>;
  expect(bots.sessions).toEqual(sessions());

  expect((await fetch(`${server.url}/nope`)).status).toBe(404);
  const root = await fetch(`${server.url}`);
  expect(root.url).toEndWith("/healthz"); // / redirects to /healthz
  server.stop();
  process.env.HEALTH_PORT = "off";
});

test("a stuck turn makes healthz report ok:false and names the session", async () => {
  // The whole point of the change: a bot whose turn wedged must stop looking
  // healthy, or the supervisor keeps believing there is nothing to fix.
  const state = stateWithBothSurfaces("hoo");
  state.connected("discord");
  state.connected("slack");
  expect(state.ok).toBe(true); // healthy until the stuck turn is reported
  const stuck = [
    { key: "slack:C1", surface: "slack", id: "C1", workdir: "/tmp/w", busy: true, turnAgeMs: 25 * 60_000, stuck: true },
  ];
  const body = healthBody(state, () => stuck);
  expect(body.ok).toBe(false);
  expect(body.stuckSessions).toEqual(["slack:C1"]);
});

test("a busy but progressing turn stays healthy", () => {
  const state = stateWithBothSurfaces("hoo");
  state.connected("discord");
  state.connected("slack");
  const busy = [
    { key: "slack:C1", surface: "slack", id: "C1", workdir: "/tmp/w", busy: true, turnAgeMs: 90_000, turnStalledMs: 2_000 },
  ];
  const body = healthBody(state, () => busy);
  expect(body.ok).toBe(true);
  expect(body.stuckSessions).toBeUndefined();
});

test("/api/bots still answers ok even with a stuck session, so the UI can load it", () => {
  // Only /healthz is the supervisor's signal. The detail view has to keep
  // working, or a wedged bot would also blank the manager page.
  const state = stateWithBothSurfaces("hoo");
  state.connected("discord");
  state.connected("slack");
  const stuck = [
    { key: "slack:C1", surface: "slack", id: "C1", workdir: "/tmp/w", busy: true, turnAgeMs: 25 * 60_000, stuck: true },
  ];
  const body = botsBody(state, () => stuck);
  expect(body.ok).toBe(true);
  expect((body.sessions as unknown[])[0]).toMatchObject({ busy: true, stuck: true });
});

test("a taken health port is reported loudly rather than silently dropped", () => {
  // Losing the port means the supervisor's curl fails and it restarts a
  // perfectly healthy bot forever. The message has to name the cause.
  // HEALTH_PORT=off is set at the top of this file, so ask for a free port
  // explicitly rather than relying on the env var.
  process.env.HEALTH_PORT = "0";
  const first = startHealthServer(stateWithBothSurfaces("a"), () => [], 0)!;
  const port = first.port;
  const seen: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => seen.push(a.map(String).join(" "));
  try {
    const second = startHealthServer(new HealthState("b"), () => [], port);
    expect(second).toBeNull();
  } finally {
    console.error = realError;
    first.stop();
    process.env.HEALTH_PORT = "off";
  }
  const said = seen.join("\n");
  expect(said).toContain(String(port));
  expect(said).toContain("restart");
});

test("healthz reports subagent reliability from the dispatch ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hoobot-health-subagents-"));
  const workdir = config.workdir;
  try {
    const path = join(dir, ".cortexcode", "dispatch", "ledger.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: Date.now(), task_id: "d1", agent_type: "explore", status: "complete", ok: true, duration_ms: 1000 }),
        JSON.stringify({ ts: Date.now(), task_id: "d2", agent_type: "plan", status: "timeout", ok: false, duration_ms: 600000 }),
      ].join("\n"),
    );
    Object.assign(config, { workdir: dir });
    const body = healthBody(new HealthState("test-Instance"));
    expect(body.subagents).toMatchObject({ known: true, attempts: 2, usable: 1 });
    // No ledger at all: the key is absent rather than a zero that reads like
    // "every subagent has ever failed".
    Object.assign(config, { workdir: join(dir, "empty") });
    expect(healthBody(new HealthState("test-Instance")).subagents).toBeUndefined();
  } finally {
    Object.assign(config, { workdir });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stuck means silent, not old: a long turn that keeps reporting is healthy", async () => {
  const { isStuck } = await import("../src/health.ts");
  const twenty = 20 * 60_000;
  // Idle is never stuck, however long ago the last event was.
  expect(isStuck(false, 5 * twenty, twenty)).toBe(false);
  // A two-hour review whose last event was a second ago: healthy. When age
  // was the signal, this restarted the bot at the 20-minute mark.
  expect(isStuck(true, 1_000, twenty)).toBe(false);
  // Silent for the full window: wedged.
  expect(isStuck(true, twenty, twenty)).toBe(true);
  expect(isStuck(true, twenty + 1, twenty)).toBe(true);
});
