/**
 * One chat space (a Discord or Slack channel or thread) ⇄ one app-server
 * thread. Translates Codex app-server notifications into chat messages and
 * approval requests into buttons. Knows nothing about Discord or Slack
 * itself: it talks to a `ChatSpace` (src/chat.ts).
 * Uses only standard Codex methods, so it works against `hoocode app-server`
 * and the real `codex app-server` alike.
 */
import { config, statusDelayFor } from "./config.ts";
import { error, log, warn } from "./log.ts";
import type { ChatSpace, Choice, Posted } from "./chat.ts";
import { idOrder } from "./context.ts";
import { code, describeTool, splitMessage, truncate } from "./format.ts";
import { CodexClient, RpcError, userInput, type Notification, type RequestId, type ServerRequest } from "./codex-client.ts";
import type { LinkStore } from "./links.ts";
import { TurnSummary } from "./summary.ts";
import { subagentLine } from "./subagents.ts";
import {
  changedSince,
  claimChanged,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  pathsInText,
  pickAttachments,
  turnLog,
  type Attachment,
} from "./attachments.ts";

type ToolLine = { id: string; text: string; state: "running" | "ok" | "error" | "declined" };

type Approval = { msg: Posted | null; title: string; resolved: boolean };

export class ThreadSession {
  private threadId: string | null = null;
  private turnId: string | null = null;
  private tools: ToolLine[] = [];
  private progressMsg: Posted | null = null;
  private progressDirty = false;
  private progressTimer: ReturnType<typeof setInterval>;
  /** Show every tool step and in-between message (`!verbose`). Off: status line + final answer. */
  private verbose = false;
  /** The running turn's summary and its status-line message. */
  private live: { summary: TurnSummary; msg: Posted | null; at: number } | null = null;
  /** Latest agent message of the running turn; posted when the turn ends. */
  private answer: string | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  /** Calls accepted by `beginCall` whose `endCall` hasn't run: each one is still working. */
  private pendingCalls = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires when a running turn has said nothing for too long. */
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the running turn last reported anything, for `/healthz`. */
  private turnStartedAt = 0;
  private lastTurnEventAt = 0;
  private approvals = new Map<RequestId, Approval>();
  /** The model the server reports for the thread. */
  private model: string | null = null;
  /** The model picked for this space (`!model`), saved in the link. */
  private chosenModel: string | null = null;
  /** Last chat message the conversation has read; saved in the link. */
  private seenId: string | null = null;
  /** Whether the space had a conversation before this session opened. */
  private wasLinked = false;
  /** The message that started the running turn; the answer replies to it. */
  private caller: { id: string } | null = null;
  /** Serialises chat sends so replies stay in order. */
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | null = null;
  private closed = false;

  constructor(
    readonly thread: ChatSpace,
    private readonly client: CodexClient,
    private readonly links: LinkStore,
    private onClose: (threadId: string) => void,
    /** The folder this thread works in (for `!status`, and files to attach). */
    readonly workdir = config.workdir,
  ) {
    client.on("notification", this.onNotification);
    client.on("request", this.onRequest);
    this.progressTimer = setInterval(() => this.flushProgress(), 1500);
    this.touch();
  }

  private get linkKey() {
    return `${this.thread.surface}:${this.thread.id}`;
  }

  get busy() {
    return this.turnId !== null;
  }

  /** How long the running turn has gone without reporting anything. */
  get turnStalledMs(): number {
    if (!this.turnId || !this.lastTurnEventAt) return 0;
    return Date.now() - this.lastTurnEventAt;
  }

  /** When the running turn began (epoch ms), or 0 when idle. */
  get turnAgeMs(): number {
    return this.turnId && this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
  }

