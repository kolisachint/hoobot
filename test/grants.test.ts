import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
const { Grants } = await import("../src/grants.ts");

/** A fresh folder, and a file path inside a subfolder that does not exist yet. */
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "hoobot-grants-"));
  return { dir, file: join(dir, "nested", "approvals.json") };
}

test("an added user is still granted after a restart (a new instance on the same file)", () => {
  const { dir, file } = tmp();
  try {
    expect(new Grants(file).has("U1")).toBe(false); // no file yet: empty, not an error

    const first = new Grants(file);
    first.add("U1");
    first.add("U1"); // no duplicate
    expect(first.has("U1")).toBe(true);
    expect(first.has("U2")).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["U1"]);

    const reloaded = new Grants(file);
    expect(reloaded.has("U1")).toBe(true);
    expect(reloaded.has("U2")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt file is treated as empty, and an add never overwrites it", () => {
  const { dir, file } = tmp();
  try {
    mkdirSync(join(dir, "nested"));
    writeFileSync(file, "{not json");
    const g = new Grants(file);
    expect(g.has("U1")).toBe(false);
    g.add("U1"); // kept in memory for this run only
    expect(g.has("U1")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("{not json");
    expect(new Grants(file).has("U1")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file path that is a directory: add does not throw and does not destroy it", () => {
  const { dir, file } = tmp();
  try {
    mkdirSync(file, { recursive: true }); // a folder where the grants file should be (EISDIR on read)
    const g = new Grants(file);
    expect(() => g.add("U1")).not.toThrow();
    expect(g.has("U1")).toBe(true);
    expect(statSync(file).isDirectory()).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a save writes through a temp file and leaves no .tmp behind", () => {
  const { dir, file } = tmp();
  try {
    new Grants(file).add("U1");
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["U1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid JSON that is not a list of ids is ignored entry by entry", () => {
  const { dir, file } = tmp();
  try {
    mkdirSync(join(dir, "nested"));
    writeFileSync(file, JSON.stringify({ U1: true }));
    expect(new Grants(file).has("U1")).toBe(false);
    writeFileSync(file, JSON.stringify(["U2", 3, null]));
    expect(new Grants(file).has("U2")).toBe(true);
    expect(new Grants(file).has("3")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
