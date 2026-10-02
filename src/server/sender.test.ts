import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedWorkspace } from "./desk/test-helpers";
import { sendingRefusal, setSenderOverride, verifySender } from "./sender";

type Sent = { from: unknown; to: string[]; subject: string; html: string; text?: string; replyTo?: string };

function makeEnv(send: (message: Sent) => Promise<{ messageId: string }>) {
  const email = { send: vi.fn(send) };
  const env = {
    APP_URL: "https://orderingdesk.test",
    EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>",
    EMAIL: email,
  } as unknown as CloudflareEnv;
  return { env, email };
}

const delivered = async () => ({ messageId: "m1" });

async function setup(fields: Partial<typeof schema.workspaces.$inferInsert> = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_impact");
  await db
    .update(schema.workspaces)
    .set({ name: "Impact Rentals", ...fields })
    .where(eq(schema.workspaces.id, "ws_impact"));
  await db
    .update(schema.workspaceSettings)
    .set({ replyTo: "office@impactrentals.store" })
    .where(eq(schema.workspaceSettings.workspaceId, "ws_impact"));
  return db;
}

async function row(db: Db) {
  const [found] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, "ws_impact"));
  return found;
}

const ACTIVE = { customDomain: "orders.impactrentals.store", customDomainStatus: "active" as const };

describe("setSenderOverride", () => {
  it("sets the override, clears the verification, and reports the platform fallback until verified", async () => {
    const db = await setup({ ...ACTIVE, sendingVerifiedAt: 99 });
    const { env } = makeEnv(delivered);
    const result = await setSenderOverride(db, env, "ws_impact", { address: " Hello@ImpactRentals.store " });
    expect(result).toEqual({
      kind: "saved",
      sender: {
        override: "hello@impactrentals.store",
        address: "hello@impactrentals.store",
        source: "override",
        verified: false,
        verifiedAt: null,
        from: "Impact Rentals <orders@orderingdesk.com>",
        replyTo: "office@impactrentals.store",
      },
    });
    expect((await row(db)).sendingVerifiedAt).toBeNull();
  });

  it("keeps the verification when the same address is saved again", async () => {
    const db = await setup({ sendingAddress: "hello@impactrentals.store", sendingVerifiedAt: 99 });
    const { env } = makeEnv(delivered);
    const result = await setSenderOverride(db, env, "ws_impact", { address: "hello@impactrentals.store" });
    expect(result.kind === "saved" ? result.sender.verified : null).toBe(true);
    expect((await row(db)).sendingVerifiedAt).toBe(99);
  });

  it("clears the override (back to accounts@<domain>) and its verification with null", async () => {
    const db = await setup({ ...ACTIVE, sendingAddress: "hello@impactrentals.store", sendingVerifiedAt: 99 });
    const { env } = makeEnv(delivered);
    const result = await setSenderOverride(db, env, "ws_impact", { address: null });
    expect(result.kind === "saved" ? result.sender : null).toMatchObject({
      override: null,
      address: "accounts@orders.impactrentals.store",
      source: "domain",
      verified: false,
    });
    const saved = await row(db);
    expect(saved.sendingAddress).toBeNull();
    expect(saved.sendingVerifiedAt).toBeNull();
  });

  it("refuses a body without address, and an address that is not one", async () => {
    const db = await setup();
    const { env } = makeEnv(delivered);
    for (const body of [{}, null, { address: "not an address" }, { address: "a@b.c\r\nBcc: x@y.z" }, { address: 5 }]) {
      expect((await setSenderOverride(db, env, "ws_impact", body)).kind).toBe("invalid");
    }
    expect(await setSenderOverride(db, env, "ws_missing", { address: null })).toEqual({ kind: "not-found" });
  });
});

