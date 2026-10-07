"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MapPinIcon } from "@phosphor-icons/react/MapPin";
import { TrayIcon } from "@phosphor-icons/react/Tray";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { useWorkspace } from "./workspace-provider";

export type NavSection = "desk" | "people" | "locations";

// Which section a path is in, under the workspace's base path ("" on its
// client host, /w/<slug> on the hub); null for anything else (Settings).
export function navSection(pathname: string, basePath: string): NavSection | null {
  if (!pathname.startsWith(basePath)) {
    return null;
  }
  const rest = pathname.slice(basePath.length);
  if (rest === "" || rest === "/") {
    return "desk";
  }
  if (rest === "/people" || rest.startsWith("/people/")) {
    return "people";
  }
  if (rest === "/locations" || rest.startsWith("/locations/")) {
    return "locations";
  }
  return null;
}

const LINKS = [
  { section: "desk", label: "Desk", Icon: TrayIcon, href: (base: string) => base || "/" },
  { section: "people", label: "People", Icon: UsersThreeIcon, href: (base: string) => `${base}/people` },
  { section: "locations", label: "Locations", Icon: MapPinIcon, href: (base: string) => `${base}/locations` },
] as const;

// Desk, People, Locations (design section 3). Icons with labels from sm up;
// icons only on phones, labels kept for screen readers; 40px targets.
export function WorkspaceNav() {
  const { workspace } = useWorkspace();
  const active = navSection(usePathname() ?? "", workspace.basePath);
  return (
    <nav aria-label="Workspace" className="flex items-center gap-1">
      {LINKS.map(({ section, label, Icon, href }) => (
        <Link
          key={section}
          href={href(workspace.basePath)}
          aria-current={active === section ? "page" : undefined}
          className={`inline-flex h-10 min-w-10 items-center justify-center gap-2 rounded-control px-2.5 text-sm font-semibold transition-colors sm:px-3 ${
            active === section ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
          }`}
        >
          <Icon size={18} aria-hidden />
          <span className="sr-only sm:not-sr-only">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
