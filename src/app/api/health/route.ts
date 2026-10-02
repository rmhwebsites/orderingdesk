import { NextResponse } from "next/server";

// Never cached or prerendered: the answer is the host of this request.
export const dynamic = "force-dynamic";

// {ok: true, host} on every host, unknown and pending ones included
// (custom-worker.ts lets this one path through). The custom domain check
// (src/server/domains.ts) fetches https://<domain>/api/health and compares
// the host reported here, which proves the domain reaches this Worker. host
// is the Host the platform routed (custom-worker.ts pins x-forwarded-host,
// which OpenNext copies over Host), lowercased.
export async function GET(request: Request) {
  const host = (request.headers.get("host") ?? "").trim().toLowerCase();
  return NextResponse.json({ ok: true, host }, { headers: { "cache-control": "no-store" } });
}
