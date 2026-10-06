import { SettingsSkeleton } from "@/components/settings/settings-skeleton";

// Settings renders on the server (it reads the session); this shows while
// it does. It reads no data, so it needs no guard (the page runs it).
export default function Loading() {
  return <SettingsSkeleton />;
}
