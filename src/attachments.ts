/**
 * Files the model wrote during a turn that are worth sending back to the chat
 * (HTML pages, images, PDFs, ...). Only regular files inside the work folder,
 * of a known type and under Discord's upload limit (the smaller one), are picked.
 *
 * Two rules keep one deliverable from arriving twice: a file name is sent
 * once, and a `.html` page replaces the `.png` preview rendered from it.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

/** A page you can open in a browser. */
const PAGE_EXTENSIONS = new Set([".html", ".htm"]);
/** A rendered preview, which the page it sits next to already shows. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** File types sent back as attachments. Source code is left out on purpose. */
export const ATTACH_EXTENSIONS = new Set([
  ".html", ".htm", ".svg",
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".pdf", ".md", ".txt", ".csv", ".json",
  ".docx", ".xlsx", ".pptx", ".zip",
]);

/** Discord's default upload limit is 10 MiB per message; stay under it. */
export const MAX_TOTAL_BYTES = 9.5 * 1024 * 1024;
/** Discord allows at most 10 attachments per message. */
export const MAX_FILES = 10;

export type Attachment = { attachment: string; name: string };

/**
 * File paths named in the model's answer, e.g. "Saved `out/report.html`".
 * Catches files written by shell commands, which aren't tracked as edits.
 */
export function pathsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[\w./~-]+\.[A-Za-z0-9]{2,5}\b/g)) {
    const p = m[0].replace(/^\.\//, "");
    if (p.startsWith("//")) continue; // the tail of a URL
    if (ATTACH_EXTENSIONS.has(extname(p).toLowerCase())) out.push(p);
  }
  return out;
}

/** Folders never scanned: tooling, dependencies, build output. */
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "__pycache__", "venv"]);
/** Stop scanning after this many entries, so a huge folder can't stall a reply. */
const SCAN_LIMIT = 20_000;

/**
 * Files of an attachable type under `workdir` modified at or after `sinceMs`,
 * oldest first. Catches files written by shell commands (`python gen.py >
 * out.html`), which the server doesn't report as edits. Skips dot folders
 * (`.git`, `.cortexcode`, ...) and the folders in SKIP_DIRS.
 */
export function changedSince(workdir: string, sinceMs: number): string[] {
  const found: { path: string; mtime: number }[] = [];
  let seen = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > SCAN_LIMIT) return;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) walk(path);
      } else if (e.isFile() && ATTACH_EXTENSIONS.has(extname(e.name).toLowerCase())) {
        try {
          const mtime = statSync(path).mtimeMs;
          if (mtime >= sinceMs) found.push({ path, mtime });
        } catch {}
      }
    }
  };
  walk(workdir);
  return found.sort((a, b) => a.mtime - b.mtime).map((f) => f.path);
}

/**
 * Turns running per work folder, so a file changed in a shared folder goes
 * back only to the turn that made it. A channel and its threads share one
 * folder; when their turns overlap, a scan of the folder can't tell whose
 * file is whose.
 */
export class TurnLog {
  private turns = new Map<string, Map<string, { start: number; end: number | null }>>();

  begin(workdir: string, key: string, now = Date.now()) {
    let byKey = this.turns.get(workdir);
    if (!byKey) this.turns.set(workdir, (byKey = new Map()));
    byKey.set(key, { start: now, end: null });
  }

  end(workdir: string, key: string, now = Date.now()) {
    const t = this.turns.get(workdir)?.get(key);
    if (t && t.end === null) t.end = now;
    this.prune(now);
  }

  /** Whether another turn in `workdir` ran at some point during `key`'s turn. */
  overlapped(workdir: string, key: string, now = Date.now()): boolean {
    const byKey = this.turns.get(workdir);
    const me = byKey?.get(key);
    if (!byKey || !me) return false;
    const myEnd = me.end ?? now;
    for (const [k, t] of byKey) {
      if (k === key) continue;
      if (t.start <= myEnd && (t.end ?? now) >= me.start) return true;
    }
    return false;
  }

