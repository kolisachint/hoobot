/**
 * What a turn did, boiled down for Discord: a one-line status while it runs
 * and a short footer under the final answer (PRs, commits, files, steps,
 * time, model). Pure: fed app-server items, no Discord or network.
 */
import { code, truncate } from "./format.ts";

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
/** `git commit` prints `[branch abc1234] subject`; `git push` prints `old..new  branch -> branch`. */
const COMMIT_LINE = /^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]/gm;

export type StepState = "running" | "ok" | "error";

/** One tool call in this turn: its name only, never its arguments. */
export interface ToolStep {
  id: string;
  tool: string;
  state: StepState;
}

export class TurnSummary {
  readonly startedAt: number;
  private steps = new Set<string>();
  private failed = 0;
  /** Every tool call this turn, in order, for the radar status line. */
  private list: ToolStep[] = [];
  private prs = new Set<string>();
  private commits = new Set<string>();
  private files = new Set<string>();
  /** Text of this turn's shell commands and their output (to tell which files it wrote). */
  private shell: string[] = [];

  constructor(now = Date.now()) {
    this.startedAt = now;
  }

  /** Paths of files edited or written this turn, in order. */
  get editedFiles(): string[] {
    return [...this.files];
  }

  /** What this turn's shell commands said, for finding the files they wrote. */
  get shellText(): string {
    return this.shell.join("\n");
  }

  /** An `item/started` item. */
  started(item: any) {
    const what = stepLabel(item);
    if (!what) return;
    this.steps.add(item.id);
    this.list.push({ id: item.id, tool: what, state: "running" });
  }

  /** An `item/completed` item. */
  completed(item: any) {
    if (item?.type === "agentMessage") {
      this.scan(item.text);
      return;
    }
    const what = stepLabel(item);
    if (!what) return;
    this.steps.add(item.id);
    const error = item.status === "failed" || item.status === "declined" || (item.exitCode ?? 0) !== 0;
    if (error) this.failed++;
    const state: StepState = error ? "error" : "ok";
    const open = this.list.findLast((s) => s.id === item.id && s.state === "running");
    if (open) open.state = state;
    else this.list.push({ id: item.id, tool: what, state });
    if (item.type === "commandExecution") {
      this.scan(item.aggregatedOutput);
      this.shell.push(String(item.command ?? ""), String(item.aggregatedOutput ?? ""));
    }
    if (item.type === "fileChange" && item.status !== "declined") {
      for (const c of item.changes ?? []) if (c?.path) this.files.add(c.path);
    }
    if (item.type === "dynamicToolCall" && (item.tool === "edit" || item.tool === "write") && item.success !== false) {
      const path = item.arguments?.path ?? item.arguments?.file_path;
      if (path) this.files.add(String(path));
    }
  }

  /**
   * The live status line: elapsed time, then the radar chain of tool names
   * (no arguments, no commands), then how many calls are done and how many
   * failed. Words, not symbols alone, carry the counts.
   * e.g. "⏳ Working · 1m 20s · Shell ×2 › Read › Edit✗ › Shell… · 4 done · 1 failed"
   */
  statusLine(now = Date.now()): string {
    const parts = ["⏳ Working", duration(now - this.startedAt)];
    if (this.list.length === 0) return parts.join(" · ");
    parts.push(radarChain(this.list));
    parts.push(`${this.list.filter((s) => s.state !== "running").length} done`);
    if (this.failed) parts.push(`${this.failed} failed`);
    return parts.join(" · ");
  }

  /** e.g. "-# PR #5 · commit `abc1234` · 3 files · 12 steps · 3m 10s · `model`", or "" for a bare chat turn. */
  footer(model: string | null, now = Date.now()): string {
    const parts: string[] = [];
    for (const url of this.prs) parts.push(`[PR #${url.split("/").pop()}](<${url}>)`);
    const commits = [...this.commits];
    if (commits.length === 1) parts.push(`commit ${code(commits[0]!.slice(0, 7))}`);
    else if (commits.length > 1) parts.push(`${commits.length} commits`);
    if (this.files.size === 1) parts.push(`edited ${code(truncate(basename([...this.files][0]!), 60))}`);
    else if (this.files.size > 1) parts.push(`${this.files.size} files edited`);
    if (this.steps.size === 0 && parts.length === 0) return "";
    if (this.steps.size) parts.push(plural(this.steps.size, "step") + (this.failed ? ` (${this.failed} failed)` : ""));
    parts.push(duration(now - this.startedAt));
    if (model) parts.push(code(model));
    return `-# ${parts.join(" · ")}`;
  }

  private scan(text: unknown) {
    if (typeof text !== "string" || !text) return;
    for (const m of text.matchAll(PR_URL)) this.prs.add(m[0]);
    for (const m of text.matchAll(COMMIT_LINE)) this.commits.add(m[1]!);
  }
}

/**
 * The radar line for a turn's tool calls, names only: e.g. "grep › read ×4 › bash✗ › edit › bash…".
 * Consecutive successful calls to the same tool collapse to `name ×N`; a failure
 * never merges and ends in ✗; a running call ends in …. More than 8 segments keep
 * the first 3 and last 2 with `…` between. Empty for no steps.
 */
export function radarChain(steps: readonly ToolStep[]): string {
  const segs: string[] = [];
  for (let i = 0; i < steps.length; ) {
    const s = steps[i]!;
    let n = 1;
    if (s.state === "ok") {
      while (i + n < steps.length && steps[i + n]!.state === "ok" && steps[i + n]!.tool === s.tool) n++;
    }
    let seg = n > 1 ? `${s.tool} ×${n}` : s.tool;
    if (s.state === "error") seg += "✗";
    if (s.state === "running") seg += "…";
    segs.push(seg);
    i += n;
  }
  const shown = segs.length > 8 ? [...segs.slice(0, 3), "…", ...segs.slice(-2)] : segs;
  return shown.join(" › ");
}

/** Tool name for a tool-ish item (never its arguments), or null for messages and reasoning. */
function stepLabel(item: any): string | null {
  switch (item?.type) {
    case "commandExecution":
      return "Shell";
    case "fileChange":
      return "Edit";
    case "dynamicToolCall":
      return String(item.tool);
    case "mcpToolCall":
      return `${item.server}/${item.tool}`;
    case "webSearch":
      return "WebSearch";
    default:
      return null;
  }
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
