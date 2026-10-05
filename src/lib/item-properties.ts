// How a line item property (personalization) shows in the drawer (draft
// orders spec section 11.4 with section 18). Pure; the drawer renders the
// result with JSX only, so text is always escaped.
//
// - Only an https URL on cdn.shopify.com (no credentials, no port) may
//   render as an image or a link; every other value, javascript:, data:
//   and http: included, is plain text.
// - image: such a URL whose path ends in an image extension, or whose key
//   reads like a preview (preview, image, thumbnail, mockup).
// - pdf: such a URL ending in .pdf, or whose key reads like a proof.
// - link: any other such URL, shown as its host.
// - hidden: a key starting with an underscore (an app's own data, such as
//   the personalizer's _pplr_preview pointer) unless it is such an image or
//   PDF. A "Show all properties" toggle reveals them as text.
// - text: everything else, as given (line breaks kept by the renderer).

export type ItemProperty = { key: string; value: string };

export type PropertyView =
  | { kind: "image"; label: string; url: string }
  | { kind: "pdf"; label: string; url: string }
  | { kind: "link"; label: string; url: string; host: string }
  | { kind: "text"; label: string; value: string }
  | { kind: "hidden"; label: string; value: string };

export const PROPERTY_TEXT_CLIP = 500;

const ASSET_HOST = "cdn.shopify.com";
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif)$/i;
const PDF_PATH = /\.pdf$/i;
const IMAGE_KEY = /preview|image|thumbnail|mockup/i;
const PDF_KEY = /pdf|proof/i;

function assetUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== ASSET_HOST || url.username || url.password || url.port) {
    return null;
  }
  return url;
}

// Public keys as given; underscore keys without their leading underscores,
// underscores as spaces, upper case when four characters or fewer ("PDF"),
// else sentence case.
export function propertyLabel(key: string): string {
  if (!key.startsWith("_")) {
    return key;
  }
  const words = key.replace(/^_+/, "").split("_").join(" ").trim();
  if (words.length === 0) {
    return "Property";
  }
  if (words.length <= 4) {
    return words.toUpperCase();
  }
  const lower = words.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function classifyProperty(property: ItemProperty): PropertyView {
  const label = propertyLabel(property.key);
  const url = assetUrl(property.value);
  if (url) {
    const href = url.toString();
    if (IMAGE_PATH.test(url.pathname)) {
      return { kind: "image", label, url: href };
    }
    if (PDF_PATH.test(url.pathname)) {
      return { kind: "pdf", label, url: href };
    }
    if (PDF_KEY.test(property.key)) {
      return { kind: "pdf", label, url: href };
    }
    if (IMAGE_KEY.test(property.key)) {
      return { kind: "image", label, url: href };
    }
    if (!property.key.startsWith("_")) {
      return { kind: "link", label, url: href, host: url.host };
    }
  }
  if (property.key.startsWith("_")) {
    return { kind: "hidden", label, value: property.value };
  }
  return { kind: "text", label, value: property.value };
}

export function clipText(value: string, max = PROPERTY_TEXT_CLIP): { text: string; clipped: boolean } {
  return value.length > max ? { text: value.slice(0, max), clipped: true } : { text: value, clipped: false };
}
