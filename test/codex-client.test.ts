import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { CodexClient, TimeoutError, recoverOrphanServers } from "../src/codex-client.ts";

const fake = new URL("./fixtures/fake-app-server.ts", import.meta.url).pathname;
const stalling = new URL("./fixtures/stalling-app-server.ts", import.meta.url).pathname;

test("connect fails when the server never answers initialize", async () => {
  // `sleep` reads nothing and sends nothing, like a hoocode without app-server.
  const err = await CodexClient.connect("stdio:sleep 30", undefined, { initializeTimeoutMs: 200 }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(String(err.message)).toContain("did not answer initialize");
});

test("connect succeeds when the server answers initialize", async () => {
  const client = await CodexClient.connect(`stdio:${process.execPath} ${fake}`, undefined, {
    initializeTimeoutMs: 5000,
  });
  expect(client.isClosed).toBe(false);
  client.close();
});

test("a call the server never answers rejects instead of hanging", async () => {
  // The bug this whole file exists for: a request with no deadline waited
  // forever, and because callers serialise per chat space, that one pending
  // promise blocked every later message in the thread. Silence, not an error.
  const client = await CodexClient.connect(`stdio:${process.execPath} ${stalling}`, undefined, {
    initializeTimeoutMs: 5000,
    requestTimeoutMs: 150,
  });
  const err = await client.request("turn/start", {}).catch((e) => e);
  expect(err).toBeInstanceOf(TimeoutError);
  expect(String(err.message)).toContain("turn/start");
  client.close();
});

test("a timed-out call leaves nothing pending, and later calls still work", async () => {
  const client = await CodexClient.connect(`stdio:${process.execPath} ${stalling}`, undefined, {
    initializeTimeoutMs: 5000,
    requestTimeoutMs: 120,
  });
  await client.request("turn/start", {}).catch(() => {});
  // The map must not keep the dead entry: a leak here is a slow memory leak.
  expect(client.inflight()).toHaveLength(0);
  // And a second timeout must not be swallowed by the first one's cleanup.
  const err = await client.request("thread/resume", {}).catch((e) => e);
  expect(err).toBeInstanceOf(TimeoutError);
  client.close();
});

test("inflight() reports the method and how long it has waited", async () => {
  const client = await CodexClient.connect(`stdio:${process.execPath} ${stalling}`, undefined, {
    initializeTimeoutMs: 5000,
    requestTimeoutMs: 5000,
  });
  const pending = client.request("turn/start", {}).catch(() => {});
  await Bun.sleep(40);
  const open = client.inflight();
  expect(open).toHaveLength(1);
  expect(open[0]!.method).toBe("turn/start");
  expect(open[0]!.waitedMs).toBeGreaterThanOrEqual(20);
  client.close();
  await pending;
});

test("timeoutMs: 0 opts a call out of the deadline", async () => {
  const client = await CodexClient.connect(`stdio:${process.execPath} ${stalling}`, undefined, {
    initializeTimeoutMs: 5000,
    requestTimeoutMs: 50,
  });
  let settled = false;
  const forever = client.request("turn/start", {}, 0).catch(() => {});
  void forever.then(() => {
    settled = true;
  });
  await Bun.sleep(200);
  // Still pending: an opted-out call is not reaped by the default budget.
  expect(settled).toBe(false);
  expect(client.inflight()).toHaveLength(1);
  client.close();
  await forever;
});

test("close stops the whole server, not only the wrapper that started it", async () => {
  // `hoocode` is a Node wrapper that runs the native app-server as a child in
  // the foreground. Killing only the wrapper left that child running. Here the
  // wrapper answers `initialize`, then runs `sleep 60` in the foreground.
  const dir = mkdtempSync(join(tmpdir(), "hoobot-group-"));
  const pidFile = join(dir, "wrapper.pid");
  const wrapper = join(dir, "hoocode-wrapper.sh");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `echo $$ > ${pidFile}`,
      "read -r line",
      `id=$(printf '%s' "$line" | sed 's/.*"id":\\([0-9][0-9]*\\).*/\\1/')`,
      `printf '{"id":%s,"result":{}}\\n' "$id"`,
      "sleep 60",
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);
  const client = await CodexClient.connect(`stdio:${wrapper}`, undefined, { initializeTimeoutMs: 5000 });
  const wrapperPid = Number(readFileSync(pidFile, "utf8"));
  // The `sleep` is the wrapper's child: it appears once the wrapper is in the foreground.
  await waitUntil(() => childrenOf(wrapperPid).length > 0, 2000);
  const [sleeper] = childrenOf(wrapperPid);
  expect(sleeper).toBeGreaterThan(0);
  expect(isAlive(sleeper!)).toBe(true);
  await client.close();
  await waitUntil(() => !isAlive(sleeper!) && !isAlive(wrapperPid), 2000);
  expect(isAlive(wrapperPid)).toBe(false);
  expect(isAlive(sleeper!)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

function childrenOf(pid: number): number[] {
  const out = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().trim();
  return out ? out.split(/\s+/).map(Number) : [];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

async function waitUntil(done: () => boolean, ms: number) {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await Bun.sleep(20);
}

test("recoverOrphanServers stops an app-server group a killed run left, and leaves other pids alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hoobot-orphan-"));
  const pidPath = join(dir, "app-servers.pid");
  // `sh -c` with a trailing `; :` keeps `sleep` as a child, and the argument
  // keeps `app-server` in the command line, as a real server has.
  const orphan = spawn("sh", ["-c", "sleep 60; :", "app-server"], { detached: true, stdio: "ignore" });
  const other = spawn("sh", ["-c", "sleep 60; :", "not-a-server"], { detached: true, stdio: "ignore" });
  orphan.unref();
  other.unref();
  try {
    await waitUntil(() => childrenOf(orphan.pid!).length > 0 && childrenOf(other.pid!).length > 0, 2000);
    writeFileSync(pidPath, `${orphan.pid}\n${other.pid}\n`);
    expect(recoverOrphanServers(pidPath)).toEqual([orphan.pid!]);
    await waitUntil(() => !isAlive(orphan.pid!), 2000);
    expect(isAlive(other.pid!)).toBe(true);
    await waitUntil(() => !existsSync(pidPath), 2000);
  } finally {
    try {
      process.kill(-other.pid!, "SIGKILL");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
