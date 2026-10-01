/**
 * Surface thread → app-server thread links (design doc 13). hoocode never
 * learns about Discord; this small JSON file is the only place that does.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Link = { threadId: string };

export class LinkStore {
  private links: Record<string, Link> = {};

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.links = JSON.parse(readFileSync(path, "utf8"));
      } catch (err) {
        console.error(`Could not read ${path}; starting with no links`, err);
      }
    }
  }

  get(key: string): Link | undefined {
    return this.links[key];
  }

  set(key: string, link: Link) {
    this.links[key] = link;
    this.save();
  }

  delete(key: string) {
    delete this.links[key];
    this.save();
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.links, null, 2) + "\n");
    renameSync(tmp, this.path);
  }
}
