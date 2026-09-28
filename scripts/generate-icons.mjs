/**
 * Icon generator for Ducky Coder Lite.
 *
 * Draws the brand mark procedurally and writes real PNG files, so the icons are
 * original assets produced from code rather than traced from anything.
 *
 * Why hand-rasterise instead of shipping an SVG or using a rasteriser library:
 *   * Tauri needs PNG (and, for Windows and macOS bundles, ICO and ICNS) at
 *     specific sizes, and it needs them at build time on any machine;
 *   * a rasteriser dependency would be a dev dependency for a one-off job;
 *   * ~200 lines of geometry is smaller than the dependency, and it is exact.
 *
 * Run with:  node scripts/generate-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "src-tauri", "icons");

// ---------------------------------------------------------------------------
// A tiny RGBA canvas with just enough drawing to make an icon
// ---------------------------------------------------------------------------

class Canvas {
  constructor(size) {
    this.size = size;
    // Premultiplied-free straight RGBA, row-major.
    this.data = new Uint8ClampedArray(size * size * 4);
  }

  /** Coverage-aware source-over blend of one pixel. `cov` is 0..1. */
  blend(x, y, [r, g, b, a], cov = 1) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const alpha = (a / 255) * cov;
    if (alpha <= 0) return;
    const i = (y * this.size + x) * 4;
    const d = this.data;
    const dstA = d[i + 3] / 255;
    const outA = alpha + dstA * (1 - alpha);
    if (outA <= 0) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      return;
    }
    d[i] = (r * alpha + d[i] * dstA * (1 - alpha)) / outA;
    d[i + 1] = (g * alpha + d[i + 1] * dstA * (1 - alpha)) / outA;
    d[i + 2] = (b * alpha + d[i + 2] * dstA * (1 - alpha)) / outA;
    d[i + 3] = outA * 255;
  }

  /**
   * Fill every pixel for which `sdf(x, y)` is negative, with 1px of analytic
   * antialiasing on the boundary. Working from a signed distance function rather
   * than a scanline fill is what makes the edges clean at 32px.
   */
  fill(sdf, colorAt) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const d = sdf(px, py);
        if (d > 1) continue;
        const cov = d <= -1 ? 1 : 1 - d;
        this.blend(x, y, colorAt(px, py), cov);
      }
    }
  }
}

// -- signed distance helpers (all in a 0..1 normalised space) ----------------

const sdCircle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

const sdEllipse = (cx, cy, rx, ry) => (x, y) => {
  // Approximate SDF: exact enough for antialiasing at icon sizes.
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  const k = Math.hypot(dx, dy);
  return (k - 1) * Math.min(rx, ry);
};

const sdRoundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  );
};

/** A capsule (thick line segment), used for the duck's bill and neck. */
const sdCapsule = (ax, ay, bx, by, r) => (x, y) => {
  const pax = x - ax;
  const pay = y - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
};

/** Union of several SDFs. */
const union = (...fns) => (x, y) => Math.min(...fns.map((f) => f(x, y)));

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

/** The palette, matching the app's CSS tokens. */
const INK = [0x0b, 0x0e, 0x14, 255];
const BG_TOP = [0x16, 0x1b, 0x24, 255];
const BG_BOTTOM = [0x0b, 0x0e, 0x14, 255];
const AMBER = [0xe8, 0xb3, 0x39, 255];
const AMBER_LIGHT = [0xf5, 0xd1, 0x7a, 255];

/**
 * Draw the icon at a given size.
 *
 * The mark is a duck head in profile: a rounded body, a neck that curves down
 * into the frame, a bill, and one eye. Drawn as a union of SDFs so it stays
 * crisp at every size the bundler asks for.
 */
