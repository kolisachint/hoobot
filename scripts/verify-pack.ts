#!/usr/bin/env bun
/**
 * What would actually reach a machine that runs `bun add -g`.
 *
 * The source tree being correct says nothing about the tarball: `files` in
 * package.json is what decides, and forgetting an entry ships a bot whose
 * skills quietly do not exist. That failure is invisible until someone
 * installs on a new machine, finds no skills, and reports it as the package
 * being broken.
 *
 * So this reads the packed file list and asserts the things the bot needs at
 * runtime — plus that every bundled skill is well-formed, since a skill with
 * no description is never loaded and fails silently rather than loudly.
 *
 * Runs in CI, and again in the release workflow before `npm publish`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const packed = JSON.parse(
  spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }).stdout,
)[0] as { files: { path: string; mode?: number }[] };

const paths = new Set(packed.files.map((f) => f.path));
const problems: string[] = [];

const need = (path: string, why: string): void => {
  if (!paths.has(path)) problems.push(`missing from the tarball: ${path}  (${why})`);
};

// The bot itself.
need("src/index.ts", "the bot cannot start without it");
need("src/skills.ts", "prepareWorkspace() imports it");
need("scripts/runtime.sh", "the manager's start/stop/restart runs it");

// Everything prepareWorkspace() seeds.
const skillsDir = join(root, "skills");
if (!existsSync(skillsDir)) {
  problems.push("no skills/ directory to ship");
} else {
  const skills = [...new Set(packed.files.filter((f) => f.path.startsWith("skills/")).map((f) => f.path.split("/")[1]))].sort();
  if (!skills.length) problems.push("skills/ is listed in files but nothing under it is packed");

  for (const skill of skills) {
    const md = `skills/${skill}/SKILL.md`;
    if (!paths.has(md)) continue;
    const text = readFileSync(join(root, md), "utf8");
    const front = text.split("---")[1] ?? "";
    // No description means the agent never loads it: silent, not broken.
    if (!front.includes("description:")) problems.push(`${md} has no description in its frontmatter`);
    if (!front.includes(`name: ${skill}`)) problems.push(`${md} does not declare "name: ${skill}"`);
  }

  // peer-sync restarts bots through paths.sh, so a skills-only package that
  // forgot it would work here and fail on a fresh machine.
  for (const rel of ["bot-slack/scripts/paths.sh", "bot-slack/scripts/slack-pty.sh", "bot-slack/scripts/peer-sync.ts", "bot-selftest/scripts/bot-selftest.sh"]) {
    need(`skills/${rel}`, "a bundled script the bot-slack and bot-selftest skills run");
  }

  // A script seeded 0644 works right up until someone runs it directly.
  for (const f of packed.files) {
    if (f.path.startsWith("skills/") && f.path.endsWith(".sh") && !(Number(f.mode) & 0o111)) {
      problems.push(`${f.path} is packed without an executable bit`);
    }
  }
}

if (problems.length) {
  console.error("The package is not shippable:\n");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`package ok: ${packed.files.length} files, ${paths.has("skills/bot-slack/SKILL.md") ? "skills included" : "no skills"}`);