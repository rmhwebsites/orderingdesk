// Personalization the person confirms before a request is sent (owner
// decision 4, Oct 7, 2026; Wave 2 plan, Decision 12). There is no "Proof
// needed" tag, chip or warning. Instead the prepare tool returns every
// personalization detail exactly as it will be sent to Shopify, with the
// instruction to ask the person to confirm them, and the confirm tool must
// carry details_confirmed: true and the same details in the same order. The
// prepared payload stores the details and their hash (the payload is
// covered by the action's content hash, src/mcp/actions.ts), and the confirm
// compares the hash of the repeated details with the stored one. Wave 3's
// employee requests use the same helpers. Relative imports only.

import * as z from "zod";
import { canonicalJson, sha256Hex, timingSafeEqual } from "./hash";

export const CONFIRM_DETAILS_INSTRUCTION = "Ask the person to confirm these details are correct.";

export const DETAIL_LINE_MAX = 20;
export const DETAIL_LABEL_MAX = 40;
export const DETAIL_VALUE_MAX = 200;
// Up to 8 fields on each of up to 20 lines.
export const DETAILS_MAX = 160;

export type PersonalizationDetail = { line: number; label: string; value: string };

// What a confirm tool repeats: the details exactly as confirm_details
// listed them.
export const DetailsInput = z
  .array(
    z
      .object({
        line: z.number().int().min(1).max(DETAIL_LINE_MAX),
        label: z.string().min(1).max(DETAIL_LABEL_MAX),
        value: z.string().min(1).max(DETAIL_VALUE_MAX),
      })
      .strict(),
  )
  .max(DETAILS_MAX);

// Every personalization field of the draft's lines, in line order, exactly
// as the draft input carries it (lines numbered from 1).
export function personalizationDetails(lineItems: readonly { customAttributes?: readonly { key: string; value: string }[] }[]): PersonalizationDetail[] {
  return lineItems.flatMap((line, index) => (line.customAttributes ?? []).map((field) => ({ line: index + 1, label: field.key, value: field.value })));
}

export function detailsHash(details: readonly PersonalizationDetail[]): Promise<string> {
  return sha256Hex(["ordering-desk.personalization.v1", canonicalJson(details.map((detail) => [detail.line, detail.label, detail.value]))].join("\n"));
}

// What a prepare tool returns as confirm_details, or null when nothing is
// personalized.
export function confirmDetailsOf(details: readonly PersonalizationDetail[]): { instruction: string; details: PersonalizationDetail[] } | null {
  return details.length > 0 ? { instruction: CONFIRM_DETAILS_INSTRUCTION, details: [...details] } : null;
}

export const DETAILS_NOT_CONFIRMED =
  "This request has personalized items. Show the person every detail in confirm_details, ask them to confirm the details are correct, then confirm with details_confirmed: true and the details.";
export const DETAILS_MISMATCH = "The personalization details do not match the preview.";

// null when nothing needs confirming, or when the person confirmed and the
// repeated details hash to the stored hash; else the sentence to answer.
// echoedHash is detailsHash of the details the confirm carried ([] when it
// carried none).
export function detailsMismatch(
  stored: { details: readonly PersonalizationDetail[]; detailsHash: string },
  confirmed: boolean | undefined,
  echoedHash: string,
): string | null {
  if (stored.details.length === 0) {
    return null;
  }
  if (confirmed !== true) {
    return DETAILS_NOT_CONFIRMED;
  }
  return timingSafeEqual(echoedHash, stored.detailsHash) ? null : DETAILS_MISMATCH;
}
