import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";

// getAuth() per request: the Cloudflare context (D1, secrets) and the host
// are request-scoped. A refused host (unknown, or a client domain that is
// not active) gets a 404 and no auth at all.
export const { GET, POST } = toNextJsHandler(async (request: Request) => {
  const auth = await getAuth();
  if (!auth) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return auth.handler(request);
});
