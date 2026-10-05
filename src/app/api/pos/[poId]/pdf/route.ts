import { guardResponse, requireMemberByPo } from "@/server/guard";
import { openPoPdf } from "@/server/po/service";

type RouteContext = { params: Promise<{ poId: string }> };

// The PO's PDF, streamed from R2 to members of its workspace (staff too);
// 404 for everyone else and when there is no PDF yet. Never cached, shown
// inline in the browser's PDF viewer.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { poId } = await context.params;
    const { db, env, workspaceId } = await requireMemberByPo(poId, "staff");
    const pdf = await openPoPdf(db, env.PO_BUCKET, workspaceId, poId);
    if (!pdf) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response(pdf.body, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pdf.filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-length": String(pdf.size),
      },
    });
  } catch (e) {
    return guardResponse(e);
  }
}
