import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { changeOrderStatus } from "@/server/desk/mutations";
import { ACTION_TTL_MS } from "../constants";
import { MANAGER, NOW, WS, call, principalFor, setupMcp, toolDeps } from "../test-helpers";
import { confirmAddNote, confirmStatusChange, prepareAddNote, prepareStatusChange } from "./status-note";

async function card(db: Awaited<ReturnType<typeof setupMcp>>, id = "d1") {
  return (await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];
}

describe("status change through an AI app", () => {
  it("previews, then changes the status once on confirm, as source ai, with the follow-ups after the answer", async () => {
    const db = await setupMcp();
    const afterWork: (() => Promise<unknown>)[] = [];
    const deps = toolDeps(db, principalFor(), { after: (work) => afterWork.push(work) });
    const prepared = (await call(prepareStatusChange, { order: "#D12", status: "processing" }, deps)).data;
    expect(prepared).toMatchObject({
      preview: { summary: "Change #D12 from New to Processing" },
      confirm_with: { tool: "confirm_status_change", confirmation_id: prepared.confirmation_id, order: "#D12", status: "Processing" },
    });
    expect((await card(db)).statusKey).toBe("new");
    const done = await call(confirmStatusChange, { confirmation_id: prepared.confirmation_id, order: "D12", status: "processing" }, deps);
    expect(done.data).toMatchObject({ done: true, order: "#D12", status: "Processing" });
    expect(await card(db)).toMatchObject({ statusKey: "processing", statusSetBy: MANAGER });
    const entries = await db.select().from(schema.events).where(and(eq(schema.events.orderId, "d1"), eq(schema.events.type, "status")));
    expect(entries.map((entry) => [entry.source, entry.meta])).toEqual([["ai", { from: "new", to: "processing", ai: { client: "claude" } }]]);
    expect(afterWork).toHaveLength(1);
    const again = await call(confirmStatusChange, { confirmation_id: prepared.confirmation_id, order: "#D12", status: "Processing" }, deps);
    expect(again.data.error).toMatchObject({ code: "already_used" });
    const audit = await db.select().from(schema.auditLog);
    expect(audit.map((row) => [row.tool, row.outcome])).toEqual([
      ["prepare_status_change", "ok"],
      ["confirm_status_change", "ok"],
      ["confirm_status_change", "already_used"],
    ]);
  });

  it("refuses a confirm that repeats a different status or order, and keeps the confirmation usable", async () => {
    const db = await setupMcp();
    const deps = toolDeps(db);
    const prepared = (await call(prepareStatusChange, { order: "#D12", status: "Processing" }, deps)).data;
    const wrong = await call(confirmStatusChange, { confirmation_id: prepared.confirmation_id, order: "#D12", status: "Shipped" }, deps);
    expect(wrong.data.error).toMatchObject({ code: "mismatch" });
    const other = await call(confirmStatusChange, { confirmation_id: prepared.confirmation_id, order: "#1001", status: "Processing" }, deps);
    expect(other.data.error).toMatchObject({ code: "mismatch" });
    expect((await card(db)).statusKey).toBe("new");
    expect((await call(confirmStatusChange, { confirmation_id: prepared.confirmation_id, order: "#D12", status: "Processing" }, deps)).data.done).toBe(true);
  });

  it("applies the app's status rules at preview time", async () => {
    const db = await setupMcp();
    const approve = await call(prepareStatusChange, { order: "#D12", status: "Approved" }, toolDeps(db));
    expect(approve.data.error).toMatchObject({ code: "invalid_input", message: "Use Approve to approve this request. It creates the order in Shopify." });
    const unknown = await call(prepareStatusChange, { order: "#D12", status: "Somewhere" }, toolDeps(db));
    expect(unknown.data.error.message).toContain("Statuses: New, Processing");
    await db.update(schema.orders).set({ statusKey: "rejected" }).where(eq(schema.orders.id, "d1"));
    const reopen = await call(prepareStatusChange, { order: "#D12", status: "New" }, toolDeps(db, principalFor("staff")));
    expect(reopen.data.error).toMatchObject({ code: "forbidden" });
  });

  it("refuses a card that changed since the preview, and an expired confirmation", async () => {
    const db = await setupMcp();
    const deps = toolDeps(db);
    const prepared = (await call(prepareStatusChange, { order: "#D12", status: "Processing" }, deps)).data;
    await changeOrderStatus(db, { workspaceId: WS, orderId: "d1", userId: MANAGER, role: "manager" }, { statusKey: "issue" });
    const changed = await call(confirmStatusChange, { confirmation_id: prepared.confirmation_id, order: "#D12", status: "Processing" }, deps);
    expect(changed.data.error).toMatchObject({ code: "changed" });
    expect((await card(db)).statusKey).toBe("issue");
    const late = (await call(prepareStatusChange, { order: "#1001", status: "Processing" }, deps)).data;
    const expired = await call(confirmStatusChange, { confirmation_id: late.confirmation_id, order: "#1001", status: "Processing" }, toolDeps(db, principalFor(), { now: () => NOW + ACTION_TTL_MS }));
    expect(expired.data.error).toMatchObject({ code: "expired" });
  });
});

describe("notes through an AI app", () => {
  it("previews the note as untrusted text and adds it on a confirm that repeats it", async () => {
    const db = await setupMcp();
    const deps = toolDeps(db);
    const prepared = (await call(prepareAddNote, { order: "#1001", note: "  Called the branch; they confirmed sizes.  " }, deps)).data;
    expect(prepared.preview).toMatchObject({ summary: "Add a note to #1001", note: { untrusted: "Called the branch; they confirmed sizes." } });
    const wrong = await call(confirmAddNote, { confirmation_id: prepared.confirmation_id, order: "#1001", note: "Something else" }, deps);
    expect(wrong.data.error).toMatchObject({ code: "mismatch" });
    const done = await call(confirmAddNote, { confirmation_id: prepared.confirmation_id, order: "#1001", note: "Called the branch; they confirmed sizes." }, deps);
    expect(done.data).toMatchObject({ done: true, order: "#1001" });
    const notes = await db.select().from(schema.events).where(and(eq(schema.events.orderId, "o1"), eq(schema.events.type, "note")));
    expect(notes.map((note) => [note.text, note.source])).toEqual([["Called the branch; they confirmed sizes.", "ai"]]);
  });

  it("stops at the daily change limit", async () => {
    const db = await setupMcp();
    const deps = toolDeps(db, principalFor("staff", { limits: { reads: 100, changes: 0 } }));
    const prepared = (await call(prepareAddNote, { order: "#1001", note: "x" }, deps)).data;
    expect((await call(confirmAddNote, { confirmation_id: prepared.confirmation_id, order: "#1001", note: "x" }, deps)).data.error).toMatchObject({ code: "limit_reached" });
  });
});
