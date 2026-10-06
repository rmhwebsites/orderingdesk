"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { mergeDeskSearch, parseDeskQuery, searchBoxText, type DeskQuery } from "@/lib/desk-query";

// The desk's filters live in the address (comprehensive desk design section
// 1): view, status, kind, q and sort, read with the same parser the orders
// API uses. A change replaces the history entry (Next keeps useSearchParams
// in step with history.replaceState), so typing a search adds no Back
// steps and the open drawer's ?order= stays.
//
// The third value is the search box's own text. Next hands a replaceState
// address to useSearchParams inside a transition, and a text input
// controlled by a transition update drops typed keys and moves the cursor,
// so the box reads this text, set in the same handler that writes the
// address. The list still filters by the address's q.
export function useDeskFilter(): [DeskQuery, (patch: Partial<DeskQuery>) => void, string] {
  const params = useSearchParams();
  const query = useMemo(() => parseDeskQuery(params), [params]);
  const [searchText, setSearchText] = useState(query.q);
  // The box takes a new q only when the address no longer holds what it
  // typed (Back, a link); a late q from its own typing changes nothing.
  useEffect(() => {
    setSearchText((current) => searchBoxText(current, window.location.search));
  }, [query.q]);
  const update = useCallback((patch: Partial<DeskQuery>) => {
    if (patch.q !== undefined) {
      setSearchText(patch.q);
    }
    const search = mergeDeskSearch(window.location.search, patch);
    window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  }, []);
  return [query, update, searchText];
}
