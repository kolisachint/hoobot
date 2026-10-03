/**
 * Avatars are generated, not stored: the same seed must always draw the
 * same face, or a bot would look different on every reload and a `git
 * diff` would be full of noise.
 */
import { expect, test } from "bun:test";
import { AVATAR_SHAPES, avatarDataUri, avatarSvg, hashSeed, PALETTES, paletteFor } from "../src/avatar.ts";

test("the same seed draws the same avatar", () => {
  expect(avatarSvg(1234)).toBe(avatarSvg(1234));
  expect(avatarSvg(1234)).not.toBe(avatarSvg(1235));
  expect(hashSeed("pepper")).toBe(hashSeed("pepper"));
  expect(hashSeed("pepper")).not.toBe(hashSeed("plum"));
});

test("an avatar is self-contained svg", () => {
  const svg = avatarSvg(7, { name: "wren & friends" });
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain("</svg>");
  // No external anything: no fonts, scripts, css or hrefs.
  expect(svg).not.toMatch(/<(script|style|use|image)\b/);
  expect(svg).not.toMatch(/(href|url\(['"]?http)/);
  // The name is escaped, and only ever in the title.
  expect(svg).toContain("<title>wren &amp; friends</title>");
});

test("shape and palette are both honoured", () => {
  expect(avatarSvg(9, { shape: "circle" })).toContain("<circle cx=\"64\"");
  expect(avatarSvg(9, { shape: "squircle" })).toContain("<rect x=\"0\" y=\"0\" width=\"128\"");
  for (const shape of AVATAR_SHAPES) expect(avatarSvg(3, { shape })).toContain("</svg>");
  expect(avatarSvg(1, { palette: "teal" })).toContain(PALETTES.teal!.from);
  // An unknown palette falls back to something rather than throwing.
  expect(avatarSvg(1, { palette: "chartreuse" })).toContain("</svg>");
});

test("the pattern is mirrored, so the tile reads as designed", () => {
  const svg = avatarSvg(42);
  const xs: [number, number][] = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  expect(xs.length).toBeGreaterThan(8);
  // Every dot has a twin across the vertical centre line (x = 64).
  for (const [x, y] of xs) {
    const twin = xs.find(([tx, ty]) => Math.abs(tx - (128 - x)) < 0.05 && Math.abs(ty - y) < 0.05);
    expect(twin).toBeDefined();
  }
});

test("a palette is picked from the seed when none is chosen", () => {
  expect(paletteFor("teal", 5)).toBe(PALETTES.teal!);
  const fromSeed = paletteFor(undefined, 1);
  expect(Object.values(PALETTES).includes(fromSeed)).toBe(true);
  expect(paletteFor(undefined, 1)).toBe(fromSeed);
});

test("the data uri escapes the whole svg", () => {
  const uri = avatarDataUri(5, { name: "vee" });
  expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
  expect(uri).not.toContain("<svg");
  expect(decodeURIComponent(uri.slice("data:image/svg+xml,".length))).toContain("<title>vee</title>");
});
// ---------------------------------------------------------------- pet style

test("the pet style is a deterministic cartoon face", () => {
  const one = avatarSvg(4242, { style: "pet" });
  expect(one).toBe(avatarSvg(4242, { style: "pet" }));
  expect(one).not.toBe(avatarSvg(4243, { style: "pet" }));
  expect(one.startsWith("<svg")).toBe(true);
  // Self-contained, like the dot tile: no fonts, scripts, css or hrefs.
  expect(one).not.toMatch(/<(script|style|use|image)\b/);
  expect(one).not.toMatch(/(href|url\(['"]?http)/);
  // The face: two eyes with highlights, a smile, two cheeks.
  expect([...one.matchAll(/<ellipse cx="(\d+)" cy="68"/g)]).toHaveLength(2);
  expect(one).toContain('stroke="#221B33"');
  expect(one).toContain("q8 9 16 0");
});

test("pet honours shape and palette, and falls back rather than throwing", () => {
  expect(avatarSvg(9, { style: "pet", shape: "circle" })).toContain('<circle cx="64"');
  expect(avatarSvg(9, { style: "pet", shape: "squircle" })).toContain('<rect x="0" y="0" width="128"');
  expect(avatarSvg(1, { style: "pet", palette: "rose" })).toContain(PALETTES.rose!.from);
  expect(avatarSvg(1, { style: "pet", palette: "chartreuse" })).toContain("</svg>");
  // dots is the default, so nobody's saved bot changes face under them.
  expect(avatarSvg(4242)).toBe(avatarSvg(4242, { style: "dots" }));
  expect(avatarSvg(4242, { style: "dots" })).not.toBe(avatarSvg(4242, { style: "pet" }));
});

test("a pet avatar escapes its name, like the dot tile", () => {
  expect(avatarSvg(3, { style: "pet", name: "wren & friends" })).toContain("<title>wren &amp; friends</title>");
  expect(decodeURIComponent(avatarDataUri(5, { style: "pet", name: "vee" }).slice("data:image/svg+xml,".length))).toContain("<title>vee</title>");
});
