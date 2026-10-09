import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { warn } from "./log.ts";

/**
 * Users who clicked "Always for me" on an approval prompt. Kept per bot in
 * `config.grantsFile` (a JSON array of chat user ids), so the choice survives
 * restarts. It lives here, not in hoocode's config.
 */
export class Grants {
  private ids: Set<string> | null = null;
  /** The file exists but could not be read: never overwrite it, keep grants in memory only. */
  private broken = false;

  constructor(readonly file: string) {}

  has(userId: string): boolean {
    return this.load().has(userId);
  }

  add(userId: string): void {
    const ids = this.load();
    if (ids.has(userId)) return;
    ids.add(userId);
    if (this.broken) {
      warn(`${this.file} could not be read at startup; keeping this grant in memory only`);
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    // Write beside the file, then rename: a crash mid-write never leaves a half-written list.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...ids], null, 2) + "\n");
    renameSync(tmp, this.file);
  }

  private load(): Set<string> {
    if (this.ids) return this.ids;
    this.ids = new Set();
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(data)) for (const id of data) if (typeof id === "string") this.ids.add(id);
    } catch (err) {
      // Missing is normal on first run. Anything else: log it, and don't overwrite the file later.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.broken = true;
        warn(`Ignoring unreadable ${this.file}`, err);
      }
    }
    return this.ids;
  }
}

export const grants = new Grants(config.grantsFile);
