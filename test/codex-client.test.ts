import { expect, test } from "bun:test";
import { CodexClient } from "../src/codex-client.ts";

const fake = new URL("./fixtures/fake-app-server.ts", import.meta.url).pathname;

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
