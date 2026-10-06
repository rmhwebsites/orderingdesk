"use client";

import { useCallback, useSyncExternalStore } from "react";

// The desk's table breakpoint: --breakpoint-desk in src/app/globals.css
// (55rem, 880px). Change them together.
export const DESK_MEDIA = "(min-width: 55rem)";

// Whether a media query matches, kept current as the window changes. The
// server render, and the client render that hydrates it, use serverValue.
export function useMediaQuery(query: string, serverValue = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => serverValue);
}
