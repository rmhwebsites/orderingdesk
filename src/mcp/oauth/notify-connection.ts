// After a grant is stored (src/mcp/oauth/authorize.ts): email the person
// that a new AI connection exists, with a link to Settings > AI connections
// on the host they connected on. Never throws. Relative imports only.

import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { user } from "../../db/schema";
import { sendNewConnectionEmail, type NewConnectionMessage } from "../../server/email/ai-connection";
import { loadMailWorkspace } from "../../server/email/workspace";
import { appOrigin, hubHostname, workspaceOrigin } from "../../server/host";
import type { ConnectionNotice } from "./authorize";

export async function notifyNewConnection(
  db: Db,
  env: CloudflareEnv,
  notice: ConnectionNotice,
  send: (env: CloudflareEnv, message: NewConnectionMessage) => Promise<void> = sendNewConnectionEmail,
): Promise<void> {
  try {
    const people = await db.select({ email: user.email }).from(user).where(eq(user.id, notice.userId)).limit(1);
    if (!people[0]) {
      return;
    }
    if (notice.workspaceId === null) {
      // A platform admin's hub connection for every workspace: the hub's
      // look and sender, and the hub's home, where every workspace is.
      await send(env, {
        to: people[0].email,
        workspace: null,
        workspaceName: "every workspace",
        everyWorkspace: true,
        clientLabel: notice.clientLabel,
        redirectHost: notice.redirectHost,
        settingsUrl: `${appOrigin(env)}/`,
      });
      return;
    }
    const workspace = await loadMailWorkspace(db, notice.workspaceId);
    if (!workspace) {
      return;
    }
    const onHub = notice.host.toLowerCase() === hubHostname(env);
    const settingsUrl = onHub
      ? `${appOrigin(env)}/w/${encodeURIComponent(workspace.slug)}/settings#ai`
      : `${workspaceOrigin(env, workspace)}/settings#ai`;
    await send(env, {
      to: people[0].email,
      workspace: onHub ? null : workspace,
      workspaceName: workspace.name,
      clientLabel: notice.clientLabel,
      redirectHost: notice.redirectHost,
      settingsUrl,
    });
  } catch (e) {
    console.error("[oauth] " + JSON.stringify({ workspaceId: notice.workspaceId, connectionEmail: "failed", error: e instanceof Error ? e.name : "unknown" }));
  }
}
