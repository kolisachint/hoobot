import { expect, test } from "bun:test";
import { duration, TurnSummary } from "../src/summary.ts";

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

test("status line counts steps and shows the current one", () => {
  const s = new TurnSummary(0);
  s.started(bash("1", "ls"));
  s.completed(bash("1", "ls"));
  s.started(bash("2", "bun test"));
  expect(s.statusLine(83_000)).toBe("⏳ Working · 2 steps · 1m 23s · bash `bun test`");
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
