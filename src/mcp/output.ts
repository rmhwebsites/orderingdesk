// What MCP tools return (comprehensive desk design section 4, prompt
// injection). Every result is JSON in one text block plus the same object as
// structuredContent; nothing is markdown. Text people typed (notes,
// reasons, request fields, personalization, timeline entries) is wrapped as
// { untrusted: "..." } so the chat app's model reads it as data. Every
// string loses control and invisible characters, HTML tags, markdown images
// and links (inline or by reference, and the reference definitions behind
// them), and every link that is not a Shopify CDN file (the personalizer's
// proofs live there). Errors are { error: { code, message, retryable } }
// with isError set.
// Relative imports only: custom-worker.ts bundles src/mcp.

export const TEXT_MAX = 500;
export const LONG_TEXT_MAX = 4000;
export const NAME_MAX = 120;
// plainText reads at most this many characters of a value, and at most 8 for
// each one it may return, and it cuts the text to that length again after
// withoutHidden, because the Unicode compatibility form can make one
// character up to 18 (U+FDFA), so the patterns below never see more. Several
// of them backtrack, so their time grows with the square of the length on
// text built to defeat them ("[" or "<a" thousands of times, no closing
// bracket): at 8,000 characters the worst case takes tens of milliseconds, at
// 200,000 it takes many seconds. Cutting only removes text, and a link cut in
// half is still a link to URL_LIKE.
export const INPUT_MAX = 8000;
const INPUT_PER_CHARACTER = 8;

// Hidden characters, which a person cannot see in the app but a chat app's
// model reads: every Unicode "other" character except tab and line feed (C0
// and C1 controls, DEL, format characters such as zero-width spaces, bidi
// controls and isolates, the BOM and the tags block of "ASCII smuggling",
// lone surrogates, private use, unassigned), every default-ignorable code
// point (soft hyphen, variation selectors, Hangul fillers), and the line and
// paragraph separators.
const HIDDEN = /[^\P{C}\t\n]|[\p{Default_Ignorable_Code_Point}\u{2028}\u{2029}]/gu;
const TAG = /<\/?[a-z][^>]*>/gi;
const MD_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
// The address of an inline link or image the two above miss (brackets
// inside its text): an inline link needs "](" right after its text.
const MD_ADDRESS = /\](?:\([^)]*\))+/g;
// "[text][label]", "[text][]" and "![alt][label]" become their text.
const MD_REFERENCE = /!?\[((?:[^[\]\\]|\\[\s\S])*)\]\[(?:[^[\]\\]|\\[\s\S])*\]/g;
// A reference definition ("[label]: address", at the start of a line, in a
// quote or in a list) makes "[label]" and "![label]" a link or an image
// anywhere in the text, and it needs "]:" right after its label. Every
// "[label]:" loses its brackets, then any "]:" still left (nested brackets)
// loses the "]", so no definition survives.
const MD_DEFINITION = /\[((?:[^[\]\\]|\\[\s\S])*)\]:/g;
const MD_DEFINITION_LEFT = /\]+:/g;
// Schemes match anywhere (GFM links a URL right after "_" or "*"), "www."
// where no letter or digit comes before it, and an address without a scheme
// ("//host.name/x") where it is not part of a longer one.
const URL_LIKE =
  /(?:https?:\/\/|ftp:\/\/|javascript:|mailto:|xmpp:|data:[a-z]+\/|(?<![a-z0-9])www\.|(?<![a-z0-9:/])\/\/[^\s/<>"']+\.)[^\s<>"']*/gi;
const SHOPIFY_CDN = "https://cdn.shopify.com/";

// A carriage return becomes a line feed (alone it is a line break too), then
// hidden characters go, then the Unicode compatibility form is taken (after
// stripping, so a hidden character cannot block it; it never makes a hidden
// character out of a visible one). The confirm echoes (src/mcp/echo.ts)
// compare text in this same form, so they match what the person saw.
export function withoutHidden(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(HIDDEN, "").normalize("NFKC");
}

export function plainText(value: unknown, max = TEXT_MAX): string {
  if (typeof value !== "string") {
    return "";
  }
  // A value cut here (before withoutHidden, or after it when the
  // compatibility form made it longer) ends in "..." like one cut at max
  // (unless nothing is left to show). The second cut drops half of a
  // surrogate pair left at its end.
  const limit = Math.min(max * INPUT_PER_CHARACTER, INPUT_MAX);
  let cut = value.length > limit;
  let visible = withoutHidden(cut ? value.slice(0, limit) : value);
  if (visible.length > limit) {
    visible = visible.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
    cut = true;
  }
  // Tags go first, so removing one cannot join the parts of a link.
  const text = visible
    .replace(TAG, "")
    .replace(MD_IMAGE, "$1")
    .replace(MD_LINK, "$1")
    .replace(MD_ADDRESS, "]")
    .replace(MD_REFERENCE, "$1")
    .replace(MD_DEFINITION, "$1:")
    .replace(MD_DEFINITION_LEFT, ":")
    .replace(URL_LIKE, (url) => (url.startsWith(SHOPIFY_CDN) ? url : "[link removed]"))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max || (cut && text.length > 0) ? text.slice(0, max - 3).trimEnd() + "..." : text;
}

// A phone number written any way: at least this many digits, and digits
// make up at least half of what is not a space.
const PHONE_DIGITS_MIN = 7;

// A person's name as every tool returns it (Decision 13: requester and team
// member emails are never returned). Shopify's displayName falls back to
// the customer's email, then phone, when the customer has no first or last
// name, the sync stores that as the card's customer name and as people.name,
// and the desk's display names fall back to the email. So a value with an @
// (in any width) or one that reads as a phone number is no name: null, and
// the tool says "a team member" where it needs words. Callers pass the
// stored name (people.name), not a display name with the email fallback.
export function personLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const visible = withoutHidden(value).replace(/\s+/g, "");
  const digits = visible.match(/\p{Nd}/gu)?.length ?? 0;
  if (visible.includes("@") || (digits >= PHONE_DIGITS_MIN && digits * 2 >= visible.length)) {
    return null;
  }
  const text = plainText(value, NAME_MAX);
  return text.length > 0 ? text : null;
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
