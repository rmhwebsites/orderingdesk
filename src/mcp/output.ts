// What MCP tools return (comprehensive desk design section 4, prompt
// injection). Every result is JSON in one text block plus the same object as
// structuredContent; nothing is markdown. Text people typed (notes,
// reasons, request fields, personalization, timeline entries) is wrapped as
// { untrusted: "..." } so the chat app's model reads it as data. Every
// string loses control and invisible characters, HTML tags, markdown images
// and links, and every link that is not a Shopify CDN file (the
// personalizer's proofs live there). Errors are { error: { code, message,
// retryable } } with isError set.
// Relative imports only: custom-worker.ts bundles src/mcp.

export const TEXT_MAX = 500;
export const LONG_TEXT_MAX = 4000;
export const NAME_MAX = 120;

// C0 except tab and line feed, DEL and C1, zero-width and bidi controls,
// word joiners, the line and paragraph separators, and the BOM.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;
const MD_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const TAG = /<\/?[a-z][^>]*>/gi;
const URL_LIKE = /\b(?:https?:\/\/|www\.|javascript:|mailto:|ftp:\/\/|data:[a-z]+\/)[^\s<>"']*/gi;
const SHOPIFY_CDN = "https://cdn.shopify.com/";

export function plainText(value: unknown, max = TEXT_MAX): string {
  if (typeof value !== "string") {
    return "";
  }
  const text = value
    .normalize("NFKC")
    .replace(CONTROL, "")
    .replace(MD_IMAGE, "$1")
    .replace(MD_LINK, "$1")
    .replace(TAG, "")
    .replace(URL_LIKE, (url) => (url.startsWith(SHOPIFY_CDN) ? url : "[link removed]"))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? text.slice(0, max - 3).trimEnd() + "..." : text;
}

export type Untrusted = { untrusted: string };

export function untrusted(value: unknown, max = LONG_TEXT_MAX): Untrusted | null {
  const text = plainText(value, max);
  return text.length > 0 ? { untrusted: text } : null;
}

export function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export type ToolErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "limit_reached"
  | "expired"
  | "already_used"
  | "mismatch"
  | "changed"
  | "refused"
  | "shopify_unavailable"
  | "unknown_outcome"
  | "internal";

const RETRYABLE = new Set<ToolErrorCode>(["shopify_unavailable", "unknown_outcome", "internal"]);

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export function okResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function errorResult(code: ToolErrorCode, message: string): ToolResult {
  const data = { error: { code, message: plainText(message, TEXT_MAX), retryable: RETRYABLE.has(code) } };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
}
