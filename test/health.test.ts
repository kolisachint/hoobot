import { expect, test } from "bun:test";

process.env.DISCORD_TOKEN ??= "x";
process.env.SLACK_BOT_TOKEN ??= "xoxb-x";
process.env.SLACK_APP_TOKEN ??= "xapp-x";
process.env.ALLOWED_USER_IDS ??= "1";
process.env.HOO_INSTANCE ??= "test-Instance";
process.env.HEALTH_PORT ??= "off";

const { HealthState, botsBody, healthBody, startHealthServer } = await import("../src/health.ts");
const { config } = await import("../src/config.ts");

const sessions = () => [{ key: "slack:C1", surface: "slack", id: "C1", workdir: "/tmp/w", busy: true }];

test("a surface is only up once it is connected", () => {
  const state = new HealthState("hoo");
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
  const state = new HealthState("hee");
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
