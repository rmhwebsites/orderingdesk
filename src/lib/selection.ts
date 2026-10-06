// Bulk selection on the desk list (comprehensive desk design section 1): a
// click toggles one card; a shift click sets every card between the last
// one clicked and this one (in list order) to this card's new state. At
// most max cards stay selected; capped says the cap stopped it.

export type Selection = { selected: ReadonlySet<string>; anchor: string | null };

export function toggleSelection(
  current: Selection,
  visibleIds: readonly string[],
  id: string,
  opts: { range: boolean; max: number },
): { selected: Set<string>; anchor: string; capped: boolean } {
  const turnOn = !current.selected.has(id);
  const next = new Set(current.selected);
  let ids = [id];
  if (opts.range && current.anchor !== null) {
    const from = visibleIds.indexOf(current.anchor);
    const to = visibleIds.indexOf(id);
    if (from !== -1 && to !== -1) {
      ids = visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
  }
  let capped = false;
  for (const each of ids) {
    if (!turnOn) {
      next.delete(each);
    } else if (!next.has(each)) {
      if (next.size >= opts.max) {
        capped = true;
        break;
      }
      next.add(each);
    }
  }
  return { selected: next, anchor: id, capped };
}

export function selectAll(visibleIds: readonly string[], max: number): { selected: Set<string>; capped: boolean } {
  return { selected: new Set(visibleIds.slice(0, max)), capped: visibleIds.length > max };
}