describe("verifySender", () => {
  it("refuses when the workspace has no sender of its own, sending nothing", async () => {
    for (const fields of [{}, { customDomain: "orders.impactrentals.store", customDomainStatus: "pending" as const }]) {
      const db = await setup(fields);
      const { env, email } = makeEnv(delivered);
      const result = await verifySender(db, env, "ws_impact", "boss@example.com");
      expect(result.kind).toBe("no-sender");
      expect(email.send).not.toHaveBeenCalled();
    }
  });

  it("sends a branded test email from accounts@<domain> to the admin and records the verification", async () => {
    const db = await setup(ACTIVE);
    const { env, email } = makeEnv(delivered);
    const result = await verifySender(db, env, "ws_impact", "boss@example.com");
    expect(email.send).toHaveBeenCalledTimes(1);
    const message = email.send.mock.calls[0][0];
    expect(message.from).toEqual({ name: "Impact Rentals", email: "accounts@orders.impactrentals.store" });
    expect(message.to).toEqual(["boss@example.com"]);
    expect(message.subject).toBe("Test email from Impact Rentals");
    expect(message.html).toContain("accounts@orders.impactrentals.store");
    expect(message.html).toContain("Sent with Ordering Desk");
    expect(message.text).toContain("accounts@orders.impactrentals.store");
    expect(result.kind).toBe("verified");
    expect(result.kind === "verified" ? result.sender : null).toMatchObject({
      address: "accounts@orders.impactrentals.store",
      verified: true,
      from: "Impact Rentals <accounts@orders.impactrentals.store>",
    });
    expect((await row(db)).sendingVerifiedAt).toEqual(expect.any(Number));
  });

  it("sends from the override address when one is set", async () => {
    const db = await setup({ ...ACTIVE, sendingAddress: "hello@impactrentals.store" });
    const { env, email } = makeEnv(delivered);
    await verifySender(db, env, "ws_impact", "boss@example.com");
    expect(email.send.mock.calls[0][0].from).toEqual({ name: "Impact Rentals", email: "hello@impactrentals.store" });
  });

  it("turns Cloudflare's refusals into the onboarding instruction and records nothing", async () => {
    for (const refusal of [
      "email sending not authorized for subdomain 'orders.impactrentals.store'",
      "could not find domain config of sending domain",
    ]) {
      const db = await setup(ACTIVE);
      const { env } = makeEnv(async () => {
        throw new Error(refusal);
      });
      const result = await verifySender(db, env, "ws_impact", "boss@example.com");
      expect(result).toEqual({
        kind: "refused",
        error:
          "Onboard orders.impactrentals.store under Compute > Email Service > Email Sending in Cloudflare (Email Sending only), then press Verify again.",
      });
      expect((await row(db)).sendingVerifiedAt).toBeNull();
    }
  });

  it("reports any other failure plainly and records nothing", async () => {
    const db = await setup(ACTIVE);
    const { env } = makeEnv(async () => {
      throw new Error("internal error");
    });
    const result = await verifySender(db, env, "ws_impact", "boss@example.com");
    expect(result.kind).toBe("failed");
    expect((await row(db)).sendingVerifiedAt).toBeNull();
  });

  it("does not record a verification for an address that changed while the test email was sent", async () => {
    const db = await setup(ACTIVE);
    const { env } = makeEnv(async () => {
      await db
        .update(schema.workspaces)
        .set({ sendingAddress: "other@impactrentals.store" })
        .where(eq(schema.workspaces.id, "ws_impact"));
      return { messageId: "m1" };
    });
    const result = await verifySender(db, env, "ws_impact", "boss@example.com");
    expect(result.kind).toBe("failed");
    expect((await row(db)).sendingVerifiedAt).toBeNull();
  });

  it("answers not-found for a missing workspace", async () => {
    const db = await setup();
    const { env } = makeEnv(delivered);
    expect(await verifySender(db, env, "ws_missing", "boss@example.com")).toEqual({ kind: "not-found" });
  });
});

describe("sendingRefusal", () => {
  it("maps only the two Cloudflare refusals, naming the sender's domain", () => {
    expect(sendingRefusal(new Error("Not Authorized to send"), "a@orders.x.example")).toBe(
      "Onboard orders.x.example under Compute > Email Service > Email Sending in Cloudflare (Email Sending only), then press Verify again.",
    );
    expect(sendingRefusal(new Error("rate limited"), "a@orders.x.example")).toBeNull();
    expect(sendingRefusal("could not find domain config of sending domain", "a@b.example")).toContain("Onboard b.example");
  });
});
