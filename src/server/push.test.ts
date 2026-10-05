import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb } from "@/server/desk/test-helpers";
import {
  PUSH_PAYLOAD_MAX_BYTES,
  encodePushNotice,
  pushConfigured,
  pushServiceEndpoint,
  removeSubscription,
  saveSubscription,
  sendPush,
  sendPushToTargets,
  subscriptionsFor,
  type PushTarget,
} from "./push";

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A VAPID pair in the shape the env holds it (the public key as the raw
// uncompressed point, the private key as the JWK d), like
// scripts/generate-vapid.mjs prints.
async function vapidPair() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: base64Url(raw), privateKey: jwk.d as string };
}

// A browser subscription's keys: an ECDH P-256 public key and 16 auth bytes.
async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { p256dh: base64Url(raw), auth: base64Url(crypto.getRandomValues(new Uint8Array(16))) };
}

const notice = { title: "New order #1001", body: "Riley, CA$120.00", url: "https://orderingdesk.test/w/impact?order=o1", tag: "order-o1" };

let db: Db;
let env: { VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; VAPID_SUBJECT: string };
let keys: { p256dh: string; auth: string };

async function seedSubscription(id: string, userId: string, endpoint = `https://fcm.googleapis.com/fcm/send/${id}`) {
  await db.insert(schema.pushSubscriptions).values({ id, userId, endpoint, keys, createdAt: 1, host: null });
  return { id, userId, endpoint, keys, host: null } satisfies PushTarget;
}

