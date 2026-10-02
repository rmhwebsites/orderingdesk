// Branding image checks: what an uploaded file really is (by its magic
// numbers, never by the type the browser claims), and whether an SVG is
// safe to serve. Pure, so every rule is tested without R2.
//
// SVG is rejected, never repaired: a file with anything active or external
// in it is refused with the reason, and the person exports a clean one.
// Refused: script and other embedding elements (foreignObject, iframe,
// embed, object, handler), event handler attributes (on*), javascript:,
// vbscript: and data:text URLs anywhere (entities decoded first), an href
// or xlink:href that is not an internal #reference or a raster data:image,
// animations that retarget an href, stylesheet imports and external url()
// in styles, xml-stylesheet instructions, and entity declarations. Text the
// scanner cannot read with certainty is refused too.

export type ImageKind =
  | { type: "image/png"; ext: "png" }
  | { type: "image/jpeg"; ext: "jpg" }
  | { type: "image/webp"; ext: "webp" }
  | { type: "image/svg+xml"; ext: "svg" };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) {
    return false;
  }
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

// Skips an XML declaration, comments, whitespace and a DOCTYPE, then checks
// that the first element is <svg>.
function looksLikeSvg(head: string): boolean {
  let s = head.startsWith("﻿") ? head.slice(1) : head;
  for (let guard = 0; guard < 20; guard++) {
    s = s.trimStart();
    if (s.startsWith("<?")) {
      const end = s.indexOf("?>");
      if (end === -1) {
        return false;
      }
      s = s.slice(end + 2);
    } else if (s.startsWith("<!--")) {
      const end = s.indexOf("-->");
      if (end === -1) {
        return false;
      }
      s = s.slice(end + 3);
    } else if (/^<!doctype\s+svg/i.test(s)) {
      const end = s.indexOf(">");
      if (end === -1) {
        return false;
      }
      s = s.slice(end + 1);
    } else {
      return /^<svg[\s>/]/.test(s);
    }
  }
  return false;
}

export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (startsWithBytes(bytes, PNG_SIGNATURE)) {
    return { type: "image/png", ext: "png" };
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return { type: "image/jpeg", ext: "jpg" };
  }
  if (startsWithBytes(bytes, ascii("RIFF")) && startsWithBytes(bytes, ascii("WEBP"), 8)) {
    return { type: "image/webp", ext: "webp" };
  }
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 2048));
  return looksLikeSvg(head) ? { type: "image/svg+xml", ext: "svg" } : null;
}

// The width in a PNG's IHDR chunk, or null when bytes is not a PNG.
export function pngWidth(bytes: Uint8Array): number | null {
  if (!startsWithBytes(bytes, PNG_SIGNATURE) || !startsWithBytes(bytes, ascii("IHDR"), 12) || bytes.length < 24) {
    return null;
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
}

const BANNED_ELEMENTS: Record<string, string> = {
  script: "script",
  foreignobject: "foreignObject",
  iframe: "iframe",
  frame: "frame",
  embed: "embed",
  object: "object",
  handler: "handler",
  listener: "listener",
};

const ANIMATIONS = new Set(["set", "animate", "animatemotion", "animatetransform", "animatecolor"]);

const UNREADABLE = "it could not be read safely (check that it is a valid SVG export)";

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1).toLowerCase();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#([0-9]+);?/g, (_m, dec: string) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_m, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name.toLowerCase()] ?? "");
}

// Lowercased, with every whitespace and control character removed, the way
// browsers read a URL scheme ("java\tscript:" is javascript:).
function normalized(value: string): string {
  return decodeEntities(value)
    .replace(/[\u0000- \u007f-\u009f]/g, "")
    .toLowerCase();
}

function dangerousUrl(value: string): boolean {
  const v = normalized(value);
  return v.includes("javascript:") || v.includes("vbscript:") || v.includes("data:text");
}

function internalOrRaster(target: string): boolean {
  return target.startsWith("#") || (target.startsWith("data:image/") && !target.startsWith("data:image/svg"));
}

