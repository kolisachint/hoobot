/**
 * Client for a Codex app-server: `hoocode app-server` or the real
 * `codex app-server`. Uses only standard Codex methods, so either works.
 *
 * Transports:
 * - `unix://PATH`: WebSocket over a Unix socket (one JSON message per frame);
 * - `stdio:CMD ARGS...`: spawn a server and talk LF-delimited JSON on its pipes.
 */
import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { log, error, warn } from "./log.ts";

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
  /** Resolves once the server side is gone (for stdio: its whole process group). */
  close(): Promise<void>;
}

/** Thrown when a call passed its deadline without an answer. */
export class TimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`app-server did not answer ${method} within ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`}`);
  }
}

/**
 * Events: `notification` (Notification), `request` (ServerRequest),
 * `close` (reason: string).
 */
type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  /** `reject` without the pending-map bookkeeping, for the timeout path. */
  rawReject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  method: string;
  startedAt: number;
};

export class CodexClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<RequestId, Pending>();
  private transport: Transport | null = null;
  private closed = false;

  private constructor(
    readonly endpoint: string,
    /** Deadline for a call with no explicit one. See `request`. */
    readonly defaultTimeoutMs: number,
  ) {
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
    options: { cwd?: string; initializeTimeoutMs?: number; requestTimeoutMs?: number } = {},
  ): Promise<CodexClient> {
    const client = new CodexClient(endpoint, options.requestTimeoutMs ?? 120_000);
    await client.open(options.cwd);
    const timeoutMs = options.initializeTimeoutMs ?? 15_000;
    try {
      // The deadline is passed to the call itself rather than raced against a
      // separate timer: one timer, cleared in one place, so the pending entry
      // cannot outlive a failed handshake.
      await client.request(
        "initialize",
        { clientInfo, capabilities: { experimentalApi: true } },
        timeoutMs,
      ).catch((err) => {
        if (err instanceof TimeoutError) {
          throw new Error(
            `app-server at ${endpoint} did not answer initialize within ${timeoutMs / 1000}s. ` +
              "Does this hoocode build support `app-server`? Set HOOCODE_BIN or APP_SERVER in .env.",
          );
        }
        throw err;
      });
    } catch (err) {
      client.close();
      throw err;
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

  /**
   * A call, with a deadline.
   *
   * Every request used to wait forever: the reply settled it, or the
   * connection closing did. A server that simply stopped answering — a
   * wedged turn, a half-dead pipe — left the promise pending for good, and
   * because callers serialise per chat space, that one pending promise
   * blocked every later message in the thread behind it. The bot went quiet
   * while still reporting healthy.
   *
   * So every call now carries a deadline and rejects with `TimeoutError`
   * when it passes. `timeoutMs: 0` (or a negative number) opts out, for the
   * rare call that is genuinely allowed to take as long as it takes.
   */
  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed || !this.transport) return Promise.reject(new Error("app-server connection closed"));
    const id = this.nextId++;
    const budget = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      // `finish` is the single way a pending call ends — reply, timeout, or
      // shutdown — so the timer is always cleared and the map never leaks.
      const finish = (fn: (v: any) => void) => (v: any) => {
        const waiter = this.pending.get(id);
        if (!waiter) return; // already settled
        clearTimeout(waiter.timer);
        this.pending.delete(id);
        fn(v);
      };
      const waiter: Pending = {
        resolve: finish(resolve),
        reject: finish((e: Error) => reject(e)),
        rawReject: (e: Error) => reject(e),
        method,
        startedAt: Date.now(),
      };
      if (budget > 0) {
        waiter.timer = setTimeout(() => {
          // Drop the entry first, then reject through the *raw* reject: the
          // stored one is wrapped by `finish`, which would look the id up
          // again, find it already gone, and silently never settle.
          if (!this.pending.delete(id)) return;
          clearTimeout(waiter.timer);
          // Loud, because this is the failure that used to be invisible.
          error(`app-server call ${method} timed out after ${budget < 1000 ? `${budget}ms` : `${Math.round(budget / 1000)}s`}`);
          waiter.rawReject(new TimeoutError(method, budget));
        }, budget);
      }
      this.pending.set(id, waiter);
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

  /** Resolves once the server is gone, so a caller can exit without leaving it behind. */
  close(): Promise<void> {
    const stopped = this.transport?.close() ?? Promise.resolve();
    this.shutdown("closed by client");
    return stopped;
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
    // The stored resolve/reject clear the timer and drop the entry.
    if (msg.error) waiter.reject(new RpcError(msg.error.code ?? -1, msg.error.message ?? "error"));
    else waiter.resolve(msg.result);
  }

  /** Calls still waiting for a reply, with how long each has waited. */
  inflight(): { method: string; waitedMs: number }[] {
    const now = Date.now();
    return [...this.pending.values()].map((w) => ({
      method: w.method,
      waitedMs: w.startedAt ? now - w.startedAt : 0,
    }));
  }

  private shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.pending.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(`app-server connection closed: ${reason}`));
    }
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
        close: () => {
          ws.close();
          return Promise.resolve();
        },
      });
    };
    ws.onmessage = (e) => onMessage(typeof e.data === "string" ? e.data : String(e.data));
    ws.onerror = () => {
      if (!opened) reject(new Error(`cannot connect to app-server at ${path}`));
    };
    ws.onclose = () => onClose("socket closed");
  });
}

/** How long a stopped server gets to exit after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 3000;

/** Process groups of stdio servers that may still be running. */
const liveGroups = new Set<number>();

/**
 * A stdio server is its own process group, so when the bot is killed with
 * SIGKILL (no shutdown, no exit hook) the server outlives it. The live groups
 * are kept in a pidfile the bot owns, and the next start stops the ones that
 * are still app-servers. Off unless `recoverOrphanServers` is called.
 */
let pidFile: string | null = null;

function saveServerPids() {
  if (!pidFile) return;
  try {
    if (liveGroups.size === 0) {
      rmSync(pidFile, { force: true });
      return;
    }
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, [...liveGroups].join("\n") + "\n");
  } catch (err) {
    warn(`Can't record app-server pids in ${pidFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function forgetGroup(pid: number) {
  liveGroups.delete(pid);
  saveServerPids();
}

