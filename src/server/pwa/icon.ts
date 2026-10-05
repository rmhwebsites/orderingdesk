// App icons drawn on the server, for the web app manifest and the iPhone
// home screen icon (src/server/pwa/manifest.ts): a letter (or the Ordering
// Desk "OD" monogram) on a solid background, as a PNG. Used for the hub and
// for a client host without an uploaded symbol.
//
// No image library: the letters are a small monoline stroke font (straight
// strokes and circular arcs on a 100 unit cap height, round caps), drawn by
// distance with anti-aliased edges, and the PNG is written here with the
// platform's own deflate (CompressionStream, on Workers and in Node).

export const GLYPH_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// L: a straight stroke from (x1, y1) to (x2, y2). A: an arc of the circle
// at (cx, cy) with radius r, from angle a0 to a1 in degrees, clockwise on
// screen (y grows downward), a0 < a1.
type Stroke = ["L", number, number, number, number] | ["A", number, number, number, number, number];

const L = (x1: number, y1: number, x2: number, y2: number): Stroke => ["L", x1, y1, x2, y2];
const A = (cx: number, cy: number, r: number, a0: number, a1: number): Stroke => ["A", cx, cy, r, a0, a1];

const GLYPHS: Record<string, Stroke[]> = {
  A: [L(0, 100, 36, 0), L(36, 0, 72, 100), L(15, 64, 57, 64)],
  B: [L(0, 0, 0, 100), L(0, 0, 34, 0), A(34, 24.5, 24.5, -90, 90), L(0, 49, 38, 49), A(38, 74.5, 25.5, -90, 90), L(38, 100, 0, 100)],
  C: [A(50, 50, 50, 40, 320)],
  D: [L(0, 0, 0, 100), L(0, 0, 25, 0), A(25, 50, 50, -90, 90), L(25, 100, 0, 100)],
  E: [L(0, 0, 0, 100), L(0, 0, 58, 0), L(0, 50, 50, 50), L(0, 100, 58, 100)],
  F: [L(0, 0, 0, 100), L(0, 0, 58, 0), L(0, 50, 50, 50)],
  G: [A(50, 50, 50, 0, 320), L(56, 50, 100, 50)],
  H: [L(0, 0, 0, 100), L(68, 0, 68, 100), L(0, 50, 68, 50)],
  I: [L(0, 0, 0, 100)],
  J: [L(52, 0, 52, 74), A(26, 74, 26, 0, 180)],
  K: [L(0, 0, 0, 100), L(62, 0, 0, 62), L(22, 40, 64, 100)],
  L: [L(0, 0, 0, 100), L(0, 100, 56, 100)],
  M: [L(0, 100, 0, 0), L(0, 0, 42, 72), L(42, 72, 84, 0), L(84, 0, 84, 100)],
  N: [L(0, 100, 0, 0), L(0, 0, 68, 100), L(68, 100, 68, 0)],
  O: [A(50, 50, 50, 0, 360)],
  P: [L(0, 0, 0, 100), L(0, 0, 34, 0), A(34, 27, 27, -90, 90), L(34, 54, 0, 54)],
  Q: [A(50, 50, 50, 0, 360), L(64, 64, 98, 98)],
  R: [L(0, 0, 0, 100), L(0, 0, 34, 0), A(34, 27, 27, -90, 90), L(34, 54, 0, 54), L(32, 54, 66, 100)],
  S: [A(34, 25, 25, 90, 330), A(34, 75, 25, -90, 150)],
  T: [L(0, 0, 72, 0), L(36, 0, 36, 100)],
  U: [L(0, 0, 0, 67), L(66, 0, 66, 67), A(33, 67, 33, 0, 180)],
  V: [L(0, 0, 36, 100), L(36, 100, 72, 0)],
  W: [L(0, 0, 24, 100), L(24, 100, 48, 24), L(48, 24, 72, 100), L(72, 100, 96, 0)],
  X: [L(0, 0, 66, 100), L(66, 0, 0, 100)],
  Y: [L(0, 0, 36, 52), L(72, 0, 36, 52), L(36, 52, 36, 100)],
  Z: [L(0, 0, 66, 0), L(66, 0, 0, 100), L(0, 100, 66, 100)],
  "0": [A(32, 32, 32, 180, 360), L(64, 32, 64, 68), A(32, 68, 32, 0, 180), L(0, 68, 0, 32)],
  "1": [L(8, 20, 34, 0), L(34, 0, 34, 100)],
  "2": [A(31, 30, 30, 190, 380), L(59.2, 40.3, 0, 100), L(0, 100, 64, 100)],
  "3": [A(30, 25, 25, 200, 450), A(30, 75, 25, -90, 160)],
  "4": [L(46, 100, 46, 0), L(46, 0, 0, 68), L(0, 68, 64, 68)],
  "5": [L(58, 0, 8, 0), L(8, 0, 7.5, 46.3), A(31, 68, 32, 222.7, 520)],
  "6": [A(32, 68, 32, 0, 360), L(50, 0, 3, 57)],
  "7": [L(0, 0, 64, 0), L(64, 0, 20, 100)],
  "8": [A(32, 24, 23, 0, 360), A(32, 74, 26, 0, 360)],
  "9": [A(32, 32, 32, 0, 360), L(61, 43, 14, 100)],
};

const STROKE = 15;
const LETTER_GAP = 24;
const MONOGRAM = "OD";

