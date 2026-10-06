// ThreadSession output with a fake app-server and a fake chat space.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";

process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
// Pinned, not defaulted: `??=` would let an ambient MODEL from the shell (or
// the developer's .env) leak in and decide what the footers under test say,
// so the suite passed or failed depending on where it was run.
process.env.MODEL = "";
const { ThreadSession } = await import("../src/session.ts");
const { LinkStore } = await import("../src/links.ts");
const { config } = await import("../src/config.ts");

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
  const replies: (string | null)[] = [];
  const uploads: string[][] = [];
  const typing: number[] = [];
  const posted = (text: string) => ({
    edit: async (t: string) => void (sent[sent.indexOf(text)] = t),
    delete: async () => void deleted.push(text),
  });
  const thread = {
    id: "d1",
    surface: "discord" as const,
    label: "Discord",
    maxLength: 2000,
    maxChoices: 25,
    sent,
    deleted,
    menus,
    replies,
    uploads,
    typing,
    async send(text: string, opts: any = {}) {
      sent.push(text);
      if (opts.replyTo) replies.push(opts.replyTo);
      if (opts.files?.length) uploads.push(opts.files.map((f: any) => f.name));
      return posted(text);
    },
    async sendTyping() {
      typing.push(Date.now());
    },
    async choose(text: string, kind: string, choices: any[]) {
      sent.push(text);
      if (kind === "menu") menus.push({ options: choices });
      const pickP = pick
        ? Promise.resolve({ value: pick, user: "tester", update: async (t: string) => void sent.push(t) })
        : Promise.reject(new Error("timeout"));
      pickP.catch(() => {});
      return { msg: posted(text), pick: pickP };
    },
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

test("MODEL reaches threads resumed from an older link; !model still wins", async () => {
  const was = config.model;
  config.model = "go/free-model";
  try {
    const server = new FakeServer();
    // A link from before MODEL was set: no model saved, server says "old-model".
    const links = new LinkStore(linksPath("env"));
    links.set("slack:C1", { threadId: "t-old" });
    const s = new ThreadSession(fakeThread(), server as any, links, () => {});
    await s.prompt("hi");
    expect(server.calls.find((c) => c.method === "turn/start")?.params.model).toBe("go/free-model");
    s.close();
    // An explicit pick in this thread outranks MODEL.
    const s2 = new ThreadSession(fakeThread(), server as any, new LinkStore(linksPath("env2")), () => {});
    await s2.chooseModel("opus");
    await s2.prompt("hi");
    expect(server.calls.filter((c) => c.method === "turn/start").at(-1)?.params.model).toBe("a/opus-5");
    s2.close();
  } finally {
    config.model = was;
  }
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
  const thread: any = fakeThread();
  const path = linksPath("seen");
  let s = new ThreadSession(thread, server as any, new LinkStore(path), () => {});
  expect(await s.readState()).toEqual({ linked: false, seen: null });
  expect(await s.prompt("alice: hi", [], { id: "555" })).toBe(true);
  s.markSeen("555");
  server.notify("item/completed", { item: { type: "agentMessage", id: "m", text: "hello" } });
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
  expect(thread.replies).toEqual(["555"]);

  s = new ThreadSession(thread, server as any, new LinkStore(path), () => {});
  expect(await s.readState()).toEqual({ linked: true, seen: "555" });
  s.markSeen("100"); // older: ignored
  expect(await s.readState()).toEqual({ linked: true, seen: "555" });
  await s.newSession(); // fresh conversation: read from scratch
  expect(await s.readState()).toEqual({ linked: false, seen: null });
  s.close();
});

test("files written this turn are attached to the answer", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "hoobot-session-att-"));
  writeFileSync(join(dir, "page.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "app.ts"), "x");
  const server = new FakeServer();
  const thread: any = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("att")), () => {}, dir);
  await s.prompt("make a page");
  for (const path of ["page.html", "app.ts"]) {
    server.notify("item/completed", {
      item: { type: "dynamicToolCall", id: path, tool: "write", arguments: { path }, success: true, status: "completed" },
    });
  }
  server.notify("item/completed", { item: { type: "agentMessage", id: "m", text: "Wrote page.html." } });
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
  expect(thread.uploads).toEqual([["page.html"]]);
  expect(thread.sent.at(-1)).toStartWith("Wrote page.html.");
});

