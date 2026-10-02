/**
 * What a turn did, boiled down for Discord: a one-line status while it runs
 * and a short footer under the final answer (PRs, commits, files, steps,
 * time, model). Pure: fed app-server items, no Discord or network.
 */
import { code, truncate } from "./format.ts";

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
/** `git commit` prints `[branch abc1234] subject`; `git push` prints `old..new  branch -> branch`. */
const COMMIT_LINE = /^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]/gm;

export class TurnSummary {
  readonly startedAt: number;
  private steps = new Set<string>();
  private failed = 0;
  private current: string | null = null;
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
    this.current = what;
  }

  /** An `item/completed` item. */
  completed(item: any) {
    if (item?.type === "agentMessage") {
      this.scan(item.text);
      return;
    }
    if (!stepLabel(item)) return;
    this.steps.add(item.id);
    if (item.status === "failed" || item.status === "declined" || (item.exitCode ?? 0) !== 0) this.failed++;
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

  /** e.g. "⏳ Working · 4 steps · 1m 20s · bash `bun test`" */
  statusLine(now = Date.now()): string {
    const parts = ["⏳ Working", plural(this.steps.size, "step"), duration(now - this.startedAt)];
    if (this.current) parts.push(this.current);
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

/** Short label for a tool-ish item, or null for messages and reasoning. */
function stepLabel(item: any): string | null {
  switch (item?.type) {
    case "commandExecution":
      return `bash ${code(truncate(String(item.command ?? ""), 60))}`;
    case "fileChange":
      return `edit ${code(truncate(basename(item.changes?.[0]?.path ?? "?"), 60))}`;
    case "dynamicToolCall": {
      const a = item.arguments ?? {};
      const arg = a.command ?? a.path ?? a.file_path ?? a.query ?? a.pattern;
      return arg ? `${item.tool} ${code(truncate(String(arg), 60))}` : String(item.tool);
    }
    case "mcpToolCall":
      return `${item.server}/${item.tool}`;
    case "webSearch":
      return `web search ${code(truncate(String(item.query ?? ""), 60))}`;
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
