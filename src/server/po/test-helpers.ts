// Test-only support for the purchase order tests; never import this from
// app code. Builds on src/server/desk/test-helpers.ts (the real migrations
// on in-memory SQLite) with an in-memory R2 bucket, a stubbed Email Service
// binding and a workspace set up for purchase orders.

import { vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { seedMember, seedOrder, seedUser, seedWorkspace, snapshotOf } from "@/server/desk/test-helpers";
import type { PoBucket } from "./storage";

export const WS = "ws_impact";
export const OTHER_WS = "ws_other";
export const ORDER = "o1";

export type FakeBucket = PoBucket & {
  objects: Map<string, { bytes: Uint8Array; contentType: string | undefined }>;
  gets: string[];
  failPut: boolean;
};

export function fakeBucket(): FakeBucket {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  const gets: string[] = [];
  const bucket = {
    objects,
    gets,
    failPut: false,
    async put(key: string, value: unknown, options?: { httpMetadata?: unknown }) {
      if (bucket.failPut) {
        throw new Error("R2 is unavailable");
      }
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      const meta = options?.httpMetadata as { contentType?: string } | undefined;
      objects.set(key, { bytes, contentType: meta?.contentType });
      return null;
    },
    async get(key: string) {
      gets.push(key);
      const object = objects.get(key);
      if (!object) {
        return null;
      }
      return {
        body: new Blob([object.bytes as BlobPart]).stream(),
        size: object.bytes.length,
        httpEtag: '"etag"',
        arrayBuffer: async () => object.bytes.slice().buffer,
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key);
      }
    },
  };
  return bucket as unknown as FakeBucket;
}

export type SentEmail = {
  from: unknown;
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{ filename: string; content: string; type: string; disposition: string }>;
};

// A non-localhost APP_URL, so sendEmail uses the (stubbed) binding.
export function mailEnv(bucket?: FakeBucket) {
  const sent: SentEmail[] = [];
  const email = {
    send: vi.fn(async (message: SentEmail) => {
      sent.push(message);
      return { messageId: `m${sent.length}` };
    }),
  };
  const env = {
    APP_URL: "https://orderingdesk.test",
    EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>",
    EMAIL: email,
    PO_BUCKET: bucket,
  } as unknown as CloudflareEnv;
  return { env, sent, email };
}

// IMPACT with prefix IMP, a notification list and a reply-to; a manager, a
// staff member and an outsider; order o1 (CAD, shipped to Riley Oakes);
// vendor v_north (with a copy address) and an archived vendor; another
// workspace with its own order and vendor.
export async function seedPoWorkspace(db: Db) {
  await seedWorkspace(db, WS);
  await db
    .update(schema.workspaces)
    .set({ name: "IMPACT Rentals" })
    .where(eq(schema.workspaces.id, WS));
  await db
    .update(schema.workspaceSettings)
    .set({ poPrefix: "IMP", notificationEmails: ["office@impact.example"], replyTo: "office@impact.example" })
    .where(eq(schema.workspaceSettings.workspaceId, WS));
  await seedWorkspace(db, OTHER_WS);
  for (const [id, email] of [
    ["u_manager", "manager@impact.example"],
    ["u_staff", "staff@impact.example"],
    ["u_stranger", "stranger@example.com"],
  ]) {
    await seedUser(db, id, email);
  }
  await seedMember(db, WS, "u_manager", "manager");
  await seedMember(db, WS, "u_staff", "staff");
  await seedMember(db, OTHER_WS, "u_stranger", "manager");
  await seedOrder(db, WS, {
    id: ORDER,
    name: "#1001",
    shopify: snapshotOf({
      currency: "CAD",
      shipping: { name: "Riley Oakes", a1: "12 Harbour St", a2: "", city: "Halifax", prov: "NS", zip: "B3H 1A1", country: "Canada" },
    }),
  });
  await seedOrder(db, OTHER_WS, { id: "o_other" });
  await db.insert(schema.vendors).values([
    { id: "v_north", workspaceId: WS, name: "Northline Supply", email: "orders@northline.example", cc: ["rep@northline.example"] },
    { id: "v_gone", workspaceId: WS, name: "Gone Co", email: "gone@vendor.example", archived: true },
    { id: "v_other", workspaceId: OTHER_WS, name: "Other Vendor", email: "other@vendor.example" },
  ]);
}

export const LINES = [
  { description: "Hard Hat (White)", sku: "HH-1", quantity: 2, unitCost: "10.00" },
  { description: "Hi-vis vest", sku: "", quantity: 1, unitCost: "5.50" },
];

export function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    vendorId: "v_north",
    lines: LINES,
    shipTo: ["Riley Oakes", "12 Harbour St", "Halifax NS B3H 1A1", "Canada"],
    notes: "Deliver before noon",
    ...overrides,
  };
}

// The recipients a send of a v_north PO must confirm.
export const NORTH_RECIPIENTS = { to: ["orders@northline.example"], cc: ["rep@northline.example", "office@impact.example"] };
