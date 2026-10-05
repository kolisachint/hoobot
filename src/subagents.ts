/**
 * Subagent reliability, read from hoocode's dispatch ledger.
 *
 * hoocode appends one line per subagent **attempt** to
 * `<workdir>/.cortexcode/dispatch/ledger.jsonl` and renders it in the TUI as
 * `/subagent-stats`. A bot does not have a TUI, and it cares about the number
 * more than the terminal does: when someone asks why an answer took eleven
 * minutes, this is the only machine-readable reason available.
 *
 * Two rules, because this file is written by another process:
 *
 * - A ledger that is missing, empty, truncated mid-line or hand-edited must
 *   never throw. Every read is best effort; a broken line is skipped and the
 *   rest still counts.
 * - `ledger.jsonl` is telemetry, not truth. If it is absent — an older
 *   hoocode, or a project that never dispatched anything — every function
 *   here reports "nothing known" rather than a zero that reads like a
 *   failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One recorded attempt. Only the fields this file reads are typed. */
export type LedgerAttempt = {
  ts: number;
  task_id: string;
  agent_type: string;
  mode: string;
  status: string;
  ok: boolean;
  duration_ms: number;
  tokens_generated: number;
  error?: string | null;
};

export type SubagentStats = {
  /** False when there is no ledger to read, which is not the same as zero. */
  known: boolean;
  attempts: number;
  /** Attempts that ended `complete` or `partial` — findings the agent can use. */
  usable: number;
  /** `usable / attempts` as 0..1, or null when nothing is known. */
  rate: number | null;
  statuses: Record<string, number>;
  medianMs: number;
  maxMs: number;
  lastFailure: { agent: string; status: string; at: number } | null;
};

const LEDGER = join(".cortexcode", "dispatch", "ledger.jsonl");

/** A worktree-relative path, overridable for tests and odd layouts. */
export function ledgerPath(workdir: string): string {
  return join(workdir, LEDGER);
}

/**
 * Parse a ledger. Unparseable lines are skipped: the file is appended to
 * concurrently, so a partially written line is possible and a reader that
 * refuses the whole file is worse than one that loses a line.
 */
export function parseLedger(text: string): LedgerAttempt[] {
  const attempts: LedgerAttempt[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object" && typeof value.status === "string") {
        attempts.push(value as LedgerAttempt);
      }
    } catch {
      // A truncated or hand-edited line. Skip it and keep the rest.
    }
  }
  return attempts;
}

/** The lower median: with an even count, the smaller of the two middles. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

/**
 * Aggregate the ledger for a workdir, optionally only what happened in the
 * last `windowMs`. A status this build has never heard of is counted, not
 * dropped, so a new outcome cannot quietly become a smaller denominator.
 */
export function subagentStats(workdir: string, windowMs?: number): SubagentStats {
  const empty: SubagentStats = {
    known: false,
    attempts: 0,
    usable: 0,
    rate: null,
    statuses: {},
    medianMs: 0,
    maxMs: 0,
    lastFailure: null,
  };
  const path = ledgerPath(workdir);
  if (!existsSync(path)) return empty;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return empty;
  }
  const cutoff = windowMs ? Date.now() - windowMs : null;
  const attempts = parseLedger(text).filter((a) => !cutoff || Number(a.ts) >= cutoff);
  if (attempts.length === 0) return { ...empty, known: true };

  const statuses: Record<string, number> = {};
  const durations: number[] = [];
  let usable = 0;
  let lastFailure: SubagentStats["lastFailure"] = null;
  for (const attempt of attempts) {
    statuses[attempt.status] = (statuses[attempt.status] ?? 0) + 1;
    durations.push(Number(attempt.duration_ms) || 0);
    if (attempt.ok) usable += 1;
    else if (!lastFailure || Number(attempt.ts) > lastFailure.at) {
      lastFailure = {
        agent: attempt.agent_type || "unknown",
        status: attempt.status || "unknown",
        at: Number(attempt.ts) || 0,
      };
    }
  }
  return {
    known: true,
    attempts: attempts.length,
    usable,
    rate: usable / attempts.length,
    statuses,
    medianMs: median(durations),
    maxMs: durations.reduce((max, value) => Math.max(max, value), 0),
    lastFailure,
  };
}

/**
 * `41s`, `3m12s`, `1h04m` — the ledger's durations, for humans. Below a minute
 * it stays in seconds; a subagent median of `0m41s` reads like a mistake.
 */
export function humanMs(ms: number): string {
  if (!ms || ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
  return `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0")}m`;
}

/**
 * One line for a chat message, or null when there is nothing worth saying.
 * A missing ledger returns null on purpose: "0 of 0 subagents worked" would
 * read as a failure to anyone who asked.
 */
export function subagentLine(workdir: string, windowMs?: number): string | null {
  const stats = subagentStats(workdir, windowMs);
  if (!stats.known || stats.attempts === 0) return null;
  const percent = Math.round((stats.rate ?? 0) * 100);
  let line = `Subagents: ${stats.usable}/${stats.attempts} usable (${percent}%), median ${humanMs(stats.medianMs)}`;
  if (stats.lastFailure) {
    line += `, last failure: ${stats.lastFailure.agent} ${stats.lastFailure.status}`;
  }
  return line;
}