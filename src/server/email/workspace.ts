// Everything an email about a workspace needs: its branding (renderEmail)
// and its sender (senderFor). One read, shared by every template.

// Relative imports: the cron path bundles this (src/server/notify.ts).
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { workspaces, workspaceSettings } from "../../db/schema";
import type { EmailWorkspace } from "./layout";
import type { SenderWorkspace } from "./send";

export type MailWorkspace = EmailWorkspace & SenderWorkspace & { slug: string };

export async function loadMailWorkspace(db: Db, workspaceId: string): Promise<MailWorkspace | null> {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      accentColor: workspaces.accentColor,
      branding: workspaces.branding,
      customDomain: workspaces.customDomain,
      customDomainStatus: workspaces.customDomainStatus,
      sendingAddress: workspaces.sendingAddress,
      sendingVerifiedAt: workspaces.sendingVerifiedAt,
      replyTo: workspaceSettings.replyTo,
    })
    .from(workspaces)
    .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, replyTo: row.replyTo ?? null } : null;
}
