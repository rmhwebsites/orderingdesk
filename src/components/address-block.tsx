// The one way an address shows in the app (comprehensive design section
// 2): a company location's name in bold, then the address lines, then the
// phone; with no location, the address alone. The lines come from
// src/lib/address.ts, which the emails and the PO PDF share.

import type { AddressBlockModel } from "@/lib/address";

export function AddressBlock({
  block,
  empty,
  className = "",
}: {
  block: AddressBlockModel | null;
  // Shown when there is no address at all.
  empty: string;
  className?: string;
}) {
  if (!block || (block.heading === null && block.lines.length === 0)) {
    return <p className={["text-sm text-ink-2", className].filter(Boolean).join(" ")}>{empty}</p>;
  }
  return (
    <address className={["text-sm not-italic leading-relaxed text-ink", className].filter(Boolean).join(" ")}>
      {block.heading ? <span className="block font-semibold">{block.heading}</span> : null}
      {block.lines.map((line, index) => (
        <span key={index} className="block break-words">
          {line}
        </span>
      ))}
      {block.phone ? <span className="mt-1 block font-mono text-ink-2">{block.phone}</span> : null}
    </address>
  );
}
