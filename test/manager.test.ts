/**
 * The manager's HTTP surface: what a browser is allowed to do, and what it
 * is not allowed to see. Every test runs against a throwaway runtime
 * folder, so nothing here can start or stop a real bot.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstance } from "../src/instances.ts";
import { applyPatch, createFromForm, handleApi, startManager, tailLog } from "../src/manager.ts";

let dir = "";
let server: ReturnType<typeof startManager> = null;
let base = "";

/** Requests go through the real router, so the Host guard is exercised. */
// The bodies are JSON of whatever the manager returns; typing them as `any`
// keeps these tests about behaviour rather than about the shapes.
async function call(path: string, init: RequestInit = {}): Promise<{ res: Response; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { host: "127.0.0.1", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const type = res.headers.get("content-type") ?? "";
  return { res, body: type.includes("json") ? ((await res.json()) as any) : await res.text() };
}

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

/** The router returns null for "not an api path"; a test means it as one. */
async function api(path: string, init: RequestInit = {}, deps?: Parameters<typeof handleApi>[1]): Promise<Response> {
  const res = await handleApi(new Request(`http://127.0.0.1${path}`, init), deps);
  if (!res) throw new Error(`${path} is not an api path`);
  return res;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hoobot-manager-"));
  process.env.HOOBOT_RUNTIME_DIR = dir;
  server = startManager({ dir, port: 0 });
  base = `http://127.0.0.1:${server!.port}`;
});

afterEach(() => {
  server?.stop();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOOBOT_RUNTIME_DIR;
});

test("the manager serves its api and the page itself", async () => {
  const { res, body } = await call("/api/manager");
  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.instances).toEqual([]);
  expect(body.groups).toContain("Chat");
  expect(body.palettes.length).toBeGreaterThan(3);
  expect(body.sharedWorkdir).toContain("shared/workspace");

  const page = await call("/");
  expect(page.res.status).toBe(200);
  expect(page.body).toContain("<title>hoobot");
  const script = await call("/app.js");
  expect(script.res.headers.get("content-type")).toContain("javascript");
  expect(await call("/../package.json").then((r) => r.res.status)).toBe(404);
});

test("a bot can be created from the form, then edited, then deleted", async () => {
  const created = await call("/api/instances", json({
    name: "pepper",
    surfaces: ["slack"],
    secrets: { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_APP_TOKEN: "xapp-secret" },
  }));
  expect(created.res.status).toBe(201);
  expect(created.body.name).toBe("pepper");
  expect(created.body.port).toBe(8787);
  expect(created.body.avatarSeed).toBeGreaterThan(0);

  const list = await call("/api/manager");
  expect(list.body.instances.map((i: { name: string }) => i.name)).toEqual(["pepper"]);
  // Stopped, so no health call and no health.
  expect(list.body.instances[0].health).toBeNull();

  const patched = await call("/api/instances/pepper", {
    method: "PATCH",
    body: JSON.stringify({ config: { MODEL: "anthropic/claude-sonnet-4-5", APPROVALS: "ask" } }),
  });
  expect(patched.body.config.MODEL).toBe("anthropic/claude-sonnet-4-5");
  expect(patched.body.config.APPROVALS).toBe("ask");

  const removed = await call("/api/instances/pepper", { method: "DELETE" });
  expect(removed.body.deleted).toBe(true);
  expect((await call("/api/manager")).body.instances).toEqual([]);
});

test("a bad create says why, and creates nothing", async () => {
  const noName = await call("/api/instances", json({ surfaces: ["slack"] }));
  expect(noName.res.status).toBe(400);
  expect(noName.body.error).toMatch(/name/i);

  const noChat = await call("/api/instances", json({ name: "quiet", surfaces: [] }));
  expect(noChat.body.error).toMatch(/chat/i);

  await call("/api/instances", json({ name: "once", surfaces: ["slack"] }));
  const twice = await call("/api/instances", json({ name: "once", surfaces: ["slack"] }));
  expect(twice.res.status).toBe(400);
  expect(twice.body.error).toMatch(/already exists/);
  expect((await call("/api/manager")).body.instances.length).toBe(1);
});

test("a real token never leaves the process, and an untouched one is not written", async () => {
  const bot = createInstance({
    name: "secretive",
    surfaces: ["slack"],
    secrets: { SLACK_BOT_TOKEN: "xoxb-real", SLACK_APP_TOKEN: "xapp-real" },
    dir,
  });
  const shown = (await call(`/api/instances/secretive`)).body;
  expect(JSON.stringify(shown)).not.toContain("xoxb-real");
  expect(shown.secrets.SLACK_BOT_TOKEN).toContain("•");

  // The browser sends back the mask for a field the user didn't touch; the
  // real value in the file must survive that.
  applyPatch("secretive", { secrets: { SLACK_BOT_TOKEN: shown.secrets.SLACK_BOT_TOKEN, SLACK_APP_TOKEN: "__unchanged__" } }, dir);
  const env = await Bun.file(bot.envPath).text();
  expect(env).toContain("SLACK_BOT_TOKEN=xoxb-real");
  expect(env).toContain("SLACK_APP_TOKEN=xapp-real");

  // A mask sent as a new value is refused, and the page is told so.
  const refused = applyPatch("secretive", { secrets: { SLACK_BOT_TOKEN: `x${shown.secrets.SLACK_BOT_TOKEN}` } }, dir);
  expect(refused.skipped).toEqual(["SLACK_BOT_TOKEN"]);
  expect(await Bun.file(bot.envPath).text()).toContain("SLACK_BOT_TOKEN=xoxb-real");
  expect(refused.tokenSurfaces).toEqual(["slack"]);

  // A genuinely new token replaces it.
  applyPatch("secretive", { secrets: { SLACK_BOT_TOKEN: "xoxb-new" } }, dir);
  expect(await Bun.file(bot.envPath).text()).toContain("SLACK_BOT_TOKEN=xoxb-new");
});

