"use client";

import { ErrorScreen } from "@/components/error-screen";

// A page outside a workspace that failed (the hub, a client host's desk).
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorScreen title="Something went wrong" onRetry={retry} homeHref="/" homeLabel="Go to the start page" digest={error.digest} />;
}
