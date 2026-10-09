import { expect, test } from "bun:test";
import { duration, radarChain, TurnSummary, type ToolStep } from "../src/summary.ts";

const bash = (id: string, command: string, out = "", exitCode = 0) => ({
  type: "commandExecution",
  id,
  command,
  status: exitCode === 0 ? "completed" : "failed",
  aggregatedOutput: out,
  exitCode,
});

test("a plain chat turn has no footer", () => {
  const s = new TurnSummary(0);
  s.completed({ type: "agentMessage", id: "m1", text: "Hi there" });
  expect(s.footer("gpt-x", 5_000)).toBe("");
});

test("status line shows the radar chain of tool names and the counts", () => {
  const s = new TurnSummary(0);
  s.started(bash("1", "ls"));
  s.completed(bash("1", "ls"));
  s.started(bash("2", "bun test"));
  expect(s.statusLine(83_000)).toBe("⏳ Working · 1m 23s · Shell › Shell… · 1 done");
});

test("status line before any step is just the clock", () => {
  const s = new TurnSummary(0);
  expect(s.statusLine(5_000)).toBe("⏳ Working · 5s");
});

test("status line never shows command text or arguments", () => {
  const s = new TurnSummary(0);
  s.started(bash("1", "bun test --secret-flag"));
  s.completed(bash("1", "bun test --secret-flag", "boom", 1));
  s.started({ type: "dynamicToolCall", id: "2", tool: "read", arguments: { path: "/w/private/notes.md" } });
  s.started({ type: "fileChange", id: "3", status: "inProgress", changes: [{ path: "/w/src/a.ts" }] });
  const line = s.statusLine(1_000);
  expect(line).toBe("⏳ Working · 1s · Shell✗ › read… › Edit… · 1 done · 1 failed");
  expect(line).not.toContain("bun test");
  expect(line).not.toContain("private");
  expect(line).not.toContain("`");
});

test("status line counts done and failed in words", () => {
  const s = new TurnSummary(0);
  s.started(bash("1", "ls"));
  s.completed(bash("1", "ls"));
  s.started(bash("2", "false"));
  s.completed(bash("2", "false", "", 1));
  expect(s.statusLine(2_000)).toBe("⏳ Working · 2s · Shell › Shell✗ · 2 done · 1 failed");
});

test("status line omits the failed count when nothing failed", () => {
  const s = new TurnSummary(0);
  s.started(bash("1", "ls"));
  s.completed(bash("1", "ls"));
  expect(s.statusLine(2_000)).toBe("⏳ Working · 2s · Shell · 1 done");
});

test("radar collapses consecutive successful repeats", () => {
  const step = (id: string, tool: string, state: ToolStep["state"] = "ok"): ToolStep => ({ id, tool, state });
  expect(radarChain([step("1", "Read"), step("2", "Read"), step("3", "Read"), step("4", "Read")])).toBe("Read ×4");
  expect(radarChain([step("1", "Read"), step("2", "Read"), step("3", "Edit"), step("4", "Read")])).toBe("Read ×2 › Edit › Read");
});

test("radar never merges a failure and marks it with ✗", () => {
  const step = (id: string, tool: string, state: ToolStep["state"]): ToolStep => ({ id, tool, state });
  expect(radarChain([step("1", "Read", "ok"), step("2", "Read", "error"), step("3", "Read", "ok")])).toBe(
    "Read › Read✗ › Read",
  );
  expect(radarChain([step("1", "Read", "error"), step("2", "Read", "error")])).toBe("Read✗ › Read✗");
});

test("radar ends with a running marker", () => {
  const step = (id: string, tool: string, state: ToolStep["state"]): ToolStep => ({ id, tool, state });
  expect(radarChain([step("1", "Read", "ok"), step("2", "Shell", "running")])).toBe("Read › Shell…");
  expect(radarChain([])).toBe("");
});

test("radar elides the middle beyond 8 segments, keeping 3 head and 2 tail", () => {
  const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  const steps: ToolStep[] = names.map((tool, i) => ({ id: String(i), tool, state: "ok" }));
  expect(radarChain(steps)).toBe("A › B › C › … › H › I");
  // Exactly 8 segments are shown in full.
  expect(radarChain(steps.slice(0, 8))).toBe("A › B › C › D › E › F › G › H");
});

test("status line uses the same radar and names MCP and web tools by name", () => {
  const s = new TurnSummary(0);
  s.started({ type: "mcpToolCall", id: "1", server: "github", tool: "search_code", arguments: { q: "secret" } });
  s.completed({ type: "mcpToolCall", id: "1", server: "github", tool: "search_code", status: "completed" });
  s.started({ type: "webSearch", id: "2", query: "bun test runner" });
  expect(s.statusLine(3_000)).toBe("⏳ Working · 3s · github/search_code › WebSearch… · 1 done");
});

test("footer picks up PRs, commits and edited files", () => {
  const s = new TurnSummary(0);
  s.completed(bash("1", "git commit -m x", "[fix/thing 3f2a9c1] fix: thing\n 2 files changed"));
  s.completed(bash("2", "gh pr create", "https://github.com/kolisachint/hoobot/pull/5\n"));
  s.completed({ type: "fileChange", id: "3", status: "completed", changes: [{ path: "/w/src/a.ts" }, { path: "/w/src/b.ts" }] });
  s.completed({ type: "dynamicToolCall", id: "4", tool: "edit", arguments: { path: "/w/README.md" }, success: true });
  s.completed(bash("5", "false", "", 1));
  expect(s.footer("deepseek-v4", 190_000)).toBe(
    "-# [PR #5](<https://github.com/kolisachint/hoobot/pull/5>) · commit `3f2a9c1` · 3 files edited · 5 steps (1 failed) · 3m 10s · `deepseek-v4`",
  );
});

test("PR links in the final message count too, once", () => {
  const s = new TurnSummary(0);
  s.completed(bash("1", "gh pr view", "https://github.com/a/b/pull/9"));
  s.completed({ type: "agentMessage", id: "m", text: "Opened https://github.com/a/b/pull/9" });
  expect(s.footer(null, 1_000)).toBe("-# [PR #9](<https://github.com/a/b/pull/9>) · 1 step · 1s");
});

test("declined edits are not counted as edited", () => {
  const s = new TurnSummary(0);
  s.completed({ type: "fileChange", id: "1", status: "declined", changes: [{ path: "x.ts" }] });
  expect(s.footer(null, 0)).toBe("-# 1 step (1 failed) · 0s");
});

test("duration formats", () => {
  expect(duration(400)).toBe("0s");
  expect(duration(59_000)).toBe("59s");
  expect(duration(3_600_000 + 120_000)).toBe("1h 2m");
});
