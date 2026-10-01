/**
 * One Discord thread ⇄ one app-server thread. Translates Codex app-server
 * notifications into Discord messages and approval requests into buttons.
 * Uses only standard Codex methods, so it works against `hoocode app-server`
 * and the real `codex app-server` alike.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  StringSelectMenuBuilder,
  type Message,
} from "discord.js";
import { config } from "./config.ts";
import { code, describeTool, splitMessage, truncate } from "./format.ts";
import { CodexClient, RpcError, userInput, type Notification, type RequestId, type ServerRequest } from "./codex-client.ts";
import type { LinkStore } from "./links.ts";
import { TurnSummary } from "./summary.ts";

/** The bits of a Discord thread this file uses (tests pass a fake). */
export interface ThreadLike {
  id: string;
  /** Resolves to a message with `edit` and `delete`. */
  send(content: any): Promise<any>;
  sendTyping(): Promise<unknown>;
}

type ToolLine = { id: string; text: string; state: "running" | "ok" | "error" | "declined" };

type Approval = { msg: Message | null; title: string; resolved: boolean };

export class ThreadSession {
  private threadId: string | null = null;
  private turnId: string | null = null;
  private tools: ToolLine[] = [];
  private progressMsg: Message | null = null;
  private progressDirty = false;
  private progressTimer: ReturnType<typeof setInterval>;
  /** Show every tool step and in-between message (`!verbose`). Off: status line + final answer. */
  private verbose = false;
  /** The running turn's summary and its status-line message. */
  private live: { summary: TurnSummary; msg: Message | null; at: number } | null = null;
  /** Latest agent message of the running turn; posted when the turn ends. */
  private answer: string | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private approvals = new Map<RequestId, Approval>();
  /** The model the server reports for the thread. */
  private model: string | null = null;
  /** The model picked for this Discord thread (`!model`), saved in the link. */
  private chosenModel: string | null = null;
  /** Serialises Discord sends so replies stay in order. */
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | null = null;
  private closed = false;

  constructor(
    readonly thread: ThreadLike,
    private readonly client: CodexClient,
    private readonly links: LinkStore,
    private onClose: (threadId: string) => void,
    /** The folder this thread works in (for `!status`). */
    readonly workdir = config.workdir,
  ) {
    client.on("notification", this.onNotification);
    client.on("request", this.onRequest);
    this.progressTimer = setInterval(() => this.flushProgress(), 1500);
    this.touch();
  }

  private get linkKey() {
    return `discord:${this.thread.id}`;
  }

  get busy() {
    return this.turnId !== null;
  }

