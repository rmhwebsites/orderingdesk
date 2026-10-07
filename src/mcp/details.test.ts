import { describe, it, expect } from "vitest";
import {
  CONFIRM_DETAILS_INSTRUCTION,
  DETAILS_MISMATCH,
  DETAILS_NOT_CONFIRMED,
  DetailsInput,
  confirmDetailsOf,
  detailsHash,
  detailsMismatch,
  personalizationDetails,
} from "./details";

// Owner decision 4 (Oct 7, 2026): no Proof needed flag; the person confirms
// every personalization detail before a request is sent.
const lines = [
  { customAttributes: [{ key: "Full Name", value: "Jordan Vale" }, { key: "Mobile Phone", value: "+15555550123" }] },
  { customAttributes: [] },
  { customAttributes: [{ key: "Email", value: "jordan@example.com" }] },
];

describe("personalization details", () => {
  it("lists every field of every line verbatim, in line order", () => {
    expect(personalizationDetails(lines)).toEqual([
      { line: 1, label: "Full Name", value: "Jordan Vale" },
      { line: 1, label: "Mobile Phone", value: "+15555550123" },
      { line: 3, label: "Email", value: "jordan@example.com" },
    ]);
    expect(personalizationDetails([{ customAttributes: [] }, {}])).toEqual([]);
  });

  it("asks the person to confirm them, only when there are any", () => {
    const details = personalizationDetails(lines);
    expect(CONFIRM_DETAILS_INSTRUCTION).toBe("Ask the person to confirm these details are correct.");
    expect(confirmDetailsOf(details)).toEqual({ instruction: CONFIRM_DETAILS_INSTRUCTION, details });
    expect(confirmDetailsOf([])).toBeNull();
  });

  it("accepts them back only with the person's confirmation and exactly the same values in the same order", async () => {
    const details = personalizationDetails(lines);
    const stored = { details, detailsHash: await detailsHash(details) };
    expect(detailsMismatch(stored, true, await detailsHash(details))).toBeNull();
    expect(detailsMismatch(stored, undefined, await detailsHash(details))).toBe(DETAILS_NOT_CONFIRMED);
    expect(detailsMismatch(stored, false, await detailsHash(details))).toBe(DETAILS_NOT_CONFIRMED);
    const changed = details.map((detail) => (detail.label === "Mobile Phone" ? { ...detail, value: "+15555550124" } : detail));
    expect(detailsMismatch(stored, true, await detailsHash(changed))).toBe(DETAILS_MISMATCH);
    expect(detailsMismatch(stored, true, await detailsHash([...details].reverse()))).toBe(DETAILS_MISMATCH);
    expect(detailsMismatch(stored, true, await detailsHash(details.slice(1)))).toBe(DETAILS_MISMATCH);
    expect(detailsMismatch({ details: [], detailsHash: await detailsHash([]) }, undefined, await detailsHash([]))).toBeNull();
  });

  it("reads repeated details strictly", () => {
    expect(DetailsInput.safeParse([{ line: 1, label: "Full Name", value: "Jordan Vale" }]).success).toBe(true);
    expect(DetailsInput.safeParse([{ line: 0, label: "Full Name", value: "Jordan Vale" }]).success).toBe(false);
    expect(DetailsInput.safeParse([{ line: 1, label: "Full Name", value: "Jordan Vale", note: "x" }]).success).toBe(false);
  });
});
