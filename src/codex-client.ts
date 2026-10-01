/**
 * Client for a Codex app-server: `hoocode app-server` or the real
 * `codex app-server`. Uses only standard Codex methods, so either works.
 *
 * Transports:
 * - `unix://PATH`: WebSocket over a Unix socket (one JSON message per frame);
 * - `stdio:CMD ARGS...`: spawn a server and talk LF-delimited JSON on its pipes.
 */
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type RequestId = number | string;

export type Notification = { method: string; params: any };
export type ServerRequest = { id: RequestId; method: string; params: any };

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Transport {
  send(message: unknown): void;
  close(): void;
}

/**
 * Events: `notification` (Notification), `request` (ServerRequest),
 * `close` (reason: string).
 */
export class CodexClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<RequestId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private transport: Transport | null = null;
  private closed = false;

  private constructor(readonly endpoint: string) {
    super();
  }

  /**
   * Connect and run the `initialize` handshake. Fails after
   * `initializeTimeoutMs` if the server never answers (e.g. a hoocode
   * build without `app-server`, which just sits on stdin).
   */
  static async connect(
    endpoint: string,
    clientInfo = { name: "hoobot", version: "0.1.0" },
    options: { cwd?: string; initializeTimeoutMs?: number } = {},
  ): Promise<CodexClient> {
    const client = new CodexClient(endpoint);
    await client.open(options.cwd);
    const timeoutMs = options.initializeTimeoutMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.request("initialize", {
          clientInfo,
          capabilities: { experimentalApi: true },
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `app-server at ${endpoint} did not answer initialize within ${timeoutMs / 1000}s. ` +
                    "Does this hoocode build support `app-server`? Set HOOCODE_BIN or APP_SERVER in .env.",
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      client.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    client.notify("initialized");
    return client;
  }

  /** `cwd`: working folder for a `stdio:` server. */
  private async open(cwd?: string) {
    const onMessage = (text: string) => this.dispatch(text);
    const onClose = (reason: string) => this.shutdown(reason);
    if (this.endpoint.startsWith("unix://")) {
      this.transport = await openUnix(this.endpoint.slice("unix://".length), onMessage, onClose);
    } else if (this.endpoint.startsWith("stdio:")) {
      const [cmd, ...args] = this.endpoint.slice("stdio:".length).trim().split(/\s+/);
      if (!cmd) throw new Error("stdio: endpoint needs a command");
      this.transport = openStdio(cmd, args, cwd, onMessage, onClose);
    } else {
      throw new Error(`unsupported endpoint ${this.endpoint} (use unix://PATH or stdio:CMD)`);
    }
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed || !this.transport) return Promise.reject(new Error("app-server connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport!.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.transport?.send(params === undefined ? { method } : { method, params });
  }

  /** Answer a server request (e.g. an approval). */
  respond(id: RequestId, result: unknown) {
    this.transport?.send({ id, result });
  }

  close() {
    this.transport?.close();
    this.shutdown("closed by client");
  }

  get isClosed() {
    return this.closed;
  }

  private dispatch(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg?.method === "string") {
      if (msg.id !== undefined && msg.id !== null) {
        this.emit("request", { id: msg.id, method: msg.method, params: msg.params } satisfies ServerRequest);
      } else {
        this.emit("notification", { method: msg.method, params: msg.params } satisfies Notification);
      }
      return;
    }
    const waiter = this.pending.get(msg?.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new RpcError(msg.error.code ?? -1, msg.error.message ?? "error"));
    else waiter.resolve(msg.result);
  }

  private shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.pending.values()) w.reject(new Error(`app-server connection closed: ${reason}`));
    this.pending.clear();
    this.emit("close", reason);
  }
}

function openUnix(
  path: string,
  onMessage: (text: string) => void,
  onClose: (reason: string) => void,
): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws+unix://" + path);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve({
        send: (m) => ws.send(JSON.stringify(m)),
        close: () => ws.close(),
      });
    };
    ws.onmessage = (e) => onMessage(typeof e.data === "string" ? e.data : String(e.data));
    ws.onerror = () => {
      if (!opened) reject(new Error(`cannot connect to app-server at ${path}`));
    };
    ws.onclose = () => onClose("socket closed");
  });
}

function openStdio(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  onMessage: (text: string) => void,
  onClose: (reason: string) => void,
): Transport {
  const child: ChildProcessWithoutNullStreams = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.trim()) onMessage(line);
  });
  child.stderr.on("data", (d) => {
    if (process.env.DEBUG === "1") process.stderr.write(`[app-server] ${d}`);
  });
  child.on("exit", (code) => onClose(`app-server exited (${code})`));
  child.on("error", (err) => onClose(err.message));
  return {
    send: (m) => child.stdin.write(JSON.stringify(m) + "\n"),
    close: () => child.kill(),
  };
}

/** Text input for `turn/start` / `turn/steer`, plus images as data URLs. */
export function userInput(text: string, images: { data: string; mimeType: string }[] = []) {
  const input: any[] = [];
  if (text) input.push({ type: "text", text, text_elements: [] });
  for (const img of images) input.push({ type: "image", url: `data:${img.mimeType};base64,${img.data}` });
  return input;
}
