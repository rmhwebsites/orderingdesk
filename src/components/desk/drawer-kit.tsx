"use client";

// Small pieces shared by the order drawer and its request parts: a section
// with its heading, a tone chip, and a copy-to-clipboard button. Tokens and
// the shared control shapes (src/components/ui.ts) only.

import { useEffect, useState } from "react";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { ui } from "@/components/ui";

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-5 first:border-t-0 first:pt-0">
      <h3 className="mb-3 font-display text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

export function ToneChip({
  tone,
  children,
  size = "md",
}: {
  tone: string;
  children: React.ReactNode;
  size?: "sm" | "md";
}) {
  return (
    <span
      data-tone={tone}
      className={`inline-flex shrink-0 items-center rounded-control bg-tone-fill font-semibold text-tone-text ${
        size === "sm" ? "min-h-5 px-2 py-0.5 text-[11px] leading-tight" : "h-7 px-2.5 text-xs"
      }`}
    >
      {children}
    </span>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), 2400);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={copy} className={`${ui.buttonQuiet} h-8 border border-line px-3 text-xs`}>
        {state === "copied" ? <CheckIcon size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
        {state === "copied" ? "Copied" : label}
      </button>
      <span role="status" className="text-xs text-ink-2">
        {state === "failed" ? "Copy is blocked here. Select the address instead." : ""}
      </span>
    </span>
  );
}
