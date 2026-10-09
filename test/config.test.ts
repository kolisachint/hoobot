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

test("prepareWorkspace writes the tool names hoocode 0.1.12 uses, and rewrites the old lists", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepareWorkspace } = await import("../src/config.ts");
  const saved = config.approvals;
  const dir = mkdtempSync(join(tmpdir(), "hoobot-workspace-"));
  const cfgPath = join(dir, ".cortexcode", "hoo-config.json");
  const allowed = () => JSON.parse(readFileSync(cfgPath, "utf8")).modes.discord.auto_allow;
  try {
    config.approvals = "auto";
    prepareWorkspace(dir);
    expect(allowed()).toEqual(["read", "Read", "bash", "Shell", "edit", "Edit", "write", "Write"]);

    // A file hoobot wrote before the rename is rewritten; a file someone edited is not.
    mkdirSync(join(dir, ".cortexcode"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ active_mode: "discord", modes: { discord: { auto_allow: ["read", "bash", "edit", "write"] } } }, null, 2) + "\n");
    prepareWorkspace(dir);
    expect(allowed()).toEqual(["read", "Read", "bash", "Shell", "edit", "Edit", "write", "Write"]);

    config.approvals = "ask";
    writeFileSync(cfgPath, JSON.stringify({ active_mode: "discord", modes: { discord: { auto_allow: ["mine"] } } }, null, 2) + "\n");
    prepareWorkspace(dir);
    expect(allowed()).toEqual(["mine"]);
  } finally {
    config.approvals = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
