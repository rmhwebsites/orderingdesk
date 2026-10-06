"use client";

// Small pieces shared by the order drawer and its request parts: the section
// frame (from the kit) and a copy-to-clipboard button. Tokens and the shared
// control shapes (src/components/ui.ts) only.

import { useEffect, useState } from "react";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { ui } from "@/components/ui";

// The section frame is shared (src/components/kit.tsx); re-exported for the
// drawer's parts.
export { Section } from "@/components/kit";

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
      <button type="button" onClick={copy} className={`${ui.buttonQuiet} h-8 border border-line px-3 text-xs pointer-coarse:h-10`}>
        {state === "copied" ? <CheckIcon size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
        {state === "copied" ? "Copied" : label}
      </button>
      <span role="status" className="text-xs text-ink-2">
        {state === "failed" ? "Copy is blocked here. Select the address instead." : ""}
      </span>
    </span>
  );
}
