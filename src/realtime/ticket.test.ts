import { describe, it, expect } from "vitest";
import { LIVE_TICKET_TTL_MS, signLiveTicket, verifyLiveTicket } from "./ticket";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const WS = "ws_impact";
const USER = "user_marta";
const NOW = Date.parse("2026-10-02T09:30:00.000Z");

function flipChar(text: string, index: number): string {
  const c = text[index];
  return text.slice(0, index) + (c === "A" ? "B" : "A") + text.slice(index + 1);
}

describe("signLiveTicket", () => {
  it("returns two unpadded base64url segments and a 60 second expiry", async () => {
    const { ticket, expiresAt } = await signLiveTicket({ workspaceId: WS, userId: USER }, SECRET, NOW);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(expiresAt).toBe(NOW + LIVE_TICKET_TTL_MS);
    expect(LIVE_TICKET_TTL_MS).toBe(60000);
  });

  it("refuses to sign without a secret", async () => {
    await expect(signLiveTicket({ workspaceId: WS, userId: USER }, "", NOW)).rejects.toThrow();
  });
});

describe("verifyLiveTicket", () => {
  it("accepts a fresh ticket for its own workspace", async () => {
    const { ticket } = await signLiveTicket({ workspaceId: WS, userId: USER }, SECRET, NOW);
    expect(await verifyLiveTicket(ticket, { secret: SECRET, workspaceId: WS, now: NOW + 1000 })).toEqual({
      workspaceId: WS,
      userId: USER,
      exp: NOW + LIVE_TICKET_TTL_MS,
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  // The nonce makes each ticket single use: the room remembers it until
  // the ticket expires (src/realtime/room.ts).
  it("gives every ticket its own nonce", async () => {
    const a = await signLiveTicket({ workspaceId: WS, userId: USER }, SECRET, NOW);
    const b = await signLiveTicket({ workspaceId: WS, userId: USER }, SECRET, NOW);
    const claimsA = await verifyLiveTicket(a.ticket, { secret: SECRET, workspaceId: WS, now: NOW });
    const claimsB = await verifyLiveTicket(b.ticket, { secret: SECRET, workspaceId: WS, now: NOW });
    expect(claimsA?.nonce).toBeTruthy();
    expect(claimsA?.nonce).not.toBe(claimsB?.nonce);
  });

  it("rejects a genuine ticket without a nonce (the format before single use)", async () => {
    const payload = btoa(JSON.stringify({ workspaceId: WS, userId: USER, exp: NOW + 60000 }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("ordering-desk.live-ticket.v1." + payload)),
    );
    const signatureSegment = btoa(String.fromCharCode(...signature))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await verifyLiveTicket(`${payload}.${signatureSegment}`, { secret: SECRET, workspaceId: WS, now: NOW })).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const { ticket } = await signLiveTicket({ workspaceId: WS, userId: USER }, SECRET, NOW);
    const [payload, signature] = ticket.split(".");
    // A forged payload naming another user, kept under the original signature.
    const forged = btoa(JSON.stringify({ workspaceId: WS, userId: "user_mallory", exp: NOW + 60000 }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await verifyLiveTicket(`${forged}.${signature}`, { secret: SECRET, workspaceId: WS, now: NOW })).toBeNull();
    expect(
      await verifyLiveTicket(`${flipChar(payload, 3)}.${signature}`, { secret: SECRET, workspaceId: WS, now: NOW }),
    ).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const { ticket } = await signLiveTicket({ workspaceId: WS, userId: USER }, SECRET, NOW);
    const [payload, signature] = ticket.split(".");
    expect(
      await verifyLiveTicket(`${payload}.${flipChar(signature, 5)}`, { secret: SECRET, workspaceId: WS, now: NOW }),
    ).toBeNull();
    expect(
      await verifyLiveTicket(`${payload}.${signature.slice(0, -2)}`, { secret: SECRET, workspaceId: WS, now: NOW }),
    ).toBeNull();
  });

  it("rejects a ticket signed with another secret", async () => {
    const { ticket } = await signLiveTicket({ workspaceId: WS, userId: USER }, "another-secret-value", NOW);
    expect(await verifyLiveTicket(ticket, { secret: SECRET, workspaceId: WS, now: NOW })).toBeNull();
  });

  it("rejects an expired ticket, including exactly at its expiry", async () => {
    const { ticket, expiresAt } = await signLiveTicket({ workspaceId: WS, userId: USER }, SECRET, NOW);
    expect(await verifyLiveTicket(ticket, { secret: SECRET, workspaceId: WS, now: expiresAt - 1 })).not.toBeNull();
    expect(await verifyLiveTicket(ticket, { secret: SECRET, workspaceId: WS, now: expiresAt })).toBeNull();
    expect(await verifyLiveTicket(ticket, { secret: SECRET, workspaceId: WS, now: expiresAt + 3600000 })).toBeNull();
  });

  it("rejects a ticket presented for another workspace", async () => {
    const { ticket } = await signLiveTicket({ workspaceId: WS, userId: USER }, SECRET, NOW);
    expect(await verifyLiveTicket(ticket, { secret: SECRET, workspaceId: "ws_other", now: NOW })).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of ["", "abc", "a.b.c", ".", "abc.", ".abc", "!!!.###", "e30.e30"]) {
      expect(await verifyLiveTicket(bad, { secret: SECRET, workspaceId: WS, now: NOW })).toBeNull();
    }
    expect(await verifyLiveTicket("x".repeat(5000), { secret: SECRET, workspaceId: WS, now: NOW })).toBeNull();
  });

  it("rejects a validly signed payload with the wrong field types", async () => {
    // Signed with the real key, so only the shape check can stop it.
    const { ticket } = await signLiveTicket(
      { workspaceId: WS, userId: 42 as unknown as string },
      SECRET,
      NOW,
    );
    expect(await verifyLiveTicket(ticket, { secret: SECRET, workspaceId: WS, now: NOW })).toBeNull();
  });

  it("returns null when no secret is configured", async () => {
    const { ticket } = await signLiveTicket({ workspaceId: WS, userId: USER }, SECRET, NOW);
    expect(await verifyLiveTicket(ticket, { secret: "", workspaceId: WS, now: NOW })).toBeNull();
  });
});
