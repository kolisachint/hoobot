import { expect, test } from "bun:test";
import { homedir } from "node:os";

process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
// Other test files may have loaded config already, so set the parsed values directly.
const { allWorkdirs, config, parseWorkspaces, workdirFor } = await import("../src/config.ts");

test("WORKSPACES maps channels to folders; others use HOO_WORKDIR", () => {
  const map = parseWorkspaces("111=/tmp/a, 222=~/b");
  expect([...map]).toEqual([["111", "/tmp/a"], ["222", `${homedir()}/b`]]);
  expect(parseWorkspaces("")).toEqual(new Map());

  const saved = { workdir: config.workdir, workspaces: config.workspaces };
  try {
    config.workdir = "/tmp/default";
    config.workspaces = map;
    expect(workdirFor("111")).toBe("/tmp/a");
    expect(workdirFor("333")).toBe("/tmp/default");
    expect(workdirFor(null)).toBe("/tmp/default");
    expect(allWorkdirs()).toEqual(["/tmp/default", "/tmp/a", `${homedir()}/b`]);
  } finally {
    Object.assign(config, saved);
  }
});