test("an avatar is served for a bot and for a bot that doesn't exist yet", async () => {
  createInstance({ name: "face", surfaces: ["slack"], dir });
  const saved = await call("/api/instances/face/avatar.svg");
  expect(saved.res.headers.get("content-type")).toContain("image/svg+xml");
  expect(saved.body.startsWith("<svg")).toBe(true);

  // Deterministic: same query, same bytes.
  const again = await call("/api/instances/face/avatar.svg");
  expect(again.body).toBe(saved.body);

  const preview = await call("/api/avatar.svg?name=wren&shape=squircle&palette=teal");
  expect(preview.body).toContain("<title>wren</title>");
  expect(preview.body).toContain("rx=\"30\"");

  // Re-rolling changes the face, and the same seed always brings it back.
  const rerolled = await call("/api/instances/face/avatar", json({ seed: 4242 }));
  expect(rerolled.body.avatarSeed).toBe(4242);
  const after = (await call("/api/instances/face/avatar.svg")).body;
  expect(after).not.toBe(saved.body);
  expect(after).toBe((await call("/api/avatar.svg?seed=4242&name=face")).body);
  await call("/api/instances/face/avatar", json({ seed: 1 }));
  expect((await call("/api/instances/face/avatar.svg")).body).not.toBe(after);
});

test("names can be re-rolled, and never collide", async () => {
  const first = (await call("/api/names/suggest")).body.name;
  createInstance({ name: first, surfaces: ["slack"], dir });
  const second = (await call("/api/names/suggest")).body.name;
  expect(second).not.toBe(first);
  // Deterministic with a seed, so the same button press is the same answer.
  expect((await call("/api/names/suggest?seed=x")).body.name).toBe((await call("/api/names/suggest?seed=x")).body.name);
});

test("the log tail is the last lines of that bot's own log", async () => {
  createInstance({ name: "talker", surfaces: ["slack"], dir });
  expect(tailLog("talker", 10, dir)).toBe("");
  writeFileSync(join(dir, "talker", "talker.log"), "one\ntwo\nthree\n");
  expect(tailLog("talker", 2, dir)).toBe("two\nthree");
  expect((await call("/api/instances/talker/logs?lines=1")).body.lines).toBe("three");
  expect((await call("/api/instances/talker/logs?lines=99999")).res.status).toBe(200);
});

test("start and stop go through the supervisor script", async () => {
  createInstance({ name: "scripted", surfaces: ["slack"], dir });
  const seen: string[] = [];
  const deps = { dir, run: async (action: string, name: string) => {
    seen.push(`${action}:${name}`);
    return { ok: true, output: `${name} ${action}ed` };
  } };
  const path = (action: string) => `/api/instances/scripted/${action}`;

  expect((await api(path("start"), { method: "POST" }, deps)).status).toBe(200);
  expect((await api(path("restart"), { method: "POST" }, deps)).status).toBe(200);
  expect(seen).toEqual(["start:scripted", "restart:scripted"]);

  // A failure is reported with the reason, not swallowed.
  const failedRes = await api(path("start"), { method: "POST" }, {
    dir,
    run: async () => ({ ok: false, output: "runtime: failed to start; bad token" }),
  });
  expect(failedRes.status).toBe(500);
  expect(((await failedRes.json()) as any).output).toContain("bad token");

  // Nothing outside the instance pattern is a start.
  // "rm" is not one of the three actions, and not a route either.
  expect((await api(path("rm"), { method: "POST" }, deps)).status).toBe(404);
});

test("only loopback hosts are answered, so a web page elsewhere can't drive bots", async () => {
  const res = await fetch(`${base}/api/manager`, { headers: { host: "hoobot.example.com" } });
  expect(res.status).toBe(403);
  const fromPage = await fetch(`${base}/api/instances`, {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "https://evil.example" },
    body: JSON.stringify({ name: "sneaky", surfaces: ["slack"] }),
  });
  expect(fromPage.status).toBe(403);
  expect((await call("/api/manager")).body.instances).toEqual([]);
});

test("unknown api paths are 404s and unknown pages fall back to the app", async () => {
  expect((await call("/api/nope")).res.status).toBe(404);
  expect((await call("/api/instances/nosuchbot")).res.status).toBe(404);
  const fallback = await call("/bots/pepper");
  expect(fallback.res.status).toBe(200);
  expect(fallback.body).toContain("<title>hoobot");
});

test("a form body is sanitised before it becomes a folder", () => {
  expect(() => createFromForm({ name: "../escape", surfaces: ["slack"] }, dir)).toThrow();
  expect(() => createFromForm({ name: "ok", surfaces: [] }, dir)).toThrow();
  const bot = createFromForm({ name: "Tidy", surfaces: ["Discord"], workdir: "~/code/hoo" }, dir);
  expect(bot.name).toBe("tidy");
  // Whatever case it arrived in, only real platforms are recorded.
  expect(bot.surfaces).toEqual(["discord"]);
  expect(bot.workdir).toContain("code/hoo");
  expect(bot.workdir.startsWith("~")).toBe(false);
});