import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { DEFAULT_ROSTER_TAGS, setRosterTags } from "./roster";
import { openTestDb, seedWorkspace } from "./desk/test-helpers";

const WS = "ws_impact";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, "ws_other");
  return db;
}

async function stored(db: Awaited<ReturnType<typeof setup>>, id = WS) {
  const rows = await db.select({ tags: schema.workspaces.rosterTags }).from(schema.workspaces).where(eq(schema.workspaces.id, id));
  return rows[0]?.tags ?? null;
}

describe("setRosterTags", () => {
  it("stores trimmed tag names and answers the tags in effect", async () => {
    const db = await setup();
    const result = await setRosterTags(db, WS, { manager: "  Desk Lead ", staff: "Desk Crew" });
    expect(result).toEqual({ kind: "saved", tags: { manager: "Desk Lead", staff: "Desk Crew" } });
    expect(await stored(db)).toEqual({ manager: "Desk Lead", staff: "Desk Crew" });
    expect(await stored(db, "ws_other")).toBeNull();
  });

  it("goes back to the defaults with null", async () => {
    const db = await setup();
    await setRosterTags(db, WS, { manager: "Desk Lead", staff: "Desk Crew" });
    expect(await setRosterTags(db, WS, null)).toEqual({ kind: "saved", tags: DEFAULT_ROSTER_TAGS });
    expect(await stored(db)).toBeNull();
  });

  it("refuses blank, overlong, comma-separated and identical tag names", async () => {
    const db = await setup();
    for (const body of [
      { manager: "", staff: "Crew" },
      { manager: "Lead", staff: "   " },
      { manager: "Lead" },
      { manager: "x".repeat(41), staff: "Crew" },
      // Shopify separates tags with commas, so a comma would be two tags.
      { manager: "Lead, Boss", staff: "Crew" },
      { manager: "Desk", staff: "desk " },
      { manager: 3, staff: "Crew" },
      "Lead",
    ]) {
      expect((await setRosterTags(db, WS, body)).kind, JSON.stringify(body)).toBe("invalid");
    }
    expect(await stored(db)).toBeNull();
  });

  it("answers a missing workspace as not found", async () => {
    const db = await setup();
    expect(await setRosterTags(db, "ws_missing", { manager: "Lead", staff: "Crew" })).toEqual({ kind: "not-found" });
  });
});
