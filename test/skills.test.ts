/**
 * Bundled skills have to arrive on a fresh machine and then get out of the
 * way. Both halves matter: a skill hoobot wrote may be refreshed when the
 * package is upgraded, and a skill a person wrote must never be touched,
 * no matter how many versions go by.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hoobotPaths, installedSkills, packagedSkillsDir, seedSkills, skillNames } from "../src/skills.ts";

let work: string;
let source: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "skills-work-"));
  source = mkdtempSync(join(tmpdir(), "skills-src-"));
  mkdirSync(join(source, "greet"), { recursive: true });
  writeFileSync(join(source, "greet", "SKILL.md"), "v1\n");
  mkdirSync(join(source, "greet", "scripts"), { recursive: true });
  writeFileSync(join(source, "greet", "scripts", "run.sh"), "#!/bin/sh\n");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

const skill = (name: string, rel = "SKILL.md") => join(work, ".cortexcode", "skills", name, rel);

test("a fresh work folder gets every bundled file, nested folders and all", () => {
  const out = seedSkills(work, { source });
  expect(out.added.sort()).toEqual(["greet/SKILL.md", "greet/scripts/run.sh"]);
  expect(readFileSync(skill("greet"), "utf8")).toBe("v1\n");
  expect(readFileSync(skill("greet", "scripts/run.sh"), "utf8")).toBe("#!/bin/sh\n");
  expect(installedSkills(work)).toEqual(["greet"]);
});

test("booting again changes nothing", () => {
  seedSkills(work, { source });
  const out = seedSkills(work, { source });
  expect(out).toEqual({ added: [], updated: [], kept: [] });
  // And the ledger is not rewritten either, so a boot doesn't dirty a repo.
  const ledger = readFileSync(join(work, ".cortexcode", "skills", ".generated.json"), "utf8");
  seedSkills(work, { source });
  expect(readFileSync(join(work, ".cortexcode", "skills", ".generated.json"), "utf8")).toBe(ledger);
});

test("a local edit survives an upgrade", () => {
  seedSkills(work, { source });
  writeFileSync(skill("greet"), "mine, hands off\n");
  writeFileSync(join(source, "greet", "SKILL.md"), "v2\n");
  const out = seedSkills(work, { source });
  expect(out.updated).toEqual([]);
  expect(out.kept).toEqual(["greet/SKILL.md"]);
  expect(readFileSync(skill("greet"), "utf8")).toBe("mine, hands off\n");
});

test("an untouched skill is refreshed when the package changes it", () => {
  seedSkills(work, { source });
  writeFileSync(join(source, "greet", "SKILL.md"), "v2\n");
  const out = seedSkills(work, { source });
  expect(out.updated).toEqual(["greet/SKILL.md"]);
  expect(out.kept).toEqual([]);
  expect(readFileSync(skill("greet"), "utf8")).toBe("v2\n");
  // And once refreshed, a second edit is recognised as local again.
  writeFileSync(skill("greet"), "mine\n");
  expect(seedSkills(work, { source }).kept).toEqual(["greet/SKILL.md"]);
});

test("a folder without a SKILL.md is not a skill", () => {
  mkdirSync(join(source, "notes"), { recursive: true });
  writeFileSync(join(source, "notes", "todo.txt"), "hi\n");
  expect(skillNames(source)).toEqual(["greet"]);
  expect(seedSkills(work, { source }).added).not.toContain("notes/todo.txt");
  expect(existsSync(join(work, ".cortexcode", "skills", "notes"))).toBe(false);
});

test("a corrupt ledger is ignored, not fatal", () => {
  seedSkills(work, { source });
  const ledger = join(work, ".cortexcode", "skills", ".generated.json");
  writeFileSync(ledger, "{not json");
  // Nothing is known to be ours any more, so nothing is overwritten.
  writeFileSync(join(source, "greet", "SKILL.md"), "v2\n");
  const out = seedSkills(work, { source });
  // Only the file that actually differs is at risk; the other still matches.
  expect(out.kept).toEqual(["greet/SKILL.md"]);
  expect(readFileSync(skill("greet"), "utf8")).toBe("v1\n");
});

test("a dry run reports without writing", () => {
  const out = seedSkills(work, { source, dryRun: true });
  expect(out.added).toHaveLength(2);
  expect(existsSync(join(work, ".cortexcode"))).toBe(false);
});

test("the package ships skills, and every one is a real skill", () => {
  // Shipping the folder without listing it in `files` is the quiet way to
  // make a new machine get nothing at all.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.files).toContain("skills");

  const names = skillNames();
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const text = readFileSync(join(packagedSkillsDir(), name, "SKILL.md"), "utf8");
    // frontmatter: a name and a description, or the agent never loads it
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain(`name: ${name}`);
    expect(text.split("---")[1]).toContain("description:");
    // no machine-specific paths: these files get copied between machines
    expect(text).not.toMatch(/~\/github\//);
    expect(text).not.toContain("~/.hoobot/runtime/shared/workspace/.cortexcode/skills");
  }
});

test("every bot skill routes through the Slack CLI before the manager", () => {
  const dir = packagedSkillsDir();
  const read = (name: string) => readFileSync(join(dir, name, "SKILL.md"), "utf8");

  // The claim these skills used to make — "Slack has no CLI for this, do it
  // in a browser" — is false: `slack app install` creates the app, installs
  // it and uploads the icon. Leaving that text in would send the user to a
  // form for something one command does.
  for (const name of skillNames()) {
    const text = read(name);
    expect(text, name).not.toMatch(/no (CLI|API) for this/i);
    expect(text, name).not.toMatch(/has no public API for creating apps/i);
    expect(text, name).not.toMatch(/only the user can re-mint/i);
  }

  // bot-slack is the one that owns the Slack CLI, and it is what the others
  // must point at rather than describing the CLI themselves.
  expect(read("slack-bot-create")).toContain("bot-slack");
  expect(read("slack-bot-update")).toContain("bot-slack");
  expect(read("bot-avatar")).toContain("bot-slack");
  expect(read("bot-selftest")).toContain("bot-slack");
  expect(read("hoobot-health-report")).toContain("bot-slack");

  // The flow is Slack → manager → Slack again, and the order is written down.
  expect(read("slack-bot-update")).toMatch(/Slack first, manager second, Slack again/);
  expect(read("bot-slack")).toMatch(/slack-app\.ts/);
});

test("the Slack half refuses to pretend it worked", () => {
  const dir = join(packagedSkillsDir(), "bot-slack", "scripts");

  // The pty wrapper exists because the CLI refuses to run without a
  // terminal, and Enter is the wrong answer for anything destructive.
  const pty = readFileSync(join(dir, "slack-pty.sh"), "utf8");
  expect(pty).toContain("SLACK_PTY_KEYS");
  expect(pty).toContain("pty.fork");

  const app = readFileSync(join(dir, "slack-app.ts"), "utf8");
  // Socket Mode, or the bot never receives a message.
  expect(app).toContain("socket_mode_enabled");
  expect(app).toContain("app_mentions:read");
  // The confirmation whose default is "keep the app".
  expect(app).toContain("will not be deleted");
  // The one call that returns both tokens in full.
  expect(app).toContain("apps.developerInstall");
  expect(app).toContain("api_access_tokens");
  // Omitting these hands back a token that answers account_inactive on a
  // perfectly healthy app, which reads as a revoked token.
  expect(app).toContain("bot_scopes");
  // And a token that cannot open a websocket is a bot that looks healthy
  // until it is mentioned.
  expect(app).toContain("apps.connections.open");
});

test("no skill sends the user to a browser for something we can do", () => {
  const read = (name: string) => readFileSync(join(packagedSkillsDir(), name, "SKILL.md"), "utf8");

  // The tokens are fetchable. A skill that still tells someone to copy an
  // xoxb- off a settings page is asking for busywork.
  for (const name of skillNames()) {
    const text = read(name);
    expect(text, name).not.toMatch(/copy the .{0,12}(xoxb|xapp)/i);
    expect(text, name).not.toMatch(/Install\/Reinstall to workspace/i);
    expect(text, name).not.toMatch(/the two tokens \(only the user\)/i);
  }
  expect(read("slack-bot-create")).toContain("tokens <name> --write");
  expect(read("bot-slack")).toContain("developerInstall");
});

test("a skill resolves paths without needing the hoobot that ships it", () => {
  // The trap this exists for: `hoobot path` arrives in the same release as
  // the skills, but a workspace can hold new skills against an older build,
  // and on that build `hoobot path` is an unknown subcommand that falls
  // through to starting the bot — prints nothing to stdout, exits 0. So
  //
  //   bash "$(hoobot path selftest)" hoo     # -> bash: : No such file
  //
  // with the real error scrolled off above it: a broken path wearing the
  // costume of a missing file. So skills go through paths.sh, which falls
  // back to the documented layout, and defines it before using it.
  const dir = join(packagedSkillsDir(), "bot-slack", "scripts", "paths.sh");
  expect(existsSync(dir)).toBe(true);
  const helper = readFileSync(dir, "utf8");
  // An empty answer is the failure mode, so never allow one.
  expect(helper).toContain("[ -n \"$p\" ] || return 1");
  expect(helper).toContain("no path for");

  for (const name of skillNames()) {
    const text = readFileSync(join(packagedSkillsDir(), name, "SKILL.md"), "utf8");
    // Nothing may call the subcommand the old build lacks.
    expect(text, name).not.toMatch(/\$\(hoobot path /);
    const uses = (text.match(/\$\(HOO_PATHS /g) ?? []).length;
    if (uses) {
      expect(text, name).toContain("HOO_PATHS() {");
      // The definition has to come before the first use, or the first
      // command in the skill runs before the shell knows the name.
      expect(text.indexOf("HOO_PATHS() {"), name).toBeLessThan(text.indexOf("$(HOO_PATHS "));
    }
  }
});

test("hoobot path answers for every key it advertises", () => {
  const paths = hoobotPaths();
  for (const key of ["package", "runtime", "workdir", "skills", "selftest", "avatar-png", "runtime-script", "manager"]) {
    expect(paths[key], key).toBeTruthy();
  }
  // The script paths are where the seeded skills actually land.
  const before = process.env.HOO_WORKDIR;
  process.env.HOO_WORKDIR = work;
  try {
    expect(hoobotPaths().skills).toBe(join(work, ".cortexcode", "skills"));
    expect(hoobotPaths().selftest).toBe(join(work, ".cortexcode", "skills", "bot-selftest", "scripts", "bot-selftest.sh"));
  } finally {
    if (before === undefined) delete process.env.HOO_WORKDIR;
    else process.env.HOO_WORKDIR = before;
  }
});