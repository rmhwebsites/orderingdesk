import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AuthError, requirePlatformAdmin } from "@/server/guard";
import { requestHost } from "@/server/request-host";
import { loadAdminPage } from "@/server/admin-page";
import { AdminScreen } from "@/components/admin/admin-screen";

// Per-viewer: reads the session.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Platform admin" };

// Platform admins only, on the hub: every workspace (create, open any),
// the platform admins, and every user with their workspaces. Signed out
// goes to sign-in; anyone else, and every client host, gets the not-found
// page.
export default async function AdminPage() {
  if ((await requestHost()).kind !== "hub") {
    notFound();
  }
  let guarded: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    guarded = await requirePlatformAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.status === 401) {
        redirect("/sign-in");
      }
      notFound();
    }
    throw e;
  }
  const data = await loadAdminPage(guarded.db, guarded.env, guarded.userId);
  return <AdminScreen data={data} />;
}
