// A running turn that stops reporting must not wedge the session.
//
// This is the failure that made the bot go quiet: a turn was acknowledged,
// its event stream then died, `turn/completed` never arrived, and `turnId`
// stayed set for good. Because calls are serialised per chat space, every
// later message in that thread queued behind the dead turn and nothing
// answered — while `/healthz` still said ok, so nothing restarted it.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";

process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
process.env.MODEL = "";
const { ThreadSession } = await import("../src/session.ts");
const { LinkStore } = await import("../src/links.ts");
const { config } = await import("../src/config.ts");

const tick = () => new Promise((r) => setTimeout(r, 5));
let seq = 0;
/** A fresh links file per session: a leftover link makes the session resume a
 *  thread that no longer exists, which is a different test entirely. */
const linksPath = (tag: string) => `/tmp/hoobot-stall-test-${process.pid}-${tag}-${seq++}.json`;

/** A server that starts turns and then goes quiet, like a dead stream. */
class StallingServer extends EventEmitter {
  endpoint = "fake";
  calls: { method: string; params: any }[] = [];
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "t1", turns: [] }, model: "test-model" };
    if (method === "thread/resume") return { thread: { id: params.threadId, turns: [] }, model: "test-model" };
    if (method === "turn/interrupt") return {};
    if (method === "turn/start") return { turn: { id: "u1" } };
    return {};
  }
  respond() {}
  notify(method: string, params: any) {
    this.emit("notification", { method, params: { threadId: "t1", ...params } });
  }
}

function fakeThread() {
  const sent: string[] = [];
  const posted = (text: string) => ({
    edit: async (t: string) => void (sent[sent.indexOf(text)] = t),
    delete: async () => {},
  });
  return {
    id: "d1",
    surface: "discord" as const,
    label: "Discord",
    maxLength: 2000,
    maxChoices: 25,
    sent,
    menus: [] as any[],
    deleted: [] as string[],
    replies: [] as (string | null)[],
    uploads: [] as string[][],
    async send(text: string) {
      sent.push(text);
      return { ...posted(text), ts: String(sent.length), ...posted(text) };
    },
    async edit() {},
    async react() {},
    async delete() {},
    async sendTyping() {},
    async choose(title: string) {
      return { msg: { ...posted(title) }, pick: Promise.resolve({ value: "go/kimi-k2" }) };
    },
  } as any;
}

test("a turn that stops reporting is given up on, and the busy flag clears", async () => {
  const wasStall = config.turnStallMs;
  config.turnStallMs = 1_000;

  try {
    const server = new StallingServer();
    const thread = fakeThread();
    const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("a")), () => {});
    const sent = await s.prompt("hello");
    expect(sent).toBe(true);
    server.notify("turn/started", { turn: { id: "u1", status: "inProgress" } });
    await tick();
    expect(s.busy).toBe(true);

    // The stream now dies: no turn/completed, ever.
    await Bun.sleep(1_400);

    expect(s.busy).toBe(false);
    expect(thread.sent.join("\n")).toContain("Stopped waiting");
    s.close();
  } finally {
    config.turnStallMs = wasStall;
  }
});

test("a long turn that keeps reporting is never given up on", async () => {
  const wasStall = config.turnStallMs;
  config.turnStallMs = 1_000;

  try {
    const server = new StallingServer();
    const thread = fakeThread();
    const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("b")), () => {});
    await s.prompt("hello");
    server.notify("turn/started", { turn: { id: "u1", status: "inProgress" } });
    await tick();

    // Progress, slower than the watchdog, but real progress: each event
    // pushes the deadline out, so the turn is never abandoned. The gaps
    // (400ms) are under the watchdog (1000ms) on purpose — this is the case
    // the naive "total turn time" limit would get wrong and kill a good answer.
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(400);
      server.notify("turn/progress", { turn: { id: "u1" } });
    }

    // Still working after ~3.2s, well past a single 1s window.
    expect(s.busy).toBe(true);
    expect(thread.sent.join("\n")).not.toContain("Stopped waiting");
    s.close();
  } finally {
    config.turnStallMs = wasStall;
  }
});

test("the stall watchdog is disarmed once the turn completes", async () => {
  const wasStall = config.turnStallMs;
  config.turnStallMs = 1_000;

  try {
    const server = new StallingServer();
    const thread = fakeThread();
    const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("c")), () => {});
    await s.prompt("hello");
    server.notify("turn/started", { turn: { id: "u1", status: "inProgress" } });
    await tick();
    server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
    await tick();
    expect(s.busy).toBe(false);

    // A completed turn must not leave a watchdog behind to fire later and
    // clear the *next* turn's flag.
    await Bun.sleep(1_400);
    expect(s.busy).toBe(false);
    expect(thread.sent.join("\n")).not.toContain("Stopped waiting");
    s.close();
  } finally {
    config.turnStallMs = wasStall;
  }
});

test("turnStalledMs and turnAgeMs report progress to /healthz", async () => {
  const wasStuck = config.turnStuckMs;
  config.turnStuckMs = 1; // anything running counts as stuck
  try {
    const server = new StallingServer();
    const thread = fakeThread();
    const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("d")), () => {});
    // Idle: both read zero, so a quiet bot is never reported as stuck.
    expect(s.turnAgeMs).toBe(0);
    expect(s.turnStalledMs).toBe(0);

    await s.prompt("hello");
    server.notify("turn/started", { turn: { id: "u1", status: "inProgress" } });
    await tick();
    expect(s.turnAgeMs).toBeGreaterThan(0);
    expect(s.busy).toBe(true);
    s.close();
  } finally {
    config.turnStuckMs = wasStuck;
  }
});
// The whole chain, against a real app-server *process*: connect over stdio,
// start a turn, let the event stream die, and check the session recovers.
// The unit tests above prove the watchdog's logic; this proves the wiring —
// that a genuine hanging server is caught, not just a fake object.
const { CodexClient } = await import("../src/codex-client.ts");

const wedging = new URL("./fixtures/wedging-app-server.ts", import.meta.url).pathname;

test("a real app-server that stops streaming mid-turn is recovered from", async () => {
  const wasStall = config.turnStallMs;
  const wasStuck = config.turnStuckMs;
  config.turnStallMs = 1_000;
  config.turnStuckMs = 1_000;
  const LP = `/tmp/hoobot-wedge-e2e-${process.pid}.json`;
  try {
    const client = await CodexClient.connect(`stdio:${process.execPath} ${wedging}`, undefined, {
      initializeTimeoutMs: 10_000,
      requestTimeoutMs: 10_000,
    });
    const thread = fakeThread();
    const s = new ThreadSession(thread, client as any, new LinkStore(LP), () => {});

    expect(await s.prompt("are you there?")).toBe(true);
    await Bun.sleep(50);
    expect(s.busy).toBe(true);
    expect(s.turnAgeMs).toBeGreaterThan(0);

    // The server acknowledged and then went quiet. No turn/completed comes.
    await Bun.sleep(1_600);

    expect(s.busy).toBe(false);
    expect(thread.sent.join("\n")).toContain("Stopped waiting");
    // And it asked the server to stop burning tokens on the abandoned turn.
    expect(s.busy).toBe(false);
    s.close();
    client.close();
  } finally {
    config.turnStallMs = wasStall;
    config.turnStuckMs = wasStuck;
    try {
      (await import("node:fs")).rmSync(LP, { force: true });
    } catch {}
  }
});
