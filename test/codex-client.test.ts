import { expect, test } from "bun:test";
import { CodexClient, TimeoutError } from "../src/codex-client.ts";

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
