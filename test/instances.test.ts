/**
 * The instance layer is the manager's whole state: `runtime/<name>/.env`
 * is the config, so these tests are mostly about what happens to a file a
 * person also edits by hand.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInstance,
  deleteInstance,
  fieldsFor,
  isSecretKey,
  listInstances,
  maskSecret,
  nextPort,
  parseEnv,
  parseLists,
  pidFor,
  readInstance,
  suggestName,
  surfacesFor,
  UNCHANGED,
  validateName,
  writeInstance,
} from "../src/instances.ts";
import { hashSeed } from "../src/avatar.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hoobot-instances-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const envOf = (name: string) => parseEnv(readFileSync(join(dir, name, ".env"), "utf8"));

test("env parsing is tolerant: comments, blanks, quotes, last wins", () => {
  const env = parseEnv(
    ['# a note', "", "A=1", 'B="two words"', "C='three'", "export D=4", "A=5", "not a key line", "=novalue"].join("\n"),
  );
  expect(env.get("A")).toBe("5");
  expect(env.get("B")).toBe("two words");
  expect(env.get("C")).toBe("three");
  expect(env.get("D")).toBe("4");
  expect(env.size).toBe(4);
  expect(parseLists(" a , b ,, c ")).toEqual(["a", "b", "c"]);
});

test("a secret is masked, and the mask never gives it away", () => {
  expect(isSecretKey("SLACK_BOT_TOKEN")).toBe(true);
  expect(isSecretKey("MODEL")).toBe(false);
  expect(maskSecret("xoxb-1234567890-abcdef")).toBe("xoxb" + "•".repeat(14) + "cdef");
  expect(maskSecret("x")).toBe("•");
  expect(maskSecret(undefined)).toBe("");
  expect(UNCHANGED).toBe("__unchanged__");
});

test("names: rejected early, explained when not", () => {
  expect(validateName("pepper", dir)).toBeNull();
  expect(validateName("", dir)).toMatch(/name/i);
  expect(validateName("Two Words", dir)).toMatch(/lowercase/);
  expect(validateName("-nope", dir)).toMatch(/starting with a letter/);
  expect(validateName("a".repeat(25), dir)).toMatch(/24 characters/);
  expect(validateName("shared", dir)).toMatch(/reserved/);
  // An existing bot can't be created twice, whatever case it's written in.
  createInstance({ name: "pepper", surfaces: ["slack"], dir });
  expect(validateName("PEPPER", dir)).toMatch(/already exists/);
  // ...but only if it exists: hoo is a perfectly good first bot.
  expect(validateName("hoo", dir)).toBeNull();
});

test("suggested names avoid the ones in use, and re-roll with a new seed", () => {
  const first = suggestName([]);
  expect(suggestName([first])).not.toBe(first);
  expect(suggestName([], "a")).toBe(suggestName([], "a"));
  expect(suggestName([], "a")).not.toBe(suggestName([], "b"));
});

test("each bot gets its own free health port", () => {
  expect(nextPort([])).toBe(8787);
  expect(nextPort([8787])).toBe(8788);
  expect(nextPort([8787, 8788, 8790])).toBe(8789);
  createInstance({ name: "one", surfaces: ["slack"], dir });
  createInstance({ name: "two", surfaces: ["slack"], dir });
  expect(readInstance("one", dir)!.port).toBe(8787);
  expect(readInstance("two", dir)!.port).toBe(8788);
});

test("a new bot is a folder with a filled-in .env and nothing secret in it", () => {
  const bot = createInstance({
    name: "Pepper",
    surfaces: ["slack"],
    secrets: { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_APP_TOKEN: "xapp-secret" },
    dir,
  });

  expect(bot.name).toBe("pepper");
  expect(bot.dir).toBe(join(dir, "pepper"));
  expect(bot.envPath).toBe(join(dir, "pepper", ".env"));
  expect(bot.surfaces).toEqual(["slack"]);
  expect(bot.port).toBe(8787);
  expect(bot.avatarSeed).toBe(hashSeed("pepper"));
  // It works in the shared folder when there is one, else in its own.
  mkdirSync(join(dir, "shared", "workspace"), { recursive: true });
  expect(createInstance({ name: "shared-user", surfaces: ["slack"], dir }).workdir).toBe(join(dir, "shared", "workspace"));

  const env = envOf("pepper");
  expect(env.get("HOO_INSTANCE")).toBe("pepper");
  expect(env.get("SLACK_BOT_TOKEN")).toBe("xoxb-secret");
  // A Slack-only bot keeps an empty Discord token, so the bot doesn't
  // wander into Discord when the template's defaults are copied in.
  expect(env.get("DISCORD_TOKEN")).toBe("");
  // The UI sees the token masked, never in full.
  expect(bot.secrets.SLACK_BOT_TOKEN).toBe(maskSecret("xoxb-secret"));
  expect(JSON.stringify(bot)).not.toContain("xoxb-secret");
});

test("a bot can be created before it has tokens", () => {
  const bot = createInstance({ name: "later", surfaces: ["discord"], dir });
  expect(bot.surfaces).toEqual(["discord"]);
  expect(bot.secrets.DISCORD_TOKEN).toBe("");
  // Discord chosen, so the Discord box is on screen waiting for the token —
  // and Slack isn't.
  expect(fieldsFor(bot.surfaces).some((f) => f.key === "DISCORD_TOKEN")).toBe(true);
  expect(fieldsFor(bot.surfaces).some((f) => f.key === "SLACK_BOT_TOKEN")).toBe(false);
  expect(fieldsFor([]).some((f) => f.key === "DISCORD_TOKEN")).toBe(false);
});

test("surfaces come from the tokens, and only those fields are offered", () => {
  expect(surfacesFor(parseEnv("DISCORD_TOKEN=x"))).toEqual(["discord"]);
  // A bot token without an app token is not a Slack bot.
  expect(surfacesFor(parseEnv("SLACK_BOT_TOKEN=xoxb-x"))).toEqual([]);
  expect(surfacesFor(parseEnv("SLACK_BOT_TOKEN=xoxb-x\nSLACK_APP_TOKEN=xapp-x"))).toEqual(["slack"]);
  const keys = fieldsFor(["slack"]).map((f) => f.key);
  expect(keys).toContain("SLACK_BOT_TOKEN");
  expect(keys).toContain("HOO_SURFACES");
  expect(keys).not.toContain("DISCORD_TOKEN");
  expect(keys).not.toContain("GUILD_ID");
});

test("editing keeps the comments and the keys you didn't touch", () => {
  const bot = createInstance({ name: "note", surfaces: ["slack"], secrets: { SLACK_BOT_TOKEN: "xoxb-a" }, dir });
  const path = join(bot.envPath);
  const text = readFileSync(path, "utf8");
  // Someone's hand-written note, as if they'd tuned this file themselves.
  writeFileSync(path, `# my own note\nMODEL=gpt-5\n${text.split("\n").filter((l) => l !== "MODEL=gpt-5").join("\n")}`);
  const envBefore = envOf("note");

  const updated = writeInstance("note", { MODEL: "anthropic/claude-sonnet-4-5" }, { dir });
  expect(updated.config.MODEL).toBe("anthropic/claude-sonnet-4-5");
  expect(readFileSync(path, "utf8")).toContain("# my own note");
  expect(envOf("note").get("SLACK_BOT_TOKEN")).toBe("xoxb-a");

  // A new key is appended rather than dropped.
  writeInstance("note", { DEBUG: "true" }, { dir });
  expect(envOf("note").get("DEBUG")).toBe("true");
  // A value can't smuggle a second line into the file.
  writeInstance("note", { MODEL: "a\nPEER_TURNS=99" }, { dir });
  const raw = readFileSync(path, "utf8");
  expect(raw).toContain("MODEL=a PEER_TURNS=99");
  // The template's own PEER_TURNS is untouched by the smuggled line.
  expect(envOf("note").get("PEER_TURNS")).toBe(envBefore.get("PEER_TURNS"));

  // Duplicate keys are collapsed onto the last one, which is the one that
  // wins when the file is read — otherwise the edit would appear to work
  // and then be ignored.
  const dupes = createInstance({ name: "dupes", surfaces: ["slack"], dir });
  const p = dupes.envPath;
  writeFileSync(p, `${readFileSync(p, "utf8")}\nMODEL=first\nMODEL=second\n`);
  writeInstance("dupes", { MODEL: "third" }, { dir });
  expect(envOf("dupes").get("MODEL")).toBe("third");
  expect(readFileSync(p, "utf8").match(/^MODEL=/gm)?.length).toBe(1);
});

test("unknown keys are ignored, not written", () => {
  createInstance({ name: "strict", surfaces: ["slack"], dir });
  writeInstance("strict", { MODEL: "x", PATH: "/tmp/evil", "rm -rf /": "1" }, { dir });
  expect(envOf("strict").get("MODEL")).toBe("x");
  expect(envOf("strict").get("PATH")).toBeUndefined();
});

test("names can't escape the runtime folder", () => {
  for (const bad of ["../evil", "..", "a/b", "", "waaaaaaaaaaaaaaaaaaaaytooooooong"]) {
    expect(() => readInstance(bad, dir)).toThrow();
    expect(() => deleteInstance(bad, dir)).toThrow();
  }
  createInstance({ name: "case", surfaces: ["slack"], dir });
  // Names are case-insensitive: the folder on disk is always lowercase.
  expect(readInstance("CASE", dir)?.name).toBe("case");
});

test("the listing puts hoo first, skips folders without an .env, and survives junk", () => {
  createInstance({ name: "zebra", surfaces: ["slack"], dir });
  createInstance({ name: "hoo", surfaces: ["slack"], dir });
  mkdirSync(join(dir, "shared"), { recursive: true });
  mkdirSync(join(dir, "notabot"), { recursive: true });
  writeFileSync(join(dir, "notabot", "readme.txt"), "no env here");

  expect(listInstances(dir).map((i) => i.name)).toEqual(["hoo", "zebra"]);
  expect(pidFor("hoo", dir)).toBeNull();
});

test("deleting needs a stopped bot", () => {
  createInstance({ name: "gone", surfaces: ["slack"], dir });
  expect(deleteInstance("gone", dir)).toBe(true);
  expect(readInstance("gone", dir)).toBeNull();
  expect(deleteInstance("gone", dir)).toBe(false);

  createInstance({ name: "busy", surfaces: ["slack"], dir });
  writeFileSync(join(dir, "busy", "busy.pid"), String(process.pid));
  expect(() => deleteInstance("busy", dir)).toThrow(/running/);
});