test("a real-shaped fileChange and a file written by a shell command are both attached", async () => {
  const { mkdtempSync, writeFileSync, utimesSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "hoobot-session-fc-"));
  writeFileSync(join(dir, "old.html"), "old");
  const old = Date.now() / 1000 - 3600;
  utimesSync(join(dir, "old.html"), old, old);
  const server = new FakeServer();
  const thread: any = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("fc")), () => {}, dir);
  await s.prompt("make pages");
  // hoocode's `write` → fileChange with an absolute path (items.rs).
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  server.notify("item/completed", {
    item: { type: "fileChange", id: "f", status: "completed", changes: [{ path: join(dir, "index.html"), kind: { type: "add" }, diff: "" }] },
  });
  // A shell command writes another file; the answer doesn't name it.
  writeFileSync(join(dir, "chart.svg"), "<svg/>");
  server.notify("item/completed", {
    item: { type: "commandExecution", id: "c", command: "python gen.py", status: "completed", exitCode: 0, aggregatedOutput: "" },
  });
  server.notify("item/completed", { item: { type: "agentMessage", id: "m", text: "Done, see the files." } });
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
  expect(thread.uploads).toEqual([["index.html", "chart.svg"]]);
});

test("a channel and its thread working in one folder at once each get only their own files", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "hoobot-session-two-"));
  // One server, two app-server threads (t1 for the channel, t2 for the thread).
  class TwoThreads extends FakeServer {
    n = 0;
    override async request(method: string, params: any): Promise<any> {
      if (method === "thread/start") return { thread: { id: `t${++this.n}`, turns: [] }, model: "m" };
      if (method === "turn/start") return { turn: { id: `u-${params.threadId}` } };
      return super.request(method, params);
    }
  }
  const server = new TwoThreads();
  const space = (id: string) => {
    const t: any = fakeThread();
    t.id = id;
    return t;
  };
  const chan = space("chan");
  const thr = space("thr");
  const links = new LinkStore(linksPath("two"));
  const a = new ThreadSession(chan, server as any, links, () => {}, dir);
  const b = new ThreadSession(thr, server as any, links, () => {}, dir);
  await a.prompt("make a");
  await b.prompt("make b");
  writeFileSync(join(dir, "a.html"), "a");
  writeFileSync(join(dir, "b.svg"), "b");
  const cmd = (threadId: string, command: string) =>
    server.emit("notification", {
      method: "item/completed",
      params: { threadId, item: { type: "commandExecution", id: "c", command, status: "completed", exitCode: 0, aggregatedOutput: "" } },
    });
  cmd("t1", "python gen.py > a.html");
  cmd("t2", "python gen.py > b.svg");
  for (const t of ["t1", "t2"]) {
    server.emit("notification", { method: "turn/completed", params: { threadId: t, turn: { id: `u-${t}`, status: "completed" } } });
  }
  await tick();
  a.close();
  b.close();
  expect(chan.uploads).toEqual([["a.html"]]);
  expect(thr.uploads).toEqual([["b.svg"]]);
});

// ── Typing indicator ────────────────────────────────────────────────────────

test("typing starts with the turn and stops when it completes", async () => {
  const server = new FakeServer();
  const thread: any = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("ty")), () => {});
  await s.prompt("do it");
  expect(thread.typing.length).toBeGreaterThan(0);
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
  expect(thread.typing.length).toBe(1); // one ping, no heartbeat left running
});

test("typing is off when TYPING=0", async () => {
  const was = config.typingIndicator;
  config.typingIndicator = false;
  try {
    const server = new FakeServer();
    const thread: any = fakeThread();
    const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("ty0")), () => {});
    await s.prompt("do it");
    server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
    await tick();
    s.close();
    expect(thread.typing).toHaveLength(0);
  } finally {
    config.typingIndicator = was;
  }
});

test("typing pauses while an approval waits on a person, then resumes", async () => {
  const server = new FakeServer();
  const thread: any = fakeThread();
  // A pick that stays pending until the test releases it, like a real person
  // deciding. `fakeThread(pick)` resolves at once, which would resume the
  // indicator before the pause could be observed.
  let release: (v: any) => void = () => {};
  const pickP = new Promise((r) => (release = r));
  pickP.catch(() => {});
  thread.choose = async (text: string, kind: string, choices: any[]) => {
    thread.sent.push(text);
    // The code calls `update` on the pick's resolution, not on the message.
    const click = { value: "accept", user: "tester", update: async () => {} };
    return { msg: { edit: async () => {}, update: async () => {} }, pick: pickP.then(() => click) };
  };
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("tya")), () => {});
  await s.prompt("do it");
  const before = thread.typing.length;
  server.emit("request", {
    id: "r1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t1", command: "rm -rf build" },
  });
  await tick();
  expect(thread.sent.some((m: string) => m.startsWith("**Approval needed**"))).toBe(true);
  expect((s as any).typingTimer).toBeNull(); // paused
  // Another message while the buttons wait doesn't turn it back on.
  s.beginCall();
  await s.prompt("also this");
  s.endCall();
  expect((s as any).typingTimer).toBeNull();
  expect(thread.typing.length).toBe(before);
  release({ value: "accept", user: "tester" });
  await tick();
  expect(thread.typing.length).toBeGreaterThan(before); // resumed
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
});

