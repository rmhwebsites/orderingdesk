import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { getWorkspaceSettings, updateWorkspaceSettings } from "./settings";
import { openTestDb, seedWorkspace, withBatch } from "./test-helpers";

const WS = "ws_impact";
const OTHER = "ws_other";
// The route passes canEditIdentity: true only for platform admins.
const PLATFORM = { canEditIdentity: true };
const MANAGER = { canEditIdentity: false };

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  return db;
}

async function snapshotRows(db: Db) {
  return {
    workspaces: await db.select().from(schema.workspaces),
    settings: await db.select().from(schema.workspaceSettings),
  };
}

async function updated(db: Db, body: Record<string, unknown>) {
  const result = await updateWorkspaceSettings(db, WS, body, PLATFORM);
  if (result.kind !== "ok") {
    throw new Error("expected ok, got " + JSON.stringify(result));
  }
  return result;
}

describe("getWorkspaceSettings", () => {
  it("returns the workspace identity and its settings", async () => {
    const db = await setup();
    expect(await getWorkspaceSettings(db, WS)).toEqual({
      workspace: { name: "Workspace " + WS, accentColor: "#91d500", slug: WS },
      settings: { notificationEmails: [], poPrefix: "PO", replyTo: null, fromName: null, timeZone: "America/New_York", aiSearch: true },
    });
    expect(await getWorkspaceSettings(db, "ws_missing")).toBeNull();
  });
});

