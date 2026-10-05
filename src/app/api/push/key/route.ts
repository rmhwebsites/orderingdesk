import { NextResponse } from "next/server";
import { guardResponse, requireSession } from "@/server/guard";
import { vapidPublicKey } from "@/server/push";

// The VAPID public key browsers subscribe with: {publicKey}. Signed-in
// people only (401 otherwise; 404 on a refused host). 503 {error} while
// push is not set up (no VAPID keys on the Worker). The private key never
// leaves the server.
export async function GET() {
  try {
    const { env } = await requireSession();
    const publicKey = vapidPublicKey(env);
    if (!publicKey) {
      return NextResponse.json({ error: "Push notifications are not set up yet." }, { status: 503 });
    }
    return NextResponse.json({ publicKey }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return guardResponse(e);
  }
}
