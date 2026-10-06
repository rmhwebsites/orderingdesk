"use client";

import "./globals.css";
import { ErrorScreen } from "@/components/error-screen";

// The root layout itself failed: this replaces it, so it brings its own
// document, styles and the stored theme (public/theme-init.js).
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong</title>
        <script src="/theme-init.js" />
      </head>
      <body className="min-h-dvh bg-bg font-sans text-ink">
        <ErrorScreen title="Something went wrong" onRetry={retry} homeHref="/" homeLabel="Go to the start page" digest={error.digest} />
      </body>
    </html>
  );
}
