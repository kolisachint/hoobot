/**
 * The skills hoobot ships, and how they land in a work folder.
 *
 * A skill is a folder with a `SKILL.md` — an instruction the agent loads
 * when the task matches its description. They ship **inside the npm
 * package**, so `bun add -g @kolisachint/hoobot` on a brand-new machine is
 * the whole install: the bot seeds its skills into the work folder on first
 * boot and the agent can already do the things they describe.
 *
 * The rule is the same one `prepareWorkspace` uses for the config and the
 * system prompt, and it exists for the same reason: **a skill hoobot wrote is
 * hoobot's to update; a skill a person wrote is theirs.** Upgrading hoobot
 * should refresh the bundled instructions and never touch local edits. The
 * only way to tell those apart across versions — where "the content we last
 * wrote" is not knowable from the current release alone — is to record what
 * we wrote in `.generated.json`, so a file whose hash still matches its
 * record is ours to overwrite and anything else is left alone.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isInstalled, runtimeDir } from "./instances.ts";

/** The package root: `…/node_modules/@kolisachint/hoobot`, or a checkout. */
function packageRoot(): string {
  return resolve(import.meta.dir, "..");
}

/** Where the bundled skills live inside the package. */
export function packagedSkillsDir(): string {
  return join(packageRoot(), "skills");
}

/** `bot-selftest`, `bot-avatar`, … — every skill folder that ships. */
export function skillNames(dir = packagedSkillsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/** Every file in a skill folder, relative to it, sorted, as posix paths. */
function skillFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...skillFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Keep the executable bit a bundled script had.
 *
 * A skill's scripts are run as `./run.sh` and `bash ./run.sh`, and a
 * workspace seeded on a fresh machine gets them 0644 — which works right up
 * until someone runs one directly, and then fails with a permission error
 * that says nothing about permissions. The mode is part of the file, so it
 * travels with it.
 */
const mode = (path: string): number => statSync(path).mode & 0o777;

/** `{"bot-selftest/SKILL.md": "sha…"}` — the last thing we wrote, per file. */
type Ledger = Record<string, string>;

function readLedger(path: string): Ledger {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Ledger) : {};
  } catch {
    // A corrupt ledger is not a reason to stop booting: treat every file as
    // unowned and leave the ones on disk alone.
    return {};
  }
}

/**
 * Copy the bundled skills into `<workdir>/.cortexcode/skills`.
 *
 * Returns what happened, so the caller can say so at startup instead of the
 * user discovering it later.
 */
export function seedSkills(
  workdir: string,
  opts: { source?: string; dryRun?: boolean } = {},
): { added: string[]; updated: string[]; kept: string[] } {
  const source = opts.source ?? packagedSkillsDir();
  const names = skillNames(source);
  const added: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];
  if (!names.length) return { added, updated, kept };

  const target = join(workdir, ".cortexcode", "skills");
  const ledgerPath = join(target, ".generated.json");
  const ledger = readLedger(ledgerPath);
  const next: Ledger = { ...ledger };

  for (const name of names) {
    for (const rel of skillFiles(join(source, name))) {
      const key = `${name}/${rel}`;
      const from = join(source, name, rel);
      const wanted = readFileSync(from, "utf8");
      const path = join(target, name, rel);

      if (existsSync(path)) {
        const current = readFileSync(path, "utf8");
        if (current === wanted) {
          next[key] = sha256(current);
          continue;
        }
        // Ours only if it still matches what we recorded writing. Anything
        // else is a local edit and stays exactly as it is.
        if (ledger[key] !== sha256(current)) {
          kept.push(key);
          continue;
        }
        if (!opts.dryRun) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, wanted);
          chmodSync(path, mode(from));
        }
        updated.push(key);
      } else {
        if (!opts.dryRun) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, wanted, { mode: mode(from) });
        }
        added.push(key);
      }
      next[key] = sha256(wanted);
    }
  }

  // Only rewrite the ledger when something actually changed, so a boot that
  // does nothing doesn't dirty the file.
  if (!opts.dryRun && JSON.stringify(next) !== JSON.stringify(ledger)) {
    mkdirSync(target, { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify(next, null, 2) + "\n");
  }
  return { added, updated, kept };
}

/**
 * The paths a skill needs, on whatever machine this is.
 *
 * Skills are copied between machines, so a skill that hard-codes
 * `~/github/hoobot` is wrong the moment it isn't that person's checkout.
 * This is the one place that knows.
 */
export function hoobotPaths(workdir?: string): Record<string, string> {
  const pkg = packageRoot();
  const runtime = runtimeDir();
  // Same default as config.ts: `HOO_WORKDIR`, else ./workspace from here.
  const work = workdir ?? (process.env.HOO_WORKDIR?.trim() || resolve(process.cwd(), "./workspace"));
  const skills = join(work, ".cortexcode", "skills");
  return {
    package: pkg,
    runtime,
    workdir: work,
    skills,
    manager: "http://127.0.0.1:8790",
    "runtime-script": join(pkg, "scripts", "runtime.sh"),
    selftest: join(skills, "bot-selftest", "scripts", "bot-selftest.sh"),
    "avatar-png": join(skills, "bot-avatar", "scripts", "avatar-png.ts"),
  };
}

/** True when this hoobot is running from an install, not a checkout. */
export function isPackageInstall(): boolean {
  return isInstalled(packageRoot());
}

/** Skills present in a work folder, for `hoobot path --skills`. */
export function installedSkills(workdir: string): string[] {
  const dir = join(workdir, ".cortexcode", "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/** For tests: is the workdir itself sane? */
export function workdirReady(workdir: string): boolean {
  try {
    return statSync(workdir).isDirectory();
  } catch {
    return false;
  }
}