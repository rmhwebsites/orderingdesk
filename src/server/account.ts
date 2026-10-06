// What the account menu shows (comprehensive desk design section 1): who is
// signed in, their role here, and where their other workspaces are. Built on
// the server from the guard's result, so the client never asks.

import type { Db } from "@/db";
import { roleLabel, type Role } from "@/lib/roles";
import type { Viewer } from "./guard";
import { appOrigin } from "./host";
import { listWorkspacesForViewer } from "./workspaces";

export type AccountView = {
  // The person's name, or null to show the email alone.
  name: string | null;
  email: string;
  // Their role where they are ("Manager"), or null on the hub list for a
  // client (no role there).
  roleLabel: string | null;
  // The workspace list, or null when there is nowhere else to go. On a
  // client host it is the hub's own address (sessions are per host, so the
  // hub may ask them to sign in there).
  switchHref: string | null;
  // Extra places (the hub's Platform admin page).
  links: { href: string; label: string }[];
};

export async function workspaceAccountView(
  db: Db,
  env: CloudflareEnv,
  input: { viewer: Viewer; name: string | null | undefined; role: Role; clientHost: boolean },
): Promise<AccountView> {
  const workspaces = await listWorkspacesForViewer(db, input.viewer);
  const elsewhere = input.viewer.platformAdmin || workspaces.length > 1;
  return {
    name: input.name?.trim() || null,
    email: input.viewer.email,
    roleLabel: roleLabel(input.role),
    switchHref: elsewhere ? (input.clientHost ? `${appOrigin(env)}/` : "/") : null,
    links: [],
  };
}
