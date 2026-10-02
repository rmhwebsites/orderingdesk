import { saveBrandTheme } from "@/server/branding/assets";
import { brandingResponse } from "@/server/branding/respond";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// PLATFORM ADMINS ONLY (404 for anyone else, 401 signed out). Body: any of
// {colors: {primary, ink, background} | null, darkColors: {primary?, ink?,
// background?} | null, fonts: {heading, body} | null, radius: sharp |
// subtle | soft | rounded | pill | null}. Every value is checked here
// because it reaches CSS: hex colors only, fonts from the allowlist, radius
// from the list. 200 {branding}; 400 {error} for a bad value; 400 {error,
// issues} when colors fail WCAG AA (each issue names the field and a
// passing shade); 409 {error} on a concurrent change.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "platform");
    const body = (await request.json().catch(() => null)) as unknown;
    return brandingResponse(await saveBrandTheme(db, id, body));
  } catch (e) {
    return guardResponse(e);
  }
}
