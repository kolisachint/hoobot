/**
 * Render a hoobot avatar as a PNG, for anything that wants a bitmap:
 * the Slack app icon, an email signature, a README.
 *
 * SVG is what the manager serves; Slack's uploader wants a square PNG of at
 * least 128px (512 is what it displays best at). Rasterising here keeps the
 * face identical to the one in the chat, because both come from
 * `avatarSvg(seed)` — one source, two formats.
 *
 *   bun avatar-png.ts --seed 4242 --style pet --shape squircle --palette rose --out hee.png
 *   bun avatar-png.ts --name hee --out hee.png     # seed from the name, as the manager does
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Find hoobot's `avatar.ts`. The published package is the source of truth
 * (see hoobot's AGENTS.md: only the npm build is what runs), so look there
 * first and fall back to a checkout for development.
 */
async function avatarModule(): Promise<typeof import("../../../../../github/hoobot/src/avatar.ts")> {
  const candidates = [
    process.env.HOOBOT_SRC,
    join(homedir(), ".local/share/bun/install/global/node_modules/@kolisachint/hoobot/src/avatar.ts"),
    join(homedir(), "github/hoobot/src/avatar.ts"),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return await import(path);
  }
  throw new Error(`hoobot's avatar.ts not found. Looked in:\n${candidates.join("\n")}\nSet HOOBOT_SRC to its path.`);
}

const { avatarSvg, hashSeed, PALETTES } = await avatarModule();

/**
 * An older hoobot doesn't know every style, and it says so by ignoring the
 * option — which would quietly save the wrong face. Ask for what was asked
 * for and say what's installed instead of shipping a lie.
 */
function supports(style: string, shape: string): boolean {
  const wanted = { style: style as never, shape: shape as never };
  if (avatarSvg(1, wanted) !== avatarSvg(1, { shape: shape as never })) return true;
  console.error(
    `avatar-png: this hoobot (${process.env.HOOBOT_SRC ?? "the installed one"}) does not support style=${style} or shape=${shape}.\n` +
      `It printed a default instead. Update it: bun add -g @kolisachint/hoobot@latest`,
  );
  return false;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const name = arg("name");
const seed = arg("seed") ? Number(arg("seed")) : hashSeed(name ?? "hoo");
const shape = arg("shape") === "squircle" ? "squircle" : "circle";
const style = arg("style") === "dots" ? "dots" : "pet";
const palette = arg("palette");
if (palette && !PALETTES[palette]) throw new Error(`unknown palette: ${palette}. One of ${Object.keys(PALETTES).join(", ")}`);
const out = arg("out") ?? `${name ?? "avatar"}.png`;
const size = Number(arg("size") ?? 512);

if (!supports(style, shape)) process.exit(1);

const svg = avatarSvg(seed, { shape, style, palette, name });
// Quick Look renders at `-s` but keeps the SVG's own pixel size, so a 128px
// viewBox comes back letterboxed inside the square. Declaring the real size
// makes the PNG fill the frame edge to edge, which is what an app icon wants.
const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);

/** SVG → PNG with whatever the machine already has. No new dependency. */
async function toPng(markup: string, px: number): Promise<Uint8Array> {
  // Quick Look writes `<name>.svg.png` next to the input, so the work
  // happens in its own folder: no stray files in whatever directory the
  // user happened to be in, and no chance of clobbering the output.
  const dir = join(tmpdir(), `avatar-${Date.now().toString(36)}`);
  try {
    const src = join(dir, "face.svg");
    await Bun.write(src, markup);
    const proc = Bun.spawn(["qlmanage", "-t", "-s", String(px), "-o", dir, src], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    const png = Bun.file(join(dir, "face.svg.png"));
    if (!(await png.exists())) throw new Error("qlmanage produced no PNG; is this macOS with Quick Look?");
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    await Bun.$`rm -rf ${dir}`.quiet();
  }
}

const png = await toPng(sized, size);
await Bun.write(out, png);
console.log(`${out} — ${png.length} bytes, ${size}×${size}, style ${style}, shape ${shape}, palette ${palette ?? "from seed"}, seed ${seed}`);