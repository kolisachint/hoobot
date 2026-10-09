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
const { authHint } = await import("../src/session.ts");
const { LinkStore } = await import("../src/links.ts");
const { config } = await import("../src/config.ts");

class FakeServer extends EventEmitter {
  endpoint = "fake";
  calls: { method: string; params: any }[] = [];
  /** The model the server reports for a new or resumed thread. */
  threadModel = "test-model";
  /** What `model/list` returns. Hidden entries are outside the user's scope. */
  models: any[] = [
    {
      id: "a/opus-5",
      model: "a/opus-5",
      displayName: "Opus 5",
      hidden: false,
      defaultReasoningEffort: "high",
      category: "capable",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "medium", description: "" },
        { reasoningEffort: "high", description: "" },
      ],
    },
    {
      id: "go/kimi-k2",
      model: "go/kimi-k2",
      displayName: "Kimi K2",
      hidden: false,
      defaultReasoningEffort: "medium",
      category: "fast",
      supportedReasoningEfforts: [
        { reasoningEffort: "off", description: "" },
        { reasoningEffort: "medium", description: "" },
      ],
    },
    { id: "go/kimi-k3", model: "go/kimi-k3", displayName: "Kimi K3", hidden: true },
    { id: "go/kimi-k4", model: "go/kimi-k4", displayName: "Kimi K4", hidden: false },
    { id: "go/free-model", model: "go/free-model", displayName: "Free", hidden: false },
  ];
  /** An older server may ignore `includeHidden` and send everything. */
  ignoreIncludeHidden = false;
  /** A server without model/list (or one that fails it). */
  failModelList = false;
  /** Held until released: a thread/start that is still waiting on the server. */
  gateStart: Promise<void> | null = null;
  /** thread/resume waits here, then fails the way a closed connection does. */
  gateResume: Promise<void> | null = null;
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === "thread/start" && this.gateStart) await this.gateStart;
    if (method === "thread/resume" && this.gateResume) {
      await this.gateResume;
      throw new Error("app-server connection closed: closed by client");
    }
    if (method === "thread/start") return { thread: { id: "t1", turns: [] }, model: this.threadModel };
    if (method === "thread/resume") return { thread: { id: params.threadId, turns: [] }, model: this.threadModel };
    if (method === "turn/start") return { turn: { id: "u1" } };
    if (method === "model/list") {
      if (this.failModelList) throw new Error("Method not found: model/list");
      const data = this.ignoreIncludeHidden || params.includeHidden ? this.models : this.models.filter((m) => !m.hidden);
      return { data };
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

const lastTurn = (server: FakeServer) => server.calls.filter((c) => c.method === "turn/start").at(-1)!;
const turnsOf = (server: FakeServer) => server.calls.filter((c) => c.method === "turn/start");

test("!model <part> picks a scoped model, sent on every turn and kept after a restart", async () => {
  const server = new FakeServer();
  const thread = fakeThread();
  const links = new LinkStore(linksPath("m"));
  let s = new ThreadSession(thread, server as any, links, () => {});
  await s.chooseModel("k4");
  expect(thread.sent.at(-1)).toContain("`go/kimi-k4` from the next message");
  await s.prompt("one");
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
  // Bot restart: a new session for the same Discord thread.
  s = new ThreadSession(thread, server as any, new LinkStore(linksPath("m")), () => {});
  await s.prompt("two");
  s.close();
  const turns = server.calls.filter((c) => c.method === "turn/start");
  expect(turns.map((c) => c.params.model)).toEqual(["go/kimi-k4", "go/kimi-k4"]);
  expect(server.calls.filter((c) => c.method === "thread/start")).toHaveLength(1); // same conversation
});

test("!model <part> never reaches a hidden model, even from a server that ignores includeHidden", async () => {
  const server = new FakeServer();
  server.ignoreIncludeHidden = true;
  const thread = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("hid")), () => {});
  await s.chooseModel("k3"); // only a hidden model matches
  expect(thread.sent.at(-1)).toContain("No model matches `k3`");
  await s.prompt("hi");
  s.close();
  expect(lastTurn(server).params).not.toHaveProperty("model");
});

