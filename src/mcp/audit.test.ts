import { describe, it, expect } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "./audit";
import { GRANT, MANAGER, NOW, WS, principalFor, setupMcp } from "./test-helpers";

describe("writeAudit", () => {
  it("records who, through which connection and app, which tool, on what and the outcome", async () => {
    const db = await setupMcp();
    await writeAudit(db, principalFor(), { tool: "confirm_approve", outcome: "ok", target: { kind: "order", id: "d1" } }, NOW);
    await writeAudit(db, principalFor(), { tool: "search_orders", outcome: "limit_reached" }, NOW);
    const rows = await db.select().from(schema.auditLog);
    expect(rows.map((row) => [row.workspaceId, row.actorId, row.grantId, row.client, row.tool, row.targetKind, row.targetId, row.outcome, row.createdAt])).toEqual([
      [WS, MANAGER, GRANT, "claude", "confirm_approve", "order", "d1", "ok", NOW],
      [WS, MANAGER, GRANT, "claude", "search_orders", null, null, "limit_reached", NOW],
    ]);
  });

  it("records a call that named no usable workspace without one", async () => {
    const db = await setupMcp();
    await writeAudit(db, { workspaceId: null, userId: MANAGER, grantId: GRANT, client: "claude" }, { tool: "get_order", outcome: "not_found" }, NOW);
    const rows = await db.select().from(schema.auditLog);
    expect(rows.map((row) => [row.workspaceId, row.tool, row.outcome])).toEqual([[null, "get_order", "not_found"]]);
  });

  it("never throws", async () => {
    const broken = { insert: () => { throw new Error("d1 down"); } } as unknown as Db;
    await expect(writeAudit(broken, principalFor(), { tool: "get_order", outcome: "ok" }, NOW)).resolves.toBeUndefined();
  });
});
