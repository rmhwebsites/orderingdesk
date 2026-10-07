import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { ACTION_TTL_MS, UNKNOWN_RECHECK_MS } from "./constants";
import { beginConfirm, cardState, claimAction, finishAction, loadAction, prepareAction, preparedResult, stateMatches } from "./actions";
import { NOW, principalFor, setupMcp, toolDeps } from "./test-helpers";

const payload = { order: "#D12", statusKey: "processing", statusLabel: "Processing" };

describe("prepared actions", () => {
  it("store a pending action bound to the connection, the person and the workspace", async () => {
    const db = await setupMcp();
    const p = principalFor();
    const prepared = await prepareAction(db, p, { tool: "status", targetId: "d1", payload, state: "new" }, NOW);
    expect(prepared).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), expiresAt: NOW + ACTION_TTL_MS });
    expect(await loadAction(db, p, prepared.id)).toMatchObject({ tool: "status", targetId: "d1", status: "pending", payload });
    expect(await loadAction(db, principalFor("manager", { grantId: "g_other" }), prepared.id)).toBeNull();
    expect(await loadAction(db, principalFor("staff"), prepared.id)).toBeNull();
  });

  it("are claimed once, and expire after ten minutes", async () => {
    const db = await setupMcp();
    const p = principalFor();
    const first = await prepareAction(db, p, { tool: "status", targetId: "d1", payload, state: "new" }, NOW);
    const row = (await loadAction(db, p, first.id))!;
    expect((await claimAction(db, row, NOW + 1)).kind).toBe("claimed");
    expect((await claimAction(db, row, NOW + 2)).kind).toBe("used");
    const late = await prepareAction(db, p, { tool: "status", targetId: "d1", payload, state: "new" }, NOW);
    expect((await claimAction(db, (await loadAction(db, p, late.id))!, NOW + ACTION_TTL_MS)).kind).toBe("expired");
    expect((await db.select().from(schema.aiActions).where(eq(schema.aiActions.id, late.id)))[0]).toMatchObject({ status: "failed", outcome: "expired" });
  });

  it("match only the payload and the target state they were prepared for", async () => {
    const db = await setupMcp();
    const p = principalFor();
    const prepared = await prepareAction(db, p, { tool: "approve", targetId: "d1", payload: { order: "#D12" }, state: cardState({ statusKey: "new", shopify: { a: 1 }, draftDeletedAt: null, shopifyOrderId: null }) }, NOW);
    const row = (await loadAction(db, p, prepared.id))!;
    expect(await stateMatches(row, cardState({ statusKey: "new", shopify: { a: 1 }, draftDeletedAt: null, shopifyOrderId: null }))).toBe(true);
    expect(await stateMatches(row, cardState({ statusKey: "new", shopify: { a: 2 }, draftDeletedAt: null, shopifyOrderId: null }))).toBe(false);
    expect(await stateMatches({ ...row, payload: { order: "#D13" } }, cardState({ statusKey: "new", shopify: { a: 1 }, draftDeletedAt: null, shopifyOrderId: null }))).toBe(false);
  });

  it("let a request whose outcome is unknown be looked up again for thirty minutes, and nothing else", async () => {
    const db = await setupMcp();
    const p = principalFor();
    const placed = await prepareAction(db, p, { tool: "place_request", targetId: null, payload: { forPerson: "Jordan Vale" }, state: "" }, NOW);
    await claimAction(db, (await loadAction(db, p, placed.id))!, NOW + 1);
    await finishAction(db, placed.id, "unknown", "no_answer");
    expect((await claimAction(db, (await loadAction(db, p, placed.id))!, NOW + 60000)).kind).toBe("recheck");
    await finishAction(db, placed.id, "unknown", "no_answer");
    expect((await claimAction(db, (await loadAction(db, p, placed.id))!, NOW + 1 + UNKNOWN_RECHECK_MS)).kind).toBe("used");
    const note = await prepareAction(db, p, { tool: "note", targetId: "d1", payload: {}, state: "" }, NOW);
    await finishAction(db, note.id, "unknown", "x");
    expect((await claimAction(db, (await loadAction(db, p, note.id))!, NOW + 1)).kind).toBe("used");
  });
});