// Why a stylesheet (a style element or attribute) is unsafe, or null.
function unsafeCss(css: string): string | null {
  const v = normalized(css);
  if (v.includes("@import")) {
    return "its styles import another stylesheet";
  }
  if (dangerousUrl(css)) {
    return "it contains a javascript: or data:text URL";
  }
  for (const match of v.matchAll(/url\(([^)]*)\)/g)) {
    const target = match[1].replace(/^['"]|['"]$/g, "");
    if (!internalOrRaster(target)) {
      return "its styles reference an external file";
    }
  }
  return null;
}

type Attribute = { name: string; value: string };

// Parses the attributes of an open tag starting at position p (just after
// the element name). Returns the attributes and the index after the closing
// ">", or null when the tag never closes or is malformed.
function parseAttributes(s: string, p: number): { attributes: Attribute[]; end: number; selfClosing: boolean } | null {
  const attributes: Attribute[] = [];
  const n = s.length;
  while (p < n) {
    while (p < n && /\s/.test(s[p])) {
      p++;
    }
    if (s[p] === ">") {
      return { attributes, end: p + 1, selfClosing: false };
    }
    if (s.startsWith("/>", p)) {
      return { attributes, end: p + 2, selfClosing: true };
    }
    const nameMatch = s.slice(p, p + 256).match(/^[^\s=/>"'<]+/);
    if (!nameMatch) {
      return null;
    }
    const name = nameMatch[0];
    p += name.length;
    while (p < n && /\s/.test(s[p])) {
      p++;
    }
    let value = "";
    if (s[p] === "=") {
      p++;
      while (p < n && /\s/.test(s[p])) {
        p++;
      }
      const quote = s[p];
      if (quote === '"' || quote === "'") {
        const close = s.indexOf(quote, p + 1);
        if (close === -1) {
          return null;
        }
        value = s.slice(p + 1, close);
        p = close + 1;
      } else {
        const bare = s.slice(p).match(/^[^\s>]+/);
        if (!bare) {
          return null;
        }
        value = bare[0];
        p += value.length;
      }
    }
    attributes.push({ name, value });
  }
  return null;
}

function unsafeElement(name: string, attributes: Attribute[]): string | null {
  const element = localName(name);
  if (element in BANNED_ELEMENTS) {
    return `it contains a <${BANNED_ELEMENTS[element]}> element`;
  }
  for (const { name: attributeName, value } of attributes) {
    const attribute = localName(attributeName);
    if (attribute.startsWith("on")) {
      return `it has an event handler attribute (${attributeName})`;
    }
    if (dangerousUrl(value)) {
      return "it contains a javascript: or data:text URL";
    }
    if (attribute === "href" && !internalOrRaster(normalized(value))) {
      return `it references an external file (${attributeName})`;
    }
    if (attribute === "style") {
      const reason = unsafeCss(value);
      if (reason) {
        return reason;
      }
    }
    if (ANIMATIONS.has(element) && attribute === "attributename" && localName(normalized(value)) === "href") {
      return "it animates a link target";
    }
  }
  return null;
}

// Why the SVG text must not be stored, or null when it is safe.
export function unsafeSvgReason(text: string): string | null {
  const s = text.startsWith("﻿") ? text.slice(1) : text;
  if (/<!ENTITY/i.test(s)) {
    return "it declares XML entities";
  }
  if (/<\?xml-stylesheet/i.test(s)) {
    return "it links a stylesheet (xml-stylesheet)";
  }
  const n = s.length;
  let i = 0;
  let sawRoot = false;
  let inStyle = false;
  let styleText = "";
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (inStyle) {
      styleText += s.slice(i, lt === -1 ? n : lt);
    }
    if (lt === -1) {
      break;
    }
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end === -1) {
        return UNREADABLE;
      }
      i = end + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt + 9);
      if (end === -1) {
        return UNREADABLE;
      }
      if (inStyle) {
        styleText += s.slice(lt + 9, end);
      }
      i = end + 3;
      continue;
    }
    if (s.startsWith("<?", lt)) {
      const end = s.indexOf("?>", lt + 2);
      if (end === -1) {
        return UNREADABLE;
      }
      if (!/^xml\s/i.test(s.slice(lt + 2, end))) {
        return "it contains a processing instruction";
      }
      i = end + 2;
      continue;
    }
    if (s.startsWith("<!", lt)) {
      const end = s.indexOf(">", lt + 2);
      if (end === -1) {
        return UNREADABLE;
      }
      const declaration = s.slice(lt, end);
      if (declaration.includes("[")) {
        return "it declares XML entities (an internal DTD)";
      }
      if (!/^<!doctype\s/i.test(declaration)) {
        return UNREADABLE;
      }
      i = end + 1;
      continue;
    }
    if (s[lt + 1] === "/") {
      const close = s.slice(lt, lt + 300).match(/^<\/\s*([A-Za-z_][\w.:-]*)\s*>/);
      if (!close) {
        return UNREADABLE;
      }
      if (inStyle && localName(close[1]) === "style") {
        inStyle = false;
        const reason = unsafeCss(styleText);
        if (reason) {
          return reason;
        }
        styleText = "";
      }
      i = lt + close[0].length;
      continue;
    }
    const open = s.slice(lt, lt + 300).match(/^<([A-Za-z_][\w.:-]*)/);
    if (!open) {
      return UNREADABLE;
    }
    const name = open[1];
    const parsed = parseAttributes(s, lt + open[0].length);
    if (!parsed) {
      return UNREADABLE;
    }
    if (!sawRoot) {
      if (localName(name) !== "svg") {
        return "it is not an SVG image (the first element must be <svg>)";
      }
      sawRoot = true;
    }
    const reason = unsafeElement(name, parsed.attributes);
    if (reason) {
      return reason;
    }
    if (localName(name) === "style" && !parsed.selfClosing) {
      inStyle = true;
      styleText = "";
    }
    i = parsed.end;
  }
  if (inStyle) {
    return UNREADABLE;
  }
  return sawRoot ? null : "it is not an SVG image (no <svg> element)";
}