test("!model with no query lists only scoped models, numbered, with effort and category; the current one is marked", async () => {
  const server = new FakeServer();
  server.threadModel = "go/kimi-k2";
  const thread = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("list")), () => {});
  await s.chooseModel();
  s.close();
  const opts = thread.menus[0].options;
  expect(opts.map((o: any) => o.label)).toEqual(["1. Opus 5", "2. Kimi K2 (current)", "3. Kimi K4", "4. Free"]);
  expect(opts.map((o: any) => o.description)).toEqual([
    "a/opus-5 · effort high · capable",
    "go/kimi-k2 · effort medium · fast",
    "go/kimi-k4",
    "go/free-model",
  ]);
  expect(opts.map((o: any) => !!o.default)).toEqual([false, true, false, false]);
  expect(server.calls.find((c) => c.method === "model/list")?.params).toEqual({ includeHidden: false });
});

test("when the server offers only hidden models, or none, !model says so plainly", async () => {
  const server = new FakeServer();
  server.models = [{ id: "go/kimi-k3", model: "go/kimi-k3", hidden: true }];
  const thread = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("hid2")), () => {});
  await s.chooseModel();
  expect(thread.menus).toHaveLength(0);
  expect(thread.sent.at(-1)).toContain("no models in your scope");
  server.models = [];
  await s.chooseModel();
  expect(thread.sent.at(-1)).toContain("no models in your scope");
  s.close();
});

test("!model <number> picks by place in the list; a number past the end matches nothing, even inside a name", async () => {
  const server = new FakeServer();
  const thread = fakeThread();
  const links = new LinkStore(linksPath("num"));
  const s = new ThreadSession(thread, server as any, links, () => {});
  await s.chooseModel("2");
  expect(thread.sent.at(-1)).toContain("`go/kimi-k2` from the next message");
  await s.chooseModel("9");
  expect(thread.sent.at(-1)).toContain("No model matches `9`");
  // "5" is inside "a/opus-5", but with 4 models it is out of range: no fallback to a name match.
  await s.chooseModel("5");
  expect(thread.sent.at(-1)).toContain("No model matches `5`");
  expect(links.get("discord:d1")?.model).toBe("go/kimi-k2");
  s.close();
});

test("!model <name> <effort> sets the effort; it is saved, sent on turns, and survives a restart", async () => {
  const server = new FakeServer();
  const thread = fakeThread();
  const links = new LinkStore(linksPath("eff"));
  let s = new ThreadSession(thread, server as any, links, () => {});
  await s.chooseModel("opus high");
  expect(thread.sent.at(-1)).toContain("`a/opus-5` (effort `high`) from the next message");
  expect(links.get("discord:d1")).toMatchObject({ model: "a/opus-5", effort: "high" });
  await s.prompt("hi");
  server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
  await tick();
  s.close();
  s = new ThreadSession(thread, server as any, new LinkStore(linksPath("eff")), () => {});
  await s.prompt("again");
  s.close();
  const turns = server.calls.filter((c) => c.method === "turn/start");
  expect(turns.map((c) => [c.params.model, c.params.effort])).toEqual([
    ["a/opus-5", "high"],
    ["a/opus-5", "high"],
  ]);
  expect(server.calls.find((c) => c.method === "thread/resume")?.params.effort).toBe("high");
});

test("an effort the model doesn't list is refused, and the model stays as it was", async () => {
  const server = new FakeServer();
  const thread = fakeThread();
  const links = new LinkStore(linksPath("bad"));
  const s = new ThreadSession(thread, server as any, links, () => {});
  await s.chooseModel("kimi-k2 xhigh");
  expect(thread.sent.at(-1)).toContain("`xhigh` isn't an effort for `go/kimi-k2`");
  expect(thread.sent.at(-1)).toContain("`off`, `medium`");
  expect(links.get("discord:d1")?.model).toBeUndefined();
  await s.prompt("hi");
  s.close();
  expect(lastTurn(server).params).not.toHaveProperty("model");
  expect(lastTurn(server).params).not.toHaveProperty("effort");
});

