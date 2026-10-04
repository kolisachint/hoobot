import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSince, pathsInText, pickAttachments } from "../src/attachments.ts";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "hoobot-att-"));
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "out", "report.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "chart.png"), "png");
  writeFileSync(join(dir, "main.ts"), "code");
  return dir;
}

test("picks known file types inside the work folder, once each", () => {
  const dir = workspace();
  const { files, skipped } = pickAttachments(
    ["out/report.html", join(dir, "out", "report.html"), "chart.png", "main.ts", "missing.html"],
    dir,
  );
  expect(files.map((f) => f.name)).toEqual(["report.html", "chart.png"]);
  expect(skipped).toEqual([]);
});

test("never attaches files outside the work folder, even via symlink", () => {
  const dir = workspace();
  const outside = mkdtempSync(join(tmpdir(), "hoobot-out-"));
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
  const { files } = pickAttachments([join(outside, "secret.txt"), "../x.txt", "link.txt"], dir);
  expect(files).toEqual([]);
});

test("caps the number of files", () => {
  const dir = workspace();
  const names = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
  for (const n of names) writeFileSync(join(dir, n), "x");
  const { files, skipped } = pickAttachments(names, dir);
  expect(files).toHaveLength(10);
  expect(skipped).toEqual(["f10.txt", "f11.txt"]);
});

test("sends one copy of a deliverable reachable by two paths", () => {
  // The write tool reports .work/slug/page.html, deliver.sh copies it to
  // out/slug/page.html and the folder scan finds that one. Both are real,
  // different files with one name, so both used to be uploaded.
  const dir = workspace();
  mkdirSync(join(dir, ".work", "report"), { recursive: true });
  writeFileSync(join(dir, ".work", "report", "report.html"), "<h1>hi</h1>");
  const { files } = pickAttachments(
    [".work/report/report.html", join(dir, "out", "report.html"), "out/report.html"],
    dir,
  );
  expect(files.map((f) => f.name)).toEqual(["report.html"]);
});

test("never sends a file from a dot folder, so scratch stays scratch", () => {
  const dir = workspace();
  mkdirSync(join(dir, ".work"), { recursive: true });
  writeFileSync(join(dir, ".work", "draft.html"), "<p>d</p>");
  writeFileSync(join(dir, ".secret.md"), "shh");
  expect(pickAttachments([".work/draft.html", ".secret.md"], dir).files).toEqual([]);
});

test("a page goes out without its preview image", () => {
  const dir = workspace();
  writeFileSync(join(dir, "out", "report.png"), "png");
  writeFileSync(join(dir, "out", "photo.png"), "png");
  // Either order: the image may be found before the page.
  expect(pickAttachments(["out/report.png", "out/report.html"], dir).files.map((f) => f.name)).toEqual(["report.html"]);
  expect(pickAttachments(["out/report.html", "out/report.png"], dir).files.map((f) => f.name)).toEqual(["report.html"]);
  // An image nobody paired with a page is still worth sending.
  expect(pickAttachments(["out/photo.png"], dir).files.map((f) => f.name)).toEqual(["photo.png"]);
});

test("finds file names in the answer, not URLs or source files", () => {
  expect(pathsInText("Saved `out/report.html` and ./chart.png. See https://x.com/a.html, edited main.ts")).toEqual([
    "out/report.html",
    "chart.png",
  ]);
});

test("changedSince finds new files of known types, skipping dot and build folders", async () => {
  const { utimesSync } = await import("node:fs");
  const dir = workspace();
  const old = Date.now() / 1000 - 3600;
  for (const f of ["out/report.html", "chart.png", "main.ts"]) utimesSync(join(dir, f), old, old);
  const since = Date.now() - 1000;
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, ".git", "x.txt"), "x");
  writeFileSync(join(dir, "node_modules", "y.html"), "y");
  writeFileSync(join(dir, "out", "new.html"), "<p>new</p>");
  writeFileSync(join(dir, "new.ts"), "x");
  expect(changedSince(dir, since)).toEqual([join(dir, "out", "new.html")]);
});

test("TurnLog: overlap per folder; claimChanged keeps only named files when overlapped", async () => {
  const { TurnLog, claimChanged } = await import("../src/attachments.ts");
  const log = new TurnLog();
  log.begin("/w", "a", 0);
  log.end("/w", "a", 10);
  log.begin("/w", "b", 20); // after a ended
  log.begin("/other", "c", 5); // another folder
  expect(log.overlapped("/w", "a", 30)).toBe(false);
  log.begin("/w", "d", 25);
  expect(log.overlapped("/w", "b", 30)).toBe(true);

  const changed = ["/w/out/a.html", "/w/b.svg"];
  expect(claimChanged(changed, "/w", true, "")).toEqual(changed);
  expect(claimChanged(changed, "/w", false, "wrote out/a.html")).toEqual(["/w/out/a.html"]);
  expect(claimChanged(changed, "/w", false, "convert x > b.svg")).toEqual(["/w/b.svg"]);
  expect(claimChanged(changed, "/w", false, "nothing named; xb.svg.bak")).toEqual([]);
});

test("claimChanged matches whole names, ./ and absolute paths, and a trailing full stop", async () => {
  const { claimChanged } = await import("../src/attachments.ts");
  const f = ["/w/b.svg"];
  for (const text of ["> ./b.svg", "Saved /w/b.svg", "Wrote b.svg.", "`b.svg`"]) expect(claimChanged(f, "/w", false, text)).toEqual(f);
  for (const text of ["sub/b.svg", "ab.svg", "b.svg.bak", "b.svg-old"]) expect(claimChanged(f, "/w", false, text)).toEqual([]);
});
