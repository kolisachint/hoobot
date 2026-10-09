/**
 * Which hoocode build a stdio app-server was started from.
 *
 * The bot keeps one `hoocode app-server` child alive for days. When hoocode
 * is upgraded, that child keeps running the old code: it still reads the
 * auth file the new build no longer uses, which is how a bot reported "No API
 * key for provider" after an upgrade. So the bot records the binary it
 * spawned, and before a new turn on an idle server it restarts the server if
 * the binary on disk has changed. The conversations live in the server, so
 * the threads resume through the usual resume path.
 */
import { realpathSync, statSync } from "node:fs";

export type BinaryStamp = {
  /** The real file, after following symlinks (`brew upgrade` swaps those). */
  path: string;
  mtimeMs: number;
  size: number;
};

/**
 * The hoocode binary a stdio server is started from: `hoocodeBin` (HOOCODE_BIN)
 * when there is no APP_SERVER, else the first word of `stdio:<cmd> ...`. Null
 * for `unix://…` (a socket server is not ours to restart) and for anything else.
 */
export function spawnedBinary(input: { appServer: string; hoocodeBin: string }): string | null {
  const { appServer, hoocodeBin } = input;
  if (!appServer) return hoocodeBin;
  if (!appServer.startsWith("stdio:")) return null;
  return appServer.slice("stdio:".length).trim().split(/\s+/)[0] || null;
}

/** The binary `bin` resolves to on PATH right now, or null if it can't be found. */
export function binaryStamp(bin: string): BinaryStamp | null {
  try {
    const found = Bun.which(bin);
    if (!found) return null;
    const path = realpathSync(found);
    const st = statSync(path);
    return { path, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** Whether the file a server was spawned from is no longer the one on disk. */
export function binaryChanged(spawned: BinaryStamp, now: BinaryStamp): boolean {
  return spawned.path !== now.path || spawned.mtimeMs !== now.mtimeMs || spawned.size !== now.size;
}

/**
 * Restart only when it is safe and certain: the server was spawned from a
 * known binary, that binary is still there and has changed, and no turn or
 * call is in flight on the server. Anything unknown (no stamp, binary missing
 * mid-upgrade) keeps the running server, which still works.
 */
export function shouldRestartServer(input: {
  spawned: BinaryStamp | null;
  current: BinaryStamp | null;
  idle: boolean;
}): boolean {
  const { spawned, current, idle } = input;
  return idle && spawned !== null && current !== null && binaryChanged(spawned, current);
}
