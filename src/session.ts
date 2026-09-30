/**
 * One hoocode process per Discord thread. Translates RPC events into Discord
 * messages and Discord button clicks into RPC responses.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { join } from "node:path";
import { config } from "./config.ts";
import { assistantText, code, describeTool, splitMessage, truncate } from "./format.ts";
import { HoocodeRpc, type RpcEvent } from "./rpc.ts";

type ToolLine = { id: string; text: string; state: "running" | "ok" | "error" };

export class ThreadSession {
  private rpc: HoocodeRpc;
  private streaming = false;
  private tools: ToolLine[] = [];
  private progressMsg: Message | null = null;
  private progressDirty = false;
  private progressTimer: ReturnType<typeof setInterval>;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialises Discord sends so replies stay in order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly thread: ThreadChannel,
    private onClose: (threadId: string) => void,
  ) {
    // One session dir per thread + --continue: after a bot restart the thread
    // picks up its old conversation instead of starting from scratch.
    const sessionDir = join(config.workdir, ".hoocode", "discord-sessions", thread.id);
    this.rpc = new HoocodeRpc({
      bin: config.hoocodeBin,
      cwd: config.workdir,
      args: ["--session-dir", sessionDir, "--continue", ...config.hoocodeArgs],
    });

    this.rpc.on("event", (e: RpcEvent) => {
      this.handleEvent(e).catch((err) => console.error(`[${thread.id}] event error`, err));
    });
    this.rpc.on("stderr", (text: string) => {
      if (config.debug) process.stderr.write(`[hoocode ${thread.id}] ${text}`);
    });
    this.rpc.on("error", (err: Error) => {
      this.post(`**Error:** could not start hoocode: ${code(err.message)}`);
    });
    this.rpc.on("exit", (exitCode: number | null) => {
      this.stopTyping();
      if (this.streaming) this.post(`**hoocode stopped** (exit code ${exitCode}). Send a message to restart.`);
      this.dispose();
    });

    this.progressTimer = setInterval(() => this.flushProgress(), 1500);
    this.touch();
  }

  // ── Input from Discord ─────────────────────────────────────────────────────

  async prompt(text: string, images: { type: "image"; data: string; mimeType: string }[] = []) {
    this.touch();
    const cmd: Record<string, unknown> = { type: "prompt", message: text };
    if (images.length) cmd.images = images;
    // While a run is in progress, the message steers it instead of failing.
    if (this.streaming) cmd.streamingBehavior = "steer";

    const res = await this.rpc.request(cmd as { type: string });
    if (!res.success) {
      await this.post(`**Not sent:** ${res.error ?? "unknown error"}`);
    } else if (cmd.streamingBehavior) {
      await this.post("Queued. hoocode will read this after its current step.");
    }
  }

  async abort() {
    const res = await this.rpc.request({ type: "abort" });
    await this.post(res.success ? "**Stopped.**" : `**Could not stop:** ${res.error}`);
  }

  async newSession() {
    if (this.streaming) await this.rpc.request({ type: "abort" });
    const res = await this.rpc.request({ type: "new_session" });
    await this.post(res.success ? "**New session.** Earlier messages are forgotten." : `**Failed:** ${res.error}`);
  }

  async status() {
    const res = await this.rpc.request({ type: "get_state" });
    if (!res.success) return this.post(`**Failed:** ${res.error}`);
    const s = res.data ?? {};
    const lines = [
      "**Status**",
      `- Model: ${code(s.model ? `${s.model.provider}/${s.model.id}` : "none")}`,
      `- Thinking: ${code(String(s.thinkingLevel ?? "?"))}`,
      `- Busy: ${s.isStreaming ? "yes" : "no"}`,
      `- Messages: ${s.messageCount ?? 0}`,
      `- Folder: ${code(config.workdir)}`,
    ];
    await this.post(lines.join("\n"));
  }

  async setModel(pattern: string) {
    const [provider, ...rest] = pattern.split("/");
    const cmd = rest.length
      ? { type: "set_model", provider, modelId: rest.join("/") }
      : { type: "set_model", modelId: pattern };
    const res = await this.rpc.request(cmd);
    await this.post(res.success ? `**Model set:** ${code(pattern)}` : `**Failed:** ${res.error}`);
  }

  close() {
    this.rpc.kill();
    this.dispose();
  }

  // ── Output to Discord ──────────────────────────────────────────────────────

  private async handleEvent(e: RpcEvent) {
    switch (e.type) {
      case "agent_start":
        this.streaming = true;
        this.tools = [];
        this.progressMsg = null;
        this.startTyping();
        break;

      case "agent_end":
        this.streaming = false;
        this.stopTyping();
        await this.flushProgress();
        this.touch();
        break;

      case "message_end": {
        const m = e.message;
        if (m?.role !== "assistant") break;
        const text = assistantText(m);
        if (text) {
          // Text arriving closes the current tool list; the next tools start a fresh one.
          await this.flushProgress();
          this.progressMsg = null;
          this.tools = [];
          for (const chunk of splitMessage(text)) await this.post(chunk);
        }
        if (m.stopReason === "error" && m.errorMessage) {
          await this.post(`**Error from model:**\n${"```"}\n${truncate(m.errorMessage, 1500)}\n${"```"}`);
        } else if (m.stopReason === "length") {
          await this.post("*(Reply was cut off: hit the output token limit.)*");
        }
        break;
      }

      case "tool_execution_start":
        this.tools.push({ id: e.toolCallId, text: describeTool(e.toolName, e.args), state: "running" });
        this.progressDirty = true;
        break;

      case "tool_execution_end": {
        const t = this.tools.find((x) => x.id === e.toolCallId);
        if (t) t.state = e.isError ? "error" : "ok";
        this.progressDirty = true;
        break;
      }

      case "auto_retry_start":
        await this.post(`Retrying (attempt ${e.attempt} of ${e.maxAttempts}): ${truncate(String(e.errorMessage ?? ""), 200)}`);
        break;

      case "compaction_start":
        await this.post("Compacting the conversation to free up context…");
        break;

      case "extension_ui_request":
        await this.handleUiRequest(e);
        break;

      case "extension_error":
        if (config.debug) console.error(`[${this.thread.id}] extension error`, e.error);
        break;
    }
  }

  /** Tool activity as one message, edited in place (throttled). */
  private async flushProgress() {
    if (!this.progressDirty || this.tools.length === 0) return;
    this.progressDirty = false;

    // Words, not just symbols, so state doesn't rely on colour or icon shape.
    const label = { running: "⏳ running", ok: "✅ done", error: "❌ failed" } as const;
    const lines = this.tools.slice(-15).map((t) => `${label[t.state]} · ${t.text}`);
    const hidden = this.tools.length - 15;
    if (hidden > 0) lines.unshift(`*…${hidden} earlier steps*`);
    const body = lines.join("\n").slice(-1900);

    await this.enqueue(async () => {
      if (this.progressMsg) {
        await this.progressMsg.edit(body).catch(() => {});
      } else {
        this.progressMsg = await this.thread.send(body);
      }
    });
  }

  /** Permission-gate prompts and other extension dialogs → Discord buttons. */
  private async handleUiRequest(e: RpcEvent) {
    if (e.method === "notify") {
      await this.post(`*${truncate(String(e.message ?? ""), 1800)}*`);
      return;
    }
    if (e.method === "select" || e.method === "confirm") {
      await this.askButtons(e);
      return;
    }
    if (e.method === "input" || e.method === "editor") {
      this.rpc.respondUi(e.id, { cancelled: true });
      await this.post(`hoocode asked for text input (${code(String(e.title ?? ""))}), which Discord can't do yet. Skipped.`);
    }
    // setStatus / setWidget / setTitle / set_editor_text: nothing to show.
  }

  private async askButtons(e: RpcEvent) {
    const isGate = e.method === "select" && Array.isArray(e.options) && e.options.includes("Yes (once)");
    // For the permission gate, offer only Allow / Deny. "Always" would edit
    // the global ~/.hoocode/hoo-config.json, which is too big a click for chat.
    const options: { label: string; value: string; style: ButtonStyle }[] =
      e.method === "confirm"
        ? [
            { label: "Yes", value: "yes", style: ButtonStyle.Success },
            { label: "No", value: "no", style: ButtonStyle.Danger },
          ]
        : isGate
          ? [
              { label: "Allow once", value: "Yes (once)", style: ButtonStyle.Success },
              { label: "Deny", value: "No (block)", style: ButtonStyle.Danger },
            ]
          : (e.options as string[]).slice(0, 5).map((o) => ({
              label: truncate(o, 80),
              value: o,
              style: ButtonStyle.Secondary,
            }));

    const title = isGate
      ? `**Approval needed**\n${String(e.title ?? "").replace(/^Allow:\s*/, "")}`
      : `**${e.title ?? "hoocode asks"}**${e.message ? `\n${e.message}` : ""}`;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      options.map((o, i) =>
        new ButtonBuilder().setCustomId(`ui:${i}`).setLabel(o.label).setStyle(o.style),
      ),
    );

    const msg = await this.enqueue(() =>
      this.thread.send({ content: title.slice(0, 1800), components: [row] }),
    );
    this.stopTyping();

    const timeout = typeof e.timeout === "number" ? e.timeout : config.approvalTimeoutMs;
    try {
      const click = await msg.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: timeout,
        filter: async (i) => {
          if (config.allowedUserIds.has(i.user.id)) return true;
          await i.reply({ content: "Only allowed users can answer this.", ephemeral: true }).catch(() => {});
          return false;
        },
      });
      const chosen = options[Number(click.customId.split(":")[1])]!;
      if (e.method === "confirm") this.rpc.respondUi(e.id, { confirmed: chosen.value === "yes" });
      else this.rpc.respondUi(e.id, { value: chosen.value });

      await click.update({
        content: `${title.slice(0, 1800)}\n→ **${chosen.label}** by ${click.user.username}`,
        components: [],
      });
    } catch {
      this.rpc.respondUi(e.id, { cancelled: true });
      await msg
        .edit({ content: `${title.slice(0, 1800)}\n→ **No answer, cancelled.**`, components: [] })
        .catch(() => {});
    }
    if (this.streaming) this.startTyping();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private post(text: string) {
    if (!text.trim()) return Promise.resolve();
    return this.enqueue(() => this.thread.send(text)).catch((err) =>
      console.error(`[${this.thread.id}] send failed`, err),
    );
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

  /** Kill idle processes; the session is on disk and resumes on the next message. */
  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.streaming) this.close();
      else this.touch();
    }, config.idleTimeoutMs);
  }

  private dispose() {
    clearInterval(this.progressTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stopTyping();
    this.onClose(this.thread.id);
  }
}
