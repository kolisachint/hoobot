// ThreadSession output with a fake app-server and a fake Discord thread.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";

process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
const { ThreadSession } = await import("../src/session.ts");
const { LinkStore } = await import("../src/links.ts");

class FakeServer extends EventEmitter {
  endpoint = "fake";
  calls: { method: string; params: any }[] = [];
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "t1", turns: [] }, model: "test-model" };
    if (method === "thread/resume") return { thread: { id: params.threadId, turns: [] }, model: "test-model" };
    if (method === "turn/start") return { turn: { id: "u1" } };
    if (method === "model/list") {
      const all = [
        { id: "a/opus-5", displayName: "Opus 5", hidden: false },
        { id: "go/kimi-k2", displayName: "Kimi K2", hidden: false },
        { id: "go/kimi-k3", displayName: "Kimi K3", hidden: true },
      ];
      return { data: params.includeHidden ? all : all.filter((m) => !m.hidden) };
    }
    return {};
  }
  respond() {}
  notify(method: string, params: any) {
    this.emit("notification", { method, params: { threadId: "t1", ...params } });
  }
}

function fakeThread(pick?: string) {
  const sent: string[] = [];
  const menus: any[] = [];
  const deleted: string[] = [];
  const thread = {
    id: "d1",
    sent,
    deleted,
    menus,
    async send(c: any) {
      const text = typeof c === "string" ? c : c.content;
      sent.push(text);
      if (c?.components) menus.push(c.components[0].toJSON().components[0]);
      return {
        edit: async (t: any) => void (sent[sent.indexOf(text)] = typeof t === "string" ? t : t.content),
        delete: async () => void deleted.push(text),
        awaitMessageComponent: async () => {
          if (!pick) throw new Error("timeout");
          return { values: [pick], update: async (u: any) => void sent.push(u.content) };
        },
      };
    },
    async sendTyping() {},
  };
  return thread;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

async function runTurn(verbose: boolean) {
  const server = new FakeServer();
  const thread = fakeThread();
  const links = new LinkStore(`/tmp/hoobot-session-test-${process.pid}-${verbose}.json`);
  const s = new ThreadSession(thread, server as any, links, () => {});
  if (verbose) await s.toggleVerbose();
  thread.sent.length = 0;
  await s.prompt("do it");
  server.notify("item/started", { item: { type: "commandExecution", id: "c1", command: "gh pr create" } });
  server.notify("item/completed", { item: { type: "agentMessage", id: "m1", text: "Let me open a PR." } });
  server.notify("item/completed", {
    item: {
      type: "commandExecution",
      id: "c1",
      command: "gh pr create",
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "https://github.com/o/r/pull/7\n",
    },
  });
  server.notify("item/completed", { item: { type: "agentMessage", id: "m2", text: "Opened the PR." } });
  await tick();
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
  return thread;
}

test("default: only the final answer, with a footer", async () => {
  const thread = await runTurn(false);
  expect(thread.sent).toHaveLength(1);
  expect(thread.sent[0]).toStartWith("Opened the PR.\n-# [PR #7](<https://github.com/o/r/pull/7>) · 1 step · ");
  expect(thread.sent[0]).toEndWith("· `test-model`");
});

test("verbose: in-between messages and the step list are shown", async () => {
  const thread = await runTurn(true);
  expect(thread.sent.some((m) => m === "Let me open a PR.")).toBe(true);
  expect(thread.sent.some((m) => m.includes("✅ done") && m.includes("gh pr create"))).toBe(true);
  expect(thread.sent.some((m) => m.startsWith("Opened the PR."))).toBe(true);
});

test("a failed turn posts the error and the footer", async () => {
  const server = new FakeServer();
  const thread = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(`/tmp/hoobot-session-test-${process.pid}-f.json`), () => {});
  await s.prompt("x");
  server.notify("item/completed", { item: { type: "commandExecution", id: "c", command: "boom", status: "failed", exitCode: 2 } });
  server.notify("turn/completed", { turn: { id: "u1", status: "failed", error: { message: "rate limited" } } });
  await tick();
  s.close();
  expect(thread.sent).toHaveLength(1);
  expect(thread.sent[0]).toContain("**Error:**");
  expect(thread.sent[0]).toContain("rate limited");
  expect(thread.sent[0]).toContain("1 step (1 failed)");
});

const linksPath = (tag: string) => `/tmp/hoobot-session-test-${process.pid}-${tag}.json`;

test("!model <part> picks a scoped or hidden model, sent on every turn and kept after a restart", async () => {
  const server = new FakeServer();
  const thread = fakeThread();
  const links = new LinkStore(linksPath("m"));
  let s = new ThreadSession(thread, server as any, links, () => {});
  await s.chooseModel("k3"); // only the hidden one matches
  expect(thread.sent.at(-1)).toContain("`go/kimi-k3` from the next message");
  await s.prompt("one");
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
  // Bot restart: a new session for the same Discord thread.
  s = new ThreadSession(thread, server as any, new LinkStore(linksPath("m")), () => {});
  await s.prompt("two");
  s.close();
  const turns = server.calls.filter((c) => c.method === "turn/start");
  expect(turns.map((c) => c.params.model)).toEqual(["go/kimi-k3", "go/kimi-k3"]);
  expect(server.calls.filter((c) => c.method === "thread/start")).toHaveLength(1); // same conversation
});

test("!model shows only scoped models; a pick applies from the next message", async () => {
  const server = new FakeServer();
  const thread = fakeThread("go/kimi-k2");
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("d")), () => {});
  await s.chooseModel();
  expect(thread.menus[0].options.map((o: any) => o.value)).toEqual(["a/opus-5", "go/kimi-k2"]);
  expect(thread.sent.at(-1)).toContain("`go/kimi-k2` from the next message");
  await s.prompt("hi");
  s.close();
  expect(server.calls.find((c) => c.method === "turn/start")?.params.model).toBe("go/kimi-k2");
});

test("!model kimi with two matches shows a dropdown of just those", async () => {
  const server = new FakeServer();
  const thread = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("k")), () => {});
  await s.chooseModel("kimi");
  s.close();
  expect(thread.menus[0].options.map((o: any) => o.value)).toEqual(["go/kimi-k2", "go/kimi-k3"]);
  expect(thread.sent.at(-1)).toContain("(not changed)");
});

test("the answer replies to the caller; the read position is saved and survives a restart", async () => {
  const server = new FakeServer();
  const replies: any[] = [];
  const thread: any = fakeThread();
  const plainSend = thread.send;
  thread.send = async (c: any) => {
    if (c?.reply) replies.push(c.reply.messageReference);
    return plainSend(c);
  };
  const path = linksPath("seen");
  let s = new ThreadSession(thread, server as any, new LinkStore(path), () => {});
  expect(await s.readState()).toEqual({ linked: false, seen: null });
  expect(await s.prompt("alice: hi", [], { id: "555" })).toBe(true);
  s.markSeen("555");
  server.notify("item/completed", { item: { type: "agentMessage", id: "m", text: "hello" } });
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
  expect(replies).toEqual(["555"]);

  s = new ThreadSession(thread, server as any, new LinkStore(path), () => {});
  expect(await s.readState()).toEqual({ linked: true, seen: "555" });
  s.markSeen("100"); // older: ignored
  expect(await s.readState()).toEqual({ linked: true, seen: "555" });
  await s.newSession(); // fresh conversation: read from scratch
  expect(await s.readState()).toEqual({ linked: false, seen: null });
  s.close();
});
