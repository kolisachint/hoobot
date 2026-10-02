/**
 * Bot avatars as inline SVG.
 *
 * A bot is a small coloured dot-grid tile, in the OpenAI / Grok avatar
 * idiom: a soft gradient tile with a symmetric constellation of dots, some
 * solid and some barely there. It has to read as *designed* at 24px in a
 * list, which is why the pattern is mirrored about the vertical axis and
 * the palette is curated — a purely random grid reads as noise.
 *
 * Two properties matter and are enforced here:
 *
 * - **Deterministic.** The same seed always produces byte-identical SVG,
 *   so an avatar survives a page reload, a restart and a `git diff` of
 *   nothing. Nothing about the avatar is stored on disk except the seed.
 * - **Self-contained.** No fonts, no CSS, no external references, no
 *   scripts. It can be inlined into the page, served as `image/svg+xml`,
 *   or pasted into a chat client without breaking.
 *
 * The seed is derived from the instance name, so a bot keeps its face
 * unless the user asks for a new one.
 */

/** The tile outline. A circle is the chat default; a squircle reads as an app icon. */
export type AvatarShape = "circle" | "squircle";

/** Two gradient stops plus the dot colour. Curated, not random: a random hue is usually ugly. */
export type AvatarPalette = { from: string; to: string; dot: string; label: string };

export const AVATAR_SHAPES: AvatarShape[] = ["circle", "squircle"];

/**
 * Palettes are picked to stay distinguishable from each other at a glance
 * and to keep white dots legible on both stops.
 */
export const PALETTES: Record<string, AvatarPalette> = {
  amber: { from: "#F6A94C", to: "#E4762B", dot: "#FFF6EA", label: "Amber" },
  teal: { from: "#57CFC0", to: "#1E8E86", dot: "#F0FFFC", label: "Teal" },
  violet: { from: "#A48CF0", to: "#6C4BD8", dot: "#F7F3FF", label: "Violet" },
  rose: { from: "#F2899E", to: "#C9456B", dot: "#FFF2F5", label: "Rose" },
  slate: { from: "#8FA3B8", to: "#4A5C70", dot: "#F4F7FA", label: "Slate" },
  lime: { from: "#A8D75A", to: "#5E9B27", dot: "#F7FFE9", label: "Lime" },
};

/** Palette ids in the order the UI offers them. */
export const PALETTE_IDS = Object.keys(PALETTES);

/**
 * FNV-1a. Small, stable and dependency-free; `crypto` would work but a
 * 32-bit hash of a name does not need a cryptographic one.
 */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — tiny seeded PRNG, so a seed always gives the same dots. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZE = 128;
const GRID = 7;
/** Cells with a lower random value than this are left empty, for texture. */
const EMPTY_BELOW = 0.18;

/** The palette for an id, or one chosen deterministically from the seed. */
export function paletteFor(id: string | undefined, seed = 0): AvatarPalette {
  const wanted = id ?? PALETTE_IDS[seed % PALETTE_IDS.length];
  return PALETTES[wanted ?? "amber"] ?? PALETTES.amber!;
}

/** Escape text for use inside XML attribute or element content. */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[c]};`);
}

/**
 * The avatar SVG for a seed.
 *
 * `name` only ever appears in the `<title>` (for hover text and screen
 * readers); the picture itself depends on the seed alone, so renaming a bot
 * is a different avatar and that is fine — the user can re-roll.
 */
export function avatarSvg(
  seed: number,
  opts: { shape?: AvatarShape; palette?: string; name?: string } = {},
): string {
  const shape = opts.shape ?? "circle";
  const palette = paletteFor(opts.palette, seed);
  const name = opts.name?.trim();
  const gid = `a${(seed >>> 0).toString(36)}`;
  const clip = `c${gid}`;
  const rand = rng((seed >>> 0) ^ 0x9e3779b9);

  const clipShape =
    shape === "circle"
      ? `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}"/>`
      : `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="30" ry="30"/>`;

  // Grid geometry: an even spread with the dots inset from the tile edge.
  const pad = 26;
  const span = SIZE - pad * 2;
  const step = span / (GRID - 1);

  const dots: string[] = [];
  for (let row = 0; row < GRID; row++) {
    const y = pad + row * step;
    for (let col = 0; col < GRID; col++) {
      // Mirror about the vertical axis: the pattern is designed, not sampled.
      if (col > (GRID - 1) / 2) continue;
      const value = rand();
      if (value < EMPTY_BELOW) continue;
      const x = pad + col * step;
      // A wide radius/opacity range is what makes the tile read as a
      // constellation rather than a uniform texture, especially at 24px.
      const radius = 2.4 + value * 4.6;
      const opacity = 0.24 + value * 0.62;
      dots.push(
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" opacity="${opacity.toFixed(2)}"/>`,
      );
      const mirrored = GRID - 1 - col;
      if (mirrored !== col) {
        const mx = pad + mirrored * step;
        dots.push(
          `<circle cx="${mx.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" opacity="${opacity.toFixed(2)}"/>`,
        );
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-hidden="false">`,
    name ? `<title>${esc(name)}</title>` : "",
    `<defs>`,
    `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(135 0.5 0.5)">`,
    `<stop offset="0%" stop-color="${palette.from}"/><stop offset="100%" stop-color="${palette.to}"/>`,
    `</linearGradient>`,
    `<clipPath id="${clip}">${clipShape}</clipPath>`,
    `</defs>`,
    `<g clip-path="url(#${clip})">`,
    `<rect width="${SIZE}" height="${SIZE}" fill="url(#${gid})"/>`,
    `<g fill="${palette.dot}">${dots.join("")}</g>`,
    // A soft sheen from the top left, so the tile reads as a physical object.
    `<ellipse cx="${SIZE * 0.32}" cy="${SIZE * 0.16}" rx="${SIZE * 0.5}" ry="${SIZE * 0.34}" fill="#FFFFFF" opacity="0.10"/>`,
    `</g>`,
    // A hairline keeps the tile crisp against a light page background.
    shape === "circle"
      ? `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 0.5}" fill="none" stroke="#000000" stroke-opacity="0.08" stroke-width="1"/>`
      : `<rect x="0.5" y="0.5" width="${SIZE - 1}" height="${SIZE - 1}" rx="29.5" fill="none" stroke="#000000" stroke-opacity="0.08"/>`,
    `</svg>`,
  ].join("");
}

/** The avatar as a data URI, for places that want an `src` (CSS, `<img>`). */
export function avatarDataUri(seed: number, opts: { shape?: AvatarShape; palette?: string; name?: string } = {}): string {
  return `data:image/svg+xml,${encodeURIComponent(avatarSvg(seed, opts))}`;
}