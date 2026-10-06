import { describe, it, expect } from "vitest";
import type { EventView } from "@/server/desk/shapes";
import { rejectionOf } from "./rejection";

const note = (id: string, createdAt: number, meta: unknown): EventView => ({
  id,
  orderId: "d1",
  type: "note",
  text: `reason ${id}`,
  actorId: "u_manager",
  meta,
  createdAt,
  source: "app",
});

describe("rejectionOf", () => {
  it("finds the newest Reject reason and ignores plain notes", () => {
    expect(rejectionOf([note("a", 10, { rejectReason: true }), note("b", 30, null), note("c", 20, { rejectReason: true })])?.id).toBe("c");
    expect(rejectionOf([note("b", 30, null)])).toBeNull();
    expect(rejectionOf([])).toBeNull();
  });
});
