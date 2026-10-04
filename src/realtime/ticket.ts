// Live tickets: a short-lived proof that a signed-in member may open the
// workspace's realtime socket. The browser cannot send its session cookie
// through anything we control on the WebSocket upgrade path (the socket is
// handled in custom-worker.ts, before Next.js and better-auth), so it first
// asks a guarded route for a ticket and passes it in the socket URL.
//
// Format: base64url(JSON {workspaceId, userId, exp, nonce}) "." base64url(HMAC-
// SHA256). The HMAC covers a purpose prefix plus the encoded payload, keyed
// with BETTER_AUTH_SECRET; the prefix keeps these signatures from ever
// matching another use of that secret. WebCrypto only, so it runs on
// workerd and in Node tests. Relative imports only: bundled into the custom
// worker.
//
// Single use: every ticket carries a random nonce, and the workspace's room
// (src/realtime/room.ts) remembers each nonce it has admitted until the
// ticket expires, so a ticket that leaks (a log, a proxy) cannot open a
// second socket.

export const LIVE_TICKET_TTL_MS = 60000;

const PURPOSE = "ordering-desk.live-ticket.v1.";
const MAX_TICKET_LENGTH = 1024;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export type LiveTicketClaims = { workspaceId: string; userId: string; exp: number; nonce: string };

const NONCE = /^[0-9a-f]{32}$/;

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Throws on input that is not base64url.
function fromBase64Url(segment: string): Uint8Array {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function hmac(secret: string, payloadSegment: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(PURPOSE + payloadSegment));
  return new Uint8Array(signature);
}

// Compares every byte whatever the first mismatch, so the time taken says
// nothing about how much of a forged signature was right. Lengths are not
// secret (every genuine signature is 32 bytes).
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function signLiveTicket(
  subject: { workspaceId: string; userId: string },
  secret: string,
  now: number = Date.now(),
): Promise<{ ticket: string; expiresAt: number }> {
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not configured");
  }
  const exp = now + LIVE_TICKET_TTL_MS;
  const payloadSegment = toBase64Url(
    encoder.encode(
      JSON.stringify({ workspaceId: subject.workspaceId, userId: subject.userId, exp, nonce: randomNonce() }),
    ),
  );
  const signatureSegment = toBase64Url(await hmac(secret, payloadSegment));
  return { ticket: `${payloadSegment}.${signatureSegment}`, expiresAt: exp };
}

// The ticket's claims when the signature is genuine, it has not expired and
// it was issued for this workspace; null otherwise (never throws).
export async function verifyLiveTicket(
  ticket: string,
  opts: { secret: string; workspaceId: string; now?: number },
): Promise<LiveTicketClaims | null> {
  if (!opts.secret || typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) {
    return null;
  }
  const parts = ticket.split(".");
  if (parts.length !== 2 || !SEGMENT.test(parts[0]) || !SEGMENT.test(parts[1])) {
    return null;
  }
  const [payloadSegment, signatureSegment] = parts;
  try {
    const expected = await hmac(opts.secret, payloadSegment);
    if (!timingSafeEqual(expected, fromBase64Url(signatureSegment))) {
      return null;
    }
    const claims: unknown = JSON.parse(decoder.decode(fromBase64Url(payloadSegment)));
    if (
      typeof claims !== "object" ||
      claims === null ||
      typeof (claims as LiveTicketClaims).workspaceId !== "string" ||
      typeof (claims as LiveTicketClaims).userId !== "string" ||
      typeof (claims as LiveTicketClaims).exp !== "number" ||
      !Number.isFinite((claims as LiveTicketClaims).exp) ||
      typeof (claims as LiveTicketClaims).nonce !== "string" ||
      !NONCE.test((claims as LiveTicketClaims).nonce)
    ) {
      return null;
    }
    const { workspaceId, userId, exp, nonce } = claims as LiveTicketClaims;
    if (exp <= (opts.now ?? Date.now()) || workspaceId !== opts.workspaceId) {
      return null;
    }
    return { workspaceId, userId, exp, nonce };
  } catch {
    return null;
  }
}
