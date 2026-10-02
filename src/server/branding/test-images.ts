// Test-only image bytes; never import this from app code.

// A PNG signature plus an IHDR chunk for the given size (enough for the
// magic number and width checks; not a decodable image).
export function pngBytes(width: number, height: number, extra = 0): Uint8Array {
  const out = new Uint8Array(33 + extra);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

export const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#91d500"/></svg>';