test("!effort shows the level and choices; sets an override the model supports; default clears it", async () => {
  const server = new FakeServer();
  server.threadModel = "a/opus-5";
  const links = new LinkStore(linksPath("effort"));
  const thread = fakeThread();
  const s = new ThreadSession(thread, server as any, links, () => {});
  await s.chooseEffort();
  expect(thread.sent.at(-1)).toContain("Scoped default: `high`");
  expect(thread.sent.at(-1)).toContain("Choices: low, medium, high");
  await s.chooseEffort("xhigh");
  expect(thread.sent.at(-1)).toContain("`xhigh` isn't an effort for `a/opus-5`");
  expect(links.get("discord:d1")?.effort).toBeUndefined();
  await s.chooseEffort("low");
  expect(thread.sent.at(-1)).toContain("**Effort:** `low` for `a/opus-5` from the next message");
  expect(links.get("discord:d1")?.effort).toBe("low");
  await s.prompt("hi");
  expect(lastTurn(server).params.effort).toBe("low");
  await s.chooseEffort("default");
  expect(thread.sent.at(-1)).toContain("back to the scoped default");
  expect(links.get("discord:d1")?.effort).toBeUndefined();
  s.close();
});

test("!effort with no pinned model pins the thread's current model, so the level and the sent model agree", async () => {
  const server = new FakeServer();
  server.threadModel = "a/opus-5";
  const links = new LinkStore(linksPath("pin"));
  const s = new ThreadSession(fakeThread(), server as any, links, () => {});
  await s.chooseEffort("low");
  expect(links.get("discord:d1")).toMatchObject({ model: "a/opus-5", effort: "low" });
  await s.prompt("hi");
  s.close();
  expect(lastTurn(server).params).toMatchObject({ model: "a/opus-5", effort: "low" });
});

test("turn/start carries an effort only when the user overrode it; a model pick clears the override", async () => {
  const server = new FakeServer();
  const thread = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("eo")), () => {});
  const runTurn = async () => {
    await s.prompt("hi");
    server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
    await tick();
  };
  await runTurn();
  expect(lastTurn(server).params).not.toHaveProperty("effort");
  await s.chooseEffort("medium");
  await runTurn();
  expect(lastTurn(server).params).toMatchObject({ effort: "medium" });
  await s.chooseModel("opus"); // no effort given: the override goes
  await runTurn();
  expect(lastTurn(server).params).toMatchObject({ model: "a/opus-5" });
  expect(lastTurn(server).params).not.toHaveProperty("effort");
  s.close();
});

test("a fresh thread (after !new) starts with the space's effort override and its pinned model", async () => {
  const server = new FakeServer();
  server.threadModel = "a/opus-5";
  const s = new ThreadSession(fakeThread(), server as any, new LinkStore(linksPath("newe")), () => {});
  await s.chooseEffort("medium");
  await s.newSession();
  s.close();
  expect(server.calls.filter((c) => c.method === "thread/start").at(-1)?.params).toEqual({ model: "a/opus-5", effort: "medium" });
});

test("MODEL the server doesn't scope in is ignored: no model is sent, the server's scoped default applies", async () => {
  const was = config.model;
  config.model = "go/not-in-scope";
  try {
    const server = new FakeServer();
    const s = new ThreadSession(fakeThread(), server as any, new LinkStore(linksPath("envx")), () => {});
    await s.prompt("hi");
    s.close();
    expect(server.calls.find((c) => c.method === "thread/start")?.params).toEqual({});
    expect(lastTurn(server).params).not.toHaveProperty("model");
  } finally {
    config.model = was;
  }
});

test("MODEL is sent as it is when model/list fails: an older server gets it, and it warns on every turn", async () => {
  const was = config.model;
  config.model = "go/whatever";
  const warnings: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const server = new FakeServer();
    server.failModelList = true;
    const s = new ThreadSession(fakeThread(), server as any, new LinkStore(linksPath("envfail")), () => {});
    await s.prompt("one");
    server.notify("turn/completed", { turn: { id: "u1", status: "completed" } });
    await tick();
    await s.prompt("two");
    s.close();
    expect(server.calls.find((c) => c.method === "thread/start")?.params).toEqual({ model: "go/whatever" });
    expect(turnsOf(server).map((c) => c.params.model)).toEqual(["go/whatever", "go/whatever"]);
    expect(warnings.filter((w) => w.includes("Can't check MODEL=go/whatever")).length).toBeGreaterThanOrEqual(2);
  } finally {
    console.error = origError;
    config.model = was;
  }
});