  /** Resume the linked thread, or start a new one. Idempotent. */
  private ensureThread(): Promise<void> {
    this.ready ??= (async () => {
      const link = this.links.get(this.linkKey);
      this.chosenModel = link?.model ?? null;
      if (link) {
        try {
          const res = await this.client.request("thread/resume", { threadId: link.threadId });
          this.adopt(res);
          return;
        } catch (err) {
          console.error(`[${this.thread.id}] resume ${link.threadId} failed; starting fresh`, err);
          await this.post(`Couldn't reopen the earlier conversation (${code(errorText(err))}). Starting a new one.`);
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
    this.links.set(this.linkKey, { threadId: this.threadId, ...(this.chosenModel ? { model: this.chosenModel } : {}) });
  }

  private adopt(res: any) {
    this.threadId = res.thread.id;
    this.model = res.model ?? null;
    // A turn still running on the server (e.g. after a bot restart).
    const running = (res.thread.turns ?? []).findLast?.((t: any) => t.status === "inProgress");
    this.turnId = null;
    if (running) this.beginTurn(running.id);
  }

  // ── Input from Discord ─────────────────────────────────────────────────────

  async prompt(text: string, images: { data: string; mimeType: string }[] = []) {
    this.touch();
    await this.ensureThread();
    const input = userInput(text, images);
    // One turn at a time: while one runs, the message steers it.
    if (this.turnId) {
      try {
        await this.client.request("turn/steer", { threadId: this.threadId, input, expectedTurnId: this.turnId });
        await this.post("Queued. It'll be read after the current step.");
        return;
      } catch (err) {
        // The turn ended in the meantime: start a new one below.
        if (!(err instanceof RpcError)) throw err;
      }
    }
    try {
      const params: Record<string, unknown> = { threadId: this.threadId, input };
      // Sent every turn: the server ignores it when it's already the model,
      // and it survives a bot restart or a server that forgot it.
      if (this.chosenModel) params.model = this.chosenModel;
      const res = await this.client.request("turn/start", params);
      if (this.chosenModel) this.model = this.chosenModel;
      this.beginTurn(res.turn.id);
    } catch (err) {
      await this.post(`**Not sent:** ${errorText(err)}`);
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
      await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    }
    if (this.threadId) await this.client.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => {});
    this.turnId = null;
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
    const shown = models.slice(0, 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("model")
      .setPlaceholder("Pick a model")
      .addOptions(
        shown.map((m) => ({
          label: truncate(m.label, 100),
          value: m.value.slice(0, 100),
          description: m.label === m.value ? undefined : truncate(m.value, 100),
          default: m.value === current || m.value.endsWith(`/${current}`),
        })),
      );
    const more = models.length > shown.length ? `\nShowing ${shown.length} of ${models.length}; narrow it with \`!model <part of name>\`.` : "";
    const title = `**Model:** ${code(current ?? "default")}. Pick one for this thread (from the next message):${more}`;
    const msg = (await this.enqueue(() =>
      this.thread.send({ content: title, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] }),
    )) as Message;
    try {
      const pick = await msg.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: 5 * 60_000,
        filter: async (i) => {
          if (config.allowedUserIds.has(i.user.id)) return true;
          await i.reply({ content: "Only allowed users can change the model.", ephemeral: true }).catch(() => {});
          return false;
        },
      });
      const name = pick.values[0]!;
      this.applyModel(name);
      await pick.update({ content: modelSetText(name), components: [] });
    } catch {
      await msg.edit({ content: `**Model:** ${code(this.chosenModel ?? this.model ?? "default")} (not changed)`, components: [] }).catch(() => {});
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
    if (this.threadId) this.client.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => {});
    this.dispose();
  }

  // ── Output to Discord ──────────────────────────────────────────────────────

  private beginTurn(turnId: string) {
    if (this.turnId === turnId) return;
    this.turnId = turnId;
    this.tools = [];
    this.progressMsg = null;
    this.live = { summary: new TurnSummary(), msg: null, at: 0 };
    this.answer = null;
    this.startTyping();
  }

  private onNotification = (n: Notification) => {
    const p = n.params ?? {};
    if (p.threadId !== undefined && p.threadId !== this.threadId) return;
    if (n.method === "thread/started" && p.thread?.id !== this.threadId) return;
    this.handleNotification(n).catch((err) => console.error(`[${this.thread.id}] event error`, err));
  };

  private async handleNotification({ method, params: p }: Notification) {
    switch (method) {
      case "turn/started":
        this.beginTurn(p.turn.id);
        break;

      case "turn/completed": {
        if (p.turn.id !== this.turnId) break;
        this.turnId = null;
        this.stopTyping();
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
          for (const chunk of splitMessage(item.text)) await this.post(chunk);
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

    const footer = status?.summary.footer(this.model) ?? "";
    const parts: string[] = [];
    if (answer) parts.push(answer);
    if (turn.status === "failed") {
      parts.push(`**Error:**\n${"```"}\n${truncate(turn.error?.message ?? "the turn failed", 1500)}\n${"```"}`);
    } else if (!answer && !this.verbose && turn.status === "completed") {
      parts.push("Done.");
    }
    if (parts.length) {
      const chunks = splitMessage(parts.join("\n\n"));
      const last = chunks.length - 1;
      if (footer && chunks[last]!.length + footer.length + 1 <= 2000) chunks[last] += `\n${footer}`;
      else if (footer) chunks.push(footer);
      for (const chunk of chunks) await this.post(chunk);
    } else if (footer && !this.verbose && turn.status !== "interrupted") {
      await this.post(footer);
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
    if (now - status.summary.startedAt < 4000 || now - status.at < 3000) return;
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
    const body = lines.join("\n").slice(-1900);
    await this.enqueue(async () => {
      if (this.progressMsg) await this.progressMsg.edit(body).catch(() => {});
      else this.progressMsg = await this.thread.send(body);
    });
  }

  // ── Approvals ──────────────────────────────────────────────────────────────

  private onRequest = (r: ServerRequest) => {
    if (r.params?.threadId !== this.threadId) return;
    this.handleRequest(r).catch((err) => console.error(`[${this.thread.id}] request error`, err));
  };

  private async handleRequest(r: ServerRequest) {
    if (r.method !== "item/commandExecution/requestApproval" && r.method !== "item/fileChange/requestApproval") {
      // Not something Discord can answer; say no rather than leave it hanging.
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
    const options = [
      { label: "Allow once", decision: "accept", style: ButtonStyle.Success },
      { label: "Deny", decision: "decline", style: ButtonStyle.Danger },
    ];
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      options.map((o, i) => new ButtonBuilder().setCustomId(`ui:${i}`).setLabel(o.label).setStyle(o.style)),
    );
    const msg = (await this.enqueue(() => this.thread.send({ content: title.slice(0, 1800), components: [row] }))) as Message;
    approval.msg = msg;
    this.stopTyping();
    if (approval.resolved) {
      // Answered elsewhere while we were sending.
      await this.markResolved(approval, "**Answered elsewhere.**");
      return;
    }
    try {
      const click = await msg.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: config.approvalTimeoutMs,
        filter: async (i) => {
          if (config.allowedUserIds.has(i.user.id)) return true;
          await i.reply({ content: "Only allowed users can answer this.", ephemeral: true }).catch(() => {});
          return false;
        },
      });
      if (approval.resolved) {
        await click.update({ content: `${title.slice(0, 1800)}\n→ **Answered elsewhere.**`, components: [] }).catch(() => {});
        return;
      }
      const chosen = options[Number(click.customId.split(":")[1])]!;
      approval.resolved = true;
      this.client.respond(r.id, { decision: chosen.decision });
      await click.update({ content: `${title.slice(0, 1800)}\n→ **${chosen.label}** by ${click.user.username}`, components: [] });
    } catch {
      if (approval.resolved) return;
      approval.resolved = true;
      this.client.respond(r.id, { decision: "decline" });
      await this.markResolved(approval, "**No answer, denied.**");
    }
    if (this.turnId) this.startTyping();
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
    await approval.msg?.edit({ content: `${approval.title.slice(0, 1800)}\n→ ${note}`, components: [] }).catch(() => {});
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private post(text: string) {
    if (!text.trim()) return Promise.resolve();
    return this.enqueue(() => this.thread.send(text)).catch((err) => console.error(`[${this.thread.id}] send failed`, err));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private startTyping() {
    if (this.typingTimer) return;
    this.thread.sendTyping().catch(() => {});
    this.typingTimer = setInterval(() => this.thread.sendTyping().catch(() => {}), 8000);
  }

  private stopTyping() {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
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
    clearInterval(this.progressTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
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