// The mark for a workspace: the first letter or digit of its name (accents
// dropped, so "Élan" is E), else the Ordering Desk monogram.
export function iconText(name: string): string {
  const plain = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  for (const char of plain) {
    if (GLYPH_CHARACTERS.includes(char)) {
      return char;
    }
  }
  return MONOGRAM;
}

type Box = { minX: number; maxX: number };

function strokeBox(stroke: Stroke): Box {
  if (stroke[0] === "L") {
    return { minX: Math.min(stroke[1], stroke[3]), maxX: Math.max(stroke[1], stroke[3]) };
  }
  const [, cx, , r, a0, a1] = stroke;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let a = a0; a <= a1; a += 2) {
    const x = cx + r * Math.cos((a * Math.PI) / 180);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  const end = cx + r * Math.cos((a1 * Math.PI) / 180);
  return { minX: Math.min(minX, end), maxX: Math.max(maxX, end) };
}

function glyphBox(strokes: Stroke[]): Box {
  return strokes.map(strokeBox).reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX) }));
}

// Distance from (px, py) to a stroke's center line, in font units.
function distanceTo(stroke: Stroke, px: number, py: number): number {
  if (stroke[0] === "L") {
    const [, x1, y1, x2, y2] = stroke;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  const [, cx, cy, r, a0, a1] = stroke;
  const vx = px - cx;
  const vy = py - cy;
  const span = a1 - a0;
  if (span >= 360) {
    return Math.abs(Math.hypot(vx, vy) - r);
  }
  const angle = (Math.atan2(vy, vx) * 180) / Math.PI;
  const along = (((angle - a0) % 360) + 360) % 360;
  if (along <= span) {
    return Math.abs(Math.hypot(vx, vy) - r);
  }
  const end = (a: number) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [sx, sy] = end(a0);
  const [ex, ey] = end(a1);
  return Math.min(Math.hypot(px - sx, py - sy), Math.hypot(px - ex, py - ey));
}

type Placed = { strokes: Stroke[]; offsetX: number };

// The text laid out on one line in font units, starting at x = 0.
function layout(text: string): { placed: Placed[]; width: number } {
  const placed: Placed[] = [];
  let x = 0;
  for (const char of text) {
    const strokes = GLYPHS[char] ?? GLYPHS.O;
    const box = glyphBox(strokes);
    placed.push({ strokes, offsetX: x - box.minX });
    x += box.maxX - box.minX + LETTER_GAP;
  }
  return { placed, width: Math.max(0, x - LETTER_GAP) };
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export type IconOptions = {
  size: number;
  text: string;
  // #rrggbb.
  background: string;
  foreground: string;
  // square: full bleed (maskable icons and the iPhone, which rounds its own
  // corners); rounded: transparent rounded corners, for everything else.
  shape: "square" | "rounded";
};

// Coverage of the rounded square at pixel center (x, y), 0 to 1.
function shapeCoverage(shape: IconOptions["shape"], size: number, x: number, y: number): number {
  if (shape === "square") {
    return 1;
  }
  const radius = size * 0.22;
  const qx = Math.abs(x - size / 2) - (size / 2 - radius);
  const qy = Math.abs(y - size / 2) - (size / 2 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  return Math.max(0, Math.min(1, 0.5 - outside));
}

export function renderIconPixels(opts: IconOptions): Uint8Array {
  const { size } = opts;
  const { placed, width } = layout(opts.text);
  // Cap height near 40% of the icon for one letter, never wider than 56%
  // (64% for the two-letter monogram, whose round ends leave the corners
  // empty), so the mark sits inside the maskable safe zone (a centered
  // circle 80% wide).
  const capShare = 0.4;
  const widthShare = opts.text.length > 1 ? 0.64 : 0.56;
  const scale = Math.min((size * capShare) / 100, (size * widthShare) / (width + STROKE));
  const originX = (size - width * scale) / 2;
  const originY = (size - 100 * scale) / 2;
  const half = (STROKE * scale) / 2;
  const reach = half + 1;
  const bg = hexRgb(opts.background);
  const fg = hexRgb(opts.foreground);
  const out = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const shape = shapeCoverage(opts.shape, size, cx, cy);
      let ink = 0;
      if (cy >= originY - reach - 6 * scale && cy <= originY + 106 * scale + reach) {
        let nearest = Infinity;
        for (const glyph of placed) {
          const ux = (cx - originX) / scale - glyph.offsetX;
          const uy = (cy - originY) / scale;
          for (const stroke of glyph.strokes) {
            nearest = Math.min(nearest, distanceTo(stroke, ux, uy) * scale);
          }
        }
        ink = Math.max(0, Math.min(1, half - nearest + 0.5));
      }
      const i = (y * size + x) * 4;
      out[i] = Math.round(bg[0] + (fg[0] - bg[0]) * ink);
      out[i + 1] = Math.round(bg[1] + (fg[1] - bg[1]) * ink);
      out[i + 2] = Math.round(bg[2] + (fg[2] - bg[2]) * ink);
      out[i + 3] = Math.round(255 * shape);
    }
  }
  return out;
}

export async function renderIcon(opts: IconOptions): Promise<Uint8Array> {
  return encodePng(opts.size, opts.size, renderIconPixels(opts));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// An 8-bit RGBA PNG (no filtering, one IDAT) of width x height pixels.
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