describe("updateWorkspaceSettings", () => {
  it("applies a partial update and leaves every other field alone", async () => {
    const db = await setup();
    await updated(db, { poPrefix: "imp", replyTo: "Ops@Impact.Example" });
    const result = await updated(db, { name: "  IMPACT Rentals  " });
    expect(result).toEqual({
      kind: "ok",
      workspace: { name: "IMPACT Rentals", accentColor: "#91d500", slug: WS },
      settings: {
        notificationEmails: [],
        poPrefix: "IMP",
        replyTo: "ops@impact.example",
        fromName: null,
        timeZone: "America/New_York",
        aiSearch: true,
      },
    });
    // The slug never changes with the name.
    expect((await getWorkspaceSettings(db, WS))?.workspace.slug).toBe(WS);
    expect((await getWorkspaceSettings(db, OTHER))?.workspace.name).toBe("Workspace " + OTHER);
  });

  it("writes the workspace row and the settings row in one batch", async () => {
    const db = await setup();
    const batched: unknown[][] = [];
    const result = await updateWorkspaceSettings(withBatch(db, batched), WS, {
      name: "IMPACT",
      poPrefix: "IMP",
    }, PLATFORM);
    expect(result.kind).toBe("ok");
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(2);
  });

  it("validates the name: 1 to 80 characters after trimming", async () => {
    const db = await setup();
    expect((await updated(db, { name: "n".repeat(80) })).workspace.name).toHaveLength(80);
    for (const name of ["", "   ", "n".repeat(81), 7, null]) {
      expect((await updateWorkspaceSettings(db, WS, { name }, PLATFORM)).kind, String(name)).toBe("invalid");
    }
  });

  // accentColor is rendered into inline styles; this check is the CSS
  // injection guard.
  it("accepts only #rrggbb accent colors and stores them lowercased", async () => {
    const db = await setup();
    expect((await updated(db, { accentColor: "#A1B2C3" })).workspace.accentColor).toBe("#a1b2c3");
    const before = await snapshotRows(db);
    for (const accentColor of [
      "red",
      "#abc",
      "#abcdeg",
      "a1b2c3",
      "#a1b2c3 ",
      "#a1b2c3; background: url(https://evil.example)",
      "#a1b2c3\n",
      "rgb(1,2,3)",
      "",
      null,
      123456,
    ]) {
      const result = await updateWorkspaceSettings(db, WS, { accentColor }, PLATFORM);
      expect(result.kind, JSON.stringify(accentColor)).toBe("invalid");
    }
    expect(await snapshotRows(db)).toEqual(before);
  });

  it("normalizes notification emails: up to 20, lowercased, deduped", async () => {
    const db = await setup();
    const result = await updated(db, {
      notificationEmails: [" Desk@Impact.Example", "desk@impact.example", "ops@impact.example"],
    });
    expect(result.settings.notificationEmails).toEqual(["desk@impact.example", "ops@impact.example"]);
    const twenty = Array.from({ length: 20 }, (_, i) => `n${i}@example.com`);
    expect((await updated(db, { notificationEmails: twenty })).settings.notificationEmails).toHaveLength(20);
    expect((await updated(db, { notificationEmails: [] })).settings.notificationEmails).toEqual([]);

    for (const notificationEmails of [
      [...twenty, "n20@example.com"],
      ["fine@example.com", "broken"],
      "desk@impact.example",
      null,
    ]) {
      const outcome = await updateWorkspaceSettings(db, WS, { notificationEmails }, PLATFORM);
      expect(outcome.kind, JSON.stringify(notificationEmails)?.slice(0, 60)).toBe("invalid");
    }
  });

  it("uppercases the PO prefix and requires 1 to 8 letters or digits", async () => {
    const db = await setup();
    expect((await updated(db, { poPrefix: " imp2 " })).settings.poPrefix).toBe("IMP2");
    expect((await updated(db, { poPrefix: "ABCDEFGH" })).settings.poPrefix).toBe("ABCDEFGH");
    for (const poPrefix of ["", "ABCDEFGHI", "IM-P", "IM P", "PO_1", "ÉP", null, 12]) {
      const result = await updateWorkspaceSettings(db, WS, { poPrefix }, PLATFORM);
      expect(result.kind, JSON.stringify(poPrefix)).toBe("invalid");
    }
  });

  it("takes a valid reply-to address or null", async () => {
    const db = await setup();
    expect((await updated(db, { replyTo: " Ops@Impact.Example " })).settings.replyTo).toBe(
      "ops@impact.example",
    );
    expect((await updated(db, { replyTo: null })).settings.replyTo).toBeNull();
    await updated(db, { replyTo: "ops@impact.example" });
    expect((await updated(db, { replyTo: "  " })).settings.replyTo).toBeNull();
    for (const replyTo of ["not-an-email", "a@b.com, c@d.com", 5]) {
      const result = await updateWorkspaceSettings(db, WS, { replyTo }, PLATFORM);
      expect(result.kind, JSON.stringify(replyTo)).toBe("invalid");
    }
  });

  // fromName becomes the display name on outgoing email.
  it("allows a from name of letters, digits, spaces and . , ' & - only", async () => {
    const db = await setup();
    for (const fromName of ["IMPACT Rentals", "Smith & Sons, Inc.", "O'Brien-Hale Co. 2"]) {
      expect((await updated(db, { fromName })).settings.fromName).toBe(fromName);
    }
    expect((await updated(db, { fromName: "  Trimmed Name  " })).settings.fromName).toBe(
      "Trimmed Name",
    );
    expect((await updated(db, { fromName: "f".repeat(60) })).settings.fromName).toHaveLength(60);
    // A phone keyboard's curly apostrophe is stored as the plain one.
    expect((await updated(db, { fromName: "Ryan’s Rentals" })).settings.fromName).toBe(
      "Ryan's Rentals",
    );
    expect((await updated(db, { fromName: null })).settings.fromName).toBeNull();
    await updated(db, { fromName: "Someone" });
    expect((await updated(db, { fromName: "" })).settings.fromName).toBeNull();

    const before = await snapshotRows(db);
    for (const fromName of [
      "f".repeat(61),
      "Evil <attacker@example.com>",
      "Name\r\nBcc: attacker@example.com",
      'Quote " Name',
      "Semi; Colon",
      "Colon: Name",
      "Café Rentals",
      "Tab\tName",
      42,
    ]) {
      const result = await updateWorkspaceSettings(db, WS, { fromName }, PLATFORM);
      expect(result.kind, JSON.stringify(fromName)).toBe("invalid");
    }
    expect(await snapshotRows(db)).toEqual(before);
  });

  it("rejects the whole update when any field is invalid", async () => {
    const db = await setup();
    const before = await snapshotRows(db);
    const result = await updateWorkspaceSettings(db, WS, {
      name: "Perfectly Fine",
      poPrefix: "IMP",
      accentColor: "javascript:alert(1)",
    }, PLATFORM);
    expect(result.kind).toBe("invalid");
    expect(await snapshotRows(db)).toEqual(before);
  });

  it("rejects a body with no known fields", async () => {
    const db = await setup();
    for (const body of [{}, { slug: "renamed" }, null, "name", []]) {
      expect((await updateWorkspaceSettings(db, WS, body, PLATFORM)).kind, JSON.stringify(body)).toBe(
        "invalid",
      );
    }
  });

  it("is not-found for a workspace that does not exist", async () => {
    const db = await setup();
    expect(await updateWorkspaceSettings(db, "ws_missing", { name: "Ghost" }, PLATFORM)).toEqual({
      kind: "not-found",
    });
  });

  // Branding (the accent color) and the workspace's name are platform-admin
  // settings; managers keep the notification and PO settings.
  it("refuses a manager's change to the name or accent color, and changes nothing", async () => {
    const db = await setup();
    const before = await snapshotRows(db);
    for (const body of [{ name: "Renamed" }, { accentColor: "#ff0000" }, { name: "Renamed", poPrefix: "IMP" }]) {
      expect(await updateWorkspaceSettings(db, WS, body, MANAGER), JSON.stringify(body)).toEqual({
        kind: "forbidden",
      });
    }
    expect(await snapshotRows(db)).toEqual(before);
  });

  it("lets a manager change notification, reply-to, from name and PO settings", async () => {
    const db = await setup();
    const result = await updateWorkspaceSettings(
      db,
      WS,
      { notificationEmails: ["ops@example.com"], replyTo: "ops@example.com", fromName: "IMPACT", poPrefix: "imp" },
      MANAGER,
    );
    expect(result).toMatchObject({
      kind: "ok",
      settings: { notificationEmails: ["ops@example.com"], replyTo: "ops@example.com", fromName: "IMPACT", poPrefix: "IMP" },
    });
  });

  it("recreates a missing settings row instead of failing", async () => {
    const db = await setup();
    await db.delete(schema.workspaceSettings).where(eq(schema.workspaceSettings.workspaceId, WS));
    const result = await updated(db, { poPrefix: "NEW" });
    expect(result.settings).toEqual({
      notificationEmails: [],
      poPrefix: "NEW",
      replyTo: null,
      fromName: null,
      timeZone: "America/New_York",
      aiSearch: true,
    });
  });
});

describe("search settings", () => {
  const manager = { canEditIdentity: false };

  it("saves the time zone and the AI search switch", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_impact");
    const result = await updateWorkspaceSettings(db, "ws_impact", { timeZone: "America/Chicago", aiSearch: false }, manager);
    expect(result).toMatchObject({ kind: "ok", settings: { timeZone: "America/Chicago", aiSearch: false } });
  });

  it("refuses a time zone the runtime does not know and a switch that is not a boolean", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_impact");
    expect(await updateWorkspaceSettings(db, "ws_impact", { timeZone: "Mars/Base" }, manager)).toEqual({
      kind: "invalid",
      error: "The time zone must be an IANA name like America/New_York",
    });
    expect(await updateWorkspaceSettings(db, "ws_impact", { aiSearch: "yes" }, manager)).toEqual({
      kind: "invalid",
      error: "AI search must be on or off",
    });
  });

  it("reads New York and AI search on for a workspace that never chose", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_impact");
    expect((await getWorkspaceSettings(db, "ws_impact"))?.settings).toMatchObject({ timeZone: "America/New_York", aiSearch: true });
  });
});
