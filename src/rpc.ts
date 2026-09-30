/**
 * Minimal client for `hoocode --mode rpc`.
 *
 * Protocol: JSON objects, one per line, LF-delimited (see hoocode docs/rpc.md).
 * We split on "\n" only — generic line readers also split on U+2028/U+2029,
 * which are legal inside JSON strings.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export type RpcEvent = { type: string; [key: string]: any };

export interface RpcOptions {
  /** Path or name of the hoocode binary. */
  bin: string;
  /** Working directory hoocode operates in. */
  cwd: string;
  /** Extra CLI args (e.g. --model, --session-dir). */
  args: string[];
}

export class HoocodeRpc extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, (res: RpcEvent) => void>();
  private _exited = false;

  constructor(opts: RpcOptions) {
    super();
    this.proc = spawn(opts.bin, ["--mode", "rpc", ...opts.args], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));

    this.proc.on("exit", (code, signal) => {
      this._exited = true;
      for (const resolve of this.pending.values()) {
        resolve({ type: "response", success: false, error: "hoocode exited" });
      }
      this.pending.clear();
      this.emit("exit", code, signal);
    });
    this.proc.on("error", (err) => this.emit("error", err));
  }

  get exited(): boolean {
    return this._exited;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;

      let msg: RpcEvent;
      try {
        msg = JSON.parse(line);
      } catch {
        // Non-JSON noise (e.g. a stray log line) — surface it, don't crash.
        this.emit("stderr", line + "\n");
        continue;
      }

      if (msg.type === "response" && typeof msg.id === "string" && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolve(msg);
      } else {
        this.emit("event", msg);
      }
    }
  }

  /** Fire-and-forget write of a raw protocol object. */
  send(obj: object) {
    if (this._exited) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Send a command and wait for its `response`. */
  request(cmd: { type: string; [key: string]: unknown }): Promise<RpcEvent> {
    if (this._exited) {
      return Promise.resolve({ type: "response", success: false, error: "hoocode exited" });
    }
    const id = `req-${this.nextId++}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ ...cmd, id });
    });
  }

  /** Answer an extension_ui_request (select / confirm / input / editor). */
  respondUi(id: string, payload: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    this.send({ type: "extension_ui_response", id, ...payload });
  }

  kill() {
    if (!this._exited) this.proc.kill("SIGTERM");
  }
}