// ── Status-line delay ────────────────────────────────────────────────────────

test("the status line waits per chat: 1s on Slack (no typing there), 4s on Discord", async () => {
  const { statusDelayFor } = await import("../src/config.ts");
  const was = config.statusDelayMs;
  try {
    config.statusDelayMs = null;
    expect(statusDelayFor("slack")).toBe(1_000);
    expect(statusDelayFor("discord")).toBe(4_000);
    config.statusDelayMs = 2_500; // STATUS_DELAY_SECONDS=2.5 overrides both
    expect(statusDelayFor("slack")).toBe(2_500);
    expect(statusDelayFor("discord")).toBe(2_500);
  } finally {
    config.statusDelayMs = was;
  }
});

test("the status line stays hidden inside the delay", async () => {
  const was = config.statusDelayMs;
  config.statusDelayMs = 60_000; // far longer than the test
  try {
    const server = new FakeServer();
    const thread: any = fakeThread();
    thread.surface = "slack"; // default 1s: a broken override would show the line
    const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("sd")), () => {});
    await s.prompt("do it");
    server.notify("item/started", { item: { type: "commandExecution", id: "c1", command: "gh pr create" } });
    await new Promise((r) => setTimeout(r, 1700)); // past one 1.5s poll
    s.close();
    expect(thread.sent).toHaveLength(0);
  } finally {
    config.statusDelayMs = was;
  }
});

test("the status line appears once the delay has passed", async () => {
  const was = config.statusDelayMs;
  config.statusDelayMs = 0;
  try {
    const server = new FakeServer();
    const thread: any = fakeThread();
    const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("sd0")), () => {});
    await s.prompt("do it");
    server.notify("item/started", { item: { type: "commandExecution", id: "c1", command: "gh pr create" } });
    // The progress poller runs every 1.5s; wait past one tick.
    await new Promise((r) => setTimeout(r, 1700));
    s.close();
    expect(thread.sent.some((m: string) => m.startsWith("⏳ Working"))).toBe(true);
  } finally {
    config.statusDelayMs = was;
  }
});

test("typing started on arrival stops when no turn comes of the call", async () => {
  const server = new FakeServer();
  const thread: any = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("tys")), () => {});
  s.beginCall(); // what handleCall does on arrival
  expect(thread.typing).toHaveLength(1);
  s.endCall(); // the preamble failed: no turn
  expect((s as any).typingTimer).toBeNull();
  // With a turn running, ending the call leaves its indicator alone.
  s.beginCall();
  await s.prompt("do it");
  s.endCall();
  expect((s as any).typingTimer).not.toBeNull();
  s.close();
});

test("a call queued behind a turn keeps typing when that turn completes", async () => {
  const server = new FakeServer();
  const thread: any = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("tyq")), () => {});
  s.beginCall();
  await s.prompt("first");
  s.endCall();
  s.beginCall(); // second message: still in its preamble
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  expect((s as any).typingTimer).not.toBeNull();
  s.endCall(); // its turn/start was refused, say
  expect((s as any).typingTimer).toBeNull();
  s.close();
});

test("STATUS_DELAY_SECONDS: a typo falls back to the per-chat default", async () => {
  const { parseSeconds } = await import("../src/config.ts");
  expect(parseSeconds(undefined)).toBeNull();
  expect(parseSeconds("0")).toBe(0);
  expect(parseSeconds("2.5")).toBe(2_500);
  expect(parseSeconds("4s")).toBeNull();
  expect(parseSeconds("-1")).toBeNull();
});

test("!new during a turn stops its typing", async () => {
  const server = new FakeServer();
  const thread: any = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("tyn")), () => {});
  await s.prompt("do it");
  expect((s as any).typingTimer).not.toBeNull();
  await s.newSession();
  expect((s as any).typingTimer).toBeNull();
  s.close();
});