  /** Resume the linked thread, or start a new one. Idempotent. */
  private ensureThread(): Promise<void> {
    this.ready ??= (async () => {
      const link = this.links.get(this.linkKey);
      this.chosenModel = link?.model ?? null;
      this.seenId = link?.seen ?? null;
      this.wasLinked = !!link;
      if (link) {
        try {
          const res = await this.client.request("thread/resume", { threadId: link.threadId });
          this.adopt(res);
          return;
        } catch (err) {
          error(`[${this.thread.id}] resume ${link.threadId} failed; starting fresh`, err);
          await this.post(`Couldn't reopen the earlier conversation (${code(errorText(err))}). Starting a new one.`);
          this.seenId = null;
          this.wasLinked = false;
        }
      }
      await this.startThread();
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private async startThread() {
    const params: Record<string, unknown> = {};
    const model = this.chosenModel ?? config.model;
    if (model) params.model = model;
    const res = await this.client.request("thread/start", params);
    this.adopt(res);
    this.saveLink();
  }

  private saveLink() {
    if (!this.threadId) return;
    this.links.set(this.linkKey, {
      threadId: this.threadId,
      ...(this.chosenModel ? { model: this.chosenModel } : {}),
      ...(this.seenId ? { seen: this.seenId } : {}),
    });
  }

  /** Read position for context: whether the space had a conversation, and its last read message. */
  async readState(): Promise<{ linked: boolean; seen: string | null }> {
    await this.ensureThread();
    return { linked: this.wasLinked, seen: this.seenId };
  }

  /** Everything up to `messageId` has been sent to the conversation. */
  markSeen(messageId: string) {
    if (this.seenId && idOrder(this.seenId, messageId) >= 0) return;
    this.seenId = messageId;
    this.wasLinked = true;
    this.saveLink();
  }

  private adopt(res: any) {
    this.threadId = res.thread.id;
    this.model = res.model ?? null;
    // A turn still running on the server (e.g. after a bot restart).
    const running = (res.thread.turns ?? []).findLast?.((t: any) => t.status === "inProgress");
    this.clearTurn();
    if (running) this.beginTurn(running.id);
  }

  // ── Input from chat ────────────────────────────────────────────────────────

  /**
   * `caller`: the chat message this answers; the final answer replies to it.
   * Resolves true when the server took the message (a new turn or a steer).
   */
  async prompt(text: string, images: { data: string; mimeType: string }[] = [], caller?: { id: string }): Promise<boolean> {
    this.touch();
    await this.ensureThread();
    const input = userInput(text, images);
    // One turn at a time: while one runs, the message steers it.
    if (this.turnId) {
      try {
        await this.client.request("turn/steer", { threadId: this.threadId, input, expectedTurnId: this.turnId });
        await this.post("Queued. It'll be read after the current step.");
        return true;
      } catch (err) {
        // The turn ended in the meantime: start a new one below.
        if (!(err instanceof RpcError)) throw err;
      }
    }
    try {
      const params: Record<string, unknown> = { threadId: this.threadId, input };
      // Sent every turn: the server ignores it when it's already the model,
      // and it survives a bot restart or a server that forgot it.
      // `config.model` counts too: MODEL is the bot's default, and a thread
      // resumed from an older link keeps the model it was started with, so
      // without this a changed MODEL would only reach new threads.
      const want = this.chosenModel ?? config.model;
      if (want) params.model = want;
      const res = await this.client.request("turn/start", params);
      if (want) this.model = want;
      this.beginTurn(res.turn.id);
      this.caller = caller ?? null;
      return true;
    } catch (err) {
      await this.post(`**Not sent:** ${errorText(err)}`);
      return false;
    }
  }

  async abort() {
    if (!this.turnId || !this.threadId) {
      await this.post("Nothing is running.");
      return;
    }
    try {
      await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
      await this.post("**Stopped.**");
    } catch (err) {
      await this.post(`**Could not stop:** ${errorText(err)}`);
    }
  }

  async newSession() {
    if (this.turnId && this.threadId) {
      // Not silent: a failed interrupt means the old turn keeps burning tokens
      // while the user believes the conversation was reset.
      await this.client
        .request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId })
        .catch((err) => warn(`[${this.thread.id}] interrupt before reset failed: ${errorText(err)}`));
    }
    if (this.threadId) await this.client.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => {});
    this.clearTurn();
    turnLog.end(this.workdir, this.linkKey);
    // The old turn's turn/completed will never match again, so nothing else
    // would stop its indicator.
    this.stopTypingIfIdle();
    // The new conversation knows nothing: the next call reads the last 30 again.
    this.seenId = null;
    this.wasLinked = false;
    this.ready = this.startThread();
    try {
      await this.ready;
      await this.post("**New session.** Earlier messages are forgotten.");
    } catch (err) {
      this.ready = null;
      await this.post(`**Failed:** ${errorText(err)}`);
    }
  }

