"use client";

import { ChatTextIcon } from "@phosphor-icons/react/ChatText";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { ClipboardTextIcon } from "@phosphor-icons/react/ClipboardText";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { ShoppingBagIcon } from "@phosphor-icons/react/ShoppingBag";
import { StorefrontIcon } from "@phosphor-icons/react/Storefront";
import { TagIcon } from "@phosphor-icons/react/Tag";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import type { EventGlyph, EventLook } from "@/lib/event-look";

const GLYPHS: Record<EventGlyph, typeof ChatTextIcon> = {
  note: ChatTextIcon,
  status: TagIcon,
  approve: CheckCircleIcon,
  reject: XCircleIcon,
  order: ShoppingBagIcon,
  request: ClipboardTextIcon,
  po: FileTextIcon,
  "po-sent": PaperPlaneTiltIcon,
  warning: WarningIcon,
  shopify: StorefrontIcon,
  completed: CheckCircleIcon,
  deleted: TrashIcon,
};

// An activity entry's icon on its tone (src/lib/event-look.ts), the same in
// the drawer's timeline and the bell. Decorative: the entry's text says it.
export function EventIcon({ look, className = "" }: { look: EventLook; className?: string }) {
  const Icon = GLYPHS[look.glyph];
  return (
    <span
      data-tone={look.tone}
      className={`grid size-8 shrink-0 place-items-center rounded-control bg-tone-fill text-tone-text ${className}`.trim()}
    >
      <Icon size={16} aria-hidden />
    </span>
  );
}
