// The 6-digit sign-in codes of the authorize page (comprehensive desk design
// section 4; Wave 2 plan, Decision 5). A link opened from email would land in
// another browser than the chat app's sign-in window, so the page asks for a
// code instead. Rules:
// - only a SHA-256 of origin, row id and code is stored; the IP is hashed
//   with the origin;
// - a code lives 10 minutes and allows 5 tries; it is bound to the host and
//   to the OAuth client that asked;
// - at most 5 codes per email per host and 20 per IP per hour;
// - a code is sent only to an email that may connect (lookupUser), but a
//   row is written for everyone and everyone gets the same page, so the page
//   reveals nothing about who has access;
// - lookupUser runs in the background after the page has answered (it can
//   call Shopify for an employee, Wave 3), so the response time is the same
//   for everyone; the row names the person only once the lookup says so,
//   and the code is sent after that, so a code typed earlier never passes;
// - after the right code, the consent page may use the sign-in once, within
//   10 minutes.
// Relative imports only.

import { and, count, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { aiSignInCodes } from "../../db/schema";
import { CODE_ATTEMPTS, CODE_TTL_MS, CODES_PER_EMAIL_HOUR, CODES_PER_IP_HOUR, CONSENT_AFTER_CODE_MS } from "../constants";
import { sha256Hex, timingSafeEqual } from "../hash";
import { newId, sixDigitCode } from "../ids";

const HOUR_MS = 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

function codeHash(origin: string, id: string, code: string): Promise<string> {
  return sha256Hex(`ordering-desk.ai-code.v1\n${origin}\n${id}\n${code}`);
}

export type CodeRequest = { origin: string; email: string; clientId: string; ip: string };

export async function requestSignInCode(
  db: Db,
  input: CodeRequest,
  deps: {
    now: number;
    lookupUser: (email: string) => Promise<string | null>;
    send: (code: string) => Promise<void>;
    background: (work: Promise<unknown>) => void;
  },
): Promise<string> {
  const { now } = deps;
  const id = newId();
  const ipHash = await sha256Hex(`ordering-desk.ai-ip.v1\n${input.origin}\n${input.ip}`);
  const since = now - HOUR_MS;
  const [byEmail, byIp] = await Promise.all([
    db
      .select({ n: count() })
      .from(aiSignInCodes)
      .where(and(eq(aiSignInCodes.origin, input.origin), eq(aiSignInCodes.email, input.email), gt(aiSignInCodes.createdAt, since))),
    db.select({ n: count() }).from(aiSignInCodes).where(and(eq(aiSignInCodes.ipHash, ipHash), gt(aiSignInCodes.createdAt, since))),
  ]);
  if (Number(byEmail[0]?.n ?? 0) >= CODES_PER_EMAIL_HOUR || Number(byIp[0]?.n ?? 0) >= CODES_PER_IP_HOUR) {
    console.log("[oauth] " + JSON.stringify({ code: "rate_limited" }));
    return id;
  }
  const code = sixDigitCode();
  await db.insert(aiSignInCodes).values({
    id,
    origin: input.origin,
    email: input.email,
    userId: null,
    clientId: input.clientId,
    codeHash: await codeHash(input.origin, id, code),
    ipHash,
    createdAt: now,
    expiresAt: now + CODE_TTL_MS,
  });
  deps.background(
    (async () => {
      const userId = await deps.lookupUser(input.email);
      if (!userId) {
        return;
      }
      await db
        .update(aiSignInCodes)
        .set({ userId })
        .where(and(eq(aiSignInCodes.id, id), isNull(aiSignInCodes.userId)));
      await deps.send(code);
    })().catch((e: unknown) => {
      console.error("[oauth] " + JSON.stringify({ codeEmail: "failed", error: e instanceof Error ? e.name : "unknown" }));
    }),
  );
  return id;
}

export type VerifyResult = { kind: "ok"; userId: string; email: string } | { kind: "wrong"; attemptsLeft: number } | { kind: "expired" };

export async function verifySignInCode(
  db: Db,
  input: { id: string; origin: string; clientId: string; code: string },
  now: number,
): Promise<VerifyResult> {
  const rows = await db
    .select()
    .from(aiSignInCodes)
    .where(and(eq(aiSignInCodes.id, input.id), eq(aiSignInCodes.origin, input.origin), eq(aiSignInCodes.clientId, input.clientId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.verifiedAt !== null || row.consumedAt !== null || row.expiresAt <= now || row.attempts >= CODE_ATTEMPTS) {
    return { kind: "expired" };
  }
  const bumped = await db
    .update(aiSignInCodes)
    .set({ attempts: sql`${aiSignInCodes.attempts} + 1` })
    .where(and(eq(aiSignInCodes.id, row.id), lt(aiSignInCodes.attempts, CODE_ATTEMPTS), isNull(aiSignInCodes.verifiedAt)))
    .returning({ attempts: aiSignInCodes.attempts });
  if (bumped.length === 0) {
    return { kind: "expired" };
  }
  const right = /^\d{6}$/.test(input.code) && timingSafeEqual(row.codeHash, await codeHash(input.origin, row.id, input.code));
  if (!right || row.userId === null) {
    const attemptsLeft = CODE_ATTEMPTS - bumped[0].attempts;
    return attemptsLeft > 0 ? { kind: "wrong", attemptsLeft } : { kind: "expired" };
  }
  const marked = await db
    .update(aiSignInCodes)
    .set({ verifiedAt: now })
    .where(and(eq(aiSignInCodes.id, row.id), isNull(aiSignInCodes.verifiedAt)))
    .returning({ id: aiSignInCodes.id });
  return marked.length === 1 ? { kind: "ok", userId: row.userId, email: row.email } : { kind: "expired" };
}

export async function consumeSignIn(
  db: Db,
  input: { id: string; origin: string; clientId: string },
  now: number,
): Promise<{ userId: string } | null> {
  const rows = await db
    .update(aiSignInCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(aiSignInCodes.id, input.id),
        eq(aiSignInCodes.origin, input.origin),
        eq(aiSignInCodes.clientId, input.clientId),
        isNotNull(aiSignInCodes.verifiedAt),
        isNull(aiSignInCodes.consumedAt),
        gt(aiSignInCodes.verifiedAt, now - CONSENT_AFTER_CODE_MS),
      ),
    )
    .returning({ userId: aiSignInCodes.userId });
  const userId = rows[0]?.userId;
  return userId ? { userId } : null;
}
