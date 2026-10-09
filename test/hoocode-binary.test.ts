// The app-server is replaced when hoocode changes on disk, and only then.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { binaryStamp, binaryChanged, shouldRestartServer, spawnedBinary } = await import("../src/hoocode-binary.ts");

const dir = () => mkdtempSync(join(tmpdir(), "hoobot-binary-"));

function fakeBinary(path: string, body = "v1") {
  writeFileSync(path, `#!/bin/sh\necho ${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("binaryStamp follows symlinks to the real file, with its size and mtime", () => {
  const d = dir();
  const real = fakeBinary(join(d, "hoocode-1.2.0"));
  const link = join(d, "hoocode");
  symlinkSync(real, link);
  const stamp = binaryStamp(link);
  expect(stamp?.path).toBe(realpathSync(real));
  expect(stamp?.size).toBeGreaterThan(0);
  expect(stamp?.mtimeMs).toBeGreaterThan(0);
});

test("binaryStamp is null when the binary can't be found", () => {
  expect(binaryStamp(join(dir(), "no-such-hoocode"))).toBeNull();
});

test("binaryChanged: same file, same size and mtime is unchanged; a new path, size or mtime is a change", () => {
  const d = dir();
  const a = fakeBinary(join(d, "a"));
  const b = fakeBinary(join(d, "b"), "other-build");
  const base = binaryStamp(a)!;
  expect(binaryChanged(base, binaryStamp(a)!)).toBe(false);
  expect(binaryChanged(base, binaryStamp(b)!)).toBe(true); // a different file
  writeFileSync(a, "#!/bin/sh\necho a much longer second build\n");
  expect(binaryChanged(base, binaryStamp(a)!)).toBe(true); // size changed
  const old = binaryStamp(a)!;
  utimesSync(a, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
  expect(binaryChanged(old, binaryStamp(a)!)).toBe(true); // only the mtime changed
});

test("shouldRestartServer: restart only when idle, the spawn binary is known, the binary is still there, and it changed", () => {
  const spawned = { path: "/opt/hoocode/a", mtimeMs: 1, size: 10 };
  const same = { ...spawned };
  const upgraded = { path: "/opt/hoocode/b", mtimeMs: 2, size: 20 };
  expect(shouldRestartServer({ spawned, current: upgraded, idle: true })).toBe(true);
  expect(shouldRestartServer({ spawned, current: same, idle: true })).toBe(false); // not upgraded
  expect(shouldRestartServer({ spawned, current: upgraded, idle: false })).toBe(false); // a turn is running
  expect(shouldRestartServer({ spawned, current: null, idle: true })).toBe(false); // binary missing mid-upgrade
  expect(shouldRestartServer({ spawned: null, current: upgraded, idle: true })).toBe(false); // unix:// or unknown
});

test("spawnedBinary: HOOCODE_BIN with no APP_SERVER, the first word of a stdio APP_SERVER, and nothing for unix://", () => {
  expect(spawnedBinary({ appServer: "", hoocodeBin: "hoocode" })).toBe("hoocode");
  expect(spawnedBinary({ appServer: "stdio:/opt/hoocode/bin/hoocode app-server --x", hoocodeBin: "hoocode" })).toBe(
    "/opt/hoocode/bin/hoocode",
  );
  expect(spawnedBinary({ appServer: "stdio:  hoocode   app-server", hoocodeBin: "other" })).toBe("hoocode");
  expect(spawnedBinary({ appServer: "stdio:", hoocodeBin: "hoocode" })).toBeNull();
  expect(spawnedBinary({ appServer: "unix:///tmp/app.sock", hoocodeBin: "hoocode" })).toBeNull();
});