  async status() {
    await this.ensureThread();
    const lines = [
      "**Status**",
      `- Model: ${code(this.chosenModel ?? this.model ?? "default")}${this.chosenModel && this.chosenModel !== this.model ? " (from the next message)" : ""}`,
      `- Busy: ${this.turnId ? "yes" : "no"}`,
      `- Folder: ${code(this.workdir)}`,
      `- Thread: ${code(this.threadId ?? "none")}`,
      `- Server: ${code(this.client.endpoint)}`,
    ];
    // Only when this project has a dispatch ledger: a missing ledger means
    // nothing is known, and "0 of 0" would read like a failure.
    const subagents = subagentLine(this.workdir);
    if (subagents) lines.push(`- ${subagents}`);
    await this.post(lines.join("\n"));
  }

  /**
   * `!model` → a dropdown of the server's models (hoocode: your
   * `enabledModels` scope). `!model kimi` → that model if one matches,
   * else a dropdown of the matches. Takes effect from the next message;
   * the conversation carries on.
   */
  async chooseModel(query = "") {
    await this.ensureThread();
    let models: ModelChoice[];
    try {
      models = await this.listModels(query !== "");
    } catch (err) {
      await this.post(`**Can't list models:** ${errorText(err)}`);
      return;
    }
    const q = query.toLowerCase();
    if (q) {
      const exact = models.find((m) => m.value.toLowerCase() === q || m.value.toLowerCase().endsWith(`/${q}`));
      if (exact) return this.setModel(exact.value);
      const matches = models.filter((m) => m.value.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
      if (matches.length === 1) return this.setModel(matches[0]!.value);
      if (matches.length === 0) {
        await this.post(`No model matches ${code(query)}. Send \`!model\` for the list.`);
        return;
      }
      // Scoped models first.
      models = [...matches.filter((m) => !m.hidden), ...matches.filter((m) => m.hidden)];
    }
    if (models.length === 0) {
      await this.post("The server lists no models.");
      return;
    }
    const current = this.chosenModel ?? this.model;
    const shown = models.slice(0, this.thread.maxChoices);
    const choices: Choice[] = shown.map((m) => ({
      label: truncate(m.label, 75),
      value: m.value.slice(0, 100),
      description: m.label === m.value ? undefined : truncate(m.value, 75),
      default: m.value === current || m.value.endsWith(`/${current}`),
    }));
    const more = models.length > shown.length ? `\nShowing ${shown.length} of ${models.length}; narrow it with \`!model <part of name>\`.` : "";
    const title = `**Model:** ${code(current ?? "default")}. Pick one for this thread (from the next message):${more}`;
    const { msg, pick } = await this.enqueue(() => this.thread.choose(title, "menu", choices, 5 * 60_000, "Pick a model"));
    try {
      const picked = await pick;
      this.applyModel(picked.value);
      await picked.update(modelSetText(picked.value));
    } catch {
      await msg.edit(`**Model:** ${code(this.chosenModel ?? this.model ?? "default")} (not changed)`).catch(() => {});
    }
  }

  private async setModel(name: string) {
    this.applyModel(name);
    await this.post(modelSetText(name));
  }

  private applyModel(name: string) {
    this.chosenModel = name;
    this.saveLink();
  }

  /** All pages of `model/list`. */
  private async listModels(includeHidden: boolean): Promise<ModelChoice[]> {
    const out: ModelChoice[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res: any = await this.client.request("model/list", { includeHidden, ...(cursor ? { cursor } : {}) });
      for (const m of res?.data ?? []) {
        const value = String(m.model ?? m.id);
        out.push({ value, label: String(m.displayName || value), hidden: !!m.hidden });
      }
      cursor = res?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return includeHidden ? out : out.filter((m) => !m.hidden);
  }

  /** Toggle the step-by-step view for this thread. */
  async toggleVerbose() {
    this.verbose = !this.verbose;
    await this.post(
      this.verbose
        ? "**Verbose on:** every step and message is shown. `!verbose` again to turn it off."
        : "**Verbose off:** a status line while working, then the final answer.",
    );
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.threadId) {
      // Fire-and-forget, but not silent: unsubscribe failing means the server
      // keeps pushing this thread's events at a client that has let go.
      this.client
        .request("thread/unsubscribe", { threadId: this.threadId })
        .catch((err) => warn(`[${this.thread.id}] unsubscribe on close failed: ${errorText(err)}`));
    }
    this.dispose();
  }

  // ── Output to chat ─────────────────────────────────────────────────────────

  /**
   * The turn is over, however it ended: completed, interrupted, or given up
   * on. Every path that drops `turnId` goes through here, so the stall timer
   * can never outlive the turn it was watching — which would fire later and
   * clear a *different* turn's flag.
   */
  private clearTurn() {
    this.turnId = null;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    this.lastTurnEventAt = 0;
  }

  private beginTurn(turnId: string) {
    if (this.turnId === turnId) return;
    // Set last, and defensively: this flag is what "busy" means everywhere, so
    // a throw between here and the end used to leave the session permanently
    // busy — every later message queued behind a turn that never existed.
    turnLog.begin(this.workdir, this.linkKey);
    this.tools = [];
    this.progressMsg = null;
    this.live = { summary: new TurnSummary(), msg: null, at: 0 };
    this.answer = null;
    try {
      this.startTyping();
    } catch (err) {
      warn(`[${this.thread.id}] typing indicator failed to start: ${errorText(err)}`);
    }
    this.turnId = turnId;
    this.turnStartedAt = Date.now();
    this.lastTurnEventAt = Date.now();
    this.armStallTimer();
  }

  private onNotification = (n: Notification) => {
    const p = n.params ?? {};
    if (p.threadId !== undefined && p.threadId !== this.threadId) return;
    if (n.method === "thread/started" && p.thread?.id !== this.threadId) return;
    // Any event for our turn counts as progress, so a long but healthy turn
    // is never mistaken for a wedged one.
    if (this.turnId) {
      this.lastTurnEventAt = Date.now();
      this.armStallTimer();
    }
    this.handleNotification(n).catch((err) => error(`[${this.thread.id}] event error`, err));
  };

  /**
   * Give up on a turn that has stopped reporting.
   *
   * The request deadline in the client covers a call that gets no *reply*,
   * but a turn is not one call: it answers `turn/start` immediately and then
   * streams events. If the stream dies mid-turn, nothing ever times out, and
   * because `turnId` is only cleared by `turn/completed`, the session stays
   * busy forever — silently swallowing every later message in the thread.
   * That was the morning's failure exactly.
   *
   * So the turn carries its own deadline, measured from the last event rather
   * than the start: a genuinely long answer keeps resetting it, and only real
   * silence trips it.
   */
  private armStallTimer() {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (!this.turnId) return;
    this.stallTimer = setTimeout(() => void this.abandonStalledTurn(), config.turnStallMs);
  }

  private async abandonStalledTurn() {
    const turn = this.turnId;
    if (!turn) return;
    const waited = Math.round(this.turnStalledMs / 1000);
    error(`[${this.thread.id}] turn stalled: no event for ${waited}s, giving up on ${turn}`);
    // Clear the busy flag first: everything below is best-effort, and a
    // throw here would leave the session wedged all over again.
    this.clearTurn();
    turnLog.end(this.workdir, this.linkKey);
    this.stopTypingIfIdle();
    this.caller = null;
    this.answer = null;
    await this.post(
      `**Stopped waiting.** The model stopped responding after ${waited}s, so I gave up on that answer. ` +
        "Send the message again and I'll pick it up from here.",
    ).catch(() => {});
    // Ask the server to stop burning tokens on a turn nobody is reading.
    await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: turn }, 10_000).catch(() => {});
    this.touch();
  }

  private async handleNotification({ method, params: p }: Notification) {
    switch (method) {
      case "turn/started":
        this.beginTurn(p.turn.id);
        break;

      case "turn/completed": {
        if (p.turn.id !== this.turnId) break;
        this.clearTurn();
        turnLog.end(this.workdir, this.linkKey);
        // A call queued behind this turn may still be in its preamble.
        this.stopTypingIfIdle();
        await this.flushProgress();
        await this.finishTurn(p.turn);
        this.touch();
        break;
      }

      case "item/started": {
        this.live?.summary.started(p.item);
        const tool = toolLine(p.item);
        if (tool) {
          this.tools.push(tool);
          this.progressDirty = true;
        }
        break;
      }

      case "item/completed": {
        const item = p.item;
        this.live?.summary.completed(item);
        if (item.type === "agentMessage" && item.text?.trim() && !this.verbose) {
          // Only the last message of the turn is posted (finishTurn).
          this.answer = item.text;
          break;
        }
        if (item.type === "agentMessage" && item.text?.trim()) {
          // Text closes the current tool list; the next tools start a fresh one.
          await this.flushProgress();
          this.progressMsg = null;
          this.tools = [];
          for (const chunk of this.split(item.text)) await this.post(chunk);
          break;
        }
        const t = this.tools.find((x) => x.id === item.id);
        if (t) {
          t.state = item.status === "declined" ? "declined" : item.status === "failed" ? "error" : "ok";
          this.progressDirty = true;
        }
        break;
      }

      case "serverRequest/resolved":
        await this.resolveApproval(p.requestId, null);
        break;
    }
  }

  /**
   * Post the final answer with a footer (PR, commits, files, steps, time,
   * model) and remove the status line. Errors are always posted in full.
   */
  private async finishTurn(turn: any) {
    const status = this.live;
    this.live = null;
    const answer = this.answer;
    this.answer = null;
    const caller = this.caller;
    this.caller = null;

    const footer = status?.summary.footer(this.model) ?? "";
    // Files the model wrote, named in its answer, or that changed in the work
    // folder during the turn (shell output) go back as attachments.
    const { files, skipped } =
      turn.status === "completed" && status
        ? pickAttachments(
            [
              ...status.summary.editedFiles,
              ...pathsInText(answer ?? ""),
              // Whole seconds: some filesystems store mtimes that coarse.
              // A channel and its threads share the folder: when another turn ran
              // there too, only files this turn names are its own.
              ...claimChanged(
                changedSince(this.workdir, Math.floor(status.summary.startedAt / 1000) * 1000),
                this.workdir,
                !turnLog.overlapped(this.workdir, this.linkKey),
                `${answer ?? ""}\n${status.summary.shellText}`,
              ),
            ],
            this.workdir,
          )
        : { files: [], skipped: [] };
    const parts: string[] = [];
    if (answer) parts.push(answer);
    if (turn.status === "failed") {
      parts.push(`**Error:**\n${"```"}\n${truncate(turn.error?.message ?? "the turn failed", 1500)}\n${"```"}`);
    } else if (!answer && !this.verbose && turn.status === "completed") {
      parts.push("Done.");
    }
    if (parts.length) {
      const chunks = this.split(parts.join("\n\n"));
      const last = chunks.length - 1;
      if (footer && chunks[last]!.length + footer.length + 1 <= this.thread.maxLength) chunks[last] += `\n${footer}`;
      else if (footer) chunks.push(footer);
      // The first chunk replies to the message that asked.
      for (const [i, chunk] of chunks.entries()) await this.post(chunk, i === 0 ? caller : null, i === chunks.length - 1 ? files : []);
    } else if (footer && !this.verbose && turn.status !== "interrupted") {
      await this.post(footer, caller, files);
    } else if (files.length) {
      await this.post("Files:", caller, files);
    }
    if (skipped.length) {
      await this.post(`-# Not attached (over ${MAX_FILES} files / ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)} MB per answer): ${skipped.map((s) => code(s)).join(", ")}`);
    }
    // Queued after any in-flight status send, so that message exists by now.
    if (status) await this.enqueue(async () => status.msg?.delete()).catch(() => {});
  }

  /** Throttled: the status line while a turn runs (non-verbose). */
  private async flushStatus() {
    const status = this.live;
    if (!status || this.verbose) return;
    const now = Date.now();
    // Quick answers need no status line; then refresh every 3 s.
    if (now - status.summary.startedAt < statusDelayFor(this.thread.surface) || now - status.at < 3000) return;
    status.at = now;
    const body = status.summary.statusLine(now);
    await this.enqueue(async () => {
      if (this.live !== status) return; // turn ended meanwhile
      if (status.msg) await status.msg.edit(body).catch(() => {});
      else status.msg = await this.thread.send(body);
    }).catch(() => {});
  }

  /** Tool activity as one message, edited in place (throttled). */
  private async flushProgress() {
    if (!this.verbose) return this.flushStatus();
    if (!this.progressDirty || this.tools.length === 0) return;
    this.progressDirty = false;
    // Words, not just symbols, so state doesn't rely on colour or icon shape.
    const label = { running: "⏳ running", ok: "✅ done", error: "❌ failed", declined: "🚫 denied" } as const;
    const lines = this.tools.slice(-15).map((t) => `${label[t.state]} · ${t.text}`);
    const hidden = this.tools.length - 15;
    if (hidden > 0) lines.unshift(`*…${hidden} earlier steps*`);
    const body = lines.join("\n").slice(-(this.thread.maxLength - 100));
    await this.enqueue(async () => {
      if (this.progressMsg) await this.progressMsg.edit(body).catch(() => {});
      else this.progressMsg = await this.thread.send(body);
    });
  }

  // ── Approvals ──────────────────────────────────────────────────────────────

  private onRequest = (r: ServerRequest) => {
    if (r.params?.threadId !== this.threadId) return;
    this.handleRequest(r).catch((err) => error(`[${this.thread.id}] request error`, err));
  };

  private async handleRequest(r: ServerRequest) {
    if (r.method !== "item/commandExecution/requestApproval" && r.method !== "item/fileChange/requestApproval") {
      // Not something a chat can answer; say no rather than leave it hanging.
      this.client.respond(r.id, { decision: "decline" });
      return;
    }
    if (this.approvals.has(r.id)) return;
    const p = r.params;
    const what =
      r.method === "item/commandExecution/requestApproval"
        ? p.command
          ? `bash ${code(truncate(p.command, 300))}`
          : (p.reason ?? "run a command")
        : (p.reason?.replace(/^Allow:\s*/, "") ?? "change files");
    const title = `**Approval needed**\n${what}`;
    const approval: Approval = { msg: null, title, resolved: false };
    this.approvals.set(r.id, approval);

    // No "always" button: it would change hoocode's global config.
    const options: Choice[] = [
      { label: "Allow once", value: "accept", style: "primary" },
      { label: "Deny", value: "decline", style: "danger" },
    ];
    const { msg, pick } = await this.enqueue(() =>
      this.thread.choose(title.slice(0, 1800), "buttons", options, config.approvalTimeoutMs),
    );
    approval.msg = msg;
    this.stopTyping();
    if (approval.resolved) {
      // Answered elsewhere while we were sending.
      await this.markResolved(approval, "**Answered elsewhere.**");
      return;
    }
    try {
      const click = await pick;
      if (approval.resolved) {
        await click.update(`${title.slice(0, 1800)}\n→ **Answered elsewhere.**`).catch(() => {});
        return;
      }
      const chosen = options.find((o) => o.value === click.value) ?? options[1]!;
      approval.resolved = true;
      this.client.respond(r.id, { decision: chosen.value });
      await click.update(`${title.slice(0, 1800)}\n→ **${chosen.label}** by ${click.user}`);
    } catch {
      if (approval.resolved) return;
      approval.resolved = true;
      this.client.respond(r.id, { decision: "decline" });
      await this.markResolved(approval, "**No answer, denied.**");
    }
    if (this.turnId || this.pendingCalls) this.startTyping();
  }

  /** The server says request `id` is settled (answered by any client, or the turn ended). */
  private async resolveApproval(id: RequestId, _: null) {
    const approval = this.approvals.get(id);
    if (!approval) return;
    this.approvals.delete(id);
    if (approval.resolved) return;
    approval.resolved = true;
    if (approval.msg) await this.markResolved(approval, "**Answered elsewhere.**");
  }

  private async markResolved(approval: Approval, note: string) {
    await approval.msg?.edit(`${approval.title.slice(0, 1800)}\n→ ${note}`).catch(() => {});
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Long text in pieces that fit one message. */
  private split(text: string): string[] {
    return splitMessage(text, this.thread.maxLength - 100);
  }

  /** `replyTo`: post as a reply to that message (no ping); plain send if it's gone. */
  private post(text: string, replyTo?: { id: string } | null, files: Attachment[] = []) {
    if (!text.trim()) return Promise.resolve();
    const opts = { replyTo: replyTo?.id ?? null };
    const send = () =>
      !files.length
        ? this.thread.send(text, opts)
        : this.thread.send(text, { ...opts, files }).catch(async (err: unknown) => {
            // e.g. over the upload limit: still post the text.
            error(`[${this.thread.id}] upload failed`, err);
            await this.thread.send(text, opts);
            return this.thread.send(`-# Couldn't attach ${files.map((f) => code(f.name)).join(", ")}: ${errorText(err)}`);
          });
    return this.enqueue(send).catch((err) => error(`[${this.thread.id}] send failed`, err));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * A call was accepted and is about to become a prompt: say “working” now.
   *
   * A turn is only acknowledged after `ensureThread` (a thread/start or resume
   * round trip), reading history, saving attachments and a turn/start round
   * trip — a couple of seconds on a message with files. Starting the indicator
   * here closes that gap. Pair every call with `endCall`.
   */
  beginCall() {
    this.pendingCalls++;
    this.startTyping();
  }

  /**
   * The call from `beginCall` is done, whether or not it became a turn. When
   * it didn't (the preamble threw, or turn/start was refused) there is no
   * turn/completed to stop the indicator, and a bot that failed would look
   * busy forever.
   */
  endCall() {
    this.pendingCalls = Math.max(0, this.pendingCalls - 1);
    this.stopTypingIfIdle();
  }

  private startTyping() {
    if (this.typingTimer || !config.typingIndicator) return;
    // Waiting on a person's click is not working: an approval keeps it off
    // until it's answered, even if another message arrives meanwhile.
    if ([...this.approvals.values()].some((a) => !a.resolved)) return;
    // The typing indicator is decoration: it must never be able to interrupt
    // the turn bookkeeping, so every path into it is guarded.
    const ping = () => this.thread.sendTyping?.().catch(() => {});
    ping();
    this.typingTimer = setInterval(ping, 8000);
  }

  private stopTyping() {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  /** Stop unless a turn runs or an accepted call is still in its preamble. */
  private stopTypingIfIdle() {
    if (!this.turnId && this.pendingCalls === 0) this.stopTyping();
  }

  /** Let go of idle threads; the server keeps them on disk. */
  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.turnId && this.approvals.size === 0) this.close();
      else this.touch();
    }, config.idleTimeoutMs);
  }

  private dispose() {
    turnLog.end(this.workdir, this.linkKey);
    clearInterval(this.progressTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stopTyping();
    this.client.off("notification", this.onNotification);
    this.client.off("request", this.onRequest);
    this.onClose(this.thread.id);
  }
}

type ModelChoice = { value: string; label: string; hidden: boolean };

function modelSetText(name: string): string {
  return `**Model:** ${code(name)} from the next message. The conversation carries on.`;
}

/** A progress line for a tool-ish item, or null for messages. */
function toolLine(item: any): ToolLine | null {
  switch (item?.type) {
    case "commandExecution":
      return { id: item.id, text: describeTool("bash", { command: item.command }), state: "running" };
    case "fileChange": {
      const paths = (item.changes ?? []).map((c: any) => c.path).join(", ");
      return { id: item.id, text: `edit ${code(truncate(paths || "?", 120))}`, state: "running" };
    }
    case "dynamicToolCall":
      return { id: item.id, text: describeTool(item.tool, item.arguments ?? {}), state: "running" };
    case "mcpToolCall":
      return { id: item.id, text: code(`${item.server}/${item.tool}`), state: "running" };
    case "webSearch":
      return { id: item.id, text: `web search ${code(truncate(String(item.query ?? ""), 100))}`, state: "running" };
    default:
      return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
