"use client";

import Link from "next/link";

export function requesterHref(basePath: string, requesterId: string | null): string | null {
  return requesterId ? `${basePath}/people/${encodeURIComponent(requesterId)}` : null;
}

// A requester's name: a link to their page when the search index knows
// them, plain text otherwise. It sits above a row's or card's own link
// (relative z-10) and does not open the row.
export function RequesterName({
  name,
  requesterId,
  basePath,
  className,
  fallback = "No customer name",
}: {
  name: string;
  requesterId: string | null;
  basePath: string;
  className?: string;
  fallback?: string;
}) {
  const href = requesterHref(basePath, requesterId);
  const text = name || fallback;
  if (!href) {
    return <span className={className}>{text}</span>;
  }
  return (
    <Link
      href={href}
      onClick={(event) => event.stopPropagation()}
      className={`relative z-10 underline-offset-4 hover:underline ${className ?? ""}`}
    >
      {text}
    </Link>
  );
}
