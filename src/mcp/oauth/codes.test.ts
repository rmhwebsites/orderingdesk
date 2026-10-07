import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { CODE_TTL_MS, CONSENT_AFTER_CODE_MS } from "../constants";
import { MANAGER, NOW, ORIGIN, setupMcp } from "../test-helpers";
import { consumeSignIn, normalizeEmail, requestSignInCode, verifySignInCode } from "./codes";

const CLIENT = "https://claude.ai/oauth/mcp-client";

async function ask(db: Awaited<ReturnType<typeof setupMcp>>, opts: { email?: string; userId?: string | null; ip?: string; now?: number } = {}) {
  const sent: string[] = [];
  const pending: Promise<unknown>[] = [];
  const handle = await requestSignInCode(
    db,
    { origin: ORIGIN, email: opts.email ?? "casey.lin@example.com", clientId: CLIENT, ip: opts.ip ?? "203.0.113.7" },
    {
      now: opts.now ?? NOW,
      lookupUser: async () => (opts.userId === undefined ? MANAGER : opts.userId),
      send: async (code) => {
        sent.push(code);
      },
      background: (work) => {
        pending.push(work);
      },
    },
  );
  await Promise.all(pending);
  return { handle, code: sent[0] ?? null, sent };
}

describe("sign-in codes", () => {
  it("stores only a hash of the code, and sends the code to someone who may connect", async () => {
    const db = await setupMcp();
    const { handle, code } = await ask(db);
    expect(code).toMatch(/^\d{6}$/);
    const row = (await db.select().from(schema.aiSignInCodes).where(eq(schema.aiSignInCodes.id, handle)))[0];
    expect(row).toMatchObject({ origin: ORIGIN, email: "casey.lin@example.com", userId: MANAGER, clientId: CLIENT, attempts: 0, expiresAt: NOW + CODE_TTL_MS });
    expect(row.codeHash).not.toContain(code!);
    expect(row.ipHash).not.toContain("203.0.113.7");
  });

  it("keeps a row but sends nothing to an email that may not connect", async () => {
    const db = await setupMcp();
    const { handle, sent } = await ask(db, { email: "stranger@example.com", userId: null });
    expect(sent).toEqual([]);
    expect((await db.select().from(schema.aiSignInCodes).where(eq(schema.aiSignInCodes.id, handle)))[0].userId).toBeNull();
  });

  // The page's answer never waits for the lookup (Wave 3's lookup can call
  // Shopify), so its timing cannot tell who has access.
  it("answers before the lookup runs, and names the person on the row only once the lookup says so", async () => {
    const db = await setupMcp();
    let release: (userId: string | null) => void = () => undefined;
    const lookup = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const lookupUser = vi.fn(() => lookup);
    const sent: string[] = [];
    const pending: Promise<unknown>[] = [];
    const handle = await requestSignInCode(
      db,
      { origin: ORIGIN, email: "casey.lin@example.com", clientId: CLIENT, ip: "203.0.113.7" },
      {
        now: NOW,
        lookupUser,
        send: async (code) => {
          sent.push(code);
        },
        background: (work) => {
          pending.push(work);
        },
      },
    );
    expect(handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await db.select().from(schema.aiSignInCodes).where(eq(schema.aiSignInCodes.id, handle)))[0].userId).toBeNull();
    expect(sent).toEqual([]);
    release(MANAGER);
    await Promise.all(pending);
    expect(lookupUser).toHaveBeenCalledWith("casey.lin@example.com");
    expect((await db.select().from(schema.aiSignInCodes).where(eq(schema.aiSignInCodes.id, handle)))[0].userId).toBe(MANAGER);
    expect(sent).toHaveLength(1);
  });

  it("sends at most five codes per email per host and twenty per IP each hour, answering the same", async () => {
    const db = await setupMcp();
    for (let i = 0; i < 5; i++) {
      expect((await ask(db, { now: NOW + i })).code).not.toBeNull();
    }
    const sixth = await ask(db, { now: NOW + 10 });
    expect(sixth.code).toBeNull();
    expect(sixth.handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await db.select().from(schema.aiSignInCodes)).toHaveLength(5);
    for (let i = 0; i < 15; i++) {
      await ask(db, { email: `person${i}@example.com`, now: NOW + 20 + i });
    }
    expect((await ask(db, { email: "late@example.com", now: NOW + 50 })).code).toBeNull();
    expect((await ask(db, { email: "late@example.com", ip: "198.51.100.4", now: NOW + 51 })).code).not.toBeNull();
    expect((await ask(db, { now: NOW + 3600001 })).code).not.toBeNull();
  });

  it("accepts the right code once, for the same host and app, within ten minutes", async () => {
    const db = await setupMcp();
    const { handle, code } = await ask(db);
    expect(await verifySignInCode(db, { id: handle, origin: ORIGIN, clientId: "https://chatgpt.com/oauth/client.json", code: code! }, NOW + 1)).toEqual({ kind: "expired" });
    expect(await verifySignInCode(db, { id: handle, origin: "https://hub.example.com", clientId: CLIENT, code: code! }, NOW + 1)).toEqual({ kind: "expired" });
    expect(await verifySignInCode(db, { id: handle, origin: ORIGIN, clientId: CLIENT, code: code! }, NOW + 2)).toEqual({
      kind: "ok",
      userId: MANAGER,
      email: "casey.lin@example.com",
    });
    expect(await verifySignInCode(db, { id: handle, origin: ORIGIN, clientId: CLIENT, code: code! }, NOW + 3)).toEqual({ kind: "expired" });
    const late = await ask(db, { now: NOW + 10 });
    expect(await verifySignInCode(db, { id: late.handle, origin: ORIGIN, clientId: CLIENT, code: late.code! }, NOW + 10 + CODE_TTL_MS)).toEqual({ kind: "expired" });
  });

  it("counts wrong codes and ends after five, even if the sixth is right", async () => {
    const db = await setupMcp();
    const { handle, code } = await ask(db);
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await verifySignInCode(db, { id: handle, origin: ORIGIN, clientId: CLIENT, code: wrong }, NOW + 1)).toEqual({ kind: "wrong", attemptsLeft: 4 });
    for (let i = 0; i < 3; i++) {
      await verifySignInCode(db, { id: handle, origin: ORIGIN, clientId: CLIENT, code: wrong }, NOW + 2);
    }
    expect(await verifySignInCode(db, { id: handle, origin: ORIGIN, clientId: CLIENT, code: wrong }, NOW + 3)).toEqual({ kind: "expired" });
    expect(await verifySignInCode(db, { id: handle, origin: ORIGIN, clientId: CLIENT, code: code! }, NOW + 4)).toEqual({ kind: "expired" });
  });

  it("never accepts a code for an email that may not connect", async () => {
    const db = await setupMcp();
    const sent = vi.fn();
    const handle = await requestSignInCode(
      db,
      { origin: ORIGIN, email: "stranger@example.com", clientId: CLIENT, ip: "203.0.113.7" },
      { now: NOW, lookupUser: async () => null, send: sent, background: () => undefined },
    );
    expect(await verifySignInCode(db, { id: handle, origin: ORIGIN, clientId: CLIENT, code: "123456" }, NOW + 1)).toMatchObject({ kind: "wrong" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("lets the consent that follows use the sign-in once, soon after the code", async () => {
    const db = await setupMcp();
    const { handle, code } = await ask(db);
    expect(await consumeSignIn(db, { id: handle, origin: ORIGIN, clientId: CLIENT }, NOW + 1)).toBeNull();
    await verifySignInCode(db, { id: handle, origin: ORIGIN, clientId: CLIENT, code: code! }, NOW + 2);
    expect(await consumeSignIn(db, { id: handle, origin: ORIGIN, clientId: CLIENT }, NOW + 3)).toEqual({ userId: MANAGER });
    expect(await consumeSignIn(db, { id: handle, origin: ORIGIN, clientId: CLIENT }, NOW + 4)).toBeNull();
    const second = await ask(db, { now: NOW + 5 });
    await verifySignInCode(db, { id: second.handle, origin: ORIGIN, clientId: CLIENT, code: second.code! }, NOW + 6);
    expect(await consumeSignIn(db, { id: second.handle, origin: ORIGIN, clientId: CLIENT }, NOW + 6 + CONSENT_AFTER_CODE_MS)).toBeNull();
  });

  it("normalizes emails", () => {
    expect(normalizeEmail("  Casey.Lin@Example.COM ")).toBe("casey.lin@example.com");
    for (const value of ["", "no-at-sign", "a@b", "two@@example.com", `${"x".repeat(250)}@example.com`, 42, null]) {
      expect(normalizeEmail(value)).toBeNull();
    }
  });
});
