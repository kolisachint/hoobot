/**
 * Files the model wrote during a turn that are worth sending back to Discord
 * (HTML pages, images, PDFs, ...). Only regular files inside the work folder,
 * of a known type and under Discord's upload limit, are picked.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { INBOX_DIR } from "./inbound.ts";

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
 * The files to attach, in the order given. Relative paths resolve against
 * `workdir`. Skips anything missing, outside `workdir` (after following
 * symlinks), of another type, or past the size/count limits.
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
  const seen = new Set<string>();
  let total = 0;
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
    // Files people sent on Discord: never echoed back.
    if (rel === INBOX_DIR || rel.startsWith(`${INBOX_DIR}/`)) continue;
    if (seen.has(real)) continue;
    seen.add(real);
    if (files.length >= MAX_FILES || total + size > MAX_TOTAL_BYTES) {
      skipped.push(basename(real));
      continue;
    }
    total += size;
    files.push({ attachment: real, name: basename(real) });
  }
  return { files, skipped };
}
