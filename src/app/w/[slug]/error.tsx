"use client";

import { useParams } from "next/navigation";
import { ErrorScreen } from "@/components/error-screen";

// A desk or Settings screen that failed, inside the workspace shell (the
// layout above keeps rendering, so the top bar and account menu stay). No
// workspace data here, so no guard: the layout already ran it.
export default function WorkspaceError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  return (
    <ErrorScreen
      title="This screen did not load"
      onRetry={retry}
      homeHref={slug ? `/w/${encodeURIComponent(slug)}` : "/"}
      homeLabel="Back to orders"
      digest={error.digest}
    />
  );
}
