import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { humanMs, ledgerPath, parseLedger, subagentLine, subagentStats } from "../src/subagents.ts";

let workdir: string;

/** A workdir with a dispatch ledger holding these attempts. */
function withLedger(lines: unknown[]) {
  const path = ledgerPath(workdir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    ts: 1_700_000_000_000,
    task_id: "dispatch-1",
    agent_type: "explore",
    mode: "blocking",
    status: "complete",
    ok: true,
    duration_ms: 30_000,
    tokens_generated: 4000,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "hoobot-subagents-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

test("a missing ledger reports unknown, not zero", () => {
  const stats = subagentStats(workdir);
  expect(stats.known).toBe(false);
  expect(stats.attempts).toBe(0);
  expect(stats.rate).toBeNull();
  // Nothing is worth saying to a human here.
  expect(subagentLine(workdir)).toBeNull();
});

test("an empty ledger is known and still empty", () => {
  mkdirSync(dirname(ledgerPath(workdir)), { recursive: true });
  writeFileSync(ledgerPath(workdir), "");
  const stats = subagentStats(workdir);
  expect(stats.known).toBe(true);
  expect(stats.attempts).toBe(0);
  expect(subagentLine(workdir)).toBeNull();
});

test("usable attempts are the ones that produced findings", () => {
  withLedger([
    attempt({ status: "complete", duration_ms: 24_000 }),
    attempt({ status: "partial", ok: true, duration_ms: 49_000 }),
    attempt({ status: "timeout", ok: false, duration_ms: 600_000, ts: 1_700_000_100_000 }),
  ]);
  const stats = subagentStats(workdir);
  expect(stats.attempts).toBe(3);
  expect(stats.usable).toBe(2);
  expect(stats.rate).toBeCloseTo(2 / 3);
  expect(stats.statuses).toEqual({ complete: 1, partial: 1, timeout: 1 });
  expect(stats.medianMs).toBe(49_000);
  expect(stats.maxMs).toBe(600_000);
  expect(stats.lastFailure).toEqual({ agent: "explore", status: "timeout", at: 1_700_000_100_000 });
});

test("an unknown status is counted, never dropped", () => {
  withLedger([attempt({ status: "reticulate-splines", ok: false })]);
  const stats = subagentStats(workdir);
  expect(stats.attempts).toBe(1);
  expect(stats.usable).toBe(0);
  expect(stats.statuses.reticulate_splines ?? stats.statuses["reticulate-splines"]).toBe(1);
});

test("a truncated line is skipped and the rest still counts", () => {
  const path = ledgerPath(workdir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      JSON.stringify(attempt()),
      '{"ts":2,"task_id":"b","agent_ty', // killed mid-write
      JSON.stringify(attempt({ status: "stalled", ok: false })),
    ].join("\n"),
  );
  const stats = subagentStats(workdir);
  expect(stats.attempts).toBe(2);
  expect(stats.usable).toBe(1);
  expect(stats.statuses.stalled).toBe(1);
});

test("rubbish in the file does not throw", () => {
  expect(parseLedger("not json\n[]\n\nnull\n42")).toEqual([]);
  expect(parseLedger("")).toEqual([]);
});

test("a window excludes older attempts", () => {
  // Comfortably outside the window rather than exactly on its edge: an attempt
  // whose `ts` equals the cutoff counts as inside it, and millisecond clock
  // granularity makes that boundary a coin flip.
  const old = Date.now() - 2 * 60 * 60 * 1000;
  withLedger([
    attempt({ ts: old, status: "timeout", ok: false }),
    attempt({ ts: Date.now() - 1000, status: "complete", ok: true }),
  ]);
  expect(subagentStats(workdir).attempts).toBe(2);
  const windowed = subagentStats(workdir, 60 * 60 * 1000);
  expect(windowed.attempts).toBe(1);
  expect(windowed.usable).toBe(1);
});

test("the chat line reads like a sentence and names the last failure", () => {
  withLedger([
    attempt({ duration_ms: 41_000 }),
    attempt({ status: "timeout", ok: false, duration_ms: 600_000, ts: 1_700_000_100_000 }),
  ]);
  // 41s and 10m00s: the lower median, and seconds below a minute.
  expect(subagentLine(workdir)).toBe(
    "Subagents: 1/2 usable (50%), median 41s, last failure: explore timeout",
  );
});

test("durations read the way a person would say them", () => {
  expect(humanMs(0)).toBe("0s");
  expect(humanMs(41_000)).toBe("41s");
  expect(humanMs(192_000)).toBe("3m12s");
  expect(humanMs(3_840_000)).toBe("1h04m");
});

test("a rewritten ledger is re-read, not served from the cache", () => {
  withLedger([attempt()]);
  expect(subagentStats(workdir).attempts).toBe(1);
  withLedger([attempt(), attempt({ status: "timeout", ok: false })]);
  expect(subagentStats(workdir).attempts).toBe(2);
});
