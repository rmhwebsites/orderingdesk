import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "./desk/test-helpers";
import { DEFAULT_NOTIFICATION_PREFS, getNotificationPrefs, saveNotificationPrefs } from "./notification-prefs";

const WS = "ws_impact";
let db: Db;

beforeEach(async () => {
  db = openTestDb().db;
  await seedWorkspace(db, WS);
  await seedWorkspace(db, "ws_other");
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedMember(db, WS, "u_staff", "staff");
  await seedMember(db, "ws_other", "u_boss", "manager");
});

describe("getNotificationPrefs", () => {
  it("answers the defaults (push and email for new orders, no all-activity push) before anything is saved", async () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({ pushNewOrders: true, emailNewOrders: true, pushAllActivity: false });
    expect(await getNotificationPrefs(db, WS, "u_staff")).toEqual({ member: true, prefs: DEFAULT_NOTIFICATION_PREFS });
  });

  it("says when the person is not a member here (a platform admin looking in)", async () => {
    expect(await getNotificationPrefs(db, WS, "u_boss")).toEqual({ member: false, prefs: DEFAULT_NOTIFICATION_PREFS });
  });
});

describe("saveNotificationPrefs", () => {
  it("changes only the fields given and keeps them per workspace", async () => {
    expect(await saveNotificationPrefs(db, WS, "u_staff", { pushAllActivity: true })).toEqual({
      kind: "saved",
      prefs: { pushNewOrders: true, emailNewOrders: true, pushAllActivity: true },
    });
    expect(await saveNotificationPrefs(db, WS, "u_staff", { emailNewOrders: false })).toEqual({
      kind: "saved",
      prefs: { pushNewOrders: true, emailNewOrders: false, pushAllActivity: true },
    });
    expect((await getNotificationPrefs(db, WS, "u_staff")).prefs).toEqual({
      pushNewOrders: true,
      emailNewOrders: false,
      pushAllActivity: true,
    });
    expect(await db.select().from(schema.notificationPrefs)).toHaveLength(1);
  });

  it.each([
    ["no body", null],
    ["no known field", { other: true }],
    ["a field that is not a boolean", { pushNewOrders: "yes" }],
  ])("refuses %s", async (_label, body) => {
    expect((await saveNotificationPrefs(db, WS, "u_staff", body)).kind).toBe("invalid");
    expect(await db.select().from(schema.notificationPrefs)).toEqual([]);
  });

  it("refuses someone who is not a member of the workspace", async () => {
    expect(await saveNotificationPrefs(db, WS, "u_boss", { pushNewOrders: false })).toEqual({ kind: "not-member" });
    expect(await db.select().from(schema.notificationPrefs)).toEqual([]);
  });
});
