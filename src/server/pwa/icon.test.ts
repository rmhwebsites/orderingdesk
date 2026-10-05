import { describe, it, expect } from "vitest";
import { GLYPH_CHARACTERS, encodePng, iconText, renderIcon } from "./icon";

type DecodedPng = { width: number; height: number; colorType: number; pixels: Uint8Array };

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A strict reader for what encodePng writes: signature, IHDR, IDAT, IEND,
// every CRC checked, filter type 0 rows.
async function decodePng(png: Uint8Array): Promise<DecodedPng> {
  expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  const types: string[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.slice(offset + 4, offset + 8));
    const data = png.slice(offset + 8, offset + 8 + length);
    const crc = view.getUint32(offset + 8 + length);
    expect(crc).toBe(crc32(png.slice(offset + 4, offset + 8 + length)));
    types.push(type);
    if (type === "IHDR") {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      expect(data[8]).toBe(8);
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + length;
  }
  expect(types[0]).toBe("IHDR");
  expect(types[types.length - 1]).toBe("IEND");
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of idat) {
    joined.set(part, at);
    at += part.length;
  }
  const raw = await inflate(joined);
  const stride = width * 4;
  expect(raw.length).toBe(height * (stride + 1));
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0);
    pixels.set(raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, colorType, pixels };
}

function pixel(png: DecodedPng, x: number, y: number): [number, number, number, number] {
  const i = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  return [png.pixels[i], png.pixels[i + 1], png.pixels[i + 2], png.pixels[i + 3]];
}

describe("encodePng", () => {
  it("writes a valid RGBA PNG of the given pixels", async () => {
    const pixels = new Uint8Array(2 * 3 * 4);
    pixels.set([255, 0, 0, 255], 0);
    pixels.set([0, 0, 255, 128], (2 * 3 - 1) * 4);
    const decoded = await decodePng(await encodePng(2, 3, pixels));
    expect(decoded).toMatchObject({ width: 2, height: 3, colorType: 6 });
    expect(pixel(decoded, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded, 1, 2)).toEqual([0, 0, 255, 128]);
    expect(pixel(decoded, 1, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe("iconText", () => {
  it("is the first letter or digit of the name, accents dropped", () => {
    expect(iconText("IMPACT Rentals")).toBe("I");
    expect(iconText("  élan studio")).toBe("E");
    expect(iconText("3 Rivers Supply")).toBe("3");
    expect(iconText("(north) yard")).toBe("N");
  });

  it("falls back to the Ordering Desk monogram when there is none", () => {
    expect(iconText("")).toBe("OD");
    expect(iconText("東京")).toBe("OD");
  });

  it("has a glyph for every letter and digit", () => {
    expect(GLYPH_CHARACTERS).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
});

describe("renderIcon", () => {
  it("draws the letter in the foreground color on a full-bleed background (maskable)", async () => {
    const png = await decodePng(
      await renderIcon({ size: 192, text: "I", background: "#91d500", foreground: "#101820", shape: "square" }),
    );
    expect(png).toMatchObject({ width: 192, height: 192, colorType: 6 });
    // Corners and edges are background, fully opaque.
    expect(pixel(png, 0, 0)).toEqual([0x91, 0xd5, 0x00, 255]);
    expect(pixel(png, 191, 191)).toEqual([0x91, 0xd5, 0x00, 255]);
    expect(pixel(png, 20, 96)).toEqual([0x91, 0xd5, 0x00, 255]);
    // The I is one vertical stroke through the middle.
    expect(pixel(png, 96, 96)).toEqual([0x10, 0x18, 0x20, 255]);
    expect(pixel(png, 96, 70)).toEqual([0x10, 0x18, 0x20, 255]);
  });

  it("rounds the corners of the regular icon", async () => {
    const png = await decodePng(
      await renderIcon({ size: 512, text: "O", background: "#101820", foreground: "#91d500", shape: "rounded" }),
    );
    expect(pixel(png, 0, 0)[3]).toBe(0);
    expect(pixel(png, 511, 0)[3]).toBe(0);
    expect(pixel(png, 256, 4)).toEqual([0x10, 0x18, 0x20, 255]);
    // An O is a ring: its middle shows the background.
    expect(pixel(png, 256, 256)).toEqual([0x10, 0x18, 0x20, 255]);
  });

  it("keeps the mark inside the maskable safe zone (a centered circle, 80% wide)", async () => {
    for (const text of ["OD", "W", "M", "Q", "8"]) {
      const png = await decodePng(
        await renderIcon({ size: 192, text, background: "#ffffff", foreground: "#000000", shape: "square" }),
      );
      for (let y = 0; y < 192; y++) {
        for (let x = 0; x < 192; x++) {
          const [r] = pixel(png, x, y);
          if (r < 250) {
            expect(Math.hypot(x + 0.5 - 96, y + 0.5 - 96), `${text} at ${x},${y}`).toBeLessThan(192 * 0.4);
          }
        }
      }
    }
  });

  it("renders every glyph without throwing and with ink on the canvas", async () => {
    for (const text of GLYPH_CHARACTERS.split("")) {
      const png = await decodePng(
        await renderIcon({ size: 64, text, background: "#ffffff", foreground: "#000000", shape: "square" }),
      );
      let inked = 0;
      for (let i = 0; i < png.pixels.length; i += 4) {
        if (png.pixels[i] < 128) {
          inked++;
        }
      }
      expect(inked, text).toBeGreaterThan(20);
    }
  });
});