/** A pid is an orphan only if it still leads its own group and its command line is an app-server. */
function isOrphanServer(pid: number): boolean {
  const ps = (field: string) =>
    spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return Number(ps("pgid")) === pid && ps("command").includes("app-server");
}

/**
 * Call once at startup, before any server is started. Stops the app-server
 * groups an earlier run left behind (SIGTERM, then SIGKILL after the grace
 * period), and starts tracking this run's groups in `path`. Returns the pids
 * it stopped.
 */
export function recoverOrphanServers(path: string): number[] {
  let pids: number[] = [];
  try {
    pids = readFileSync(path, "utf8").split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    // No pidfile: nothing was left behind.
  }
  pidFile = path;
  const orphans = pids.filter(isOrphanServer);
  for (const pid of orphans) {
    liveGroups.add(pid);
    signalGroup(pid, "SIGTERM");
    reapGroup(pid);
  }
  saveServerPids();
  if (orphans.length) onProcessExit();
  return orphans;
}

/** Poll until the group is gone, then forget it; SIGKILL it once the grace period is over. */
function reapGroup(pid: number) {
  const deadline = Date.now() + STOP_GRACE_MS;
  const check = () => {
    if (!groupAlive(pid)) return forgetGroup(pid);
    if (Date.now() >= deadline) {
      signalGroup(pid, "SIGKILL");
      return forgetGroup(pid);
    }
    setTimeout(check, 50).unref();
  };
  check();
}

/**
 * `process.exit` skips `closeAll` (an uncaught exception, for one), so the
 * servers would outlive the bot. On exit, signal whatever is still running.
 */
let exitHookSet = false;
function onProcessExit() {
  if (exitHookSet) return;
  exitHookSet = true;
  process.once("exit", () => {
    for (const pid of liveGroups) signalGroup(pid, "SIGTERM");
  });
}

/**
 * Send `signal` to the child's process group. Nothing to signal is fine:
 * ESRCH is an empty group, and macOS answers EPERM when a group holds only
 * zombies, which are already dead.
 */
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Gone already.
  }
}

/** Whether any process is still signalable in the child's group (zombies don't count). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a stdio server and everything it started. `hoocode` is a Node wrapper
 * that runs the native app-server as its own child, so `child.kill()` stopped
 * only the wrapper and left the server running. The child is spawned as its
 * own process group (`detached`), so the whole group gets the signal: SIGTERM,
 * then SIGKILL after `STOP_GRACE_MS` if anything is still alive.
 */
function stopGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === "win32") {
    child.kill();
    return Promise.resolve();
  }
  signalGroup(pid, "SIGTERM");
  return new Promise((resolve) => {
    const deadline = Date.now() + STOP_GRACE_MS;
    const check = () => {
      if (!groupAlive(pid)) {
        forgetGroup(pid);
        return resolve();
      }
      if (Date.now() >= deadline) {
        signalGroup(pid, "SIGKILL");
        forgetGroup(pid);
        return resolve();
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function openStdio(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  onMessage: (text: string) => void,
  onClose: (reason: string) => void,
): Transport {
  // `detached`: its own process group, so `stopGroup` reaches what it started.
  // Stdio stays on pipes, so this doesn't change how the server talks to us.
  // It also means a terminal Ctrl-C no longer reaches the server: the bot's
  // shutdown (src/index.ts → closeAll) is what stops it.
  const child: ChildProcessWithoutNullStreams = spawn(cmd, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  if (child.pid) {
    liveGroups.add(child.pid);
    saveServerPids();
    onProcessExit();
  }
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.trim()) onMessage(line);
  });
  child.stderr.on("data", (d) => {
    if (process.env.DEBUG === "1") process.stderr.write(`[app-server] ${d}`);
  });
  child.on("exit", (code) => {
    // The wrapper can exit while what it started lives on: clear its group too.
    void stopGroup(child);
    onClose(`app-server exited (${code})`);
  });
  child.on("error", (err) => {
    error(`app-server process error: ${err.message}`);
    onClose(err.message);
  });
  return {
    send: (m) => child.stdin.write(JSON.stringify(m) + "\n"),
    close: () => stopGroup(child),
  };
}

/** Text input for `turn/start` / `turn/steer`, plus images as data URLs. */
export function userInput(text: string, images: { data: string; mimeType: string }[] = []) {
  const input: any[] = [];
  if (text) input.push({ type: "text", text, text_elements: [] });
  for (const img of images) input.push({ type: "image", url: `data:${img.mimeType};base64,${img.data}` });
  return input;
}
