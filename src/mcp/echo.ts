// The readable fields a confirm tool must repeat (design section 4): the
// chat app's approval dialog then shows what is being approved, and a
// confirm for anything else is refused. Text compares ignoring case,
// spacing, hidden characters and Unicode form (tool output drops hidden
// characters, src/mcp/output.ts, so an echo is compared with what the person
// saw); order numbers also ignore the "#" (Wave 1c's normalizeOrderNumber).
// Relative imports only.

import { normalizeOrderNumber } from "../lib/desk-query";
import { withoutHidden } from "./output";

function folded(value: string): string {
  return withoutHidden(value).toLowerCase().replace(/\s+/g, " ").trim();
}

export function sameText(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const left = folded(a);
  return left.length > 0 && left === folded(b);
}

export function sameOrderNumber(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const left = normalizeOrderNumber(withoutHidden(a));
  const right = normalizeOrderNumber(withoutHidden(b));
  return left !== "" && right !== "" ? left === right : sameText(a, b);
}
