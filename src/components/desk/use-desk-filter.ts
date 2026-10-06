"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { mergeDeskSearch, parseDeskQuery, type DeskQuery } from "@/lib/desk-query";

// The desk's filters live in the address (comprehensive desk design section
// 1): view, status, kind, q and sort, read with the same parser the orders
// API uses. A change replaces the history entry (Next keeps useSearchParams
// in step with history.replaceState), so typing a search adds no Back
// steps and the open drawer's ?order= stays.
export function useDeskFilter(): [DeskQuery, (patch: Partial<DeskQuery>) => void] {
  const params = useSearchParams();
  const query = useMemo(() => parseDeskQuery(params), [params]);
  const update = useCallback((patch: Partial<DeskQuery>) => {
    const search = mergeDeskSearch(window.location.search, patch);
    window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  }, []);
  return [query, update];
}