function drawMark(size) {
  const c = new Canvas(size);
  const s = (v) => v * size; // normalised -> pixels

  // Background: a rounded square with a vertical gradient.
  const bg = sdRoundRect(s(0.5), s(0.5), s(0.5), s(0.5), s(0.22));
  c.fill(bg, (_x, y) => {
    const t = y / size;
    return [
      BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t,
      BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t,
      BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t,
      255,
    ];
  });

  // A soft accent glow behind the mark, so the mark reads on both light and dark
  // taskbars without a hard outline.
  c.fill(sdCircle(s(0.5), s(0.48), s(0.3)), () => [232, 179, 57, 16]);

  // --- The duck -----------------------------------------------------------
  // Head: an ellipse tilted slightly forward.
  const head = sdEllipse(s(0.45), s(0.44), s(0.165), s(0.15));
  // Neck: a slender capsule running down and to the left, exiting the frame.
  const neck = sdCapsule(s(0.415), s(0.5), s(0.325), s(0.84), s(0.082));
  // Bill: two capsules forming a slightly tapered wedge.
  const bill = sdCapsule(s(0.58), s(0.435), s(0.79), s(0.468), s(0.042));
  const billLower = sdCapsule(s(0.58), s(0.47), s(0.765), s(0.5), s(0.036));
  // Chest: a small join so head and neck read as one continuous shape.
  const chest = sdEllipse(s(0.375), s(0.6), s(0.125), s(0.105));

  const duck = union(head, neck, chest, bill, billLower);
  c.fill(duck, (_x, y) => {
    // A vertical gradient on the mark itself gives it depth at large sizes.
    const t = Math.max(0, Math.min(1, (y / size - 0.3) / 0.6));
    return [
      AMBER_LIGHT[0] + (AMBER[0] - AMBER_LIGHT[0]) * t,
      AMBER_LIGHT[1] + (AMBER[1] - AMBER_LIGHT[1]) * t,
      AMBER_LIGHT[2] + (AMBER[2] - AMBER_LIGHT[2]) * t,
      255,
    ];
  });

  // Cut the eye in the background colour so it reads as a hole rather than as a
  // mark drawn on top of the shape.
  const eye = sdCircle(s(0.478), s(0.4), s(0.032));
  const bgColor = (_x, y) => {
    const t = y / size;
    return [
      BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t,
      BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t,
      BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t,
      255,
    ];
  };
  // Only paint the eye where it is actually inside the duck.
  // "inside eye AND inside duck" == max(eye, duck) < 0 under the convention
  // that a negative signed distance means inside.
  c.fill(
    (x, y) => Math.max(eye(x, y), duck(x, y)),
    bgColor,
  );

  // Outline the whole mark with a thin dark keyline: this is what keeps it
  // legible against a light desktop background at 32px.
  c.fill(
    (x, y) => {
      const d = duck(x, y);
      const w = Math.max(1.1, size * 0.016);
      return Math.abs(d) - w;
    },
    () => INK,
  );

  return c;
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode a canvas as an 8-bit RGBA PNG. */
function encodePng(canvas) {
  const { size, data } = canvas;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    // Filter type 0 (None) per scanline. Combined with deflate this is compact
    // enough, and it keeps the encoder short and obviously correct.
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size * 4; x++) {
      raw[y * (size * 4 + 1) + 1 + x] = data[y * size * 4 + x];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
  ["Square30x30Logo.png", 30],
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square89x89Logo.png", 89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
  ["StoreLogo.png", 50],
];

for (const [name, size] of targets) {
  const canvas = drawMark(size);
  writeFileSync(join(OUT_DIR, name), encodePng(canvas));
  process.stdout.write(`wrote ${name} (${size}x${size})\n`);
}

// A monochrome variant for tray use, where a colour mark would be invisible.
{
  const canvas = drawMark(64);
  for (let i = 0; i < canvas.data.length; i += 4) {
    const a = canvas.data[i + 3];
    canvas.data[i] = 0xd5;
    canvas.data[i + 1] = 0xda;
    canvas.data[i + 2] = 0xe3;
    canvas.data[i + 3] = a;
  }
  writeFileSync(join(OUT_DIR, "tray.png"), encodePng(canvas));
  process.stdout.write("wrote tray.png (64x64)\n");
}

process.stdout.write(`\nAll icons written to ${OUT_DIR}\n`);