test("MODEL the server scopes in is used when nothing is picked", async () => {
  const was = config.model;
  config.model = "go/kimi-k4";
  try {
    const server = new FakeServer();
    const s = new ThreadSession(fakeThread(), server as any, new LinkStore(linksPath("envok")), () => {});
    await s.prompt("hi");
    s.close();
    expect(server.calls.find((c) => c.method === "thread/start")?.params).toEqual({ model: "go/kimi-k4" });
    expect(lastTurn(server).params.model).toBe("go/kimi-k4");
  } finally {
    config.model = was;
  }
});

test("a turn that fails for lack of a login says how to fix it; other failures get no such hint", async () => {
  const server = new FakeServer();
  const thread = fakeThread();
  const s = new ThreadSession(thread, server as any, new LinkStore(linksPath("auth")), () => {});
  await s.prompt("x");
  server.notify("turn/completed", {
    turn: { id: "u1", status: "failed", error: { message: "No API key for provider: anthropic" } },
  });
  await tick();
  expect(thread.sent.at(-1)).toContain("**Error:**");
  expect(thread.sent.at(-1)).toContain(
    "hoocode can't authenticate with anthropic. Run `hoocode` on the host and `/login anthropic`.",
  );
  await s.prompt("y");
  server.notify("turn/completed", { turn: { id: "u1", status: "failed", error: { message: "rate limited" } } });
  await tick();
  s.close();
  expect(thread.sent.at(-1)).not.toContain("can't authenticate");
});

test("authHint names the provider the error names, in its three forms; otherwise a generic hint, never a guess from the model", () => {
  const hint = (provider: string) =>
    `hoocode can't authenticate with ${provider}. Run \`hoocode\` on the host and \`/login ${provider}\`.`;
  const generic = "hoocode can't authenticate with the model's provider. Run `hoocode` on the host and `/login <provider>`.";
  expect(authHint("No API key for provider: anthropic")).toBe(hint("anthropic"));
  expect(authHint('Authentication failed for "opencode-go"')).toBe(hint("opencode-go"));
  expect(authHint('Unauthorized for "anthropic"')).toBe(hint("anthropic"));
  expect(authHint("Unauthorized")).toBe(generic);
  expect(authHint("Authentication failed")).toBe(generic);
  expect(authHint("rate limited")).toBeNull();
});

test("a command racing a close is not reported as a failed resume", async () => {
  const server = new FakeServer();
  const links = new LinkStore(linksPath("closing"));
  const first = new ThreadSession(fakeThread(), server as any, links, () => {});
  await first.chooseEffort("low"); // leaves a link to resume
  first.close();
  let release!: () => void;
  server.gateResume = new Promise<void>((r) => (release = r));
  const thread = fakeThread();
  const s = new ThreadSession(thread, server as any, links, () => {});
  const status = s.status().catch((err) => err);
  s.close();
  release();
  expect(await status).toBeInstanceOf(Error);
  expect(thread.sent.some((t) => t.includes("Couldn't reopen"))).toBe(false);
});

test("a command that is still resolving its thread counts as in flight, so a restart waits for it", async () => {
  const server = new FakeServer();
  let release!: () => void;
  server.gateStart = new Promise<void>((r) => (release = r));
  const s = new ThreadSession(fakeThread(), server as any, new LinkStore(linksPath("resolving")), () => {});
  const status = s.status();
  expect(s.inFlight).toBe(true);
  release();
  await status;
  expect(s.inFlight).toBe(false);
  s.close();
});

test("help lists !effort and the numbered !model, and no longer suggests --thinking", async () => {
  const { helpText } = await import("../src/core.ts");
  const text = helpText("Discord", "a list");
  expect(text).toContain("`!effort [level]`");
  expect(text).toContain("`!model <number or part of name> [effort]`");
  expect(text).not.toContain("--thinking");
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
