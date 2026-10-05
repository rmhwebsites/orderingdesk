import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedWorkspace } from "@/server/desk/test-helpers";
import {
  draftPoNumber,
  isMintedPoNumber,
  nextPoNumber,
  previewPoNumber,
  PoNumberError,
  PO_NUMBER_ATTEMPTS,
} from "./number";

// PO numbers: <prefix>-<YYYY>-<NNNN>, sequential per workspace and year,
// minted at a PO's first send attempt. Race safety comes from the
// (workspace_id, po_number) unique index: a mint that loses a race retries
// with the next number, a bounded number of times.

const WS = "ws_impact";
const JAN_2026 = Date.UTC(2026, 0, 15, 12);
const DEC_31_2026_LATE = Date.UTC(2026, 11, 31, 23, 59);
const JAN_1_2027 = Date.UTC(2027, 0, 1, 0, 1);

let db: Db;
let raw: ReturnType<typeof openTestDb>["raw"];

async function seedDraft(id: string, workspaceId = WS) {
  await db.insert(schema.purchaseOrders).values({
    id,
    workspaceId,
    orderId: "o1",
    vendorId: "v1",
    poNumber: draftPoNumber(id),
    lineItems: [],
    createdBy: "u_manager",
    createdAt: 1,
  });
}

async function numberOf(id: string) {
  const row = raw.prepare("SELECT po_number FROM purchase_orders WHERE id = ?").get(id) as { po_number: string };
  return row.po_number;
}

beforeEach(async () => {
  ({ db, raw } = openTestDb());
  await seedWorkspace(db, WS);
  await seedWorkspace(db, "ws_other");
});

describe("PO number shapes", () => {
  it("tells a minted number from a draft placeholder, whatever the prefix", () => {
    expect(isMintedPoNumber("IMP-2026-0041")).toBe(true);
    expect(isMintedPoNumber("PO-2026-12345")).toBe(true);
    expect(isMintedPoNumber(draftPoNumber("abc"))).toBe(false);
    // DRAFT is a valid prefix; its numbers still read as minted.
    expect(isMintedPoNumber("DRAFT-2026-0001")).toBe(true);
    expect(isMintedPoNumber("imp-2026-0001")).toBe(false);
    expect(isMintedPoNumber("IMP-26-0001")).toBe(false);
  });
});

