"use client";

import Link from "next/link";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { roleAtLeast } from "@/lib/roles";
import { syncChipState } from "@/lib/sync-status";
import { useWorkspace } from "./workspace-provider";
import { SETTINGS_PAGE_AVAILABLE } from "@/lib/features";

function landed(added: number, updated: number): string {
  const parts = [];
  if (added > 0) {
    parts.push(`${added} new`);
  }
  if (updated > 0) {
    parts.push(`${updated} updated`);
  }
  return parts.length > 0 ? ` ${parts.join(" and ")} ${added + updated === 1 ? "order" : "orders"} still came through.` : "";
}

// Persistent sync problems, inline under the top bar: the last manual run's
// failure (with what still landed), else the connection's last error. It
// stays until a later sync clears it; it is a state, not a toast.
export function SyncBanner() {
  const { sync, manual, role, workspace } = useWorkspace();
  const chip = syncChipState(sync, Date.now());
  const failure = manual.failure;
  const detail = failure ? failure.message : chip.kind === "ready" ? chip.detail : null;
  if (!detail) {
    return null;
  }
  const severe = chip.kind === "ready" && chip.tone === "bad";

  return (
    <div data-tone={severe ? "red" : "amber"} className="border-b border-line bg-tone-fill" role="status">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm text-tone-text sm:px-6">
        <WarningIcon size={18} aria-hidden className="mt-px shrink-0" />
        <p className="min-w-0 flex-1">
          <span className="font-semibold">{failure ? "Sync stopped: " : "Last sync failed: "}</span>
          <span className="break-words">{detail}</span>
          {failure ? landed(failure.added, failure.updated) : null}
        </p>
        {/* The store connection is a platform-admin setting. */}
        {SETTINGS_PAGE_AVAILABLE && roleAtLeast(role, "platform") ? (
          <Link
            href={`${workspace.basePath}/settings`}
            className="shrink-0 font-semibold underline decoration-1 underline-offset-2 hover:decoration-2"
          >
            Check the store connection
          </Link>
        ) : null}
      </div>
    </div>
  );
}