describe("beginConfirm", () => {
  it("refuses a wrong echo without using the confirmation up, then claims it and counts one change", async () => {
    const db = await setupMcp();
    const deps = toolDeps(db);
    const prepared = await prepareAction(db, deps.principal, { tool: "status", targetId: "d1", payload, state: "new" }, NOW);
    const echo = (label: string) => (stored: typeof payload) => (stored.statusLabel === label ? null : `The status in this confirmation is ${stored.statusLabel}.`);
    const wrong = await beginConfirm(deps, { id: prepared.id, tool: "status", echo: echo("Shipped") });
    expect(wrong).toMatchObject({ ok: false, outcome: { ok: false, code: "mismatch" } });
    expect((await beginConfirm(deps, { id: prepared.id, tool: "note", echo: () => null })).ok).toBe(false);
    const right = await beginConfirm(deps, { id: prepared.id, tool: "status", echo: echo("Processing") });
    expect(right).toMatchObject({ ok: true, recheck: false, payload });
    expect((await db.select().from(schema.aiUsage)).map((row) => [row.kind, row.count])).toEqual([["mcp_change", 1]]);
    expect(await beginConfirm(deps, { id: prepared.id, tool: "status", echo: echo("Processing") })).toMatchObject({ ok: false, outcome: { code: "already_used" } });
    expect(await beginConfirm(deps, { id: "nope", tool: "status", echo: () => null })).toMatchObject({ ok: false, outcome: { code: "not_found" } });
  });

  it("marks the action failed when today's changes are used up", async () => {
    const db = await setupMcp();
    const deps = toolDeps(db, principalFor("staff", { limits: { reads: 10, changes: 0 } }));
    const prepared = await prepareAction(db, deps.principal, { tool: "note", targetId: "d1", payload: {}, state: "" }, NOW);
    expect(await beginConfirm(deps, { id: prepared.id, tool: "note", echo: () => null })).toMatchObject({ ok: false, outcome: { code: "limit_reached" } });
    expect((await db.select().from(schema.aiActions).where(eq(schema.aiActions.id, prepared.id)))[0]).toMatchObject({ status: "failed", outcome: "limit_reached" });
  });

  it("shapes a preview with the confirmation and the fields to repeat", () => {
    expect(
      preparedResult(
        { id: "a1", expiresAt: NOW + ACTION_TTL_MS },
        { summary: "Change #D12 from New to Processing", details: { order: "#D12" }, warnings: [], confirm: { tool: "confirm_status_change", fields: { order: "#D12", status: "Processing" } } },
      ),
    ).toEqual({
      ok: true,
      data: {
        confirmation_id: "a1",
        expires_at: new Date(NOW + ACTION_TTL_MS).toISOString(),
        preview: { summary: "Change #D12 from New to Processing", order: "#D12" },
        warnings: [],
        confirm_with: { tool: "confirm_status_change", confirmation_id: "a1", order: "#D12", status: "Processing" },
      },
    });
  });

  it("adds what the person must confirm, when there is something", () => {
    const details = [{ line: 1, label: "Full Name", value: "Jordan Vale" }];
    const outcome = preparedResult(
      { id: "a2", expiresAt: NOW + ACTION_TTL_MS },
      {
        summary: "Place a request",
        confirmDetails: { instruction: "Ask the person to confirm these details are correct.", details },
        confirm: { tool: "confirm_place_request", fields: { for_person: "Jordan Vale", details } },
      },
    );
    expect(outcome).toMatchObject({
      ok: true,
      data: {
        confirm_details: { instruction: "Ask the person to confirm these details are correct.", details },
        confirm_with: { tool: "confirm_place_request", confirmation_id: "a2", for_person: "Jordan Vale", details },
      },
    });
  });
});