describe("nextPoNumber", () => {
  it("mints 0001 for a workspace's first PO of the year", async () => {
    await seedDraft("po1");
    expect(await nextPoNumber(db, { workspaceId: WS, poId: "po1", prefix: "IMP", now: JAN_2026 })).toBe("IMP-2026-0001");
    expect(await numberOf("po1")).toBe("IMP-2026-0001");
  });

  it("counts up in sequence, per workspace", async () => {
    for (const id of ["po1", "po2", "po3"]) {
      await seedDraft(id);
    }
    await seedDraft("other1", "ws_other");
    const minted = [];
    for (const id of ["po1", "po2", "po3"]) {
      minted.push(await nextPoNumber(db, { workspaceId: WS, poId: id, prefix: "IMP", now: JAN_2026 }));
    }
    expect(minted).toEqual(["IMP-2026-0001", "IMP-2026-0002", "IMP-2026-0003"]);
    // Another workspace has its own sequence.
    expect(await nextPoNumber(db, { workspaceId: "ws_other", poId: "other1", prefix: "IMP", now: JAN_2026 })).toBe(
      "IMP-2026-0001",
    );
  });

  it("starts again at 0001 in a new year (UTC)", async () => {
    for (const id of ["po1", "po2", "po3"]) {
      await seedDraft(id);
    }
    expect(await nextPoNumber(db, { workspaceId: WS, poId: "po1", prefix: "IMP", now: JAN_2026 })).toBe("IMP-2026-0001");
    expect(await nextPoNumber(db, { workspaceId: WS, poId: "po2", prefix: "IMP", now: DEC_31_2026_LATE })).toBe(
      "IMP-2026-0002",
    );
    expect(await nextPoNumber(db, { workspaceId: WS, poId: "po3", prefix: "IMP", now: JAN_1_2027 })).toBe("IMP-2027-0001");
  });

  it("continues after the highest number, keeps going past 9999, and ignores drafts and other prefixes", async () => {
    await seedDraft("po_new");
    await db.insert(schema.purchaseOrders).values([
      { id: "a", workspaceId: WS, orderId: "o1", vendorId: "v1", poNumber: "IMP-2026-0007", lineItems: [], createdBy: "u", createdAt: 1 },
      { id: "b", workspaceId: WS, orderId: "o1", vendorId: "v1", poNumber: "IMPX-2026-0050", lineItems: [], createdBy: "u", createdAt: 1 },
      { id: "c", workspaceId: WS, orderId: "o1", vendorId: "v1", poNumber: "IMP-2025-0090", lineItems: [], createdBy: "u", createdAt: 1 },
    ]);
    expect(await nextPoNumber(db, { workspaceId: WS, poId: "po_new", prefix: "IMP", now: JAN_2026 })).toBe("IMP-2026-0008");

    await db.insert(schema.purchaseOrders).values({
      id: "d", workspaceId: WS, orderId: "o1", vendorId: "v1", poNumber: "IMP-2026-9999", lineItems: [], createdBy: "u", createdAt: 1,
    });
    await seedDraft("po_big");
    expect(await nextPoNumber(db, { workspaceId: WS, poId: "po_big", prefix: "IMP", now: JAN_2026 })).toBe("IMP-2026-10000");
  });

  it("keeps a PO's number once minted (a retry after a failed send)", async () => {
    await seedDraft("po1");
    await seedDraft("po2");
    const first = await nextPoNumber(db, { workspaceId: WS, poId: "po1", prefix: "IMP", now: JAN_2026 });
    await nextPoNumber(db, { workspaceId: WS, poId: "po2", prefix: "IMP", now: JAN_2026 });
    expect(await nextPoNumber(db, { workspaceId: WS, poId: "po1", prefix: "OTHER", now: JAN_1_2027 })).toBe(first);
  });

  it("gives two POs minted at the same moment distinct, consecutive numbers", async () => {
    for (const id of ["po1", "po2", "po3", "po4"]) {
      await seedDraft(id);
    }
    const minted = await Promise.all(
      ["po1", "po2", "po3", "po4"].map((poId) => nextPoNumber(db, { workspaceId: WS, poId, prefix: "IMP", now: JAN_2026 })),
    );
    expect([...minted].sort()).toEqual(["IMP-2026-0001", "IMP-2026-0002", "IMP-2026-0003", "IMP-2026-0004"]);
  });

  it("gives one PO minted twice at once a single number", async () => {
    await seedDraft("po1");
    const [a, b] = await Promise.all([
      nextPoNumber(db, { workspaceId: WS, poId: "po1", prefix: "IMP", now: JAN_2026 }),
      nextPoNumber(db, { workspaceId: WS, poId: "po1", prefix: "IMP", now: JAN_2026 }),
    ]);
    expect(a).toBe("IMP-2026-0001");
    expect(b).toBe("IMP-2026-0001");
  });

  // A competing mint lands between reading the highest number and writing
  // the next one: the unique index refuses the write and the mint retries.
  function racingDb(competitors: number): Db {
    let left = competitors;
    return new Proxy(db as object, {
      get(target, prop) {
        if (prop === "update") {
          return (table: unknown) => {
            if (left > 0) {
              left--;
              const top = raw
                .prepare("SELECT max(cast(substr(po_number, 10) as integer)) AS top FROM purchase_orders WHERE workspace_id = ? AND po_number GLOB 'IMP-2026-[0-9]*'")
                .get(WS) as { top: number | null };
              const next = String((top.top ?? 0) + 1).padStart(4, "0");
              raw
                .prepare("INSERT INTO purchase_orders (id, workspace_id, order_id, vendor_id, po_number, line_items, created_by, created_at) VALUES (?, ?, 'o1', 'v1', ?, '[]', 'u', 1)")
                .run(`rival_${left}`, WS, `IMP-2026-${next}`);
            }
            return (target as Db).update(table as typeof schema.purchaseOrders);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as Db;
  }

  it("retries with the next number when another mint takes the one it read", async () => {
    await seedDraft("po1");
    expect(await nextPoNumber(racingDb(2), { workspaceId: WS, poId: "po1", prefix: "IMP", now: JAN_2026 })).toBe(
      "IMP-2026-0003",
    );
  });

  it("gives up after a bounded number of lost races, leaving the PO a draft", async () => {
    await seedDraft("po1");
    await expect(
      nextPoNumber(racingDb(PO_NUMBER_ATTEMPTS), { workspaceId: WS, poId: "po1", prefix: "IMP", now: JAN_2026 }),
    ).rejects.toBeInstanceOf(PoNumberError);
    expect(isMintedPoNumber(await numberOf("po1"))).toBe(false);
  });

  it("refuses a PO that is not in the workspace", async () => {
    await seedDraft("po1", "ws_other");
    await expect(nextPoNumber(db, { workspaceId: WS, poId: "po1", prefix: "IMP", now: JAN_2026 })).rejects.toBeInstanceOf(
      PoNumberError,
    );
  });
});

describe("previewPoNumber", () => {
  it("names the number the next send would mint, without taking it", async () => {
    expect(await previewPoNumber(db, WS, "IMP", JAN_2026)).toBe("IMP-2026-0001");
    await seedDraft("po1");
    await nextPoNumber(db, { workspaceId: WS, poId: "po1", prefix: "IMP", now: JAN_2026 });
    expect(await previewPoNumber(db, WS, "IMP", JAN_2026)).toBe("IMP-2026-0002");
    expect(await previewPoNumber(db, WS, "IMP", JAN_2026)).toBe("IMP-2026-0002");
    expect(await previewPoNumber(db, WS, "IMP", JAN_1_2027)).toBe("IMP-2027-0001");
  });
});