  /** Forget turns that ended over an hour ago; no running turn can overlap them. */
  private prune(now: number) {
    for (const [dir, byKey] of this.turns) {
      for (const [k, t] of byKey) if (t.end !== null && now - t.end > 60 * 60 * 1000) byKey.delete(k);
      if (byKey.size === 0) this.turns.delete(dir);
    }
  }
}

/** One log for the whole process: every session in a folder shares it. */
export const turnLog = new TurnLog();

/**
 * Of `changed` (files changed in the folder during a turn), the ones this
 * turn can claim. Alone in the folder: all of them. Overlapping another
 * turn: only those its answer or shell commands name (by path or file name);
 * the rest are ambiguous and go to nobody rather than to everyone.
 */
export function claimChanged(changed: string[], workdir: string, alone: boolean, mentions: string): string[] {
  if (alone) return changed;
  return changed.filter((p) => {
    const rel = relative(workdir, p);
    // Whole names only: `b.svg` matches `> b.svg` or `./b.svg`, not `xb.svg.bak` or `sub/b.svg`.
    return [p, rel, basename(p)].some((name) =>
      new RegExp(`(^|[^\\w./-]|(?<![\\w.])\\./)${escapeRe(name)}($|[^\\w./-]|\\.(?!\\w))`).test(mentions),
    );
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scratch and inboxes live in dot folders (`.work/`, `.slack/`, ...): never sent. */
function inDotFolder(rel: string): boolean {
  return rel.split("/").some((seg) => seg.startsWith("."));
}

/** `report.html` -> `report`; the key that ties a page to its preview image. */
function stem(name: string): string {
  const ext = extname(name);
  return (ext ? name.slice(0, -ext.length) : name).toLowerCase();
}

/**
 * The files to attach, in the order given. Relative paths resolve against
 * `workdir`. Skips anything missing, outside `workdir` (after following
 * symlinks), of another type, in a dot folder, or past the size/count limits.
 *
 * Two more rules, because Slack and Discord both show one row per file and a
 * reader can't tell rows apart:
 *
 * - **One name, one file.** A deliverable is often reachable twice — the
 *   scratch copy the write tool reported and the `out/` copy a shell command
 *   produced, or the same path from the answer text and from the folder scan.
 *   Uploading both posted the same page to the channel twice. First one wins.
 * - **A page beats its preview.** `report.html` and `report.png` are one
 *   deliverable, and the page is the real one: Slack can't render it and
 *   downloads it, the phone shows it in a browser. Sending the image too
 *   just doubles the answer for no gain.
 */
export function pickAttachments(paths: Iterable<string>, workdir: string): { files: Attachment[]; skipped: string[] } {
  const files: Attachment[] = [];
  const skipped: string[] = [];
  let root: string;
  try {
    root = realpathSync(workdir);
  } catch {
    return { files, skipped };
  }
  // Collect first, choose second: the page may come after its preview image.
  const found: { real: string; name: string; size: number }[] = [];
  const seenPaths = new Set<string>();
  for (const p of paths) {
    if (!ATTACH_EXTENSIONS.has(extname(p).toLowerCase())) continue;
    let real: string;
    let size: number;
    try {
      real = realpathSync(resolve(workdir, p));
      const st = statSync(real);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue; // deleted or never written
    }
    const rel = relative(root, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    // Files people sent on a chat, and scratch: never echoed back.
    if (inDotFolder(rel)) continue;
    if (seenPaths.has(real)) continue;
    seenPaths.add(real);
    found.push({ real, name: basename(real), size });
  }

  const pages = new Set(found.filter((f) => PAGE_EXTENSIONS.has(extname(f.name).toLowerCase())).map((f) => stem(f.name)));
  const sent = new Set<string>();
  let total = 0;
  for (const f of found) {
    const ext = extname(f.name).toLowerCase();
    const key = f.name.toLowerCase();
    if (sent.has(key)) continue; // the same file by another route
    if (IMAGE_EXTENSIONS.has(ext) && pages.has(stem(f.name))) continue; // preview of a page we're sending
    sent.add(key);
    if (files.length >= MAX_FILES || total + f.size > MAX_TOTAL_BYTES) {
      skipped.push(f.name);
      continue;
    }
    total += f.size;
    files.push({ attachment: f.real, name: f.name });
  }
  return { files, skipped };
}