beforeEach(async () => {
  db = openTestDb().db;
  const vapid = await vapidPair();
  env = { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:ops@example.com" };
  keys = await browserKeys();
});

describe("encodePushNotice", () => {
  it("carries the title, body, link and tag only", () => {
    expect(JSON.parse(encodePushNotice(notice))).toEqual(notice);
  });

  it("stays far below the push size limit whatever the input", () => {
    const huge = "x".repeat(20000);
    const encoded = encodePushNotice({ title: huge, body: huge, url: `https://orderingdesk.test/${huge}`, tag: huge });
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(1024);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(PUSH_PAYLOAD_MAX_BYTES);
  });

  it("refuses a link that is not http or https", () => {
    expect(() => encodePushNotice({ ...notice, url: "javascript:alert(1)" })).toThrow();
  });
});

describe("sendPush", () => {
  it("posts an encrypted, VAPID-signed message to the subscription endpoint", async () => {
    const target = await seedSubscription("s1", "u1");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    expect(await sendPush(db, env, target, notice, { fetchImpl, urgency: "high", ttl: 3600 })).toBe("sent");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(target.endpoint);
    expect(init.method).toBe("post");
    expect(init.headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(init.headers["content-encoding"]).toBe("aes128gcm");
    expect(init.headers.ttl).toBe("3600");
    expect(init.headers.urgency).toBe("high");
    // The body is ciphertext: the notice text never travels in the clear.
    const body = new TextDecoder().decode(init.body as Uint8Array);
    expect(body).not.toContain("Riley");
  });

  it.each([404, 410])("deletes a subscription the push service answers %i for", async (status) => {
    const target = await seedSubscription("s_gone", "u1");
    const fetchImpl = vi.fn(async () => new Response(null, { status }));
    expect(await sendPush(db, env, target, notice, { fetchImpl })).toBe("gone");
    expect(await db.select().from(schema.pushSubscriptions)).toEqual([]);
  });

  it("keeps the subscription on any other failure", async () => {
    const target = await seedSubscription("s_keep", "u1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await sendPush(db, env, target, notice, { fetchImpl: async () => new Response(null, { status: 500 }) })).toBe("failed");
    expect(
      await sendPush(db, env, target, notice, {
        fetchImpl: async () => {
          throw new Error("network down");
        },
      }),
    ).toBe("failed");
    expect(await db.select({ id: schema.pushSubscriptions.id }).from(schema.pushSubscriptions)).toEqual([{ id: "s_keep" }]);
    // The endpoint is a capability URL: it never reaches the log.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(target.endpoint);
    warn.mockRestore();
  });

  // A row stored before the endpoint allowlist tightened, or written some
  // other way, never reaches the network, and a push service's redirect is
  // never followed (it would carry the VAPID-signed message elsewhere).
  it("re-checks the endpoint before posting and never follows a redirect", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const endpoint of [
      "https://storage.googleapis.com/fcm/send/s_bad",
      "http://fcm.googleapis.com/fcm/send/s_bad",
      "https://fcm.googleapis.com:443/fcm/send/s_bad",
      "https://evil.example/fcm/send/s_bad",
    ]) {
      const target = await seedSubscription(`s_${endpoint.length}_${endpoint.charCodeAt(9)}`, "u1", endpoint);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
      expect(await sendPush(db, env, target, notice, { fetchImpl }), endpoint).toBe("failed");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("evil.example");

    const target = await seedSubscription("s_ok", "u1");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    await sendPush(db, env, target, notice, { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("manual");
    // A redirect answer is a failure, and the subscription is kept.
    const redirecting = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    expect(await sendPush(db, env, target, notice, { fetchImpl: redirecting })).toBe("failed");
    expect(redirecting).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, "s_ok"))).length).toBe(1);
    warn.mockRestore();
  });

  it("sends nothing while VAPID keys are not configured", async () => {
    const target = await seedSubscription("s1", "u1");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const bare = { VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" };
    expect(pushConfigured(bare)).toBe(false);
    expect(await sendPush(db, bare, target, notice, { fetchImpl })).toBe("failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("sendPushToTargets", () => {
  it("sends one message per subscription, counts the outcomes and prunes the dead ones", async () => {
    await seedSubscription("a", "u1", "https://fcm.googleapis.com/fcm/send/a");
    await seedSubscription("b", "u1", "https://fcm.googleapis.com/fcm/send/b");
    await seedSubscription("c", "u2", "https://fcm.googleapis.com/fcm/send/c");
    await seedSubscription("d", "u3", "https://fcm.googleapis.com/fcm/send/d");
    const targets = await subscriptionsFor(db, ["u1", "u2"]);
    expect(targets.map((target) => target.id).sort()).toEqual(["a", "b", "c"]);
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL) => new Response(null, { status: String(url).endsWith("/b") ? 410 : 201 }),
    );
    const counts = await sendPushToTargets(db, env, targets, () => notice, { fetchImpl });
    expect(counts).toEqual({ sent: 2, gone: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const left = await db.select({ id: schema.pushSubscriptions.id }).from(schema.pushSubscriptions);
    expect(left.map((row) => row.id).sort()).toEqual(["a", "c", "d"]);
  });

  it("skips a target its notice builder declines", async () => {
    await seedSubscription("a", "u1");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const targets = await subscriptionsFor(db, ["u1"]);
    expect(await sendPushToTargets(db, env, targets, () => null, { fetchImpl })).toEqual({ sent: 0, gone: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("saveSubscription and removeSubscription", () => {
  const input = (endpoint = "https://fcm.googleapis.com/fcm/send/abc") => ({ endpoint, keys });

  it("stores the endpoint, keys, host and browser for the signed-in user", async () => {
    const saved = await saveSubscription(db, { userId: "u1", host: "orders.impactrentals.store", userAgent: "Phone", now: 5 }, input());
    expect(saved).toEqual({ kind: "saved" });
    const rows = await db.select().from(schema.pushSubscriptions);
    expect(rows).toEqual([
      expect.objectContaining({
        userId: "u1",
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        keys,
        host: "orders.impactrentals.store",
        userAgent: "Phone",
        createdAt: 5,
      }),
    ]);
  });

  it("moves an endpoint to whoever registers it last (a shared device)", async () => {
    await saveSubscription(db, { userId: "u1", host: "orderingdesk.test", userAgent: null, now: 1 }, input());
    await saveSubscription(db, { userId: "u2", host: "orderingdesk.test", userAgent: null, now: 2 }, input());
    const rows = await db.select().from(schema.pushSubscriptions);
    expect(rows.map((row) => row.userId)).toEqual(["u2"]);
  });

  it("keeps each person's ten newest devices", async () => {
    for (let i = 0; i < 12; i++) {
      await saveSubscription(db, { userId: "u1", host: null, userAgent: null, now: i }, input(`https://fcm.googleapis.com/fcm/send/${i}`));
    }
    const rows = await db.select({ endpoint: schema.pushSubscriptions.endpoint }).from(schema.pushSubscriptions);
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.endpoint)).not.toContain("https://fcm.googleapis.com/fcm/send/0");
    expect(rows.map((row) => row.endpoint)).not.toContain("https://fcm.googleapis.com/fcm/send/1");
  });

  // A client host is run by its tenant: a session there (or one captured
  // there) must not be able to push out the person's devices on the hub or
  // on another workspace's host.
  it("caps devices per host, so saving on one host never evicts a device on another", async () => {
    await saveSubscription(db, { userId: "u1", host: "orderingdesk.test", userAgent: "Hub phone", now: 0 }, input("https://fcm.googleapis.com/fcm/send/hub"));
    await saveSubscription(db, { userId: "u1", host: "orders.other.example", userAgent: null, now: 1 }, input("https://fcm.googleapis.com/fcm/send/other"));
    for (let i = 0; i < 12; i++) {
      await saveSubscription(
        db,
        { userId: "u1", host: "orders.impactrentals.store", userAgent: null, now: 10 + i },
        input(`https://fcm.googleapis.com/fcm/send/junk-${i}`),
      );
    }
    const rows = await db.select({ endpoint: schema.pushSubscriptions.endpoint, host: schema.pushSubscriptions.host }).from(schema.pushSubscriptions);
    expect(rows.filter((row) => row.host === "orders.impactrentals.store")).toHaveLength(10);
    expect(rows.map((row) => row.endpoint)).toContain("https://fcm.googleapis.com/fcm/send/hub");
    expect(rows.map((row) => row.endpoint)).toContain("https://fcm.googleapis.com/fcm/send/other");
    expect(rows.map((row) => row.endpoint)).not.toContain("https://fcm.googleapis.com/fcm/send/junk-0");
  });

  it("refuses to move an endpoint recorded on one host to another host", async () => {
    await saveSubscription(db, { userId: "u1", host: "orderingdesk.test", userAgent: "Hub phone", now: 1 }, input());
    const attacker = await browserKeys();
    for (const ctx of [
      { userId: "u1", host: "orders.impactrentals.store" },
      { userId: "u2", host: "orders.impactrentals.store" },
      { userId: "u1", host: null },
    ]) {
      const saved = await saveSubscription(db, { ...ctx, userAgent: "Other", now: 2 }, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: attacker });
      expect(saved.kind).toBe("conflict");
    }
    const rows = await db.select().from(schema.pushSubscriptions);
    expect(rows).toEqual([
      expect.objectContaining({ userId: "u1", host: "orderingdesk.test", keys, userAgent: "Hub phone", createdAt: 1 }),
    ]);
  });

  it.each([
    ["no body", null],
    ["a plain http endpoint", { endpoint: "http://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "BAAA".repeat(22), auth: "abcdefghijklmnopqrstuv" } }],
    ["an endpoint outside the browser push services", { endpoint: "https://evil.example/collect", keys: { p256dh: "BAAA".repeat(22), auth: "abcdefghijklmnopqrstuv" } }],
    ["an endpoint with credentials", { endpoint: "https://user:pw@fcm.googleapis.com/x", keys: { p256dh: "BAAA".repeat(22), auth: "abcdefghijklmnopqrstuv" } }],
    ["missing keys", { endpoint: "https://fcm.googleapis.com/fcm/send/x" }],
    ["keys that are not base64url", { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "<script>".repeat(12), auth: "abcdefghijklmnopqrstuv" } }],
  ])("refuses %s", async (_label, body) => {
    const saved = await saveSubscription(db, { userId: "u1", host: null, userAgent: null, now: 1 }, body);
    expect(saved.kind).toBe("invalid");
    expect(await db.select().from(schema.pushSubscriptions)).toEqual([]);
  });

  it("accepts the Apple, Mozilla and Windows push services", async () => {
    for (const endpoint of [
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
    ]) {
      expect(await saveSubscription(db, { userId: "u1", host: null, userAgent: null, now: 1 }, input(endpoint))).toEqual({ kind: "saved" });
    }
  });

  it("refuses a host that merely shares a push service's domain, storing nothing", async () => {
    for (const endpoint of [
      "https://storage.googleapis.com/bucket/collect",
      "https://www.googleapis.com/fcm/send/abc",
      "https://bugzilla.mozilla.com/wpush/v2/abc",
    ]) {
      expect(await saveSubscription(db, { userId: "u1", host: null, userAgent: null, now: 1 }, input(endpoint))).toMatchObject({ kind: "invalid" });
    }
    expect(await db.select().from(schema.pushSubscriptions)).toEqual([]);
  });

  it("removes only the caller's own endpoint", async () => {
    await saveSubscription(db, { userId: "u1", host: null, userAgent: null, now: 1 }, input());
    expect(await removeSubscription(db, { userId: "u2", host: null }, { endpoint: "https://fcm.googleapis.com/fcm/send/abc" })).toEqual({ kind: "not-found" });
    expect(await db.select().from(schema.pushSubscriptions)).toHaveLength(1);
    expect(await removeSubscription(db, { userId: "u1", host: null }, { endpoint: "https://fcm.googleapis.com/fcm/send/abc" })).toEqual({ kind: "removed" });
    expect(
      await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, "u1")),
    ).toEqual([]);
    expect((await removeSubscription(db, { userId: "u1", host: null }, { nope: true })).kind).toBe("invalid");
  });

  it("removes a device only from the host it was recorded on", async () => {
    await saveSubscription(db, { userId: "u1", host: "orderingdesk.test", userAgent: null, now: 1 }, input());
    expect(
      await removeSubscription(db, { userId: "u1", host: "orders.impactrentals.store" }, { endpoint: "https://fcm.googleapis.com/fcm/send/abc" }),
    ).toEqual({ kind: "not-found" });
    expect(await db.select().from(schema.pushSubscriptions)).toHaveLength(1);
    expect(
      await removeSubscription(db, { userId: "u1", host: "orderingdesk.test" }, { endpoint: "https://fcm.googleapis.com/fcm/send/abc" }),
    ).toEqual({ kind: "removed" });
  });
});

// Only the endpoints the browsers' own push services hand out today, so the
// Worker never posts to an address a signed-in person made up.
describe("pushServiceEndpoint", () => {
  it.each([
    ["Chrome (FCM, legacy path)", "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bH"],
    ["Chrome (FCM, web push path)", "https://fcm.googleapis.com/wp/dQw4w9WgXcQ:APA91bH"],
    ["Firefox", "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk"],
    ["Firefox without VAPID", "https://updates.push.services.mozilla.com/wpush/v1/gAAAAABk"],
    ["Safari", "https://web.push.apple.com/QGuQyavXutnMH-3ofDZ1Bk"],
    ["Edge on Windows", "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bx"],
    ["Edge on Windows, another region", "https://sg2p.notify.windows.com/w/?token=BQYAAAB"],
    ["Edge on Windows, a third region", "https://db5p.notify.windows.com/w/?token=BQYAAAB"],
  ])("accepts %s", (_label, endpoint) => {
    expect(pushServiceEndpoint(endpoint)).toBe(endpoint);
  });

  it.each([
    ["another Google API host", "https://storage.googleapis.com/fcm/send/x"],
    ["another Google API host with an FCM path", "https://www.googleapis.com/fcm/send/x"],
    ["the retired GCM host", "https://android.googleapis.com/gcm/send/x"],
    ["FCM outside its push paths", "https://fcm.googleapis.com/v1/projects/x/messages:send"],
    ["FCM with its path prefix only", "https://fcm.googleapis.com/wp/"],
    ["FCM with a path that climbs out of its prefix", "https://fcm.googleapis.com/wp/../v1/projects/x"],
    ["another Mozilla host", "https://bugzilla.mozilla.com/wpush/v2/x"],
    ["a host under Mozilla's push host", "https://evil.updates.push.services.mozilla.com/wpush/v2/x"],
    ["Mozilla outside its push path", "https://updates.push.services.mozilla.com/admin/x"],
    ["another Apple push host", "https://api.push.apple.com/3/device/x"],
    ["Apple with no token", "https://web.push.apple.com/"],
    ["WNS without a region label", "https://notify.windows.com/w/?token=x"],
    ["WNS two labels deep", "https://a.b.notify.windows.com/w/?token=x"],
    ["WNS outside its push path", "https://sg2p.notify.windows.com/?token=x"],
    ["a look-alike host", "https://fcm.googleapis.com.evil.example/wp/x"],
    ["a trailing-dot host", "https://fcm.googleapis.com./wp/x"],
    ["plain http", "http://fcm.googleapis.com/wp/x"],
    ["a port", "https://fcm.googleapis.com:8443/wp/x"],
    ["the default port written out", "https://fcm.googleapis.com:443/wp/x"],
    ["credentials", "https://user:pw@fcm.googleapis.com/wp/x"],
    ["a user name only", "https://user@web.push.apple.com/x"],
    ["white space", "https://fcm.googleapis.com/wp/x y"],
    ["an IP address", "https://142.250.0.1/wp/x"],
    ["not a URL", "fcm.googleapis.com/wp/x"],
    ["something too long", `https://fcm.googleapis.com/wp/${"a".repeat(2100)}`],
  ])("refuses %s", (_label, endpoint) => {
    expect(pushServiceEndpoint(endpoint)).toBeNull();
  });

  it("refuses anything but a string", () => {
    for (const value of [null, undefined, 42, {}, ["https://fcm.googleapis.com/wp/x"]]) {
      expect(pushServiceEndpoint(value)).toBeNull();
    }
  });
});
