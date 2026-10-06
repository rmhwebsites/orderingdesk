# Wave 1a: Taste v2 Polish and the Work Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the Ordering Desk list into a dense, honest work queue (Open by default, ages, a Needs approval queue with Approve and next, URL filters, bulk status moves) on one shared component kit, with the taste v2 fixes from design section 1.

**Architecture:** A shared component kit (`src/components/kit.tsx`) and token fixes land first, then migration 0011 (`statuses.closed`, age thresholds, price display), then the account menu and one-row top bar, then the desk features. The server owns every view default through one pure parser (`src/lib/desk-query.ts`) that both the orders API and the client read; the desk loads one view at a time and the URL is the source of truth for filters. Every status rule lives once in `src/lib/status-rules.ts` and is applied by the single change, the bulk change and the bulk confirmation alike.

**Tech Stack:** Next.js 16 (App Router, OpenNext on Cloudflare Workers), D1 through drizzle-orm and drizzle-kit, better-auth, Tailwind v4 tokens (`src/app/globals.css`), Phosphor icons, vitest with in-memory SQLite built from the real migrations (`src/server/desk/test-helpers.ts`), `react-dom/server` render tests.

---

## Ground rules (read before Task 1)

- Binding design: `docs/plans/2026-10-05-comprehensive-desk-design.md` section 1. Read it first, then the newest STATE UPDATE sections at the end of `docs/HANDOFF.md`.
- Branch: work on `build/m1-core` in `/Users/ryboss/Documents/RMH LLC/Clients/Impact Rentals/order-desk`. Never push (main auto-deploys). Never add a `build` field to `wrangler.jsonc`.
- Test-first (@superpowers:test-driven-development): write the failing test, run it and see it fail for the stated reason, write the minimal code, see it pass.
- Gates before EVERY commit: `npm run test` and `npx tsc --noEmit --incremental false`, both green. `npm run build` before the last commit (Task 20).
- Commits: explicit pathspecs only, never `git add -A` or `git add .`. Use `git add <files>` then `git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <files>`. Deleted files: `git rm <file>` and list them in the pathspec.
- After any dependency change (this plan adds none): `rm -rf node_modules package-lock.json && npm install`, then `grep -c '"node_modules/@rolldown/binding-' package-lock.json` must print 15 or more before committing.
- Migrations: additive only. Generate with `npm run db:generate -- --name <name>`, append reviewed hand-written data steps, update the drift test in `src/db/schema.test.ts` and the minimum-migration pin in `src/server/sync/run.test.ts`, and prove the migration on production-shaped data (Task 20). Wave 1a owns migration 0011, named `work_queue`. Waves 1b (0012) and 1c (0013) build on this branch after it merges.
- Auth: 401 signed out; 404 (never 403) for non-members and under-ranked roles. The only 403s are the existing ones in `src/app/api/orders/[orderId]/status/route.ts`, `approve/route.ts` and `reject/route.ts` (staff on manager-only draft actions). New routes in this plan answer 404 to under-ranked roles. Every `/w/[slug]` and client-host page calls `requireMemberBySlug` and exports `dynamic = "force-dynamic"`.
- Shopify writes are sent once; a timeout is followed by a read, never a resend. This plan adds no new Shopify write; the bulk move reuses `pushAndShare` (the same single write per card as one status change).
- UI: tokens only (no hard-coded colors), Phosphor icons, light default plus dark, phone width works (375px), AA contrast, 40 to 44px touch targets on touch screens, chip text 12px or more. Load @design-taste-frontend for every UI task.
- Copy and code: zero em-dashes, en-dashes and emoji. Use hyphen-minus only.
- A PreToolUse hook rejects file writes containing the RegExp exec method written with its leading dot, and the DOM inner-HTML property written as one word. Use `String.match`, `RegExp.test` and JSX only.
- The repo is public: no client employee names, emails or phone numbers in code, tests, docs or commits. Use invented names (Jordan Vale, Casey Lin, Sam Ortiz) and `@example.com`.
- Line ranges in **Files** blocks are as they are TODAY (before Task 1). Earlier tasks shift them; find each spot by the quoted anchor text.
- Commands used throughout: `npx vitest run <file>`, `npm run test`, `npx tsc --noEmit --incremental false`, `npm run build`, `npm run db:generate -- --name <name>`, `npm run db:migrate:local`, `npm run dev`.

## Task list and build order

1. Component kit
2. Adopt the kit everywhere (one Chip, one InlineMessage, shared pieces)
3. Tokens and control states (primary hover, danger, busy, invalid fields)
4. One shared event map for the timeline and the bell
5. Migration 0011 `work_queue`
6. Closed statuses in the services and Settings > Statuses
7. Work queue settings (age thresholds, Show prices)
8. Account menu component and the server account view
9. One-row top bar and the hub header
10. Density: one list per breakpoint, 44px rows, compact cards, one toolbar row
11. Honest state: sync staleness, error and loading screens, themed not-found
12. Open by default (server views, counts, view switcher)
13. Age on every card and the Waiting longest sort
14. Needs approval queue and Approve and next
15. Filters in the URL
16. Bulk status change with server re-check
17. $0 price display
18. Request state copy
19. Phone ergonomics
20. Final verification

Then: Notes for Waves 1b and 1c, and Deploy notes (the end of this file).

---

### Task 1: Component kit

One Chip in three sizes, one InlineMessage, and shared Section, DetailRow, RadioCard, Segmented, Monogram and Spinner, so every later UI task reuses them. @design-taste-frontend

**Files:**
- Create: `src/components/kit.tsx`
- Test: `src/components/kit.test.ts`

**Step 1: Write the failing test**

Create `src/components/kit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Chip, DetailRow, InlineMessage, Monogram, RadioCard, Section, Segmented, Spinner } from "./kit";

// The shared kit (comprehensive desk design section 1). Rendered on the
// server, the way the rest of the component tests run.
describe("Chip", () => {
  it("comes in three sizes, 24, 28 and 32px tall, never with text under 12px", () => {
    const sm = renderToStaticMarkup(createElement(Chip, { tone: "slate", size: "sm", children: "Draft" }));
    const md = renderToStaticMarkup(createElement(Chip, { tone: "slate", children: "Open" }));
    const lg = renderToStaticMarkup(createElement(Chip, { tone: "amber", size: "lg", children: "Synced" }));
    expect(sm).toContain("min-h-6");
    expect(md).toContain("h-7");
    expect(lg).toContain("h-8");
    expect(lg).toContain('data-tone="amber"');
    for (const chip of [sm, md, lg]) {
      expect(chip).toContain("bg-tone-fill");
      expect(chip).not.toMatch(/text-\[(9|10|11)px\]/);
    }
  });
});

describe("InlineMessage", () => {
  it("announces problems at once and the rest politely, with an optional action", () => {
    const bad = renderToStaticMarkup(createElement(InlineMessage, { tone: "bad", children: "Not saved." }));
    expect(bad).toContain('role="alert"');
    expect(bad).toContain('data-tone="red"');
    const info = renderToStaticMarkup(
      createElement(InlineMessage, {
        tone: "info",
        children: "Draft orders are not synced.",
        action: createElement("button", { type: "button" }, "Dismiss"),
      }),
    );
    expect(info).toContain('role="status"');
    expect(info).toContain(">Dismiss<");
  });
});

describe("Section and DetailRow", () => {
  it("render a titled section and a term with its value", () => {
    expect(renderToStaticMarkup(createElement(Section, { title: "Items", children: "x" }))).toContain(">Items</h3>");
    const row = renderToStaticMarkup(createElement("dl", null, createElement(DetailRow, { term: "Company", children: "Impact" })));
    expect(row).toContain("<dt");
    expect(row).toContain(">Company</dt>");
    expect(row).toContain(">Impact</dd>");
  });
});

describe("RadioCard", () => {
  it("is a native radio with its label and help", () => {
    const html = renderToStaticMarkup(
      createElement(RadioCard, {
        name: "history-range",
        value: "all",
        checked: true,
        onChange: () => {},
        label: "All orders",
        help: "Every order the store has.",
      }),
    );
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*name="history-range"[^>]*value="all"[^>]*checked=""/);
    expect(html).toContain("border-primary-strong");
    expect(html).toContain("Every order the store has.");
  });
});

describe("Segmented", () => {
  it("is one radio group with counts and a primary-strong bar under the active option", () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, {
        name: "desk-view",
        legend: "Show",
        value: "open",
        options: [
          { value: "open", label: "Open", count: 1234 },
          { value: "all", label: "All" },
        ],
        onChange: () => {},
      }),
    );
    expect(html).toContain("<legend");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/<input[^>]*value="open"[^>]*checked=""/);
    expect(html).toContain("1,234");
    expect(html.match(/bg-primary-strong/g)).toHaveLength(1);
    expect(html).toContain("pointer-coarse:h-10");
  });

  it("can show icons only, keeping each label for screen readers and as a tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, {
        name: "theme",
        legend: "Theme",
        value: null,
        options: [{ value: "dark", label: "Dark", icon: createElement("svg"), iconOnly: true }],
        onChange: () => {},
      }),
    );
    expect(html).toContain('title="Dark"');
    expect(html).toContain('<span class="sr-only">Dark</span>');
    expect(html).not.toContain('checked=""');
  });
});

describe("Monogram and Spinner", () => {
  it("draws a decorative letter tile and a spinning busy mark", () => {
    const tile = renderToStaticMarkup(createElement(Monogram, { text: "CL", size: "sm" }));
    expect(tile).toContain(">CL<");
    expect(tile).toContain('aria-hidden="true"');
    expect(tile).toContain("size-8");
    const spinner = renderToStaticMarkup(createElement(Spinner));
    expect(spinner).toContain("od-spin");
    expect(spinner).toContain('aria-hidden="true"');
  });
});
```

**Step 2: Run it and see it fail**

Run: `npx vitest run src/components/kit.test.ts`
Expected: FAIL, `Error: Failed to resolve import "./kit" from "src/components/kit.test.ts". Does the file exist?`

**Step 3: Write the minimal implementation**

Create `src/components/kit.tsx`:

```tsx
"use client";

// One component kit (comprehensive desk design section 1, taste v2 audit):
// Chip in three sizes, InlineMessage, Section, DetailRow, RadioCard,
// Segmented, Monogram and Spinner. Desk, shell and Settings screens build
// from these instead of local copies (src/components/kit-adoption.test.ts
// keeps it that way). Tokens and the shared control shapes
// (src/components/ui.ts) only. A client module, so server components can
// render the hook-free pieces (Monogram, Chip) as client components.

import type { ReactNode } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";

export type ChipSize = "sm" | "md" | "lg";

// 24, 28 and 32px tall. Chip text is never under 12px (phone ergonomics).
const CHIP_SIZES: Record<ChipSize, string> = {
  sm: "min-h-6 gap-1 px-2 py-0.5 text-xs leading-tight",
  md: "h-7 gap-1.5 px-2.5 text-xs",
  lg: "h-8 gap-1.5 px-3 text-sm",
};

// A state label on its semantic tone (data-tone, src/app/globals.css).
export function Chip({
  tone,
  size = "md",
  title,
  className = "",
  children,
}: {
  tone: string;
  size?: ChipSize;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-tone={tone}
      title={title}
      className={`inline-flex shrink-0 items-center rounded-control bg-tone-fill font-semibold text-tone-text ${CHIP_SIZES[size]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}

export type MessageTone = "good" | "bad" | "warn" | "info";

const MESSAGE: Record<MessageTone, { tone: string; Icon: typeof InfoIcon }> = {
  good: { tone: "green", Icon: CheckCircleIcon },
  bad: { tone: "red", Icon: WarningCircleIcon },
  warn: { tone: "amber", Icon: WarningIcon },
  info: { tone: "blue", Icon: InfoIcon },
};

// A persistent inline message (a result, a problem, a heads-up), on its
// semantic tone. Errors are announced at once, the rest politely. action:
// a control at its end (a dismiss button).
export function InlineMessage({
  tone,
  children,
  id,
  action,
}: {
  tone: MessageTone;
  children: ReactNode;
  id?: string;
  action?: ReactNode;
}) {
  const { tone: color, Icon } = MESSAGE[tone];
  return (
    <div
      id={id}
      role={tone === "bad" ? "alert" : "status"}
      data-tone={color}
      className="flex items-start gap-2.5 rounded-panel bg-tone-fill px-3.5 py-3 text-sm text-tone-text"
    >
      <Icon size={18} aria-hidden className="mt-px shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action ? <div className="-my-1.5 -mr-1.5 shrink-0">{action}</div> : null}
    </div>
  );
}

// A drawer section with its heading, separated from the one before it.
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line py-5 first:border-t-0 first:pt-0">
      <h3 className="mb-3 font-display text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

// One term and its value inside a dl: stacked on phones, side by side from
// sm.
export function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-sm text-ink-2 sm:w-40">{term}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

// One choice of a short list drawn as a card: a native radio (keyboard and
// screen readers for free), its label and an optional line of help.
export function RadioCard({
  name,
  value,
  checked,
  onChange,
  label,
  help,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  help?: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-panel border px-3.5 py-3 transition-colors ${
        checked ? "border-primary-strong bg-surface" : "border-line hover:bg-surface-2"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 accent-[var(--primary-strong)]"
      />
      <span>
        <span className="block text-sm font-semibold text-ink">{label}</span>
        {help ? <span className="block text-sm text-ink-2">{help}</span> : null}
      </span>
    </label>
  );
}

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
  icon?: ReactNode;
  // Show only the icon; the label stays for screen readers and as a tooltip.
  iconOnly?: boolean;
};

// A one-of-several choice as a native radio group: arrow keys move between
// options and the group is one tab stop. The active option carries a bar in
// primary-strong (a plain primary can read under 3:1 on light surfaces;
// lime reads at 1.76:1). 40px tall on touch screens.
export function Segmented<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  size = "md",
  className = "",
}: {
  name: string;
  legend: string;
  value: T | null;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <fieldset className={`min-w-0 ${className}`.trim()}>
      <legend className="sr-only">{legend}</legend>
      <div className="inline-flex max-w-full overflow-x-auto rounded-control border border-line bg-surface-2 p-0.5 [scrollbar-width:none]">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              title={option.iconOnly ? option.label : undefined}
              className={`relative inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-control text-sm transition-colors pointer-coarse:h-10 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                size === "sm" ? "h-8 px-2.5" : "h-9 px-3.5"
              } ${checked ? "bg-surface font-semibold text-ink shadow-panel" : "text-ink-2 hover:text-ink"}`}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.icon}
              <span className={option.iconOnly ? "sr-only" : undefined}>{option.label}</span>
              {option.count !== undefined ? (
                <span className="font-mono text-xs tabular-nums text-ink-2">{option.count.toLocaleString("en-US")}</span>
              ) : null}
              {checked ? (
                <span aria-hidden className="absolute inset-x-2 bottom-0.5 h-0.5 rounded-control bg-primary-strong" />
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const MONOGRAM_SIZES = {
  sm: "size-8 text-sm",
  md: "size-9 text-sm",
  lg: "size-10 text-base",
} as const;

// One or two letters on a primary tile: a workspace without a symbol, or a
// person in the account menu. Decorative: the name beside it (or the
// control's label) carries the meaning.
export function Monogram({ text, size = "md" }: { text: string; size?: keyof typeof MONOGRAM_SIZES }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-control bg-primary font-display font-semibold text-primary-ink ${MONOGRAM_SIZES[size]}`}
    >
      {text}
    </span>
  );
}

// The busy mark inside a button that is working (the button carries
// aria-busy). Still under reduced motion (.od-spin in globals.css).
export function Spinner({ size = 16 }: { size?: number }) {
  return <CircleNotchIcon size={size} aria-hidden className="od-spin shrink-0" />;
}
```

**Step 4: Run it and see it pass**

Run: `npx vitest run src/components/kit.test.ts`
Expected: PASS (7 tests).

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
git add src/components/kit.tsx src/components/kit.test.ts
git commit -m "feat: one component kit (Chip, InlineMessage, Section, DetailRow, RadioCard, Segmented, Monogram, Spinner)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/kit.tsx src/components/kit.test.ts
```

---

### Task 2: Adopt the kit everywhere

Replace the two ToneChips with Chip, move InlineMessage into the kit (settings keeps a re-export), and use the shared Section, DetailRow, RadioCard, Segmented (theme switch) and Monogram. Raise the bell badge to 12px. @design-taste-frontend

**Files:**
- Create: `src/test/sources.ts` (test-only source reader), `src/components/kit-adoption.test.ts`
- Modify: `src/components/settings/kit.tsx` (icon imports 9-13; `MessageTone`, `MESSAGE`, `InlineMessage` and `ToneChip` at 186-229)
- Modify: `src/components/desk/drawer-kit.tsx` (header comment 3-5, `Section` 12-19, `ToneChip` 21-40)
- Modify (ToneChip users): `src/components/admin/platform-admins.tsx`, `src/components/desk/po-history.tsx`, `src/components/settings/custom-domain.tsx`, `src/components/settings/my-notifications.tsx`, `src/components/settings/notifications.tsx`, `src/components/settings/order-history.tsx`, `src/components/settings/store-connection.tsx`, `src/components/settings/team.tsx`, `src/components/desk/order-drawer.tsx`, `src/components/desk/request-parts.tsx`, `src/components/desk/order-list.tsx`
- Modify: `src/components/desk/desk.tsx` (`InfoIcon` import line 5, `DraftsBanner` 76-100)
- Modify: `src/components/desk/request-parts.tsx` (imports 9-18, truncation notice 178-193, `Field` 249-256, `RequestSection` 261-303)
- Modify: `src/components/desk/review-panel.tsx` (complete-in-Shopify notice 276-281)
- Modify: `src/components/settings/order-history.tsx` (radio cards 157-189), `src/components/settings/store-connection.tsx` (radio cards 204-232)
- Modify: `src/components/theme-toggle.tsx` (whole file, 1-61)
- Modify: `src/components/shell/workspace-brand-slot.tsx` (`Monogram` 18-25, use 38), `src/app/page.tsx` (hub tile monogram 159-166), `src/app/(auth)/sign-in/page.tsx` (monogram 57-64)
- Modify: `src/components/shell/bell.tsx` (badge class 215-219)
- Test: `src/components/kit-adoption.test.ts` plus the existing suite

**Step 1: Write the failing test**

Create `src/test/sources.ts` (test-only; never import it from app code):

```ts
// Test-only: read the app's own .tsx sources, for guard tests that keep a
// rule true everywhere (one component kit, busy buttons). Paths are
// relative to src/ with forward slashes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function tsxUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return tsxUnder(path);
    }
    return name.endsWith(".tsx") ? [path] : [];
  });
}

// Every .tsx file under src/components and src/app.
export function appSources(): string[] {
  return [...tsxUnder(join(SRC, "components")), ...tsxUnder(join(SRC, "app"))];
}

export function readSource(file: string): string {
  return readFileSync(file, "utf8");
}

export function rel(file: string): string {
  return relative(SRC, file).split("\\").join("/");
}
```

Create `src/components/kit-adoption.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { appSources, readSource, rel } from "@/test/sources";

// One component kit (comprehensive desk design section 1): screens build
// from src/components/kit.tsx, not from local copies. These guards read the
// sources, so a copy that creeps back in fails the suite.
const KIT = "components/kit.tsx";
const files = appSources();
const outsideKit = files.filter((file) => rel(file) !== KIT);
const containing = (list: string[], text: string) => list.filter((file) => readSource(file).includes(text)).map(rel);

describe("one component kit", () => {
  it("has one Chip and no ToneChip", () => {
    expect(containing(files, "ToneChip")).toEqual([]);
  });

  it("has one InlineMessage and no copied tone panels", () => {
    expect(containing(files, "function InlineMessage")).toEqual([KIT]);
    expect(containing(outsideKit, "rounded-panel bg-tone-fill")).toEqual([]);
  });

  it("has one Monogram tile and one RadioCard", () => {
    expect(containing(outsideKit, "function Monogram")).toEqual([]);
    expect(containing(outsideKit, "bg-primary font-display")).toEqual([]);
    expect(containing(outsideKit, "accent-[var(--primary-strong)]")).toEqual([]);
  });

  it("keeps chip and badge text at 12px or more on the desk and in the shell", () => {
    const scoped = files.filter((file) => rel(file).startsWith("components/desk/") || rel(file).startsWith("components/shell/") || rel(file) === KIT);
    expect(scoped.filter((file) => /text-\[(9|10|11)px\]/.test(readSource(file))).map(rel)).toEqual([]);
  });
});
```

**Step 2: Run it and see it fail**

Run: `npx vitest run src/components/kit-adoption.test.ts`
Expected: FAIL. The first test lists eleven files that still say `ToneChip` (for example `components/desk/order-list.tsx`); the second lists `components/settings/kit.tsx` beside `components/kit.tsx` and `components/desk/desk.tsx`, `components/desk/request-parts.tsx`, `components/desk/review-panel.tsx` as copied panels; the third lists `components/shell/workspace-brand-slot.tsx`, `app/page.tsx`, `app/(auth)/sign-in/page.tsx`, `components/settings/order-history.tsx`, `components/settings/store-connection.tsx`; the fourth lists `components/desk/drawer-kit.tsx` and `components/shell/bell.tsx`.

**Step 3: Minimal implementation**

3a. `src/components/settings/kit.tsx`: delete `type MessageTone`, `const MESSAGE`, `function InlineMessage` and `function ToneChip` (lines 186-229) and put this in their place:

```tsx
// The inline message lives in the shared kit (src/components/kit.tsx); it
// is re-exported so Settings sections keep importing it from here.
export { InlineMessage } from "@/components/kit";
```

Then delete the now unused imports `InfoIcon`, `WarningIcon` and `WarningCircleIcon` (lines 11-13). Keep `CaretDownIcon` (Select) and `CheckCircleIcon` (SaveStatus). Update the header comment's list to drop "inline messages, tone chips".

3b. `src/components/desk/drawer-kit.tsx`: delete `Section` (12-19) and `ToneChip` (21-40); add after the imports:

```tsx
// The section frame is shared (src/components/kit.tsx); re-exported for the
// drawer's parts.
export { Section } from "@/components/kit";
```

and change the header comment to "Small pieces shared by the order drawer and its request parts: the section frame (from the kit) and a copy-to-clipboard button." Keep `CopyButton` and its imports.

3c. Rename ToneChip to Chip. Run exactly:

```bash
SETTINGS_USERS="src/components/admin/platform-admins.tsx src/components/desk/po-history.tsx src/components/settings/custom-domain.tsx src/components/settings/my-notifications.tsx src/components/settings/notifications.tsx src/components/settings/order-history.tsx src/components/settings/store-connection.tsx src/components/settings/team.tsx"
DRAWER_USERS="src/components/desk/order-drawer.tsx src/components/desk/request-parts.tsx"
# Settings chips were 24px tall: they become Chip size="sm" (24px, 12px text).
perl -0pi -e 's/^\s*ToneChip,\n//m; s/, ToneChip \}/ }/; s/<ToneChip /<Chip size="sm" /g; s/<\/ToneChip>/<\/Chip>/g' $SETTINGS_USERS
# Drawer chips already say size="sm" or default to md (28px).
perl -0pi -e 's/, ToneChip \}/ }/; s/<ToneChip/<Chip/g; s/<\/ToneChip>/<\/Chip>/g' $DRAWER_USERS
for f in $SETTINGS_USERS $DRAWER_USERS; do perl -0pi -e 's|\A"use client";\n|"use client";\n\nimport { Chip } from "\@/components/kit";\n|' "$f"; done
perl -0pi -e 's|import \{ ToneChip \} from "\./drawer-kit";|import { Chip } from "\@/components/kit";|; s/<ToneChip/<Chip/g; s/<\/ToneChip>/<\/Chip>/g' src/components/desk/order-list.tsx
grep -rn "ToneChip" src
```

Expected: the final grep prints nothing. Open each changed file and check the import block reads cleanly (one `import { Chip } from "@/components/kit";`, no leftover empty braces).

3d. `src/components/desk/desk.tsx`: replace `DraftsBanner` (76-100) with:

```tsx
// Platform admins only (draft orders spec section 11.8): this store's app
// lacks the draft scopes, so requests are not synced.
function DraftsBanner({ settingsHref, onDismiss }: { settingsHref: string; onDismiss: () => void }) {
  return (
    <InlineMessage
      tone="info"
      action={
        <button type="button" onClick={onDismiss} className={`${ui.iconButton} size-9 text-tone-text`}>
          <XIcon size={16} aria-hidden />
          <span className="sr-only">Dismiss this message</span>
        </button>
      }
    >
      Draft orders are not synced for this store. Grant read_draft_orders and write_draft_orders to the Shopify app, then
      use Refresh connection in{" "}
      <a href={settingsHref} className="font-semibold underline underline-offset-2">
        Settings
      </a>
      .
    </InlineMessage>
  );
}
```

Remove `import { InfoIcon } from "@phosphor-icons/react/Info";` (line 5) and add `import { InlineMessage } from "@/components/kit";` after the `@/components/ui` import.

3e. `src/components/desk/request-parts.tsx`:
- Imports: change line 18 to `import { CopyButton, Section } from "./drawer-kit";` (already done by 3c) and add `import { DetailRow, InlineMessage } from "@/components/kit";`.
- Replace the truncation notice (the `{itemsTruncated ? (<p data-tone="amber" ...` block, 178-193) with:

```tsx
      {itemsTruncated ? (
        <div className="mb-3">
          <InlineMessage tone="warn">
            Showing the first {snapshot.items.length} items.{" "}
            {shopifyUrl ? (
              <a href={shopifyUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
                Open in Shopify for the rest
                <span className="sr-only">{NEW_TAB}</span>
              </a>
            ) : (
              "Open it in Shopify for the rest."
            )}
          </InlineMessage>
        </div>
      ) : null}
```

- Delete the local `function Field` (249-256) and, inside `RequestSection`, replace every `<Field term=` with `<DetailRow term=` and every `</Field>` with `</DetailRow>`.
- If `grep -n "InfoIcon" src/components/desk/request-parts.tsx` now shows only the import line, delete that import.

3f. `src/components/desk/review-panel.tsx`: replace the `<p data-tone="amber" ...>Complete this draft in Shopify...</p>` block (276-281) with:

```tsx
      {canReview && completeInShopify ? (
        <div className="mt-3">
          <InlineMessage tone="warn">
            Complete this draft in Shopify. The card follows when you do.{" "}
            {completeInShopify.url ? <ShopifyLink href={completeInShopify.url}>Open the draft in Shopify</ShopifyLink> : null}
          </InlineMessage>
        </div>
      ) : null}
```

and add `import { InlineMessage } from "@/components/kit";`.

3g. Radio cards. In `src/components/settings/order-history.tsx` replace the `.map(([value, label, help]) => ( <label ...> ... </label> ))` inside the "What to import" fieldset with:

```tsx
        ).map(([value, label, help]) => (
          <RadioCard
            key={value}
            name="history-range"
            value={value}
            checked={mode === value}
            onChange={() => {
              setMode(value);
              onEdit();
            }}
            label={label}
            help={help}
          />
        ))}
```

In `src/components/settings/store-connection.tsx` replace the same map inside "How the store connects" with:

```tsx
        ).map(([value, label, help]) => (
          <RadioCard
            key={value}
            name="auth-mode"
            value={value}
            checked={mode === value}
            onChange={() => setMode(value)}
            label={label}
            help={help}
          />
        ))}
```

Add `RadioCard` to the `import { Chip } from "@/components/kit";` line in both files (`import { Chip, RadioCard } from "@/components/kit";`).

3h. Replace `src/components/theme-toggle.tsx` with:

```tsx
"use client";

import { useEffect, useState } from "react";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { MoonIcon } from "@phosphor-icons/react/Moon";
import { SunIcon } from "@phosphor-icons/react/Sun";
import { THEMES, applyTheme, readStoredTheme, storeTheme, type Theme } from "@/lib/theme";
import { Segmented } from "@/components/kit";

const LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Match system" };

const ICONS: Record<Theme, React.ReactNode> = {
  light: <SunIcon size={16} aria-hidden />,
  dark: <MoonIcon size={16} aria-hidden />,
  system: <DesktopIcon size={16} aria-hidden />,
};

// Three-state theme switch (light default, dark, system), the shared
// Segmented radio group. labels: show the words (the account menu); icons
// only otherwise, with the words for screen readers and as tooltips.
export function ThemeToggle({ labels = false }: { labels?: boolean }) {
  // Unknown until mounted: the server cannot see localStorage, and
  // theme-init.js has already applied the stored value to <html>.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  return (
    <Segmented
      name="theme"
      legend="Theme"
      size="sm"
      value={theme}
      options={THEMES.map((value) => ({ value, label: LABELS[value], icon: ICONS[value], iconOnly: !labels }))}
      onChange={(next) => {
        setTheme(next);
        applyTheme(next);
        storeTheme(next);
      }}
    />
  );
}
```

3i. Monogram. In `src/components/shell/workspace-brand-slot.tsx` delete the local `Monogram` (18-25), add `import { Monogram } from "@/components/kit";`, and change the fallback to `<Monogram text={name.trim().charAt(0).toUpperCase() || "W"} size="sm" />`. In `src/app/page.tsx` replace the hub tile's monogram `<span aria-hidden className="grid size-9 ...">{workspace.name.trim().charAt(0).toUpperCase()}</span>` (159-166) with `<Monogram text={workspace.name.trim().charAt(0).toUpperCase() || "W"} size="md" />` and import `Monogram` from `@/components/kit`. In `src/app/(auth)/sign-in/page.tsx` replace the monogram span (57-64) with `<Monogram text={view.name.trim().charAt(0).toUpperCase() || "W"} size="lg" />` and import it.

3j. `src/components/shell/bell.tsx`: change the badge class (215-219) to

```tsx
            className="absolute right-0 top-0 grid h-5 min-w-5 place-items-center rounded-control bg-primary px-1 text-xs font-semibold tabular-nums text-primary-ink ring-2 ring-surface"
```

**Step 4: Run it and see it pass**

Run: `npx vitest run src/components/kit-adoption.test.ts src/components/settings src/components/desk src/app/page.test.ts`
Expected: PASS. The order history radios (`order-history.test.ts`), the review panel copy (`review-panel.test.ts`) and the request section (`request-parts.test.ts`) keep their assertions.

Local visual check: `npm run dev`, open Settings (store connection and order history radio cards, chips in Team), the drawer of a request (Draft chip, Items notice on a truncated order), the hub tiles. Light and dark.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/test/sources.ts src/components/kit-adoption.test.ts src/components/settings/kit.tsx src/components/desk/drawer-kit.tsx src/components/admin/platform-admins.tsx src/components/desk/po-history.tsx src/components/settings/custom-domain.tsx src/components/settings/my-notifications.tsx src/components/settings/notifications.tsx src/components/settings/order-history.tsx src/components/settings/store-connection.tsx src/components/settings/team.tsx src/components/desk/order-drawer.tsx src/components/desk/request-parts.tsx src/components/desk/order-list.tsx src/components/desk/desk.tsx src/components/desk/review-panel.tsx src/components/theme-toggle.tsx src/components/shell/workspace-brand-slot.tsx src/app/page.tsx src/app/(auth)/sign-in/page.tsx src/components/shell/bell.tsx"
git add $FILES
git commit -m "refactor: one Chip, one InlineMessage and shared kit pieces everywhere" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

(Quote `"src/app/(auth)/sign-in/page.tsx"` if your shell treats the parentheses specially.)

---

### Task 3: Tokens and control states

A primary hover derived per theme (brightness hover vanishes on dark brands), a danger hover that shows in dark mode, a secondary danger button, busy buttons that keep full opacity with `aria-busy` and a spinner (labels without an ellipsis), styled `aria-invalid` fields with hover and focus borders, and the sign-in error under its field. @design-taste-frontend

**Files:**
- Modify: `src/lib/brand-theme.ts` (`PrimaryTokens` 164-172, `primaryTokens` 178-184, `brandStyle` 445-451)
- Modify: `src/app/globals.css` (`@theme inline` 27-59, `:root` 87-94, primary blocks 219-241, force-theme blocks 292-320, `[data-tone]` 357-360)
- Modify: `src/components/ui.ts` (whole file, 1-25)
- Modify: `src/components/desk/review-panel.tsx` (busy labels 103 and 207, Reject button class 306)
- Modify: `src/components/desk/status-select.tsx` (busy opacity 86-88, caret 101-105)
- Modify: `src/app/(auth)/sign-in/sign-in-form.tsx` (form 42-67)
- Modify (busy buttons): `src/app/new-workspace-form.tsx:59`, `src/app/sign-out-button.tsx:35-37`, `src/app/(auth)/sign-in/sign-in-form.tsx:60`, `src/components/admin/platform-admins.tsx:158`, `src/components/desk/order-drawer.tsx:419-422`, `src/components/desk/po-modal.tsx:202,324,838`, `src/components/desk/po-send-confirm.tsx:271-279`, `src/components/settings/branding.tsx:451`, `src/components/settings/custom-domain.tsx:147,153`, `src/components/settings/my-notifications.tsx:168,181`, `src/components/settings/notifications.tsx:109,226,230`, `src/components/settings/order-history.tsx:232`, `src/components/settings/statuses.tsx:294-296`, `src/components/settings/store-connection.tsx:293,455`, `src/components/settings/team.tsx:205,321,618`, `src/components/settings/kit.tsx` (ConfirmStep confirm button 292-301), `src/components/shell/bell.tsx:236-239`, `src/components/shell/top-bar.tsx` (SyncButton 70-89)
- Test: `src/lib/brand-theme.test.ts`, `src/components/ui.test.ts` (new), `src/components/desk/status-select.test.ts`

**Step 1: Write the failing tests**

Append to `src/lib/brand-theme.test.ts` (add `primaryHover` to the import from `./brand-theme`):

```ts
// Comprehensive desk design section 1: a primary hover per theme. The fill
// moves toward its own text (darker under dark text, lighter under light
// text), or away from it when that would cost the text AA.
describe("primaryHover", () => {
  it("is visible on light and dark fills and keeps the button text at AA", () => {
    expect(primaryHover("#91d500", "#101820")).toBe("#82be04");
    for (const [fill, ink] of [
      ["#91d500", "#101820"],
      ["#1b2a4a", "#ffffff"],
      ["#0057ff", "#ffffff"],
      ["#757575", "#000000"],
    ]) {
      const hover = primaryHover(fill, ink);
      expect(hover, fill).not.toBe(fill);
      expect(contrastRatio(ink, hover), fill).toBeGreaterThanOrEqual(TEXT_MIN);
    }
  });

  it("is set for both themes in the brand style, and the defaults match globals.css", () => {
    const { style } = brandStyle(null, "#91d500");
    expect(style["--primary-hover-light"]).toBe("#82be04");
    expect(style["--primary-hover-dark"]).toBe("#82be04");
    expect(brandStyle(null, "#1b2a4a").style["--primary-hover-dark"]).not.toBe("#1b2a4a");
    const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
    expect(css).toContain("--primary-hover-light: #82be04;");
    expect(css).toContain("--primary-hover-dark: #82be04;");
    expect(css).toContain("--color-primary-hover: var(--primary-hover);");
    expect(css).toContain("--color-tone-fill-hover: var(--tone-fill-hover);");
  });
});
```

Create `src/components/ui.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { appSources, readSource, rel } from "@/test/sources";
import { ui } from "./ui";

// Control states (comprehensive desk design section 1): busy buttons stay
// readable, hovers come from tokens, invalid fields look invalid.
const BUTTONS = ["buttonPrimary", "buttonSecondary", "buttonQuiet", "buttonDanger", "buttonDangerSecondary", "iconButton"] as const;

describe("ui control shapes", () => {
  it("keep a busy button at full opacity", () => {
    for (const key of BUTTONS) {
      expect(ui[key], key).toContain("aria-busy:opacity-100");
    }
  });

  it("take hovers from tokens, never from a brightness filter", () => {
    expect(ui.buttonPrimary).toContain("hover:bg-primary-hover");
    expect(ui.buttonDanger).toContain("hover:bg-tone-fill-hover");
    expect(Object.values(ui).join(" ")).not.toContain("brightness");
  });

  it("have a secondary danger button in the danger text color", () => {
    expect(ui.buttonDangerSecondary).toContain("text-bad");
    expect(ui.buttonDangerSecondary).toContain("border-line-strong");
  });

  it("style invalid fields, and show hover and focus on every field", () => {
    for (const key of ["input", "textarea"] as const) {
      expect(ui[key], key).toContain("aria-[invalid=true]:border-bad");
      expect(ui[key], key).toContain("hover:border-ink-3");
      expect(ui[key], key).toContain("focus-visible:border-ink");
    }
  });
});

// A button whose label switches to "Saving" (or another -ing word) while it
// works is a busy button: it must say so with aria-busy, and its label has
// no ellipsis.
const BUSY_LABEL =
  /\{\s*(?:busy|saving|sending|inviting|refreshing|marking|linesRetrying|phase)(?:\s*===\s*"[a-z]+")?\s*\?\s*"[A-Z][a-z]+ing\b/g;

describe("busy buttons", () => {
  it("are marked aria-busy wherever a label says the work is under way", () => {
    const offenders = appSources().flatMap((file) => {
      const text = readSource(file);
      const labels = text.match(BUSY_LABEL)?.length ?? 0;
      const marks = text.match(/aria-busy=/g)?.length ?? 0;
      return labels > marks ? [`${rel(file)}: ${labels} busy labels, ${marks} aria-busy`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("never end their label with an ellipsis", () => {
    expect(appSources().filter((file) => /ing\.\.\."/.test(readSource(file))).map(rel)).toEqual([]);
  });
});
```

In `src/components/desk/status-select.test.ts`, extend the first test:

```ts
  it("marks itself busy while a change is saving, and stays enabled", () => {
    const html = render(true);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("disabled=");
    // Full opacity with a spinner in place of the caret.
    expect(html).toContain("od-spin");
    expect(html).not.toContain("opacity-70");
  });
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/brand-theme.test.ts src/components/ui.test.ts src/components/desk/status-select.test.ts`
Expected: FAIL. `primaryHover is not a function` (or not exported); `expected "...hover:brightness-95" to contain "aria-busy:opacity-100"`; the busy guard lists about twenty files (for example `components/settings/statuses.tsx: 1 busy labels, 0 aria-busy`); the ellipsis guard lists `components/desk/review-panel.tsx`; the status select test finds no `od-spin`.

**Step 3: Minimal implementation**

3a. `src/lib/brand-theme.ts`. Add `hover` to `PrimaryTokens`:

```ts
export type PrimaryTokens = {
  // The fill: buttons, active filter underline, highlights.
  fill: string;
  // Text on the fill.
  ink: string;
  // The fill pulled toward the theme's ink until it reads as text, focus
  // ring or thin rule on every surface of that theme.
  strong: string;
  // The fill under the pointer: visible on light and dark fills alike.
  hover: string;
};
```

Add above `primaryTokens`:

```ts
// The fill moved 12% toward its text (darker under dark text, lighter under
// light text), which shows on every fill; if that would bring the text
// under AA, 12% away from it instead (more contrast, still visible).
export function primaryHover(fill: string, ink: string): string {
  const toward = mixHex(fill, ink, 0.12);
  if (contrastRatio(ink, toward) >= TEXT_MIN) {
    return toward;
  }
  const away = contrastRatio(ink, WHITE) >= contrastRatio(ink, BLACK) ? WHITE : BLACK;
  return mixHex(fill, away, 0.12);
}
```

Replace `primaryTokens`:

```ts
function primaryTokens(fill: string, palette: Palette, onFill: readonly string[]): PrimaryTokens {
  const ink = bestOn(fill, onFill);
  return {
    fill,
    ink,
    strong: strengthen(fill, palette.ink, surfacesOf(palette), TEXT_MIN),
    hover: primaryHover(fill, ink),
  };
}
```

In `brandStyle`, inside the `for (const mode of ["light", "dark"] as const)` loop, add `style[`--primary-hover-${mode}`] = primary.hover;` after the `--primary-strong-` line.

3b. `src/app/globals.css`:
- In `@theme inline`, after `--color-primary-strong: var(--primary-strong);` add `--color-primary-hover: var(--primary-hover);`, and after `--color-tone-text: var(--tone-text);` add `--color-tone-fill-hover: var(--tone-fill-hover);`.
- In `:root`, after `--primary-strong-dark: #91d500;` add:

```css
  --primary-hover-light: #82be04;
  --primary-hover-dark: #82be04;
```

- In the `:root, [data-brand-scope]` block add `--primary-hover: var(--primary-hover-light);`; in `:root[data-theme="dark"], :root[data-theme="dark"] [data-brand-scope]` and in the `prefers-color-scheme: dark` system block add `--primary-hover: var(--primary-hover-dark);`; in `[data-force-theme="light"]` add `--primary-hover: var(--primary-hover-light);` and in `[data-force-theme="dark"]` add `--primary-hover: var(--primary-hover-dark);`.
- Replace the `[data-tone]` block with:

```css
[data-tone] {
  --tone-fill: var(--st-slate-fill);
  --tone-text: var(--st-slate-text);
  /* A danger or tone button under the pointer: the fill moved toward its
     text, which shows in light and dark alike. Declared here so it follows
     each element's own tone. */
  --tone-fill-hover: color-mix(in srgb, var(--tone-fill) 82%, var(--tone-text));
}
```

3c. Replace `src/components/ui.ts` with:

```ts
// Shared class lists for the few control shapes the app uses. One radius
// system: every interactive control is rounded-control, panels and cards
// are rounded-panel; both come from the workspace's radius choice (pill
// controls on 12px panels by default). Colors come from the tokens in
// globals.css. A busy button (aria-busy) keeps full opacity: it is working,
// not unavailable (comprehensive desk design section 1).

const control =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control text-sm font-semibold transition-[background-color,border-color,color,transform] duration-150 ease-out-soft motion-safe:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 aria-busy:cursor-progress aria-busy:opacity-100";

// Text fields: a hover and a focus border, and a red border and ring when
// aria-invalid is set.
const field =
  "w-full border border-line-strong bg-surface text-sm text-ink transition-colors placeholder:text-ink-3 hover:border-ink-3 focus-visible:border-ink aria-[invalid=true]:border-bad aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-bad/25";

export const ui = {
  buttonPrimary: `${control} h-10 bg-primary px-4 text-primary-ink hover:bg-primary-hover`,
  buttonSecondary: `${control} h-10 border border-line-strong bg-surface px-4 text-ink hover:bg-surface-2`,
  buttonQuiet: `${control} h-9 px-3 text-ink-2 hover:bg-surface-2 hover:text-ink`,
  // Confirms a destructive step; sits inside a data-tone="red" element.
  buttonDanger: `${control} h-10 bg-tone-fill px-4 text-tone-text hover:bg-tone-fill-hover`,
  // Opens a destructive step (Reject, Remove): quiet until it is confirmed.
  buttonDangerSecondary: `${control} h-10 border border-line-strong bg-surface px-4 text-bad hover:bg-surface-2`,
  iconButton: `${control} size-10 text-ink-2 hover:bg-surface-2 hover:text-ink`,
  input: `h-10 rounded-control px-4 ${field}`,
  // Multi-line text takes the panel radius (a pill would clip its corners).
  textarea: `min-h-20 rounded-panel px-4 py-2.5 ${field}`,
  label: "text-sm font-medium text-ink",
  panel: "rounded-panel border border-line bg-surface",
  errorText: "text-sm text-bad",
} as const;
```

3d. `src/components/desk/review-panel.tsx`: the Reject trigger gets `className={ui.buttonDangerSecondary}` (replacing `ui.buttonSecondary.replace("text-ink", "text-bad")`). The Approve confirm button becomes:

```tsx
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-describedby={`${id}-question${error ? ` ${id}-error` : ""}`}
          className={ui.buttonPrimary}
        >
          {busy ? <Spinner /> : <CheckCircleIcon size={16} aria-hidden />}
          {busy ? "Approving" : "Approve and create order"}
        </button>
```

and the Reject submit:

```tsx
        <button type="submit" disabled={busy} aria-busy={busy || undefined} className={ui.buttonDanger}>
          {busy ? <Spinner /> : <XCircleIcon size={16} aria-hidden />}
          {busy ? "Rejecting" : "Reject request"}
        </button>
```

Import `Spinner` with InlineMessage: `import { InlineMessage, Spinner } from "@/components/kit";`.

3e. The busy pass. In every file listed under "Modify (busy buttons)", find the button whose label switches on the busy flag and (1) add `aria-busy={FLAG || undefined}` next to its `disabled`, where FLAG is exactly the condition of the label ternary (`busy`, `saving`, `busy === "save"`, `phase === "sending"`, `inviting`, `refreshing`, `marking`, `linesRetrying`, `manual.running`); (2) while FLAG is true render `<Spinner />` in place of the button's leading icon, or just before the label when it has none; import `Spinner` from `@/components/kit`. Leave Cancel buttons alone (they are blocked, not working). In `src/components/settings/kit.tsx` ConfirmStep, add `aria-busy={busy || undefined}` to the confirm button and `{busy ? <Spinner /> : null}` before `{busy ? busyLabel : confirmLabel}`. Worked example, `src/components/settings/statuses.tsx`:

```tsx
          <button type="button" onClick={save} disabled={busy || !dirty} aria-busy={busy || undefined} className={ui.buttonPrimary}>
            {busy ? <Spinner /> : null}
            {busy ? "Saving" : "Save statuses"}
          </button>
```

In `src/components/shell/top-bar.tsx` SyncButton add `aria-busy={manual.running || undefined}` (its icon already spins).

3f. `src/components/desk/status-select.tsx`: remove `${busy ? "opacity-70" : ""}` from the select's class, and replace the caret with:

```tsx
      {busy ? (
        <span className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-tone-text ${size === "md" ? "right-3.5" : "right-3"}`}>
          <Spinner size={12} />
        </span>
      ) : (
        <CaretDownIcon
          size={12}
          aria-hidden
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-tone-text ${size === "md" ? "right-3.5" : "right-3"}`}
        />
      )}
```

with `import { Spinner } from "@/components/kit";`.

3g. `src/app/(auth)/sign-in/sign-in-form.tsx`: move the error paragraph directly under the input (before the submit button) so it reads with the field, and add aria-busy to the submit:

```tsx
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@company.com"
        aria-invalid={phase === "error" ? true : undefined}
        aria-describedby={phase === "error" ? "sign-in-error" : undefined}
        className={ui.input}
      />
      {phase === "error" ? (
        <p id="sign-in-error" className={ui.errorText}>
          {errorMessage}
        </p>
      ) : null}
      <button type="submit" disabled={phase === "sending"} aria-busy={phase === "sending" || undefined} className={`${ui.buttonPrimary} mt-2`}>
        {phase === "sending" ? <Spinner /> : null}
        {phase === "sending" ? "Sending" : "Send sign-in link"}
      </button>
```

**Step 4: Run them and see them pass**

Run: `npx vitest run src/lib/brand-theme.test.ts src/components/ui.test.ts src/components/desk/status-select.test.ts`
Expected: PASS. Then `npm run test` (the settings, review and PO tests still pass: labels changed only from "Approving..." to "Approving").

Local visual check (`npm run dev`): hover a primary button in light and dark (IMPACT lime, and a dark brand in Settings > Branding preview); the Reject button reads red on its outline; the sign-in page with a bad email shows the red field and the message under it; a status change shows the spinner at full opacity.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/brand-theme.ts src/lib/brand-theme.test.ts src/app/globals.css src/components/ui.ts src/components/ui.test.ts src/components/desk/review-panel.tsx src/components/desk/status-select.tsx src/components/desk/status-select.test.ts src/app/(auth)/sign-in/sign-in-form.tsx src/app/new-workspace-form.tsx src/app/sign-out-button.tsx src/components/admin/platform-admins.tsx src/components/desk/order-drawer.tsx src/components/desk/po-modal.tsx src/components/desk/po-send-confirm.tsx src/components/settings/branding.tsx src/components/settings/custom-domain.tsx src/components/settings/my-notifications.tsx src/components/settings/notifications.tsx src/components/settings/order-history.tsx src/components/settings/statuses.tsx src/components/settings/store-connection.tsx src/components/settings/team.tsx src/components/settings/kit.tsx src/components/shell/bell.tsx src/components/shell/top-bar.tsx"
git add $FILES
git commit -m "feat: token hovers, secondary danger button, busy and invalid control states" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 4: One shared event map for the timeline and the bell

Today the drawer and the bell keep two icon maps that disagree, all grey. One pure map gives every event a glyph and a meaningful tone: approve green, reject and failed writes red, sync errors amber, PO sent blue, the rest neutral. @design-taste-frontend

**Files:**
- Create: `src/lib/event-look.ts`, `src/components/event-icon.tsx`
- Modify: `src/components/desk/order-drawer.tsx` (icon imports 5-18, `EVENT_ICONS` 232-243, `metaOf` stays, `eventIcon` 249-272, timeline icon 319-324)
- Modify: `src/components/shell/bell.tsx` (icon imports 5-14, `ICONS` 32-44, `ItemContent` icon 54-59)
- Modify: `src/server/activity.ts` (`ActivityItem` 28-43, select 89-100, map 107-121)
- Test: `src/lib/event-look.test.ts` (new), `src/server/activity.test.ts`

**Step 1: Write the failing tests**

Create `src/lib/event-look.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eventLook } from "./event-look";

// One look per event for the drawer timeline and the bell (comprehensive
// desk design section 1).
describe("eventLook", () => {
  it("colors decisions, failures and sends by what they mean", () => {
    expect(eventLook({ type: "status", meta: { action: "approve" }, source: "app" })).toEqual({ glyph: "approve", tone: "green" });
    expect(eventLook({ type: "status", meta: { action: "reject" }, source: "app" })).toEqual({ glyph: "reject", tone: "red" });
    expect(eventLook({ type: "shopify_write", meta: { ok: false }, source: "system" })).toEqual({ glyph: "warning", tone: "red" });
    expect(eventLook({ type: "po_failed", meta: null, source: "system" })).toEqual({ glyph: "warning", tone: "red" });
    expect(eventLook({ type: "sync_error", meta: null, source: "system" })).toEqual({ glyph: "warning", tone: "amber" });
    expect(eventLook({ type: "po_sent", meta: null, source: "app" })).toEqual({ glyph: "po-sent", tone: "blue" });
  });

  it("keeps everyday entries neutral", () => {
    expect(eventLook({ type: "note", meta: null, source: "app" })).toEqual({ glyph: "note", tone: "slate" });
    expect(eventLook({ type: "status", meta: { from: "new", to: "shipped" }, source: "app" })).toEqual({ glyph: "status", tone: "slate" });
    expect(eventLook({ type: "order_new", meta: { kind: "draft" }, source: "shopify" })).toEqual({ glyph: "request", tone: "slate" });
    expect(eventLook({ type: "order_new", meta: null, source: "shopify" })).toEqual({ glyph: "order", tone: "slate" });
    expect(eventLook({ type: "po_draft", meta: null, source: "app" })).toEqual({ glyph: "po", tone: "slate" });
    expect(eventLook({ type: "shopify_write", meta: { ok: true }, source: "system" })).toEqual({ glyph: "shopify", tone: "slate" });
  });

  it("shows a completion in Shopify as an approval and a deleted draft as a warning", () => {
    expect(eventLook({ type: "status", meta: { reason: "completed" }, source: "shopify" })).toEqual({ glyph: "completed", tone: "green" });
    expect(eventLook({ type: "draft_completed", meta: null, source: "shopify" })).toEqual({ glyph: "completed", tone: "green" });
    expect(eventLook({ type: "draft_deleted", meta: null, source: "shopify" })).toEqual({ glyph: "deleted", tone: "amber" });
    // A type added later still gets a neutral look.
    expect(eventLook({ type: "something_new", meta: null, source: "app" })).toEqual({ glyph: "status", tone: "slate" });
  });
});
```

In `src/server/activity.test.ts`, add inside `describe("loadActivityFeed items", ...)`:

```ts
  it("carries each entry's meta, so the bell can show what it means", async () => {
    await event({ createdAt: 10, actorId: "u_other", type: "status", text: "Approved the request", meta: { action: "approve" } });
    const feed = await loadActivityFeed(db, WS, "u_me");
    expect(feed.items[0].meta).toEqual({ action: "approve" });
  });
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/event-look.test.ts src/server/activity.test.ts`
Expected: FAIL, `Failed to resolve import "./event-look"`, and `expected undefined to deeply equal { action: 'approve' }`.

**Step 3: Minimal implementation**

Create `src/lib/event-look.ts`:

```ts
// One look for activity entries (comprehensive desk design section 1): the
// drawer's timeline and the bell show the same glyph and tone for the same
// event. Tones carry meaning: approvals green, rejections and failed writes
// red, sync problems amber, purchase orders sent blue, everything else
// neutral. Pure, so the mapping is tested; src/components/event-icon.tsx
// turns a glyph into its Phosphor icon.

export type EventGlyph =
  | "note"
  | "status"
  | "approve"
  | "reject"
  | "order"
  | "request"
  | "po"
  | "po-sent"
  | "warning"
  | "shopify"
  | "completed"
  | "deleted";

export type EventTone = "slate" | "green" | "red" | "amber" | "blue";

export type EventLook = { glyph: EventGlyph; tone: EventTone };

function metaOf(meta: unknown): Record<string, unknown> {
  return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
}

export function eventLook(event: { type: string; meta?: unknown; source?: string | null }): EventLook {
  const meta = metaOf(event.meta);
  switch (event.type) {
    case "note":
      return { glyph: "note", tone: "slate" };
    case "order_new":
      return meta.kind === "draft" ? { glyph: "request", tone: "slate" } : { glyph: "order", tone: "slate" };
    case "po_draft":
      return { glyph: "po", tone: "slate" };
    case "po_sent":
      return { glyph: "po-sent", tone: "blue" };
    case "po_failed":
      return { glyph: "warning", tone: "red" };
    case "sync_error":
      return { glyph: "warning", tone: "amber" };
    case "shopify_write":
      return meta.ok === false ? { glyph: "warning", tone: "red" } : { glyph: "shopify", tone: "slate" };
    case "draft_completed":
      return { glyph: "completed", tone: "green" };
    case "draft_deleted":
      return { glyph: "deleted", tone: "amber" };
    case "status":
      if (meta.action === "approve") {
        return { glyph: "approve", tone: "green" };
      }
      if (meta.action === "reject") {
        return { glyph: "reject", tone: "red" };
      }
      if (event.source === "shopify" && (meta.reason === "completed" || meta.completed === true)) {
        return { glyph: "completed", tone: "green" };
      }
      return { glyph: "status", tone: "slate" };
    default:
      return { glyph: "status", tone: "slate" };
  }
}
```

Create `src/components/event-icon.tsx`:

```tsx
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
```

`src/components/desk/order-drawer.tsx`: delete `EVENT_ICONS` (232-243) and `eventIcon` (249-272). In `Timeline`, replace

```tsx
        const Icon = eventIcon(event);
        ...
            <span className="grid size-8 shrink-0 place-items-center rounded-control bg-surface-2 text-ink-2">
              <Icon size={16} aria-hidden />
            </span>
```

with `<EventIcon look={eventLook(event)} />` (and drop the `const Icon` line). Add `import { eventLook } from "@/lib/event-look";` and `import { EventIcon } from "@/components/event-icon";`. Remove the icon imports nothing else uses (`ChatTextIcon`, `ClipboardTextIcon`, `FileTextIcon`, `ShoppingBagIcon`, `StorefrontIcon`, `TagIcon`, `TrashIcon`, `WarningIcon`, `XCircleIcon`, and `CheckCircleIcon` if unused); check each with `grep -n "<Name>Icon" src/components/desk/order-drawer.tsx`. Keep `metaOf` (the timeline's Reason label uses it).

`src/components/shell/bell.tsx`: delete `ICONS` (32-44) and in `ItemContent` replace the `const Icon = ...` line and the icon span with `<EventIcon look={eventLook(item)} className="mt-0.5" />`; import `eventLook` and `EventIcon`; remove now unused icon imports (keep `BellIcon` and `ChecksIcon`).

`src/server/activity.ts`: add `meta: unknown;` to `ActivityItem` (after `source`), add `meta: events.meta,` to the select, and `meta: row.meta ?? null,` to the mapped item.

**Step 4: Run them and see them pass**

Run: `npx vitest run src/lib/event-look.test.ts src/server/activity.test.ts src/components/desk/order-drawer.test.ts`
Expected: PASS.

Local visual check: open a request with an approval or rejection in its timeline and the bell, light and dark: green check, red cross, blue paper plane on a sent PO.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/event-look.ts src/lib/event-look.test.ts src/components/event-icon.tsx src/components/desk/order-drawer.tsx src/components/shell/bell.tsx src/server/activity.ts src/server/activity.test.ts"
git add $FILES
git commit -m "feat: one event map with meaningful colors for the timeline and the bell" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 5: Migration 0011 `work_queue`

`statuses.closed` (Delivered and Rejected closed in every existing workspace), and on `workspace_settings` the age thresholds and the price display mode. Additive only.

**Files:**
- Create: `src/lib/queue-settings.ts` (the price display values; grows in Tasks 7 and 17)
- Modify: `src/db/schema.ts` (imports 1-4, `statuses` 132-147, `workspaceSettings` 296-302)
- Create (generated, then hand-edited): `drizzle/0011_work_queue.sql`, `drizzle/meta/0011_snapshot.json`; Modify (generated): `drizzle/meta/_journal.json`
- Modify: `src/db/schema.test.ts` ("keeps the workspace settings as they were" 438-448; add a 0011 case after "links the shipped and delivered status keys" 421-436)
- Modify: `src/server/sync/run.test.ts` (the pin, 2012-2025)
- Test: `src/db/migration-work-queue.test.ts` (new)

**Step 1: Write the failing test**

Create `src/db/migration-work-queue.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Migration 0011 (work queue, comprehensive desk design section 1): statuses
// gain closed, with Delivered and Rejected closed in every existing
// workspace (by Shopify link, or by key where a workspace unlinked them),
// and workspace_settings gains the age thresholds and the price display.
// Replayed on rows in the 0010 shape.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigrations(db: Database, include: (file: string) => boolean) {
  for (const file of migrationFiles().filter(include)) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        db.prepare(trimmed).run();
      }
    }
  }
}

describe("migration 0011 on rows in the 0010 shape", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    expect(migrationFiles().some((file) => file.startsWith("0011_"))).toBe(true);
    applyMigrations(db, (file) => file.slice(0, 4) <= "0010");

    const workspace = db.prepare("INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)");
    workspace.run("ws_impact", "Impact", "impact", "u1", 1);
    workspace.run("ws_custom", "Custom", "custom", "u1", 1);
    const status = db.prepare(
      "INSERT INTO statuses (id, workspace_id, key, label, color, sort, triggers_po, shopify_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const impact = [
      ["new", "New", "lime", 0, 0, null],
      ["approved", "Approved", "green", 1, 1, "draft_completed"],
      ["shipped", "Shipped", "violet", 2, 0, "fulfilled"],
      ["delivered", "Delivered", "slate", 3, 0, "delivered"],
      ["rejected", "Rejected", "pink", 4, 0, "draft_rejected"],
    ] as const;
    for (const [key, label, color, sort, po, link] of impact) {
      status.run(`ws_impact_${key}`, "ws_impact", key, label, color, sort, po, link);
    }
    // A workspace that renamed and relinked: "done" follows delivered,
    // "rejected" lost its link, "archive" is closed by nothing.
    status.run("ws_custom_done", "ws_custom", "done", "Done", "slate", 0, 0, "delivered");
    status.run("ws_custom_rejected", "ws_custom", "rejected", "Declined", "pink", 1, 0, null);
    status.run("ws_custom_archive", "ws_custom", "archive", "Archive", "slate", 2, 0, null);
    db.prepare("INSERT INTO workspace_settings (workspace_id, notification_emails, po_prefix) VALUES (?, ?, ?)").run(
      "ws_impact",
      "[]",
      "IMP",
    );

    applyMigrations(db, (file) => file.slice(0, 4) === "0011");
  });

  afterAll(() => {
    db.close();
  });

  it("closes Delivered and Rejected by Shopify link or by key, and nothing else", () => {
    expect(db.prepare("SELECT workspace_id, key, closed FROM statuses ORDER BY workspace_id, sort").all()).toEqual([
      { workspace_id: "ws_custom", key: "done", closed: 1 },
      { workspace_id: "ws_custom", key: "rejected", closed: 1 },
      { workspace_id: "ws_custom", key: "archive", closed: 0 },
      { workspace_id: "ws_impact", key: "new", closed: 0 },
      { workspace_id: "ws_impact", key: "approved", closed: 0 },
      { workspace_id: "ws_impact", key: "shipped", closed: 0 },
      { workspace_id: "ws_impact", key: "delivered", closed: 1 },
      { workspace_id: "ws_impact", key: "rejected", closed: 1 },
    ]);
  });

  it("gives existing settings rows the default age thresholds and automatic prices", () => {
    expect(
      db.prepare("SELECT workspace_id, po_prefix, age_amber_days, age_red_days, price_display FROM workspace_settings").all(),
    ).toEqual([{ workspace_id: "ws_impact", po_prefix: "IMP", age_amber_days: 2, age_red_days: 4, price_display: "auto" }]);
  });

  it("starts a status written without closed as open", () => {
    db.prepare("INSERT INTO statuses (id, workspace_id, key, label, color, sort) VALUES (?, ?, ?, ?, ?, ?)").run(
      "ws_custom_fresh",
      "ws_custom",
      "fresh",
      "Fresh",
      "blue",
      3,
    );
    expect(db.prepare("SELECT closed FROM statuses WHERE id = ?").get("ws_custom_fresh")).toEqual({ closed: 0 });
  });

  it("only adds: no drop, delete or rename", () => {
    const file = migrationFiles().find((name) => name.startsWith("0011_"));
    const sql = readFileSync(join(migrationsDir, file as string), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bRENAME\b/i);
  });
});
```

**Step 2: Run it and see it fail**

Run: `npx vitest run src/db/migration-work-queue.test.ts`
Expected: FAIL, `expected false to be true` at the `0011_` file check.

**Step 3: Minimal implementation**

3a. Create `src/lib/queue-settings.ts`:

```ts
// Work queue settings per workspace (comprehensive desk design section 1).
// Pure and shared: the schema takes the price display values from here, the
// server validates with them and the desk reads them.

// Totals and the Paid chip on the desk: auto hides them when nearly every
// card is $0, show and hide force it.
export const PRICE_DISPLAY_VALUES = ["auto", "show", "hide"] as const;
export type PriceDisplay = (typeof PRICE_DISPLAY_VALUES)[number];
```

3b. `src/db/schema.ts`: add `import { PRICE_DISPLAY_VALUES } from "../lib/queue-settings";` after the `../lib/branding` import. In `statuses`, after `shopifyLink`, add:

```ts
  // Closed statuses are finished work: their cards leave the Open view and
  // show their age without a warning color (comprehensive desk design
  // section 1). Delivered and Rejected start closed (migration 0011).
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
```

In `workspaceSettings`, after `fromName`, add:

```ts
  // An open card's age turns amber, then red, after this many days in its
  // status (migration 0011).
  ageAmberDays: integer("age_amber_days").notNull().default(2),
  ageRedDays: integer("age_red_days").notNull().default(4),
  // Totals and the Paid chip on the desk (src/lib/queue-settings.ts).
  priceDisplay: text("price_display", { enum: PRICE_DISPLAY_VALUES }).notNull().default("auto"),
```

3c. Generate: `npm run db:generate -- --name work_queue`
Expected: drizzle-kit writes `drizzle/0011_work_queue.sql`, `drizzle/meta/0011_snapshot.json` and a new `_journal.json` entry. The SQL must be exactly four `ALTER TABLE ... ADD` statements:

```sql
ALTER TABLE `statuses` ADD `closed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `age_amber_days` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `age_red_days` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `price_display` text DEFAULT 'auto' NOT NULL;
```

If it shows anything else (a table rebuild, a dropped index), stop: the schema edit is wrong.

3d. Append the reviewed data step to the end of `drizzle/0011_work_queue.sql`:

```sql
--> statement-breakpoint
-- Hand-written data step (comprehensive desk design section 1): Delivered
-- and Rejected cards leave the Open view in every existing workspace, by
-- Shopify link, or by key where a workspace unlinked the status.
UPDATE `statuses` SET `closed` = 1 WHERE `shopify_link` IN ('delivered', 'draft_rejected') OR `key` IN ('delivered', 'rejected');
```

3e. `src/db/schema.test.ts`: in "keeps the workspace settings as they were" add the three new columns to the expected row:

```ts
      {
        workspace_id: "ws_impact",
        notification_emails: '["ops@example.com"]',
        po_prefix: "IMP",
        reply_to: "ops@example.com",
        from_name: "IMPACT Rentals",
        age_amber_days: 2,
        age_red_days: 4,
        price_display: "auto",
      },
```

and add after "links the shipped and delivered status keys...":

```ts
  // 0011 (work queue) closes Delivered and Rejected.
  it("closes the delivered and rejected statuses", () => {
    expect(db.prepare("SELECT workspace_id, key FROM statuses WHERE closed = 1 ORDER BY workspace_id, key").all()).toEqual([
      { workspace_id: "ws_custom", key: "rejected" },
      { workspace_id: "ws_impact", key: "delivered" },
      { workspace_id: "ws_impact", key: "rejected" },
    ]);
  });
```

The drift test ("matches every exported table and column") needs no change: still 21 tables, and it checks the new columns exist.

3f. `src/server/sync/run.test.ts`: drizzle names every column of a table in every insert, so the test's own status seed (and, in the app, `createWorkspace` and Settings > Statuses) needs `statuses.closed`. Raise the pin and its note:

```ts
  it("runs a whole cursor chain on the schema as of migration 0011", async () => {
    // The sync engine reads and writes whole store_connections rows (and
    // writes events.source), so a column it needs from a migration that has
    // not been applied yet fails every run. This pins that the engine needs
    // nothing newer than 0011. Raised from 0003 by the platform phase (0004),
    // then by Phase 6 (0007: drizzle names orders.notified_at in every order
    // insert), then by the order history import (0008: runSync selects the
    // whole store_connections row, backfill columns included), then by draft
    // orders (0010: every order insert names the draft columns and runSync
    // reads the draft cursor columns), then by the work queue (0011: every
    // statuses insert names statuses.closed and every workspace_settings
    // insert names the age and price columns; the engine itself reads
    // neither). DEPLOY NOTE, run `npm run db:migrate:remote` (applies 0011)
    // BEFORE the code that needs it reaches production. Raise the number
    // again only together with a deploy note like this one.
    const { db, env } = openDb({ through: "0011" });
```

**Step 4: Run it and see it pass**

Run: `npx vitest run src/db/migration-work-queue.test.ts src/db/schema.test.ts src/server/sync/run.test.ts`
Expected: PASS. Then `npm run test` (it runs `drizzle-kit check` first; it must report the snapshots consistent).

Apply to local dev: `npm run db:migrate:local` (expected: "0011_work_queue.sql" applied).

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/queue-settings.ts src/db/schema.ts drizzle/0011_work_queue.sql drizzle/meta/0011_snapshot.json drizzle/meta/_journal.json src/db/schema.test.ts src/db/migration-work-queue.test.ts src/server/sync/run.test.ts"
git add $FILES
git commit -m "feat: migration 0011 work_queue (closed statuses, age thresholds, price display)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 6: Closed statuses in the services and Settings > Statuses

`StatusView` carries `closed`; new workspaces get Delivered and Rejected closed; the statuses editor keeps or sets the flag and closes a new status linked to delivered or draft_rejected by default. @design-taste-frontend

**Files:**
- Modify: `src/server/desk/shapes.ts` (`StatusView` 6-16, `statusView` 53-62)
- Modify: `src/server/workspaces.ts` (`DEFAULT_STATUSES` 19-28)
- Modify: `src/server/desk/statuses.ts` (`Entry` 55-61, `parseEntries` 63-106, write loop 255-282)
- Modify: `src/app/api/workspaces/[id]/statuses/route.ts` (doc comment 7-13)
- Modify: `src/server/desk/test-helpers.ts` (`TEST_STATUSES` 61-66, `seedDraftStatuses` 230-246)
- Modify: `src/components/settings/statuses.tsx` (`Row` 25-32, `rowsOf` 38-47, `payload` 49-57, `add` 106-111, help text 142-152, switches 260-267)
- Modify (StatusView literals gain `closed`): `src/server/desk/read.test.ts:60-67`, `src/server/desk/statuses.test.ts:72-74`, `src/components/desk/order-drawer.test.ts:14-18`, `src/lib/desk-state.test.ts:411-414`, `src/lib/status-options.test.ts:9-16`
- Test: `src/server/desk/statuses.test.ts`, `src/server/workspaces.test.ts`, `src/components/settings/statuses.test.ts` (new)

**Step 1: Write the failing tests**

Append to `src/server/desk/statuses.test.ts` inside `describe("replaceStatuses", ...)`:

```ts
  // Comprehensive desk design section 1: closed statuses leave the Open view.
  it("keeps each status's closed flag unless the list sets it, and closes a new Delivered or Rejected status", async () => {
    const { db } = await setup();
    const first = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
      { key: "shipped", label: "Shipped", color: "violet", triggersPo: false, closed: true },
      entry("Delivered", { shopifyLink: "delivered" }),
      entry("On Hold"),
    ]);
    if (first.kind !== "ok") throw new Error(first.kind);
    expect(first.statuses.map((s) => [s.key, s.closed])).toEqual([
      ["new", false],
      ["shipped", true],
      ["delivered", true],
      ["on_hold", false],
    ]);

    const second = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
      { key: "shipped", label: "Shipped", color: "violet", triggersPo: false },
      { key: "delivered", label: "Delivered", color: "slate", triggersPo: false, closed: false },
      { key: "on_hold", label: "On Hold", color: "amber", triggersPo: false },
    ]);
    if (second.kind !== "ok") throw new Error(second.kind);
    expect(second.statuses.map((s) => [s.key, s.closed])).toEqual([
      ["new", false],
      ["shipped", true],
      ["delivered", false],
      ["on_hold", false],
    ]);
  });

  it("refuses a closed flag that is not true or false", async () => {
    const { db } = await setup();
    expect(await replaceStatuses(db, WS, [entry("New", { closed: "yes" })])).toEqual({
      kind: "invalid",
      error: "Status 1: closed must be true or false",
    });
  });
```

Append to `src/server/workspaces.test.ts` (inside the `createWorkspace` describe, using the same `db`/`id` setup as the default statuses test there):

```ts
  it("starts every new workspace with Delivered and Rejected closed", async () => {
    const { db } = openTestDb();
    const result = await createWorkspace(db, "user_admin", { name: "Closed Check" });
    if (result.kind !== "created") throw new Error(result.kind);
    const rows = await db
      .select({ key: schema.statuses.key, closed: schema.statuses.closed })
      .from(schema.statuses)
      .where(eq(schema.statuses.workspaceId, result.workspace.id));
    expect(rows.filter((row) => row.closed).map((row) => row.key).sort()).toEqual(["delivered", "rejected"]);
  });
```

(Reuse the file's existing imports of `schema`, `eq` and `openTestDb`; add any that are missing.)

Create `src/components/settings/statuses.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusView } from "@/server/desk/shapes";
import { StatusesSection } from "./statuses";

const STATUSES: StatusView[] = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
  { key: "delivered", label: "Delivered", color: "slate", sort: 1, triggersPo: false, shopifyLink: "delivered", closed: true },
];

describe("StatusesSection", () => {
  it("has a Closed switch per status, on for the closed ones", () => {
    const html = renderToStaticMarkup(createElement(StatusesSection, { workspaceId: "ws_impact", initial: STATUSES }));
    const switches = html.match(/<input[^>]*id="status-[a-z_]+-closed"[^>]*>/g) ?? [];
    expect(switches).toHaveLength(2);
    expect(switches.filter((input) => input.includes('checked=""'))).toHaveLength(1);
    expect(html).toContain("Closed (leaves the Open view)");
  });
});
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/server/desk/statuses.test.ts src/server/workspaces.test.ts src/components/settings/statuses.test.ts`
Expected: FAIL: `closed` is undefined in the status views; the closed-flag validation is missing (the result is `ok`); the workspace has no closed statuses; the section renders no Closed switches. `npx tsc --noEmit --incremental false` also fails on the StatusView literal in the new component test (`closed` does not exist in type StatusView).

**Step 3: Minimal implementation**

3a. `src/server/desk/shapes.ts`: add to `StatusView` after `shopifyLink`:

```ts
  // Finished work: cards in it leave the Open view (migration 0011).
  closed: boolean;
```

and `closed: row.closed,` in `statusView`.

3b. `src/server/workspaces.ts` `DEFAULT_STATUSES`: add `closed: false` to every entry except `delivered` and `rejected`, which get `closed: true`. Extend the comment: "Delivered and Rejected are closed: their cards leave the Open view (migration 0011 did the same for existing workspaces)."

3c. `src/server/desk/statuses.ts`:
- `Entry` gains `closed: boolean | undefined;` (undefined: an existing status keeps its flag, a new one takes `closedByDefault`).
- In `parseEntries`, before `entries.push(...)`:

```ts
    let closed: boolean | undefined;
    if (raw.closed !== undefined && raw.closed !== null) {
      if (typeof raw.closed !== "boolean") {
        return `${position}: closed must be true or false`;
      }
      closed = raw.closed;
    }
    entries.push({ key, label, color, triggersPo: raw.triggersPo, shopifyLink, closed });
```

- After `LINK_NAMES` add:

```ts
// Statuses whose cards are finished when they are new: a delivered order
// and a rejected request. Wave 1b adds "cancelled" here.
const CLOSED_LINKS: readonly string[] = ["delivered", "draft_rejected"];

export function closedByDefault(link: string | null): boolean {
  return link !== null && CLOSED_LINKS.includes(link);
}
```

- Before `const taken = new Set(existingKeys);` add `const storedClosed = new Map(existing.map((row) => [row.key, row.closed]));`, and in `entries.forEach((entry, sort) => {` build `fields` with the flag:

```ts
    const closed =
      entry.closed !== undefined
        ? entry.closed
        : entry.key !== null
          ? (storedClosed.get(entry.key) ?? false)
          : closedByDefault(links[sort]);
    const fields = {
      label: entry.label,
      color: entry.color,
      sort,
      triggersPo: entry.triggersPo,
      shopifyLink: links[sort],
      closed,
    };
```

(A single inserted row binds 9 parameters and an update 8, inside D1's 100.)

3d. Route doc comment (`src/app/api/workspaces/[id]/statuses/route.ts`): the body entries become `{key?, label, color, triggersPo, shopifyLink?, closed?}` and add "an existing status without closed keeps its flag; a new one is closed when it follows delivered or draft rejected".

3e. `src/server/desk/test-helpers.ts`: add `closed: false` to each `TEST_STATUSES` entry, and `closed: true` to the `rejected` row in `seedDraftStatuses`.

3f. `src/components/settings/statuses.tsx`:
- `Row` gains `closed: boolean;`; `rowsOf` maps `closed: status.closed`; `payload` sends `closed: row.closed`; `add()` creates rows with `closed: false`.
- Add a third help paragraph after the draft orders one:

```tsx
        <p className="text-sm text-ink-2">
          Closed statuses are finished work: their cards leave the Open view and their age stops turning amber or red.
          Delivered and Rejected start closed.
        </p>
```

- Replace the purchase order switch cell (`<div className="md:col-span-2 xl:col-span-1">...</div>`) with:

```tsx
                  <div className="flex flex-wrap gap-x-6 gap-y-2 md:col-span-2 xl:col-span-1">
                    <Switch
                      id={`${id}-po`}
                      checked={row.triggersPo}
                      onChange={(checked) => update(row.uid, { triggersPo: checked })}
                      label="Starts a purchase order"
                    />
                    <Switch
                      id={`${id}-closed`}
                      checked={row.closed}
                      onChange={(checked) => update(row.uid, { closed: checked })}
                      label="Closed (leaves the Open view)"
                    />
                  </div>
```

3g. StatusView literals in tests: add `closed: false` to each literal in `src/components/desk/order-drawer.test.ts` (STATUSES; `rejected` gets `closed: true`), `src/lib/desk-state.test.ts` (the `statusChips` statuses), `src/lib/status-options.test.ts` (the `status()` helper returns `closed: false`), `src/server/desk/statuses.test.ts` (the three expected statuses at 72-74 get `closed: false`), and `src/server/desk/read.test.ts` (the `approved` status at 60-67 gets `closed: false`). `npx tsc --noEmit --incremental false` lists any you miss.

**Step 4: Run them and see them pass**

Run: `npx vitest run src/server/desk/statuses.test.ts src/server/workspaces.test.ts src/components/settings/statuses.test.ts src/server/desk/read.test.ts`
Expected: PASS.

Local visual check: Settings > Statuses shows both switches per row at 1440 and 375, light and dark; Delivered and Rejected are on.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/server/desk/shapes.ts src/server/workspaces.ts src/server/workspaces.test.ts src/server/desk/statuses.ts src/server/desk/statuses.test.ts src/app/api/workspaces/[id]/statuses/route.ts src/server/desk/test-helpers.ts src/components/settings/statuses.tsx src/components/settings/statuses.test.ts src/server/desk/read.test.ts src/components/desk/order-drawer.test.ts src/lib/desk-state.test.ts src/lib/status-options.test.ts"
git add $FILES
git commit -m "feat: closed statuses (Delivered and Rejected by default) in the services and Settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 7: Work queue settings (age thresholds and Show prices)

Managers set when the age turns amber and red (2 and 4 days by default) and whether prices show (Automatic, Show, Hide). A separate small service and route, so the existing workspace settings payload stays as it is. @design-taste-frontend

**Files:**
- Modify: `src/lib/queue-settings.ts` (add the view type, defaults and validation)
- Create: `src/server/desk/queue-settings.ts`, `src/app/api/workspaces/[id]/queue-settings/route.ts`, `src/components/settings/queue-settings.tsx`
- Modify: `src/server/settings-page.ts` (type 26-46, loads 68-78, result 96), `src/components/settings/statuses.tsx` (props 59, after the Panel 313), `src/components/settings/settings-page.tsx` (line 76)
- Test: `src/lib/queue-settings.test.ts`, `src/server/desk/queue-settings.test.ts`, `src/app/api/workspaces/[id]/queue-settings/route.test.ts`, `src/components/settings/queue-settings.test.ts` (all new), `src/server/settings-page.test.ts`

**Step 1: Write the failing tests**

Create `src/lib/queue-settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_QUEUE_SETTINGS, parseQueueSettings } from "./queue-settings";

describe("parseQueueSettings", () => {
  it("accepts whole days with red after amber, and a price display mode", () => {
    expect(parseQueueSettings({ ageAmberDays: 3, ageRedDays: 7, priceDisplay: "hide" })).toEqual({
      ageAmberDays: 3,
      ageRedDays: 7,
      priceDisplay: "hide",
    });
    expect(DEFAULT_QUEUE_SETTINGS).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });
  });

  it("says what is wrong in plain words", () => {
    expect(parseQueueSettings(null)).toBe("Send ageAmberDays, ageRedDays and priceDisplay");
    expect(parseQueueSettings({ ageAmberDays: 0, ageRedDays: 4, priceDisplay: "auto" })).toBe(
      "Amber after must be a whole number of days from 1 to 60",
    );
    expect(parseQueueSettings({ ageAmberDays: 2, ageRedDays: 2.5, priceDisplay: "auto" })).toBe(
      "Red after must be a whole number of days from 1 to 90",
    );
    expect(parseQueueSettings({ ageAmberDays: 4, ageRedDays: 4, priceDisplay: "auto" })).toBe(
      "Red must come after amber: pick more days for red",
    );
    expect(parseQueueSettings({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "always" })).toBe(
      "Show prices must be auto, show or hide",
    );
  });
});
```

Create `src/server/desk/queue-settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getQueueSettings, updateQueueSettings } from "./queue-settings";
import { openTestDb, seedWorkspace } from "./test-helpers";

const WS = "ws_impact";

describe("queue settings", () => {
  it("reads the defaults, saves a valid change and refuses an invalid one without writing", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    await seedWorkspace(db, "ws_other");
    expect(await getQueueSettings(db, WS)).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });

    expect(await updateQueueSettings(db, WS, { ageAmberDays: 3, ageRedDays: 6, priceDisplay: "show" })).toEqual({
      kind: "ok",
      queue: { ageAmberDays: 3, ageRedDays: 6, priceDisplay: "show" },
    });
    expect(await getQueueSettings(db, WS)).toEqual({ ageAmberDays: 3, ageRedDays: 6, priceDisplay: "show" });
    expect(await getQueueSettings(db, "ws_other")).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });

    expect(await updateQueueSettings(db, WS, { ageAmberDays: 5, ageRedDays: 1, priceDisplay: "show" })).toEqual({
      kind: "invalid",
      error: "Red must come after amber: pick more days for red",
    });
    expect((await getQueueSettings(db, WS)).ageAmberDays).toBe(3);
  });
});
```

Create `src/app/api/workspaces/[id]/queue-settings/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test" }, ctx: { waitUntil: () => {} } }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { PUT } = await import("./route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const put = (body: unknown) =>
  new Request("https://orderingdesk.test/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const as = (id: string) => {
  state.session = { user: { id, email: `${id}@example.com` } };
};
const VALID = { ageAmberDays: 3, ageRedDays: 6, priceDisplay: "hide" };

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  for (const id of ["u_manager", "u_staff", "u_stranger"]) {
    await seedUser(db, id, `${id}@example.com`);
  }
  await seedMember(db, "ws_impact", "u_manager", "manager");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("PUT /api/workspaces/[id]/queue-settings", () => {
  it("answers 401 signed out and 404 to staff and to outsiders", async () => {
    expect((await PUT(put(VALID), context)).status).toBe(401);
    as("u_staff");
    expect((await PUT(put(VALID), context)).status).toBe(404);
    as("u_stranger");
    expect((await PUT(put(VALID), context)).status).toBe(404);
  });

  it("saves a manager's change and explains a refusal", async () => {
    as("u_manager");
    const saved = await PUT(put(VALID), context);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ queue: VALID });
    const refused = await PUT(put({ ...VALID, priceDisplay: "always" }), context);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Show prices must be auto, show or hide" });
  });
});
```

Create `src/components/settings/queue-settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueSettingsPanel } from "./queue-settings";

describe("QueueSettingsPanel", () => {
  it("shows the age thresholds and the price display, with Save off until something changes", () => {
    const html = renderToStaticMarkup(
      createElement(QueueSettingsPanel, { workspaceId: "ws_impact", initial: { ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" } }),
    );
    expect(html).toMatch(/<input[^>]*id="queue-amber"[^>]*value="2"/);
    expect(html).toMatch(/<input[^>]*id="queue-red"[^>]*value="4"/);
    expect(html).toMatch(/<input[^>]*name="queue-prices"[^>]*value="auto"[^>]*checked=""/);
    expect(html).toContain("Automatic");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save work queue<\/button>/);
  });
});
```

In `src/server/settings-page.test.ts`, in "adds the team, statuses and notification settings for a manager", add `expect(page.queue).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });`, and in the staff test add `expect(page.queue).toBeNull();`.

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/queue-settings.test.ts src/server/desk/queue-settings.test.ts "src/app/api/workspaces/[id]/queue-settings/route.test.ts" src/components/settings/queue-settings.test.ts src/server/settings-page.test.ts`
Expected: FAIL: `parseQueueSettings` is not exported; `Failed to resolve import "./queue-settings"` for the service, route and component; `page.queue` is undefined.

**Step 3: Minimal implementation**

3a. Append to `src/lib/queue-settings.ts`:

```ts
export const AGE_AMBER_MAX = 60;
export const AGE_RED_MAX = 90;

export type QueueSettingsView = { ageAmberDays: number; ageRedDays: number; priceDisplay: PriceDisplay };

export const DEFAULT_QUEUE_SETTINGS: QueueSettingsView = { ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" };

function wholeDays(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

// The whole setting, or what is wrong with it. Red must come after amber.
export function parseQueueSettings(body: unknown): QueueSettingsView | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Send ageAmberDays, ageRedDays and priceDisplay";
  }
  const record = body as Record<string, unknown>;
  const amber = wholeDays(record.ageAmberDays, AGE_AMBER_MAX);
  if (amber === null) {
    return `Amber after must be a whole number of days from 1 to ${AGE_AMBER_MAX}`;
  }
  const red = wholeDays(record.ageRedDays, AGE_RED_MAX);
  if (red === null) {
    return `Red after must be a whole number of days from 1 to ${AGE_RED_MAX}`;
  }
  if (red <= amber) {
    return "Red must come after amber: pick more days for red";
  }
  const display = record.priceDisplay;
  if (typeof display !== "string" || !(PRICE_DISPLAY_VALUES as readonly string[]).includes(display)) {
    return "Show prices must be auto, show or hide";
  }
  return { ageAmberDays: amber, ageRedDays: red, priceDisplay: display as PriceDisplay };
}
```

3b. Create `src/server/desk/queue-settings.ts`:

```ts
// Work queue settings per workspace (comprehensive desk design section 1),
// on the workspace_settings row: when an open card's age turns amber and
// red, and whether the desk shows prices. Rules in src/lib/queue-settings.ts.

import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { workspaceSettings } from "@/db/schema";
import { DEFAULT_QUEUE_SETTINGS, parseQueueSettings, type QueueSettingsView } from "@/lib/queue-settings";

type QueueRow = Pick<typeof workspaceSettings.$inferSelect, "ageAmberDays" | "ageRedDays" | "priceDisplay">;

export function queueSettingsView(row: QueueRow | undefined): QueueSettingsView {
  return row
    ? { ageAmberDays: row.ageAmberDays, ageRedDays: row.ageRedDays, priceDisplay: row.priceDisplay }
    : { ...DEFAULT_QUEUE_SETTINGS };
}

export async function getQueueSettings(db: Db, workspaceId: string): Promise<QueueSettingsView> {
  const rows = await db
    .select({
      ageAmberDays: workspaceSettings.ageAmberDays,
      ageRedDays: workspaceSettings.ageRedDays,
      priceDisplay: workspaceSettings.priceDisplay,
    })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return queueSettingsView(rows[0]);
}

export type UpdateQueueSettingsResult = { kind: "invalid"; error: string } | { kind: "ok"; queue: QueueSettingsView };

// Replaces the whole setting. Upsert, like the workspace settings: a missing
// row is recreated with its column defaults. The caller has checked the
// workspace exists (the route's guard).
export async function updateQueueSettings(db: Db, workspaceId: string, body: unknown): Promise<UpdateQueueSettingsResult> {
  const queue = parseQueueSettings(body);
  if (typeof queue === "string") {
    return { kind: "invalid", error: queue };
  }
  await db
    .insert(workspaceSettings)
    .values({ workspaceId, ...queue })
    .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: queue });
  return { kind: "ok", queue };
}
```

3c. Create `src/app/api/workspaces/[id]/queue-settings/route.ts`:

```ts
import { NextResponse } from "next/server";
import { updateQueueSettings } from "@/server/desk/queue-settings";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Managers and platform admins (401 signed out, 404 for staff and
// outsiders). Body {ageAmberDays, ageRedDays, priceDisplay: auto | show |
// hide}, the whole setting. 200 {queue}; 400 {error}.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await updateQueueSettings(db, id, body);
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ queue: result.queue });
  } catch (e) {
    return guardResponse(e);
  }
}
```

3d. Create `src/components/settings/queue-settings.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { PriceDisplay, QueueSettingsView } from "@/lib/queue-settings";
import { Segmented, Spinner, type SegmentedOption } from "@/components/kit";
import { ui } from "@/components/ui";
import { Field, InlineMessage, Panel, requestJson, SaveStatus } from "./kit";

const PRICE_OPTIONS: SegmentedOption<PriceDisplay>[] = [
  { value: "auto", label: "Automatic" },
  { value: "show", label: "Show" },
  { value: "hide", label: "Hide" },
];

// Settings > Statuses, second panel: when an open card's age turns amber
// and red, and whether the desk shows totals and the Paid chip.
export function QueueSettingsPanel({ workspaceId, initial }: { workspaceId: string; initial: QueueSettingsView }) {
  const [saved, setSaved] = useState(initial);
  const [amber, setAmber] = useState(String(initial.ageAmberDays));
  const [red, setRed] = useState(String(initial.ageRedDays));
  const [display, setDisplay] = useState<PriceDisplay>(initial.priceDisplay);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dirty = amber !== String(saved.ageAmberDays) || red !== String(saved.ageRedDays) || display !== saved.priceDisplay;

  async function save() {
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await requestJson<{ queue: QueueSettingsView }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/queue-settings`,
      { method: "PUT", json: { ageAmberDays: Number(amber), ageRedDays: Number(red), priceDisplay: display } },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(result.data.queue);
    setAmber(String(result.data.queue.ageAmberDays));
    setRed(String(result.data.queue.ageRedDays));
    setDisplay(result.data.queue.priceDisplay);
    setDone("Work queue saved.");
  }

  const edited = () => setDone(null);

  return (
    <Panel className="flex flex-col gap-4">
      <div>
        <h3 className="font-display text-base font-semibold text-ink">Waiting time and prices</h3>
        <p className="mt-1 max-w-[65ch] text-sm text-ink-2">
          Every open card shows how long it has been in its status. The age turns amber, then red, after these many days.
        </p>
      </div>
      <div className="grid max-w-md gap-4 sm:grid-cols-2">
        <Field id="queue-amber" label="Amber after (days)">
          <input
            id="queue-amber"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            step={1}
            value={amber}
            onChange={(event) => {
              setAmber(event.target.value);
              edited();
            }}
            aria-invalid={error ? true : undefined}
            className={ui.input}
          />
        </Field>
        <Field id="queue-red" label="Red after (days)">
          <input
            id="queue-red"
            type="number"
            inputMode="numeric"
            min={2}
            max={90}
            step={1}
            value={red}
            onChange={(event) => {
              setRed(event.target.value);
              edited();
            }}
            aria-invalid={error ? true : undefined}
            className={ui.input}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-2">
        <p aria-hidden className={ui.label}>
          Show prices
        </p>
        <p className="max-w-[65ch] text-sm text-ink-2">
          Automatic hides totals and the Paid chip when nearly every order is $0, as on a company store with free items. A
          card with a price still says so.
        </p>
        <Segmented
          name="queue-prices"
          legend="Show prices"
          value={display}
          options={PRICE_OPTIONS}
          onChange={(next) => {
            setDisplay(next);
            edited();
          }}
        />
      </div>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="button" onClick={() => void save()} disabled={busy || !dirty} aria-busy={busy || undefined} className={ui.buttonPrimary}>
          {busy ? <Spinner /> : null}
          {busy ? "Saving" : "Save work queue"}
        </button>
        <SaveStatus text={done} />
      </div>
    </Panel>
  );
}
```

3e. `src/server/settings-page.ts`: import `getQueueSettings` from `./desk/queue-settings` and `type QueueSettingsView` from `@/lib/queue-settings`; add `queue: QueueSettingsView | null;` to `SettingsPageData` (after `statuses`); add `shows("statuses") ? getQueueSettings(db, workspace.id) : Promise.resolve(null),` as a new last element of the `Promise.all` (destructure it as `queue`), and `queue,` in the returned object.

3f. `src/components/settings/statuses.tsx`: the section takes `queue?: QueueSettingsView | null` and renders `{queue ? <QueueSettingsPanel workspaceId={workspaceId} initial={queue} /> : null}` right after the closing `</Panel>`. `src/components/settings/settings-page.tsx` line 76 becomes `{data.statuses ? <StatusesSection workspaceId={workspace.id} initial={data.statuses} queue={data.queue} /> : null}`.

**Step 4: Run them and see them pass**

Run the five test files from Step 2 again.
Expected: PASS.

Local visual check: Settings > Statuses, the second panel at 1440 and 375, light and dark: change Red to 1 and save; the red error explains it and both day fields show the invalid border.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/queue-settings.ts src/lib/queue-settings.test.ts src/server/desk/queue-settings.ts src/server/desk/queue-settings.test.ts src/app/api/workspaces/[id]/queue-settings/route.ts src/app/api/workspaces/[id]/queue-settings/route.test.ts src/components/settings/queue-settings.tsx src/components/settings/queue-settings.test.ts src/server/settings-page.ts src/server/settings-page.test.ts src/components/settings/statuses.tsx src/components/settings/settings-page.tsx"
git add $FILES
git commit -m "feat: work queue settings (age thresholds and Show prices)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 8: Account menu component and the server account view

One menu on every host: name, email, role, theme, switch workspace, Sign out (there is no sign-out inside a workspace today). Built from server data so the client never asks. @design-taste-frontend

**Files:**
- Modify: `src/lib/format.ts` (append `initials`)
- Create: `src/server/account.ts`, `src/components/shell/account-menu.tsx`
- Modify: `src/app/sign-out-button.tsx` (whole file, 1-39)
- Test: `src/lib/format.test.ts`, `src/server/account.test.ts` (new), `src/components/shell/account-menu.test.ts` (new)

**Step 1: Write the failing tests**

Append to `src/lib/format.test.ts` (add `initials` to the import):

```ts
describe("initials", () => {
  it("takes up to two first letters of the name, else the email's first letter", () => {
    expect(initials("Casey Lin", "casey@example.com")).toBe("CL");
    expect(initials("  sam  ortiz  vale ", "sam@example.com")).toBe("SO");
    expect(initials("", "jordan@example.com")).toBe("J");
    expect(initials(null, "")).toBe("?");
  });
});
```

Create `src/server/account.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { workspaceAccountView } from "./account";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "./desk/test-helpers";

const env = { APP_URL: "https://orderingdesk.test" } as CloudflareEnv;

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_a");
  await seedWorkspace(db, "ws_b");
  await seedUser(db, "u_one", "one@example.com", "Casey Lin");
  await seedUser(db, "u_two", "two@example.com", "");
  await seedMember(db, "ws_a", "u_one", "staff");
  await seedMember(db, "ws_a", "u_two", "manager");
  await seedMember(db, "ws_b", "u_two", "staff");
  return db;
}

describe("workspaceAccountView", () => {
  it("names the person and their role, with nowhere to switch when they have one workspace", async () => {
    const db = await setup();
    const viewer = { userId: "u_one", email: "one@example.com", platformAdmin: false };
    expect(await workspaceAccountView(db, env, { viewer, name: " Casey Lin ", role: "staff", clientHost: false })).toEqual({
      name: "Casey Lin",
      email: "one@example.com",
      roleLabel: "Staff",
      switchHref: null,
      links: [],
    });
  });

  it("sends someone with several workspaces to the list, on the hub and from a client host", async () => {
    const db = await setup();
    const viewer = { userId: "u_two", email: "two@example.com", platformAdmin: false };
    const hub = await workspaceAccountView(db, env, { viewer, name: "", role: "manager", clientHost: false });
    expect(hub.name).toBeNull();
    expect(hub.switchHref).toBe("/");
    const client = await workspaceAccountView(db, env, { viewer, name: "", role: "manager", clientHost: true });
    expect(client.switchHref).toBe("https://orderingdesk.test/");
  });

  it("always offers a platform admin the list", async () => {
    const db = await setup();
    const viewer = { userId: "u_boss", email: "boss@example.com", platformAdmin: true };
    const view = await workspaceAccountView(db, env, { viewer, name: "Boss", role: "platform", clientHost: false });
    expect(view.switchHref).toBe("/");
    expect(view.roleLabel).toBe("Platform admin");
  });
});
```

Create `src/components/shell/account-menu.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

const { AccountMenu, AccountMenuPanel } = await import("./account-menu");

const ACCOUNT = { name: "Casey Lin", email: "casey@example.com", roleLabel: "Manager", switchHref: "/", links: [] };

describe("AccountMenu", () => {
  it("is one closed button with the person's initials", () => {
    const html = renderToStaticMarkup(createElement(AccountMenu, { account: ACCOUNT }));
    expect(html).toContain('aria-label="Account menu for Casey Lin"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">CL<");
    expect(html).not.toContain("Sign out");
  });
});

describe("AccountMenuPanel", () => {
  it("lists who is signed in, their role, the theme, switch workspace and Sign out", () => {
    const html = renderToStaticMarkup(createElement(AccountMenuPanel, { account: ACCOUNT, settingsHref: "/w/impact/settings", sync: null }));
    expect(html).toContain("Casey Lin");
    expect(html).toContain("casey@example.com");
    expect(html).toContain("Manager");
    expect(html).toContain('name="theme"');
    expect(html).toContain(">Light<");
    expect(html).toContain("Switch workspace");
    expect(html).toContain('href="/w/impact/settings"');
    expect(html).toContain(">Sign out<");
  });

  it("leaves out Switch workspace when there is nowhere to go, and shows extra links", () => {
    const html = renderToStaticMarkup(
      createElement(AccountMenuPanel, {
        account: { ...ACCOUNT, switchHref: null, links: [{ href: "/admin", label: "Platform admin" }] },
        settingsHref: null,
        sync: null,
      }),
    );
    expect(html).not.toContain("Switch workspace");
    expect(html).toContain('href="/admin"');
  });

  it("offers Sync now with the sync state below the large breakpoint", () => {
    const html = renderToStaticMarkup(
      createElement(AccountMenuPanel, {
        account: ACCOUNT,
        settingsHref: null,
        sync: { label: "Synced 5 h ago", tip: "Press Sync to fetch new orders now.", running: false, disabled: false, onSync: () => {} },
      }),
    );
    expect(html).toContain("Sync now");
    expect(html).toContain("Synced 5 h ago. Press Sync to fetch new orders now.");
    expect(html).toMatch(/<li class="lg:hidden">/);
  });
});
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/format.test.ts src/server/account.test.ts src/components/shell/account-menu.test.ts`
Expected: FAIL: `initials is not a function`; `Failed to resolve import "./account"`; `Failed to resolve import "./account-menu"`.

**Step 3: Minimal implementation**

3a. Append to `src/lib/format.ts`:

```ts
// "Casey Lin" -> "CL"; no name: the email's first letter. Uppercase, at
// most two letters, "?" when there is nothing to use.
export function initials(name: string | null | undefined, email: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter((word) => word.length > 0);
  const letters = words.length > 0 ? words.slice(0, 2).map((word) => word.charAt(0)) : [email.trim().charAt(0)];
  const text = letters.join("").toUpperCase();
  return text.length > 0 ? text : "?";
}
```

3b. Create `src/server/account.ts`:

```ts
// What the account menu shows (comprehensive desk design section 1): who is
// signed in, their role here, and where their other workspaces are. Built on
// the server from the guard's result, so the client never asks.

import type { Db } from "@/db";
import { roleLabel, type Role } from "@/lib/roles";
import type { Viewer } from "./guard";
import { appOrigin } from "./host";
import { listWorkspacesForViewer } from "./workspaces";

export type AccountView = {
  // The person's name, or null to show the email alone.
  name: string | null;
  email: string;
  // Their role where they are ("Manager"), or null on the hub list for a
  // client (no role there).
  roleLabel: string | null;
  // The workspace list, or null when there is nowhere else to go. On a
  // client host it is the hub's own address (sessions are per host, so the
  // hub may ask them to sign in there).
  switchHref: string | null;
  // Extra places (the hub's Platform admin page).
  links: { href: string; label: string }[];
};

export async function workspaceAccountView(
  db: Db,
  env: CloudflareEnv,
  input: { viewer: Viewer; name: string | null | undefined; role: Role; clientHost: boolean },
): Promise<AccountView> {
  const workspaces = await listWorkspacesForViewer(db, input.viewer);
  const elsewhere = input.viewer.platformAdmin || workspaces.length > 1;
  return {
    name: input.name?.trim() || null,
    email: input.viewer.email,
    roleLabel: roleLabel(input.role),
    switchHref: elsewhere ? (input.clientHost ? `${appOrigin(env)}/` : "/") : null,
    links: [],
  };
}
```

3c. Replace `src/app/sign-out-button.tsx` with (same behavior, a menu variant added):

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { authClient } from "@/lib/auth-client";
import { disableDevicePush } from "@/lib/push-client";
import { Spinner } from "@/components/kit";
import { ui } from "@/components/ui";

// How long signing out waits for this browser's push subscription to be
// forgotten before it signs out anyway.
const FORGET_PUSH_MS = 2000;

// variant "menu": a row of the account menu (className from the menu).
export function SignOutButton({ variant = "button", className }: { variant?: "button" | "menu"; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      // A signed-out browser stops getting this person's notifications
      // (a shared device): forget its push subscription while the session
      // still allows it.
      await Promise.race([disableDevicePush(), new Promise((resolve) => setTimeout(resolve, FORGET_PUSH_MS))]);
      await authClient.signOut();
    } finally {
      router.replace("/sign-in");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      aria-busy={busy || undefined}
      className={className ?? ui.buttonSecondary}
    >
      {busy ? <Spinner /> : variant === "menu" ? <SignOutIcon size={18} aria-hidden /> : null}
      {busy ? "Signing out" : "Sign out"}
    </button>
  );
}
```

3d. Create `src/components/shell/account-menu.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/ArrowsLeftRight";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { initials } from "@/lib/format";
import type { AccountView } from "@/server/account";
import { SignOutButton } from "@/app/sign-out-button";
import { Monogram, Spinner } from "@/components/kit";
import { ThemeToggle } from "@/components/theme-toggle";
import { ui } from "@/components/ui";

// The account menu (comprehensive desk design section 1): who is signed in,
// their role, the theme, switch workspace and Sign out, on every host. Below
// the large breakpoint it also holds Sync now (the top bar has no room for
// the Sync button there) and, on phones, Settings.

export type AccountSync = {
  // The sync state in words ("Synced 5 h ago") and what to do about it.
  label: string;
  tip: string | null;
  running: boolean;
  disabled: boolean;
  onSync: () => void;
};

const row =
  "flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-left text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60";

export function AccountMenuPanel({
  account,
  settingsHref,
  sync,
}: {
  account: AccountView;
  settingsHref: string | null;
  sync: AccountSync | null;
}) {
  return (
    <div className="flex flex-col p-2">
      <div className="flex items-center gap-3 px-2 py-2">
        <Monogram text={initials(account.name, account.email)} size="md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{account.name ?? account.email}</p>
          {account.name ? <p className="truncate text-xs text-ink-2">{account.email}</p> : null}
          {account.roleLabel ? <p className="text-xs font-medium text-ink-2">{account.roleLabel}</p> : null}
        </div>
      </div>
      <div className="border-t border-line px-2 pb-2 pt-3">
        <p aria-hidden className="mb-2 text-xs font-semibold text-ink-2">
          Theme
        </p>
        <ThemeToggle labels />
      </div>
      <ul className="flex flex-col border-t border-line pt-1">
        {sync ? (
          <li className="lg:hidden">
            <button type="button" onClick={sync.onSync} disabled={sync.disabled} aria-busy={sync.running || undefined} className={row}>
              {sync.running ? <Spinner size={18} /> : <ArrowsClockwiseIcon size={18} aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="block">{sync.running ? "Syncing" : "Sync now"}</span>
                <span className="block text-xs font-normal text-ink-2">
                  {sync.tip ? `${sync.label}. ${sync.tip}` : sync.label}
                </span>
              </span>
            </button>
          </li>
        ) : null}
        {settingsHref ? (
          <li className="sm:hidden">
            <Link href={settingsHref} className={row}>
              <GearSixIcon size={18} aria-hidden />
              Settings
            </Link>
          </li>
        ) : null}
        {account.links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className={row}>
              {link.label}
            </Link>
          </li>
        ))}
        {account.switchHref ? (
          <li>
            <a href={account.switchHref} className={row}>
              <ArrowsLeftRightIcon size={18} aria-hidden />
              Switch workspace
            </a>
          </li>
        ) : null}
        <li>
          <SignOutButton variant="menu" className={row} />
        </li>
      </ul>
    </div>
  );
}

// One button with the person's initials opens the panel below it, right
// aligned (keep it last in its row so the panel stays on screen). Esc and a
// click outside close it; focus returns to the button.
export function AccountMenu({
  account,
  settingsHref = null,
  sync = null,
}: {
  account: AccountView;
  settingsHref?: string | null;
  sync?: AccountSync | null;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    panelRef.current?.focus();
    function onPointerDown(event: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account menu for ${account.name ?? account.email}`}
        onClick={() => setOpen((current) => !current)}
        className={ui.iconButton}
      >
        <Monogram text={initials(account.name, account.email)} size="sm" />
      </button>
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-label="Account"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) {
              setOpen(false);
            }
          }}
          className="od-rise absolute right-0 top-full z-10 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-panel border border-line bg-surface shadow-lift focus:outline-none"
        >
          <AccountMenuPanel
            account={account}
            settingsHref={settingsHref}
            sync={
              sync
                ? {
                    ...sync,
                    onSync: () => {
                      sync.onSync();
                      setOpen(false);
                    },
                  }
                : null
            }
          />
        </div>
      ) : null}
    </div>
  );
}
```

**Step 4: Run them and see them pass**

Run: `npx vitest run src/lib/format.test.ts src/server/account.test.ts src/components/shell/account-menu.test.ts`
Expected: PASS.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/format.ts src/lib/format.test.ts src/server/account.ts src/server/account.test.ts src/components/shell/account-menu.tsx src/components/shell/account-menu.test.ts src/app/sign-out-button.tsx"
git add $FILES
git commit -m "feat: account menu with name, role, theme, switch workspace and Sign out" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 9: One-row top bar and the hub header

The workspace top bar becomes one 56px row on every width (brand, sync, Settings, bell, account menu last); the theme switch moves into the menu. The hub header stops breaking at 375px (email one letter per line, admin link over the title) by moving its controls into the same menu. @design-taste-frontend

**Files:**
- Modify: `src/components/shell/workspace-shell.tsx` (props 14-33, TopBar 53)
- Modify: `src/components/shell/top-bar.tsx` (whole file, 1-138)
- Modify: `src/app/w/[slug]/layout.tsx` (59-65), `src/app/page.tsx` (imports 1-20, `clientHostDesk` 48-67, hub header 120-139), `src/app/settings/page.tsx` (45-57)
- Test: `src/components/shell/top-bar.test.ts` (rewrite), `src/app/page.test.ts`

**Step 1: Write the failing tests**

Replace `src/components/shell/top-bar.test.ts` with:

```ts
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The top bar on the server, with the workspace context stood in.
const state = vi.hoisted(() => ({
  value: {
    workspace: { id: "ws_impact", slug: "impact", name: "Impact", basePath: "" },
    role: "manager",
    userId: "u_me",
    liveStatus: "live",
    sync: { status: "ready", connection: null },
    connection: null,
    manual: { running: false, cooldownUntil: 0, failure: null },
    runManualSync: () => {},
    subscribe: () => () => {},
  } as Record<string, unknown>,
}));
vi.mock("./workspace-provider", () => ({ useWorkspace: () => state.value }));
vi.mock("@/components/toasts", () => ({ useToast: () => () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

const { TopBar } = await import("./top-bar");

const ACCOUNT = { name: "Casey Lin", email: "casey@example.com", roleLabel: "Manager", switchHref: null, links: [] };
const LONG_NAME = "Impact Rentals Construction Equipment and Site Services of Southern Ontario Ltd.";
const render = (name = "Impact") =>
  renderToStaticMarkup(createElement(TopBar, { name, images: { logo: null, symbol: null }, account: ACCOUNT }));

function classOf(html: string, marker: RegExp): string {
  const match = html.match(marker);
  if (!match) {
    throw new Error(`no element matching ${marker}`);
  }
  return match[1];
}

describe("TopBar", () => {
  it("is one 56px row with the account menu last and the theme switch inside it", () => {
    const html = render();
    const bar = classOf(html, /<header[^>]*><div class="([^"]*)"/).split(" ");
    expect(bar).toContain("h-14");
    expect(bar).not.toContain("flex-wrap");
    expect(html.indexOf('aria-label="Activity"')).toBeLessThan(html.indexOf("Account menu for Casey Lin"));
    // The account button is the last button in the bar.
    expect(html.slice(html.lastIndexOf("<button"))).toMatch(/^<button[^>]*aria-label="Account menu for Casey Lin"/);
    expect(html).not.toContain('name="theme"');
  });

  it("lets a long workspace name shrink and truncate", () => {
    expect(LONG_NAME).toHaveLength(80);
    const brand = classOf(render(LONG_NAME), /<a[^>]*title="Orders"[^>]*class="([^"]*)"/).split(" ");
    expect(brand).toContain("min-w-0");
    expect(brand).toContain("lg:flex-initial");
  });

  it("keeps the sync chip from shrinking, and the Sync button for the large breakpoint", () => {
    const html = render();
    const chip = classOf(html, /<span data-tone="[^"]+" title="[^"]+" class="([^"]*)"/).split(" ");
    expect(chip).toContain("shrink-0");
    expect(html).toMatch(/<button[^>]*aria-label="Sync orders from Shopify now"[^>]*class="[^"]*max-lg:hidden/);
  });
});
```

(`max-lg:hidden` and `max-sm:hidden` rather than `hidden lg:inline-flex`: the shared control classes already set `inline-flex`, and a breakpoint variant reliably wins over it.)

Append to `src/app/page.test.ts` (and add `useRouter: () => ({ push() {}, replace() {}, refresh() {} }),` to the `vi.mock("next/navigation", ...)` object at the top; add `import { renderToStaticMarkup } from "react-dom/server";`):

```ts
describe("the hub header", () => {
  it("puts the account controls in one menu that fits a phone", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const html = renderToStaticMarkup((await outcome()) as ReactElement);
    expect(html).toContain('aria-label="Account menu for boss@example.com"');
    expect(html).not.toContain("Signed in as");
    expect(html).not.toContain(">Sign out<");
    expect(html).not.toContain('name="theme"');
  });
});
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/components/shell/top-bar.test.ts src/app/page.test.ts`
Expected: FAIL: the bar has `flex-wrap` and no `h-14`, the theme radios are in the bar, there is no account menu; the hub header says "Signed in as".

**Step 3: Minimal implementation**

3a. `src/components/shell/workspace-shell.tsx`: add `account: AccountView;` to the props (with `import type { AccountView } from "@/server/account";`) and pass it: `<TopBar name={workspace.name} images={brandImages(workspace.id, workspace.branding)} account={account} />`.

3b. Replace `src/components/shell/top-bar.tsx` with:

```tsx
"use client";

import Link from "next/link";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CloudSlashIcon } from "@phosphor-icons/react/CloudSlash";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { PauseIcon } from "@phosphor-icons/react/Pause";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { APP_NAME } from "@/lib/brand";
import type { BrandImages } from "@/lib/brand-assets";
import { CHIP_TONE_COLOR, syncChipState, type ChipTone } from "@/lib/sync-status";
import { useNow } from "@/lib/use-now";
import type { AccountView } from "@/server/account";
import { ui } from "@/components/ui";
import { AccountMenu, type AccountSync } from "./account-menu";
import { Bell } from "./bell";
import { useWorkspace } from "./workspace-provider";
import { WorkspaceBrandSlot } from "./workspace-brand-slot";

const LIVE_TEXT = {
  live: "Live updates on",
  connecting: "Connecting live updates",
  offline: "Live updates paused; checking every 30 seconds",
} as const;

function chipIcon(tone: ChipTone, label: string) {
  if (label === "Catching up") {
    return <ArrowsClockwiseIcon size={14} aria-hidden className="od-spin" />;
  }
  if (label === "Sync paused") {
    return <PauseIcon size={14} aria-hidden />;
  }
  switch (tone) {
    case "good":
      return <CheckCircleIcon size={14} aria-hidden />;
    case "warn":
      return <WarningIcon size={14} aria-hidden />;
    case "bad":
      return <WarningCircleIcon size={14} aria-hidden />;
    default:
      return <CloudSlashIcon size={14} aria-hidden />;
  }
}

// The sync state from sm up (phones get it in the account menu).
function SyncChip() {
  const { sync, liveStatus } = useWorkspace();
  const now = useNow(30000);
  const state = syncChipState(sync, now || Date.now());

  if (state.kind === "loading") {
    return <span className="od-skeleton hidden h-8 w-36 sm:block" aria-label="Loading sync status" />;
  }
  return (
    // shrink-0: the chip never collapses below its icon and label; a long
    // workspace name truncates instead.
    <span
      data-tone={CHIP_TONE_COLOR[state.tone]}
      title={LIVE_TEXT[liveStatus]}
      className="hidden h-8 shrink-0 items-center gap-1.5 rounded-control bg-tone-fill px-3 text-xs font-semibold text-tone-text sm:inline-flex"
    >
      {chipIcon(state.tone, state.label)}
      <span>{state.label}</span>
      <span className="sr-only">. {LIVE_TEXT[liveStatus]}.</span>
    </span>
  );
}

// From lg; below it, Sync now lives in the account menu.
function SyncButton() {
  const { manual, runManualSync } = useWorkspace();
  const now = useNow(1000);
  const waitSeconds = now > 0 ? Math.ceil((manual.cooldownUntil - now) / 1000) : 0;
  const coolingDown = waitSeconds > 0;
  const label = manual.running ? "Syncing" : coolingDown ? `Wait ${waitSeconds}s` : "Sync";

  return (
    <button
      type="button"
      onClick={runManualSync}
      disabled={manual.running || coolingDown}
      aria-busy={manual.running || undefined}
      aria-label={coolingDown ? `Sync available in ${waitSeconds} seconds` : "Sync orders from Shopify now"}
      className={`${ui.buttonPrimary} h-9 min-w-[6.5rem] tabular-nums max-lg:hidden`}
    >
      <ArrowsClockwiseIcon size={16} aria-hidden className={manual.running ? "od-spin" : undefined} />
      {label}
    </button>
  );
}

// The account menu with this workspace's Settings and Sync now.
function WorkspaceAccount({ account }: { account: AccountView }) {
  const { workspace, sync, manual, runManualSync } = useWorkspace();
  const now = useNow(30000);
  const state = syncChipState(sync, now || Date.now());
  const coolingDown = now > 0 && manual.cooldownUntil > now;
  const syncItem: AccountSync | null =
    state.kind === "ready"
      ? { label: state.label, tip: null, running: manual.running, disabled: manual.running || coolingDown, onSync: runManualSync }
      : null;
  return <AccountMenu account={account} settingsHref={`${workspace.basePath}/settings`} sync={syncItem} />;
}

// One 56px row at every width: the workspace (its name truncates first),
// the sync chip from sm, the Sync button from lg, Settings from sm, the
// bell, and the account menu last so its panel, right aligned to it, stays
// on screen.
export function TopBar({ name, images, account }: { name: string; images: BrandImages; account: AccountView }) {
  const { workspace } = useWorkspace();
  return (
    // z-30: the top layer of the page itself; the drawer (z-40) and toasts
    // (z-50) sit above it.
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
        {/* On a client host "/" is this workspace itself; on the hub it
            is the workspace list. */}
        <Link
          href="/"
          title={workspace.basePath === "" ? "Orders" : "All workspaces"}
          className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-control p-1 lg:flex-initial"
        >
          <WorkspaceBrandSlot name={name} images={images} />
          <span className="min-w-0">
            <span className="block truncate font-display text-[15px] font-semibold leading-tight text-ink">{name}</span>
            <span className="block text-xs leading-tight text-ink-2">{APP_NAME}</span>
          </span>
        </Link>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <SyncChip />
          <SyncButton />
          {/* Every member: each role sees its own Settings sections. */}
          <Link href={`${workspace.basePath}/settings`} className={`${ui.buttonQuiet} h-10 max-sm:hidden`}>
            <GearSixIcon size={18} aria-hidden />
            <span className="sr-only lg:not-sr-only">Settings</span>
          </Link>
          <Bell />
          <WorkspaceAccount account={account} />
        </div>
      </div>
    </header>
  );
}
```

3c. Callers build the account view after the guard. `src/app/w/[slug]/layout.tsx`:

```tsx
  const { workspace, role, userId, viewer, session, db, env } = guarded;
  const account = await workspaceAccountView(db, env, { viewer, name: session.user.name, role, clientHost: false });

  return (
    <WorkspaceShell workspace={workspace} role={role} userId={userId} clientHost={false} account={account}>
      {children}
    </WorkspaceShell>
  );
```

`src/app/page.tsx` `clientHostDesk`: after the guard, `const account = await workspaceAccountView(guarded.db, guarded.env, { viewer: guarded.viewer, name: guarded.session.user.name, role: guarded.role, clientHost: true });` and pass `account={account}`. `src/app/settings/page.tsx` the same with `clientHost: true`. Import `workspaceAccountView` from `@/server/account` in all three.

3d. Hub header in `src/app/page.tsx` (the `view.kind === "list"` branch, 120-139). Replace the `<header>` with:

```tsx
      <header className="flex items-center justify-between gap-4">
        <h1 className="min-w-0 truncate font-display text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
        <AccountMenu
          account={{
            name: guarded.session.user.name?.trim() || null,
            email: viewer.email,
            roleLabel: viewer.platformAdmin ? roleLabel("platform") : null,
            switchHref: null,
            links: viewer.platformAdmin ? [{ href: "/admin", label: "Platform admin" }] : [],
          }}
        />
      </header>
```

Import `AccountMenu` from `@/components/shell/account-menu`; remove the `ThemeToggle` import (the no-access branch keeps `SignOutButton`).

**Step 4: Run them and see them pass**

Run: `npx vitest run src/components/shell/top-bar.test.ts src/app/page.test.ts`
Expected: PASS.

Local visual check at 1440x900 and 375x812, light and dark: one row on the desk and Settings; the account menu opens right aligned, Esc closes it and focus returns; Sign out works; on the hub at 375px the title and the menu share one row and nothing overlaps; Switch workspace appears only for a viewer with several workspaces.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/components/shell/workspace-shell.tsx src/components/shell/top-bar.tsx src/components/shell/top-bar.test.ts src/app/w/[slug]/layout.tsx src/app/page.tsx src/app/page.test.ts src/app/settings/page.tsx"
git add $FILES
git commit -m "feat: one-row top bar with the account menu, and a hub header that fits phones" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 10: Density (one list per breakpoint, 44px rows, compact cards, one toolbar row)

Today 7 orders fit above the fold at 1440x900 and both the table and the cards are mounted at every width (1,000 cards mean 2,000 hidden status selects). Render the table or the cards, never both; single-line 44px rows; compact cards; one toolbar row (status, kind, search, sort) with a smaller heading; on phones one row with search and the other filters behind buttons. @design-taste-frontend

**Files:**
- Create: `src/lib/use-media-query.ts`
- Modify: `src/lib/format.ts` (append `formatDay`)
- Modify: `src/components/desk/order-list.tsx` (whole file, 1-247)
- Modify: `src/components/desk/toolbar.tsx` (whole file, 1-146)
- Modify: `src/components/desk/desk-skeleton.tsx` (whole file, 1-79)
- Modify: `src/components/desk/desk.tsx` (imports 37-40, component top 126-130, render 637-736)
- Delete: `src/components/desk/status-strip.tsx`
- Test: `src/lib/format.test.ts`, `src/lib/use-media-query.test.ts` (new), `src/components/desk/order-list.test.ts` (new), `src/components/desk/toolbar.test.ts` (new)

**Step 1: Write the failing tests**

Append to `src/lib/format.test.ts` (add `formatDay` to the import):

```ts
describe("formatDay", () => {
  it("leaves the year out for this year", () => {
    const now = Date.parse("2026-10-06T00:00:00.000Z");
    expect(formatDay(Date.parse("2026-10-05T19:00:00.000Z"), now, "UTC")).toBe("Oct 5");
    expect(formatDay(Date.parse("2025-10-05T19:00:00.000Z"), now, "UTC")).toBe("Oct 5, 2025");
  });
});
```

Create `src/lib/use-media-query.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DESK_MEDIA, useMediaQuery } from "./use-media-query";

function Probe({ serverValue }: { serverValue: boolean }) {
  return String(useMediaQuery(DESK_MEDIA, serverValue));
}

describe("useMediaQuery", () => {
  it("uses the server value when there is no window", () => {
    expect(renderToStaticMarkup(createElement(Probe, { serverValue: true }))).toBe("true");
    expect(renderToStaticMarkup(createElement(Probe, { serverValue: false }))).toBe("false");
    expect(DESK_MEDIA).toBe("(min-width: 55rem)");
  });
});
```

Create `src/components/desk/order-list.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrderSummary } from "@/server/desk/read";
import type { StatusView } from "@/server/desk/shapes";
import { OrderList, type ListProps } from "./order-list";

const NOW = Date.parse("2026-10-05T15:00:00.000Z");
const STATUSES: StatusView[] = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
];

function card(id: string, overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id,
    name: "#" + id,
    statusKey: "new",
    statusSetBy: null,
    statusSetAt: null,
    createdAt: NOW - 3600000,
    syncedAt: NOW,
    customerName: "Jordan Vale",
    email: "jordan@example.com",
    total: "0.00",
    currency: "USD",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    itemCount: 1,
    itemsPreview: ["1 x Hard Hat"],
    itemTitles: ["Hard Hat"],
    itemsTruncated: false,
    kind: "order",
    draftName: null,
    draftStatus: null,
    draftDeleted: false,
    company: "",
    location: "",
    requestFor: "",
    branch: "",
    searchText: [],
    ...overrides,
  };
}

const base: ListProps = {
  orders: [
    card("1001"),
    card("d12", { name: "#D12", kind: "draft", draftName: "#D12", draftStatus: "open", requestFor: "Casey Lin", branch: "Buford HQ" }),
    card("d13", { name: "#D13", kind: "draft", draftName: "#D13", draftDeleted: true }),
  ],
  statuses: STATUSES,
  role: "manager",
  flashing: new Set(),
  rowErrors: {},
  savingIds: new Set(),
  now: NOW,
  onOpen: () => {},
  onChangeStatus: () => {},
};

const render = (layout: "table" | "cards", overrides: Partial<ListProps> = {}) =>
  renderToStaticMarkup(createElement(OrderList, { ...base, ...overrides, layout }));

describe("OrderList", () => {
  it("renders the table alone at desk width, one status control per card", () => {
    const html = render("table");
    expect(html).toContain("<table");
    expect(html).not.toContain("<ul");
    expect(html.match(/<select/g)).toHaveLength(3);
  });

  it("renders the cards alone below it, letting the browser skip off-screen cards", () => {
    const html = render("cards");
    expect(html).toContain("<ul");
    expect(html).not.toContain("<table");
    expect(html).toContain("[content-visibility:auto]");
    expect(html.match(/<select/g)).toHaveLength(3);
  });

  it("keeps every table row on one 44px line", () => {
    const html = render("table");
    expect(html.match(/<tr class="h-11 /g)).toHaveLength(3);
    expect(html).not.toContain("line-clamp-2");
    expect(html).toContain("For Casey Lin · Buford HQ");
  });

  it("marks requests, and a request whose draft Shopify deleted", () => {
    const html = render("table");
    expect(html).toContain(">Draft</span>");
    expect(html).toContain('Deleted<span class="sr-only"> in Shopify</span>');
  });
});
```

Create `src/components/desk/toolbar.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusChip } from "@/lib/desk-state";
import { Toolbar, type ToolbarProps } from "./toolbar";

const CHIPS: StatusChip[] = [
  { key: "processing", label: "Processing", color: "blue", count: 6, known: true },
  { key: "backorder", label: "Unknown status", color: "slate", count: 1, known: false },
];

const base: ToolbarProps = {
  layout: "row",
  statusKey: null,
  onStatus: () => {},
  statusChips: CHIPS,
  query: "",
  onQuery: () => {},
  sort: "newest",
  onSort: () => {},
  kindFilter: { kind: "all", onKind: () => {}, draftCount: 5, deletedCount: 0 },
  shown: 34,
};

const render = (overrides: Partial<ToolbarProps> = {}) => renderToStaticMarkup(createElement(Toolbar, { ...base, ...overrides }));

describe("Toolbar", () => {
  it("puts status, kind, search and sort in one row at desk width", () => {
    const html = render();
    expect(html).toMatch(/^<div class="flex min-w-0 flex-1 flex-wrap items-center/);
    for (const marker of ['id="desk-status"', 'name="desk-kind"', 'id="desk-search"', 'id="desk-sort"']) {
      expect(html).toContain(marker);
    }
    expect(html).toContain("34 cards shown");
  });

  it("lists every status with its count, and unknown keys by their key", () => {
    const html = render();
    expect(html).toContain(">All statuses</option>");
    expect(html).toContain(">Processing (6)</option>");
    expect(html).toContain(">Unknown: backorder (1)</option>");
  });

  it("is one row on phones, with search and the other filters behind buttons", () => {
    const closed = render({ layout: "phone" });
    expect(closed).toContain('id="desk-status"');
    expect(closed).not.toContain('id="desk-search"');
    expect(closed).not.toContain('id="desk-sort"');
    expect(closed.match(/aria-expanded="false"/g)).toHaveLength(2);
    const searching = render({ layout: "phone", query: "vest" });
    expect(searching).toContain('id="desk-search"');
    expect(searching).toContain('value="vest"');
    expect(render({ layout: "phone", sort: "oldest" })).toContain("More filters, 1 on");
  });
});
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/format.test.ts src/lib/use-media-query.test.ts src/components/desk/order-list.test.ts src/components/desk/toolbar.test.ts`
Expected: FAIL: `formatDay is not a function`; `Failed to resolve import "./use-media-query"`; `OrderList` and `ListProps` are not exported; the toolbar has no `layout` and renders no status filter.

**Step 3: Minimal implementation**

3a. Append to `src/lib/format.ts`:

```ts
// "Oct 5" this year, "Oct 5, 2025" otherwise: a list's date column.
export function formatDay(ms: number, now: number, timeZone?: string): string {
  const year = (value: number) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: year(ms) === year(now) ? undefined : "numeric",
    timeZone,
  }).format(ms);
}
```

3b. Create `src/lib/use-media-query.ts`:

```ts
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
```

3c. Replace `src/components/desk/order-list.tsx` with:

```tsx
"use client";

import { InfoIcon } from "@phosphor-icons/react/Info";
import { formatDateTime, formatDay, formatMoney } from "@/lib/format";
import type { Role } from "@/lib/roles";
import { statusOptionsFor } from "@/lib/status-options";
import type { OrderSummary } from "@/server/desk/read";
import type { StatusView } from "@/server/desk/shapes";
import { Chip } from "@/components/kit";
import { StatusSelect } from "./status-select";

// The desk list (comprehensive desk design section 1): a table of one-line
// 44px rows from 880px, compact cards below it. Exactly one of the two is
// rendered (the desk picks with useMediaQuery), so a long list holds one
// status control per card, not two.

export type ListProps = {
  orders: OrderSummary[];
  statuses: StatusView[];
  // Decides which statuses a request offers (src/lib/status-options.ts).
  role: Role;
  flashing: Set<string>;
  rowErrors: Record<string, string>;
  // Orders whose status change is saving.
  savingIds: ReadonlySet<string>;
  // The current time for dates (0 before the first client render).
  now: number;
  onOpen: (orderId: string) => void;
  onChangeStatus: (orderId: string, statusKey: string) => void;
};

function itemsLine(order: OrderSummary): string {
  if (order.itemsPreview.length === 0) {
    return "No line items";
  }
  const more = order.itemTitles.length - order.itemsPreview.length;
  return `${order.itemsPreview.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

// "For Casey Lin · Buford HQ" when the request names them.
function requestLine(order: OrderSummary): string | null {
  const parts = [order.requestFor ? `For ${order.requestFor}` : "", order.branch].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// A request's Draft chip, Deleted when Shopify deleted its draft; an order
// that was a request names its draft.
function KindMark({ order }: { order: OrderSummary }) {
  if (order.kind === "draft") {
    return order.draftDeleted ? (
      <Chip tone="amber" size="sm">
        Deleted<span className="sr-only"> in Shopify</span>
      </Chip>
    ) : (
      <Chip tone="slate" size="sm">
        Draft
      </Chip>
    );
  }
  return order.draftName ? (
    <span className="shrink-0 truncate text-xs text-ink-2">{`from ${order.draftName}`}</span>
  ) : null;
}

function CustomerLine({ order }: { order: OrderSummary }) {
  const line = requestLine(order);
  return (
    <span className="block truncate text-sm" title={order.email || undefined}>
      <span className="font-medium text-ink">{order.customerName || "No customer name"}</span>
      {line ? <span className="text-ink-2">{` · ${line}`}</span> : null}
    </span>
  );
}

function ItemsLine({ order }: { order: OrderSummary }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={`truncate text-sm ${order.itemsPreview.length > 0 ? "text-ink-2" : "text-ink-3"}`}>{itemsLine(order)}</span>
      {order.itemsTruncated ? (
        <span className="inline-flex shrink-0 text-warn" title="More items in Shopify">
          <InfoIcon size={14} aria-hidden />
          <span className="sr-only">More items in Shopify</span>
        </span>
      ) : null}
    </span>
  );
}

function RowStatus({
  order,
  statuses,
  role,
  busy,
  onChangeStatus,
}: {
  order: OrderSummary;
  statuses: StatusView[];
  role: Role;
  busy: boolean;
  onChangeStatus: (orderId: string, statusKey: string) => void;
}) {
  const options = statusOptionsFor({ kind: order.kind, role, currentKey: order.statusKey, statuses });
  return (
    <StatusSelect
      statuses={options.options}
      value={order.statusKey}
      onChange={(key) => onChangeStatus(order.id, key)}
      label={`Status for ${order.kind === "draft" ? "request" : "order"} ${order.name}`}
      busy={busy}
      disabled={options.disabled}
      hint={options.hint}
    />
  );
}

function RowError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="mt-1 text-xs font-medium text-bad">
      {message}
    </p>
  ) : null;
}

function Total({ order }: { order: OrderSummary }) {
  return <span className="font-mono text-sm tabular-nums text-ink">{formatMoney(order.total, order.currency)}</span>;
}

function DayText({ order, now }: { order: OrderSummary; now: number }) {
  return (
    <span className="block truncate text-sm tabular-nums text-ink" title={formatDateTime(order.createdAt)}>
      {now > 0 ? formatDay(order.createdAt, now) : ""}
    </span>
  );
}

// From 880px: one 44px line per card, so 15 to 18 fit above the fold at
// 1440 by 900.
export function OrderTable({ orders, statuses, role, flashing, rowErrors, savingIds, now, onOpen, onChangeStatus }: ListProps) {
  return (
    <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-panel">
      <table className="w-full table-fixed border-collapse text-left">
        <colgroup>
          <col className="w-[10rem]" />
          <col className="w-[6.5rem]" />
          <col className="w-[24%]" />
          <col />
          <col className="w-[7rem]" />
          <col className="w-[11rem]" />
        </colgroup>
        <thead>
          <tr className="h-9 text-xs font-semibold text-ink-2">
            <th scope="col" className="px-4 font-semibold">Order</th>
            <th scope="col" className="px-3 font-semibold">Date</th>
            <th scope="col" className="px-3 font-semibold">Customer</th>
            <th scope="col" className="px-3 font-semibold">Items</th>
            <th scope="col" className="px-3 text-right font-semibold">Total</th>
            <th scope="col" className="px-4 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const flash = flashing.has(order.id) ? "od-flash" : "";
            return (
              <tr
                key={order.id}
                onClick={() => onOpen(order.id)}
                className="h-11 cursor-pointer border-t border-line transition-colors hover:bg-surface-2/70"
              >
                <td className={`px-4 ${flash}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(order.id);
                      }}
                      className="-mx-1 shrink-0 rounded-control px-1 font-mono text-sm font-semibold tabular-nums text-ink underline-offset-4 hover:underline"
                    >
                      <span className="sr-only">{order.kind === "draft" ? "Open request " : "Open order "}</span>
                      {order.name}
                    </button>
                    <KindMark order={order} />
                  </span>
                </td>
                <td className={`px-3 ${flash}`}>
                  <DayText order={order} now={now} />
                </td>
                <td className={`px-3 ${flash}`}>
                  <CustomerLine order={order} />
                </td>
                <td className={`px-3 ${flash}`}>
                  <ItemsLine order={order} />
                </td>
                <td className={`px-3 text-right ${flash}`}>
                  <Total order={order} />
                </td>
                <td className={`px-4 ${flash}`} onClick={(event) => event.stopPropagation()}>
                  <RowStatus order={order} statuses={statuses} role={role} busy={savingIds.has(order.id)} onChangeStatus={onChangeStatus} />
                  <RowError message={rowErrors[order.id]} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Below 880px: compact cards, the order and its kind with the date in the
// header, who and what on one line each, then the status control. The
// order number is a stretched button over the card; the status control
// sits above it so both stay usable. content-visibility lets the browser
// skip laying out cards that are off screen.
export function OrderCards({ orders, statuses, role, flashing, rowErrors, savingIds, now, onOpen, onChangeStatus }: ListProps) {
  return (
    <ul className="flex flex-col gap-2">
      {orders.map((order) => (
        <li
          key={order.id}
          className={`relative rounded-panel border border-line bg-surface px-3.5 py-3 shadow-panel [contain-intrinsic-size:auto_8.5rem] [content-visibility:auto] ${
            flashing.has(order.id) ? "od-flash" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpen(order.id)}
              className="shrink-0 font-mono text-[15px] font-semibold tabular-nums text-ink after:absolute after:inset-0 after:rounded-panel after:content-['']"
            >
              <span className="sr-only">{order.kind === "draft" ? "Open request " : "Open order "}</span>
              {order.name}
            </button>
            <KindMark order={order} />
            <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-2">{now > 0 ? formatDay(order.createdAt, now) : ""}</span>
          </div>
          <div className="mt-1">
            <CustomerLine order={order} />
          </div>
          <div className="mt-0.5">
            <ItemsLine order={order} />
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <div className="relative z-10 flex min-w-0 flex-col items-start">
              <RowStatus order={order} statuses={statuses} role={role} busy={savingIds.has(order.id)} onChangeStatus={onChangeStatus} />
              <RowError message={rowErrors[order.id]} />
            </div>
            <Total order={order} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// One list, never both.
export function OrderList({ layout, ...props }: ListProps & { layout: "table" | "cards" }) {
  return layout === "table" ? <OrderTable {...props} /> : <OrderCards {...props} />;
}
```

3d. Replace `src/components/desk/toolbar.tsx` with:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { FunnelSimpleIcon } from "@phosphor-icons/react/FunnelSimple";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/X";
import type { DeskKind, SortKey, StatusChip } from "@/lib/desk-state";
import { Segmented, type SegmentedOption } from "@/components/kit";
import { ui } from "@/components/ui";

// The desk's filters (comprehensive desk design section 1): one row from
// 880px (status, kind, search, sort); on phones one row with the status, a
// search button and a filter button, whose rows open beneath it.

const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "total", label: "Highest total" },
];

export type KindFilter = {
  kind: DeskKind;
  onKind: (kind: DeskKind) => void;
  draftCount: number;
  deletedCount: number;
};

export type ToolbarProps = {
  layout: "row" | "phone";
  statusKey: string | null;
  onStatus: (statusKey: string | null) => void;
  statusChips: StatusChip[];
  query: string;
  onQuery: (query: string) => void;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  // The requests and orders filter, when the workspace has requests.
  kindFilter: KindFilter | null;
  // How many cards the list shows now (announced politely).
  shown: number;
};

const ALL = "";

function NativeSelect({
  id,
  label,
  value,
  onChange,
  className = "",
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`relative ${className}`.trim()}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${ui.input} cursor-pointer appearance-none truncate pr-9 font-medium`}
      >
        {children}
      </select>
      <CaretDownIcon size={12} aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-2" />
    </div>
  );
}

function StatusFilter({
  statusKey,
  onStatus,
  chips,
  className,
}: {
  statusKey: string | null;
  onStatus: (statusKey: string | null) => void;
  chips: StatusChip[];
  className?: string;
}) {
  return (
    <NativeSelect
      id="desk-status"
      label="Filter by status"
      value={statusKey ?? ALL}
      onChange={(value) => onStatus(value === ALL ? null : value)}
      className={className}
    >
      <option value={ALL}>All statuses</option>
      {chips.map((chip) => (
        <option key={chip.key} value={chip.key}>
          {`${chip.known ? chip.label : `Unknown: ${chip.key}`} (${chip.count.toLocaleString("en-US")})`}
        </option>
      ))}
    </NativeSelect>
  );
}

function SortSelect({ sort, onSort, className }: { sort: SortKey; onSort: (sort: SortKey) => void; className?: string }) {
  return (
    <NativeSelect id="desk-sort" label="Sort orders" value={sort} onChange={(value) => onSort(value as SortKey)} className={className}>
      {SORTS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </NativeSelect>
  );
}

function kindOptions(filter: KindFilter): SegmentedOption<DeskKind>[] {
  return [
    { value: "all", label: "All" },
    { value: "drafts", label: "Drafts", count: filter.draftCount },
    { value: "orders", label: "Orders" },
    ...(filter.deletedCount > 0 ? [{ value: "deleted" as const, label: "Deleted", count: filter.deletedCount }] : []),
  ];
}

function KindSegments({ filter, className }: { filter: KindFilter; className?: string }) {
  return (
    <Segmented
      name="desk-kind"
      legend="Show requests and orders"
      value={filter.kind}
      options={kindOptions(filter)}
      onChange={filter.onKind}
      className={className}
    />
  );
}

function SearchField({
  query,
  onQuery,
  hasRequests,
  inputRef,
  className = "",
}: {
  query: string;
  onQuery: (query: string) => void;
  hasRequests: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`.trim()}>
      <label htmlFor="desk-search" className="sr-only">
        Search orders
      </label>
      <MagnifyingGlassIcon size={16} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
      <input
        ref={inputRef}
        id="desk-search"
        type="search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder={hasRequests ? "Search order, request, name or item" : "Search order, customer, email or item"}
        autoComplete="off"
        spellCheck={false}
        className={`${ui.input} pl-10`}
      />
    </div>
  );
}

function ShownCount({ shown }: { shown: number }) {
  return (
    <p className="sr-only" aria-live="polite">
      {`${shown.toLocaleString("en-US")} ${shown === 1 ? "card" : "cards"} shown`}
    </p>
  );
}

function RowToolbar({ statusKey, onStatus, statusChips, query, onQuery, sort, onSort, kindFilter, shown }: ToolbarProps) {
  return (
    // Wraps to a second line only between 880px and about 1280px; one row
    // at 1440.
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-2">
      <StatusFilter statusKey={statusKey} onStatus={onStatus} chips={statusChips} className="w-52 shrink-0" />
      {kindFilter ? <KindSegments filter={kindFilter} className="shrink-0" /> : null}
      <SearchField query={query} onQuery={onQuery} hasRequests={kindFilter !== null} className="min-w-40 max-w-md flex-1" />
      <SortSelect sort={sort} onSort={onSort} className="ml-auto w-44 shrink-0" />
      <ShownCount shown={shown} />
    </div>
  );
}

function PhoneToolbar({ statusKey, onStatus, statusChips, query, onQuery, sort, onSort, kindFilter, shown }: ToolbarProps) {
  const [searching, setSearching] = useState(query.length > 0);
  const [filtering, setFiltering] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Focus the search only when the person opened it (not on a page that
  // loads with a search in its address).
  const focusSearch = useRef(false);
  useEffect(() => {
    if (searching && focusSearch.current) {
      focusSearch.current = false;
      searchRef.current?.focus();
    }
  }, [searching]);
  const active = (kindFilter && kindFilter.kind !== "all" ? 1 : 0) + (sort !== "newest" ? 1 : 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <StatusFilter statusKey={statusKey} onStatus={onStatus} chips={statusChips} className="min-w-0 flex-1" />
        <button
          type="button"
          aria-expanded={searching}
          aria-controls="desk-search-row"
          onClick={() => {
            focusSearch.current = !searching;
            setSearching((current) => !current);
          }}
          className={`${ui.iconButton} border border-line-strong`}
        >
          <MagnifyingGlassIcon size={18} aria-hidden />
          <span className="sr-only">Search</span>
        </button>
        <button
          type="button"
          aria-expanded={filtering}
          aria-controls="desk-filter-row"
          onClick={() => setFiltering((current) => !current)}
          className={`${ui.iconButton} relative border border-line-strong`}
        >
          <FunnelSimpleIcon size={18} aria-hidden />
          <span className="sr-only">{active > 0 ? `More filters, ${active} on` : "More filters"}</span>
          {active > 0 ? (
            <span
              aria-hidden
              className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-control bg-primary px-1 text-xs font-semibold tabular-nums text-primary-ink"
            >
              {active}
            </span>
          ) : null}
        </button>
      </div>
      {searching ? (
        <div id="desk-search-row" className="flex items-center gap-2">
          <SearchField query={query} onQuery={onQuery} hasRequests={kindFilter !== null} inputRef={searchRef} className="min-w-0 flex-1" />
          {query ? (
            <button type="button" onClick={() => onQuery("")} className={ui.iconButton}>
              <XIcon size={18} aria-hidden />
              <span className="sr-only">Clear the search</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {filtering ? (
        <div id="desk-filter-row" className="flex flex-col gap-2">
          {kindFilter ? <KindSegments filter={kindFilter} /> : null}
          <SortSelect sort={sort} onSort={onSort} className="w-full" />
        </div>
      ) : null}
      <ShownCount shown={shown} />
    </div>
  );
}

export function Toolbar(props: ToolbarProps) {
  return props.layout === "row" ? <RowToolbar {...props} /> : <PhoneToolbar {...props} />;
}
```

3e. Replace `src/components/desk/desk-skeleton.tsx` with (Bar's base class sets `block`, so wide-only bars use `max-desk:hidden`, never `hidden desk:block`):

```tsx
// Loading placeholders shaped like the real desk: the toolbar row, then
// 44px table rows (880px and up) or compact cards (below).

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`od-skeleton block ${className}`} />;
}

export function DeskSkeleton() {
  return (
    <div role="status" aria-label="Loading orders" className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Bar className="h-10 flex-1 desk:w-52 desk:flex-none" />
        <Bar className="h-10 w-10 desk:hidden" />
        <Bar className="h-10 w-10 desk:hidden" />
        <Bar className="h-10 w-72 max-desk:hidden" />
        <Bar className="h-10 w-44 max-desk:hidden desk:ml-auto" />
      </div>

      <div className="hidden overflow-hidden rounded-panel border border-line bg-surface desk:block">
        <div className="flex h-9 items-center gap-6 px-4">
          {["w-12", "w-10", "w-16", "w-12"].map((width, i) => (
            <Bar key={i} className={`h-3 ${width}`} />
          ))}
        </div>
        {ROWS.map((row) => (
          <div key={row} className="grid h-11 grid-cols-[10rem_6.5rem_24%_1fr_7rem_11rem] items-center border-t border-line">
            <div className="px-4">
              <Bar className="h-4 w-20" />
            </div>
            <div className="px-3">
              <Bar className="h-3.5 w-14" />
            </div>
            <div className="px-3">
              <Bar className="h-3.5 w-40" />
            </div>
            <div className="px-3">
              <Bar className="h-3.5 w-11/12" />
            </div>
            <div className="flex justify-end px-3">
              <Bar className="h-3.5 w-14" />
            </div>
            <div className="px-4">
              <Bar className="h-8 w-28" />
            </div>
          </div>
        ))}
      </div>

      <ul className="flex flex-col gap-2 desk:hidden">
        {ROWS.slice(0, 5).map((row) => (
          <li key={row} className="rounded-panel border border-line bg-surface px-3.5 py-3">
            <div className="flex justify-between">
              <Bar className="h-4 w-20" />
              <Bar className="h-3.5 w-12" />
            </div>
            <Bar className="mt-2 h-3.5 w-48" />
            <Bar className="mt-1.5 h-3.5 w-56" />
            <Bar className="mt-3 h-8 w-28" />
          </li>
        ))}
      </ul>
      <span className="sr-only">Loading orders</span>
    </div>
  );
}
```

3f. `src/components/desk/desk.tsx`:
- Imports: replace `import { OrderCards, OrderTable } from "./order-list";` with `import { OrderList } from "./order-list";`, delete `import { StatusStrip } from "./status-strip";`, and add `import { DESK_MEDIA, useMediaQuery } from "@/lib/use-media-query";` and `import { useNow } from "@/lib/use-now";`.
- At the top of `Desk()` add `const isDesk = useMediaQuery(DESK_MEDIA);` and `const now = useNow(60000);`.
- Replace the JSX from `<main ...>` down to (and including) the `hasMore` paragraph's closing `) : null}` and the `</>` / `)` / `) : null}` that close the ready branch with:

```tsx
  const showToolbar = load.status === "ready" && !(total === 0 && desk.orders.length === 0);

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-4 sm:px-6 sm:py-5">
      {/* Phones: one sticky bar under the 56px top bar (z-20, below the
          top bar's z-30 and the drawer's z-40), on the page background so
          cards scroll under it. From 880px it is an ordinary row. */}
      <div className="flex flex-col gap-2 max-desk:sticky max-desk:top-14 max-desk:z-20 max-desk:-mx-4 max-desk:bg-bg max-desk:px-4 max-desk:py-2 desk:min-h-12 desk:flex-row desk:items-center desk:gap-4">
        <h1
          id="desk-heading"
          tabIndex={-1}
          className="sr-only font-display text-xl font-semibold tracking-tight focus:outline-none desk:not-sr-only desk:shrink-0"
        >
          Orders
        </h1>
        {showToolbar ? (
          <Toolbar
            layout={isDesk ? "row" : "phone"}
            statusKey={filter.statusKey}
            onStatus={(statusKey) => setFilter((current) => ({ ...current, statusKey }))}
            statusChips={chips}
            query={filter.query}
            onQuery={(query) => setFilter((current) => ({ ...current, query }))}
            sort={filter.sort}
            onSort={(sort) => setFilter((current) => ({ ...current, sort }))}
            kindFilter={
              showKindFilter
                ? {
                    kind: filter.kind ?? "all",
                    onKind: (kind: DeskKind) => setFilter((current) => ({ ...current, kind })),
                    draftCount: drafts.draftCount,
                    deletedCount: drafts.deletedDraftCount,
                  }
                : null
            }
            shown={visible.length}
          />
        ) : null}
      </div>

      {showBanner ? (
        <DraftsBanner
          settingsHref={`${workspace.basePath}/settings#store`}
          onDismiss={() => {
            dismissBanner(workspace.id);
            setBannerHidden(true);
          }}
        />
      ) : null}

      {load.status === "loading" ? <DeskSkeleton /> : null}

      {load.status === "error" ? (
        <DeskLoadError
          message={load.message}
          onRetry={() => {
            setLoad({ status: "loading" });
            void reload();
          }}
        />
      ) : null}

      {load.status === "ready" ? (
        total === 0 && desk.orders.length === 0 ? (
          <EmptyDesk basePath={workspace.basePath} canConnect={roleAtLeast(role, "platform")} />
        ) : (
          <>
            {visible.length === 0 ? (
              <NoMatches
                query={filter.query}
                kind={filter.kind ?? "all"}
                statusLabel={
                  filter.statusKey === null
                    ? null
                    : (chips.find((chip) => chip.key === filter.statusKey)?.label ?? "this status")
                }
                onClear={() => setFilter((current) => ({ ...current, query: "", statusKey: null, kind: "all" }))}
              />
            ) : (
              <OrderList
                layout={isDesk ? "table" : "cards"}
                orders={visible}
                statuses={statuses}
                role={role}
                flashing={flashing}
                rowErrors={rowErrors}
                savingIds={savingIds}
                now={now}
                onOpen={openOrder}
                onChangeStatus={changeStatus}
              />
            )}
            {hasMore ? (
              <p className="text-xs text-ink-2">
                Showing the newest 1,000 orders. Older orders are still in Shopify, and the counts above include them.
              </p>
            ) : null}
          </>
        )
      ) : null}
```

(The drawer and PO modal below stay as they are.)
- Delete the file: `git rm src/components/desk/status-strip.tsx`.

**Step 4: Run them and see them pass**

Run: `npx vitest run src/lib/format.test.ts src/lib/use-media-query.test.ts src/components/desk/order-list.test.ts src/components/desk/toolbar.test.ts`
Expected: PASS. Then `npm run test`.

Local visual check (`npm run dev`, local sample data from `scripts/seed-local.sql` if your local D1 is empty): at 1440x900 count the rows above the fold (15 to 18), one toolbar row, no wrapping; resize below 880px: the table disappears from the DOM (inspect: one `<ul>`, no `<table>`); at 375x812 the phone row shows status, search and filter buttons and stays pinned under the top bar while the cards scroll beneath it (design: "Phone: one sticky bar"); light and dark.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/format.ts src/lib/format.test.ts src/lib/use-media-query.ts src/lib/use-media-query.test.ts src/components/desk/order-list.tsx src/components/desk/order-list.test.ts src/components/desk/toolbar.tsx src/components/desk/toolbar.test.ts src/components/desk/desk-skeleton.tsx src/components/desk/desk.tsx src/components/desk/status-strip.tsx"
git add src/lib/format.ts src/lib/format.test.ts src/lib/use-media-query.ts src/lib/use-media-query.test.ts src/components/desk/order-list.tsx src/components/desk/order-list.test.ts src/components/desk/toolbar.tsx src/components/desk/toolbar.test.ts src/components/desk/desk-skeleton.tsx src/components/desk/desk.tsx
git commit -m "feat: dense desk (one list per breakpoint, 44px rows, compact cards, one toolbar row)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 11: Honest state (sync staleness, error and loading screens, themed not-found)

The sync chip turns amber after 30 minutes and red after 3 hours, with a tip ("Synced 17 h ago" no longer looks healthy). Error, global error and Settings loading screens in the workspace look; the not-found page wears the workspace's theme on a client host. @design-taste-frontend

**Files:**
- Modify: `src/lib/sync-status.ts` (whole file, 1-66)
- Modify: `src/components/shell/top-bar.tsx` (`SyncChip`, `WorkspaceAccount` from Task 9)
- Create: `src/components/error-screen.tsx`, `src/app/error.tsx`, `src/app/global-error.tsx`, `src/app/w/[slug]/error.tsx`, `src/components/settings/settings-skeleton.tsx`, `src/app/w/[slug]/settings/loading.tsx`, `src/app/settings/loading.tsx`
- Modify: `src/app/not-found.tsx` (whole file, 1-19)
- Test: `src/lib/sync-status.test.ts`, `src/components/shell/top-bar.test.ts`, `src/app/error-pages.test.ts` (new), `src/app/not-found.test.ts` (new)

**Step 1: Write the failing tests**

Append to `src/lib/sync-status.test.ts` inside the describe:

```ts
  // Comprehensive desk design section 1: an old sync must not look healthy.
  it("turns amber after 30 minutes and red after 3 hours, with a tip", () => {
    const at = (minutesAgo: number) =>
      syncChipState({ status: "ready", connection: connection({ lastSyncAt: NOW - minutesAgo * 60000 }) }, NOW);
    expect(at(29)).toMatchObject({ tone: "good", label: "Synced 29 min ago", tip: null });
    const late = at(30);
    expect(late).toMatchObject({ tone: "warn", label: "Synced 30 min ago", detail: null });
    expect(late.kind === "ready" ? late.tip : "").toContain("Press Sync");
    const old = at(17 * 60);
    expect(old).toMatchObject({ tone: "bad", label: "Synced 17 h ago", detail: null });
    expect(old.kind === "ready" ? old.tip : "").toContain("check the store connection");
  });
```

Append to `src/components/shell/top-bar.test.ts`:

```ts
describe("TopBar sync chip on phones", () => {
  it("shows a stale sync at every width, with its tip", () => {
    state.value = {
      ...state.value,
      sync: {
        status: "ready",
        connection: {
          shopDomain: "x.myshopify.com",
          adminShopDomain: "x.myshopify.com",
          status: "ok",
          lastSyncAt: Date.now() - 5 * 3600000,
          lastError: null,
          catchingUp: false,
        },
      },
    };
    const html = render();
    const chip = classOf(html, /<span data-tone="red" title="([^"]+)"/);
    expect(chip).toContain("check the store connection");
    expect(classOf(html, /<span data-tone="red" title="[^"]+" class="([^"]*)"/).split(" ")[0]).toBe("inline-flex");
  });
});
```

Create `src/app/error-pages.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "impact" }) }));

const { default: AppError } = await import("./error");
const { default: GlobalError } = await import("./global-error");
const { default: WorkspaceError } = await import("./w/[slug]/error");
const { default: SettingsLoading } = await import("./w/[slug]/settings/loading");
const { default: ClientSettingsLoading } = await import("./settings/loading");

const failure = Object.assign(new Error("database exploded"), { digest: "d1g3st" });

describe("error and loading screens", () => {
  it("say what happened, offer Try again and a way out, and never show the error text", () => {
    const html = renderToStaticMarkup(createElement(AppError, { error: failure, retry: () => {} }));
    expect(html).toContain("Something went wrong");
    expect(html).toContain(">Try again</button>");
    expect(html).toContain('href="/"');
    expect(html).toContain("d1g3st");
    expect(html).not.toContain("database exploded");
  });

  it("keep a failed workspace screen inside the workspace, with a way back to its orders", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceError, { error: failure, retry: () => {} }));
    expect(html).toContain("This screen did not load");
    expect(html).toContain('href="/w/impact"');
  });

  it("render their own document when the root layout fails", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: failure, retry: () => {} }));
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Something went wrong");
  });

  it("show a Settings placeholder while Settings loads, on the hub and on a client host", () => {
    for (const Loading of [SettingsLoading, ClientSettingsLoading]) {
      expect(renderToStaticMarkup(createElement(Loading))).toContain('aria-label="Loading settings"');
    }
  });
});
```

Create `src/app/not-found.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; host: string } = { db: null, host: "orderingdesk.test" };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test" }, ctx: {} }),
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { default: NotFound } = await import("./not-found");
const CLIENT_HOST = "orders.impactrentals.store";

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.test";
  await seedWorkspace(db, "ws_impact");
  await db
    .update(schema.workspaces)
    .set({ name: "Impact Rentals", customDomain: CLIENT_HOST, customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
});

describe("the not-found page", () => {
  it("keeps the Ordering Desk look on the hub", async () => {
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toContain("Ordering Desk");
    expect(html).toContain("Go to your workspaces");
  });

  it("wears the workspace's theme and name on its client host, with a way back to its orders", async () => {
    state.host = CLIENT_HOST;
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toContain("data-brand-scope");
    expect(html).toContain("Go to Impact Rentals orders");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Go to your workspaces");
  });
});
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/sync-status.test.ts src/components/shell/top-bar.test.ts src/app/error-pages.test.ts src/app/not-found.test.ts`
Expected: FAIL: the 30 minute case is still `good` and there is no `tip`; the stale chip is `hidden` below sm and green; `Failed to resolve import "./error"`; the client host not-found shows "Go to your workspaces".

**Step 3: Minimal implementation**

3a. Replace `src/lib/sync-status.ts` with:

```ts
// What the top bar's sync chip says, from GET /api/workspaces/[id]/sync.
// Pure so every state is tested; the chip, the account menu and the problem
// banner all read it.

import type { SyncConnectionView } from "@/server/desk/sync";
import { relativeTime } from "./format";

export type SyncLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; connection: SyncConnectionView | null };

export type ChipTone = "good" | "warn" | "bad" | "info" | "neutral";

export type SyncChipState =
  | { kind: "loading" }
  | {
      kind: "ready";
      tone: ChipTone;
      label: string;
      // Problem text for the banner under the top bar (the last error).
      detail: string | null;
      // What to do about a late sync (the chip's tooltip, the account menu).
      tip: string | null;
    };

// The automatic sync runs every 10 minutes: half an hour without one is
// late, three hours means orders may be missing (comprehensive desk design
// section 1).
export const SYNC_LATE_MS = 30 * 60 * 1000;
export const SYNC_STALE_MS = 3 * 60 * 60 * 1000;

const LATE_TIP = "The automatic sync runs every 10 minutes and is late. Press Sync to fetch new orders now.";
const STALE_TIP =
  "Orders may be missing: the automatic sync has not finished for hours. Press Sync, and if it fails, check the store connection in Settings.";

// Status tone names in globals.css for each chip tone.
export const CHIP_TONE_COLOR: Record<ChipTone, string> = {
  good: "green",
  warn: "amber",
  bad: "red",
  info: "blue",
  neutral: "slate",
};

function ready(tone: ChipTone, label: string, detail: string | null = null, tip: string | null = null): SyncChipState {
  return { kind: "ready", tone, label, detail, tip };
}

export function syncChipState(state: SyncLoadState, now: number): SyncChipState {
  if (state.status === "loading") {
    return { kind: "loading" };
  }
  if (state.status === "error") {
    return ready("warn", "Sync status unavailable");
  }
  const connection = state.connection;
  if (!connection) {
    return ready("neutral", "Store not connected");
  }
  if (connection.status === "disabled") {
    return ready("neutral", "Sync paused");
  }
  if (connection.status === "error") {
    return ready("bad", "Sync error", connection.lastError);
  }
  if (connection.lastError) {
    return ready("warn", "Last sync failed", connection.lastError);
  }
  if (connection.catchingUp) {
    return ready("info", "Catching up");
  }
  if (connection.lastSyncAt === 0) {
    return ready("neutral", "Not synced yet");
  }
  const label = `Synced ${relativeTime(connection.lastSyncAt, now)}`;
  const elapsed = now - connection.lastSyncAt;
  if (elapsed >= SYNC_STALE_MS) {
    return ready("bad", label, null, STALE_TIP);
  }
  if (elapsed >= SYNC_LATE_MS) {
    return ready("warn", label, null, LATE_TIP);
  }
  return ready("good", label);
}
```

3b. `src/components/shell/top-bar.tsx`. Replace `SyncChip`'s returned span with (a quiet state stays hidden on phones; a problem shows at every width as its icon):

```tsx
  const quiet = state.tone === "good" || state.tone === "neutral" || state.tone === "info";
  return (
    <span
      data-tone={CHIP_TONE_COLOR[state.tone]}
      title={state.tip ?? LIVE_TEXT[liveStatus]}
      className={`${quiet ? "hidden sm:inline-flex" : "inline-flex"} h-8 shrink-0 items-center gap-1.5 rounded-control bg-tone-fill px-2.5 text-xs font-semibold text-tone-text sm:px-3`}
    >
      {chipIcon(state.tone, state.label)}
      <span className="sr-only sm:not-sr-only">{state.label}</span>
      {state.tip ? <span className="sr-only">. {state.tip}</span> : null}
      <span className="sr-only">. {LIVE_TEXT[liveStatus]}.</span>
    </span>
  );
```

and in `WorkspaceAccount` pass the tip: `tip: state.tip`.

3c. Create `src/components/error-screen.tsx`:

```tsx
"use client";

import Link from "next/link";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { ui } from "@/components/ui";

// What a screen that failed to render says (the error.tsx files): plainly
// that it did not load, Try again, and a way out. Never the error's own
// text; the digest lets the operator find the server log line.
export function ErrorScreen({
  title,
  onRetry,
  homeHref,
  homeLabel,
  digest,
}: {
  title: string;
  onRetry: () => void;
  homeHref: string;
  homeLabel: string;
  digest?: string;
}) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col items-start gap-4 px-4 py-16 sm:px-6">
      <span className="grid size-12 place-items-center rounded-control bg-surface-2 text-ink-2">
        <WarningCircleIcon size={24} aria-hidden />
      </span>
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      <p className="text-sm text-ink-2">
        {digest
          ? `Try again. If it keeps happening, tell your platform admin the code ${digest}.`
          : "Try again. If it keeps happening, tell your platform admin."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className={ui.buttonPrimary}>
          Try again
        </button>
        <Link href={homeHref} className={ui.buttonSecondary}>
          {homeLabel}
        </Link>
      </div>
    </main>
  );
}
```

3d. Create `src/app/error.tsx` (Next 16 passes `retry`, which re-fetches and re-renders the segment):

```tsx
"use client";

import { ErrorScreen } from "@/components/error-screen";

// A page outside a workspace that failed (the hub, a client host's desk).
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorScreen title="Something went wrong" onRetry={retry} homeHref="/" homeLabel="Go to the start page" digest={error.digest} />;
}
```

Create `src/app/w/[slug]/error.tsx`:

```tsx
"use client";

import { useParams } from "next/navigation";
import { ErrorScreen } from "@/components/error-screen";

// A desk or Settings screen that failed, inside the workspace shell (the
// layout above keeps rendering, so the top bar and account menu stay). No
// workspace data here, so no guard: the layout already ran it.
export default function WorkspaceError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  return (
    <ErrorScreen
      title="This screen did not load"
      onRetry={retry}
      homeHref={slug ? `/w/${encodeURIComponent(slug)}` : "/"}
      homeLabel="Back to orders"
      digest={error.digest}
    />
  );
}
```

Create `src/app/global-error.tsx`:

```tsx
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
```

3e. Create `src/components/settings/settings-skeleton.tsx`:

```tsx
// Loading placeholders shaped like Settings: the back link and title, the
// section list, then two panels. The loading.tsx files show it while a
// Settings page renders on the server.

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`od-skeleton block ${className}`} />;
}

export function SettingsSkeleton() {
  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-5 sm:px-6 sm:pt-7">
      <div role="status" aria-label="Loading settings">
        <Bar className="h-9 w-24" />
        <Bar className="mt-2 h-8 w-40" />
        <Bar className="mt-2 h-4 w-72 max-w-full" />
        <div className="mt-6 grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
          <div className="flex gap-2 overflow-hidden lg:flex-col">
            {["w-32", "w-28", "w-20", "w-24", "w-20"].map((width, i) => (
              <Bar key={i} className={`h-9 shrink-0 ${width}`} />
            ))}
          </div>
          <div className="flex min-w-0 max-w-5xl flex-col gap-12">
            {[0, 1].map((section) => (
              <div key={section} className="flex flex-col gap-4">
                <Bar className="h-6 w-48" />
                <Bar className="h-4 w-96 max-w-full" />
                <div className="rounded-panel border border-line bg-surface p-5">
                  <Bar className="h-4 w-3/4" />
                  <Bar className="mt-3 h-10 w-full" />
                  <Bar className="mt-3 h-10 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <span className="sr-only">Loading settings</span>
      </div>
    </main>
  );
}
```

Create `src/app/w/[slug]/settings/loading.tsx` and `src/app/settings/loading.tsx`, both:

```tsx
import { SettingsSkeleton } from "@/components/settings/settings-skeleton";

// Settings renders on the server (it reads the session); this shows while
// it does. It reads no data, so it needs no guard (the page runs it).
export default function Loading() {
  return <SettingsSkeleton />;
}
```

3f. Replace `src/app/not-found.tsx` with:

```tsx
import Link from "next/link";
import { headers } from "next/headers";
import { APP_NAME } from "@/lib/brand";
import { signInView } from "@/server/client-host";
import { requestHost } from "@/server/request-host";
import { Monogram } from "@/components/kit";
import { BrandScope } from "@/components/shell/brand-scope";
import { ThemedImage } from "@/components/shell/workspace-brand-slot";
import { ui } from "@/components/ui";

// Not found, by host (src/server/client-host.ts): the hub keeps the
// Ordering Desk page; a workspace's client host shows it in the workspace's
// theme with its name and a way back to its orders.
export default async function NotFound() {
  // Read the request first: it marks this page dynamic before anything
  // touches the Cloudflare context (there is none at build time).
  await headers();
  const view = signInView(await requestHost());
  if (view.kind !== "workspace") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 sm:px-6">
        <p className="text-sm font-medium text-ink-2">{APP_NAME}</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">This page is not here</h1>
        <p className="text-sm text-ink-2">
          The link may be old or mistyped. If it is for a workspace you expected to open, ask your manager to invite
          you.
        </p>
        <Link href="/" className={`${ui.buttonSecondary} self-start`}>
          Go to your workspaces
        </Link>
      </main>
    );
  }
  return (
    <BrandScope branding={view.branding} accentColor={view.accent} className="min-h-dvh bg-bg font-sans text-ink">
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 sm:px-6">
        {view.symbol ? (
          <span role="img" aria-label={view.name} className="flex size-10">
            <ThemedImage paths={view.symbol} className="size-10 object-contain" />
          </span>
        ) : (
          <Monogram text={view.name.trim().charAt(0).toUpperCase() || "W"} size="lg" />
        )}
        <p className="text-sm font-medium text-ink-2">{view.name}</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">This page is not here</h1>
        <p className="text-sm text-ink-2">The link may be old or mistyped.</p>
        <Link href="/" className={`${ui.buttonSecondary} self-start`}>
          {`Go to ${view.name} orders`}
        </Link>
      </main>
    </BrandScope>
  );
}
```

**Step 4: Run them and see them pass**

Run: `npx vitest run src/lib/sync-status.test.ts src/components/shell/top-bar.test.ts src/app/error-pages.test.ts src/app/not-found.test.ts`
Expected: PASS.

Local visual check: set a local connection's `last_sync_at` five hours back (`npx wrangler d1 execute orderingdesk --local --command "UPDATE store_connections SET last_sync_at = (strftime('%s','now') - 18000) * 1000"`), reload the desk: red chip with the tip on hover at 1440, the red icon in the bar at 375 and the tip under Sync now in the account menu. Throw from a page temporarily (do not commit) to see the error screen inside the shell. Visit `/nope` on the hub and on a local client host (see "Attaching a client host" in HANDOFF for the local setup).

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/sync-status.ts src/lib/sync-status.test.ts src/components/shell/top-bar.tsx src/components/shell/top-bar.test.ts src/components/error-screen.tsx src/app/error.tsx src/app/global-error.tsx src/app/w/[slug]/error.tsx src/components/settings/settings-skeleton.tsx src/app/w/[slug]/settings/loading.tsx src/app/settings/loading.tsx src/app/not-found.tsx src/app/error-pages.test.ts src/app/not-found.test.ts"
git add $FILES
git commit -m "feat: honest state (stale sync chip, error and loading screens, themed not-found)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 12: Open by default (server views, counts, view switcher)

The desk opens on Open with its count; Needs approval (managers), All and Closed are one click away. The server owns the default view: one pure parser (`src/lib/desk-query.ts`) that the orders API uses (no view means Open) and the desk reads. The desk loads one view at a time; a card that moves into a closed status leaves Open at once. The URL contract's sort set (newest, oldest, waiting) lands here too: Highest total becomes Waiting longest. @design-taste-frontend

**Files:**
- Create: `src/lib/desk-query.ts`
- Modify: `src/server/desk/read.ts` (imports 5-19, `DeskPayload` 81-95, `loadDesk` 151-234; add `countNeedsApproval`)
- Modify: `src/app/api/workspaces/[id]/orders/route.ts` (whole file, 1-34)
- Modify: `src/lib/desk-state.ts` (types 265-271, `selectOrders` 321-357; add `viewMatches`, `shiftViewCounts`, `crossesClosed`, `chipsForView`)
- Modify: `src/components/desk/toolbar.tsx` (from Task 10: `SORTS`, `ToolbarProps`, `RowToolbar`, `PhoneToolbar`)
- Modify: `src/components/desk/empty-states.tsx` (`noMatchesCopy` 43-68, `NoMatches` 70-103)
- Modify: `src/components/desk/desk.tsx` (imports, `DeskPayload` 43-51, state 132-168, `fetchDesk` 195-241, `changeStatus` 412-484, `applyEvent` 380-395, derived values 627-635, render from Task 10)
- Test: `src/lib/desk-query.test.ts` (new), `src/server/desk/read.test.ts`, `src/app/api/workspaces/[id]/orders/route.test.ts` (new), `src/lib/desk-state.test.ts`, `src/components/desk/toolbar.test.ts`, `src/components/desk/empty-states.test.ts`

**Step 1: Write the failing tests**

Create `src/lib/desk-query.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deskSearch, parseDeskQuery } from "./desk-query";

describe("parseDeskQuery", () => {
  it("opens on Open, newest first, with nothing else filtered", () => {
    expect(parseDeskQuery(new URLSearchParams(""))).toEqual({ view: "open", status: null, kind: "all", q: "", sort: "newest" });
  });

  it("reads every parameter, from a URL or from a searchParams object", () => {
    expect(parseDeskQuery(new URLSearchParams("view=closed&status=on_hold&kind=drafts&q=vest&sort=oldest"))).toEqual({
      view: "closed",
      status: "on_hold",
      kind: "drafts",
      q: "vest",
      sort: "oldest",
    });
    expect(parseDeskQuery({ view: ["all", "closed"], q: "hard hat" })).toMatchObject({ view: "all", q: "hard hat" });
  });

  it("sorts the approval queue by waiting longest unless told otherwise", () => {
    expect(parseDeskQuery(new URLSearchParams("view=approval")).sort).toBe("waiting");
    expect(parseDeskQuery(new URLSearchParams("view=approval&sort=newest")).sort).toBe("newest");
  });

  it("falls back to the defaults for anything it does not know", () => {
    expect(parseDeskQuery(new URLSearchParams("view=everything&status=New Status!&kind=x&sort=total"))).toEqual({
      view: "open",
      status: null,
      kind: "all",
      q: "",
      sort: "newest",
    });
    expect(parseDeskQuery(new URLSearchParams(`q=${"a".repeat(300)}`)).q).toHaveLength(200);
  });
});

describe("deskSearch", () => {
  it("leaves the defaults out and keeps the open order", () => {
    expect(deskSearch(parseDeskQuery(new URLSearchParams("")))).toBe("");
    expect(deskSearch({ view: "approval", status: null, kind: "all", q: "", sort: "waiting" }, "d12")).toBe("?view=approval&order=d12");
    expect(deskSearch({ view: "open", status: "new", kind: "drafts", q: "hard hat", sort: "oldest" })).toBe(
      "?status=new&kind=drafts&q=hard+hat&sort=oldest",
    );
  });
});
```

Append to `src/server/desk/read.test.ts` (add `and` to the drizzle import, `countNeedsApproval` to the `./read` import and `seedDraftStatuses` to the helpers import):

```ts
// Comprehensive desk design section 1: Open by default.
describe("loadDesk views", () => {
  async function seeded() {
    const db = await setup();
    await seedDraftStatuses(db, WS);
    await db.update(schema.statuses).set({ closed: true }).where(and(eq(schema.statuses.workspaceId, WS), eq(schema.statuses.key, "shipped")));
    // The other workspace closes "new" instead: only this workspace's flags count.
    await db.update(schema.statuses).set({ closed: true }).where(and(eq(schema.statuses.workspaceId, OTHER), eq(schema.statuses.key, "new")));
    await seedOrder(db, WS, { id: "o_new", statusKey: "new", createdAt: 6 });
    await seedOrder(db, WS, { id: "o_shipped", statusKey: "shipped", createdAt: 5 });
    await seedDraft(db, WS, { id: "d_wait", statusKey: "new", createdAt: 4 });
    await seedDraft(db, WS, { id: "d_rejected", statusKey: "rejected", createdAt: 3 });
    await seedDraft(db, WS, { id: "d_gone", statusKey: "new", createdAt: 2, draftDeletedAt: 10 });
    await seedOrder(db, WS, { id: "o_legacy", statusKey: "legacy_key", createdAt: 1 });
    return db;
  }

  it("loads one view at a time: closed statuses out of Open, waiting requests in the approval queue", async () => {
    const db = await seeded();
    const ids = async (view: "open" | "closed" | "approval" | "all") =>
      (await loadDesk(db, WS, { view }))?.orders.map((order) => order.id);
    expect(await ids("open")).toEqual(["o_new", "d_wait", "d_gone", "o_legacy"]);
    expect(await ids("closed")).toEqual(["o_shipped", "d_rejected"]);
    expect(await ids("approval")).toEqual(["d_wait"]);
    expect(await ids("all")).toHaveLength(6);
    // No view given: everything (the route always passes one).
    expect((await loadDesk(db, WS))?.orders).toHaveLength(6);
  });

  it("counts every view over all cards, leaving deleted requests out", async () => {
    const db = await seeded();
    expect((await loadDesk(db, WS, { view: "open" }))?.viewCounts).toEqual({ open: 3, approval: 1, all: 5, closed: 2 });
    expect(await countNeedsApproval(db, WS)).toBe(1);
    expect(await countNeedsApproval(db, OTHER)).toBe(0);
  });

  it("carries the work queue settings", async () => {
    const db = await seeded();
    expect((await loadDesk(db, WS))?.queue).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });
  });
});
```

Create `src/app/api/workspaces/[id]/orders/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test" }, ctx: { waitUntil: () => {} } }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { GET } = await import("./route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const get = (query = "") => new Request(`https://orderingdesk.test/api/workspaces/ws_impact/orders${query}`);

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await db
    .update(schema.statuses)
    .set({ closed: true })
    .where(and(eq(schema.statuses.workspaceId, "ws_impact"), eq(schema.statuses.key, "shipped")));
  await seedOrder(db, "ws_impact", { id: "o_new", statusKey: "new", createdAt: 2 });
  await seedOrder(db, "ws_impact", { id: "o_shipped", statusKey: "shipped", createdAt: 1 });
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("GET /api/workspaces/[id]/orders", () => {
  it("answers 401 signed out and 404 to a non-member", async () => {
    expect((await GET(get(), context)).status).toBe(401);
    state.session = { user: { id: "u_stranger", email: "stranger@example.com" } };
    expect((await GET(get(), context)).status).toBe(404);
  });

  it("opens on the Open view when no view is asked for, with every view's count and the queue settings", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const body = (await (await GET(get(), context)).json()) as {
      view: string;
      orders: { id: string }[];
      viewCounts: unknown;
      queue: unknown;
    };
    expect(body.view).toBe("open");
    expect(body.orders.map((order) => order.id)).toEqual(["o_new"]);
    expect(body.viewCounts).toEqual({ open: 1, approval: 0, all: 2, closed: 1 });
    expect(body.queue).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });
  });

  it("loads the view it is asked for, and Open for one it does not know", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const all = (await (await GET(get("?view=all"), context)).json()) as { orders: unknown[] };
    expect(all.orders).toHaveLength(2);
    const unknown = (await (await GET(get("?view=nope"), context)).json()) as { view: string };
    expect(unknown.view).toBe("open");
  });
});
```

Append to `src/lib/desk-state.test.ts` (import `chipsForView`, `crossesClosed`, `shiftViewCounts` from `./desk-state`), and in the existing "sorts newest, oldest and by total" test delete the `sort: "total"` line and rename it "sorts newest and oldest":

```ts
// Comprehensive desk design section 1: Open by default and the views.
describe("views", () => {
  const closed = new Set(["delivered", "rejected"]);
  const list = [
    order("o1", { statusKey: "new", createdAt: 5 }),
    order("o2", { statusKey: "delivered", createdAt: 4 }),
    order("d1", { kind: "draft", statusKey: "new", createdAt: 3 }),
    order("d2", { kind: "draft", statusKey: "rejected", createdAt: 2 }),
    order("d3", { kind: "draft", statusKey: "new", draftDeleted: true, createdAt: 1 }),
  ];
  const ids = (view: "open" | "closed" | "approval" | "all", kind: "all" | "deleted" = "all") =>
    selectOrders(list, { query: "", statusKey: null, sort: "newest", kind, view }, closed).map((row) => row.id);

  it("keeps closed cards out of Open, and puts waiting requests in the approval queue", () => {
    expect(ids("open")).toEqual(["o1", "d1"]);
    expect(ids("closed")).toEqual(["o2", "d2"]);
    expect(ids("approval")).toEqual(["d1"]);
    expect(ids("all")).toEqual(["o1", "o2", "d1", "d2"]);
    expect(ids("open", "deleted")).toEqual(["d3"]);
  });

  it("sorts by waiting longest: the oldest status change first, the arrival when none was set", () => {
    const waiting = [
      order("a", { statusSetAt: 300, createdAt: 1 }),
      order("b", { statusSetAt: null, createdAt: 100 }),
      order("c", { statusSetAt: 200, createdAt: 2 }),
    ];
    expect(selectOrders(waiting, { query: "", statusKey: null, sort: "waiting" }).map((row) => row.id)).toEqual(["b", "c", "a"]);
  });

  it("moves the view counts with a card that crosses between open and closed", () => {
    const counts = { open: 3, approval: 1, all: 5, closed: 2 };
    expect(shiftViewCounts(counts, { kind: "draft", draftDeleted: false }, "new", "rejected", closed)).toEqual({
      open: 2,
      approval: 0,
      all: 5,
      closed: 3,
    });
    expect(shiftViewCounts(counts, { kind: "order", draftDeleted: false }, "delivered", "new", closed)).toEqual({
      open: 4,
      approval: 1,
      all: 5,
      closed: 1,
    });
    expect(shiftViewCounts(counts, { kind: "order", draftDeleted: false }, "new", "processing", closed)).toBe(counts);
    expect(shiftViewCounts(counts, { kind: "draft", draftDeleted: true }, "new", "rejected", closed)).toBe(counts);
  });

  it("tells when a card it has not loaded crossed, from the status entry's own record", () => {
    expect(crossesClosed({ from: "new", to: "delivered" }, closed)).toBe(true);
    expect(crossesClosed({ from: "new", to: "processing" }, closed)).toBe(false);
    expect(crossesClosed(null, closed)).toBe(false);
  });

  it("offers the statuses that belong to the view in the status filter", () => {
    const chips = [
      { key: "new", label: "New", color: "lime", count: 2, known: true },
      { key: "delivered", label: "Delivered", color: "slate", count: 1, known: true },
      { key: "gone", label: "Unknown status", color: "slate", count: 1, known: false },
    ];
    expect(chipsForView(chips, "open", closed).map((chip) => chip.key)).toEqual(["new", "gone"]);
    expect(chipsForView(chips, "approval", closed).map((chip) => chip.key)).toEqual(["new", "gone"]);
    expect(chipsForView(chips, "closed", closed).map((chip) => chip.key)).toEqual(["delivered"]);
    expect(chipsForView(chips, "all", closed)).toHaveLength(3);
  });
});
```

In `src/components/desk/toolbar.test.ts` add to `base`: `view: "open", onView: () => {}, viewCounts: { open: 23, approval: 3, all: 35, closed: 12 }, showApproval: true,` and append:

```ts
describe("Toolbar views", () => {
  it("starts the row with the views and their counts, Needs approval only for those who approve", () => {
    const html = render();
    expect(html.indexOf('name="desk-view"')).toBeLessThan(html.indexOf('id="desk-status"'));
    expect(html).toMatch(/<input[^>]*name="desk-view"[^>]*value="open"[^>]*checked=""/);
    expect(html).toContain("Needs approval");
    expect(html).toContain(">35<");
    expect(render({ showApproval: false })).not.toContain("Needs approval");
  });

  it("puts the view first on phones, as one select with counts, and the status behind More filters", () => {
    const html = render({ layout: "phone" });
    expect(html).toContain(">Open (23)</option>");
    expect(html).toContain(">Needs approval (3)</option>");
    expect(html).not.toContain('id="desk-status"');
  });

  it("offers Waiting longest instead of Highest total", () => {
    const html = render();
    expect(html).toContain(">Waiting longest</option>");
    expect(html).not.toContain("Highest total");
  });
});
```

Also change the existing phone test's first expectations: the status select now lives behind More filters, so replace `expect(closed).toContain('id="desk-status"');` with `expect(closed).toContain('id="desk-view"');`.

Append to `src/components/desk/empty-states.test.ts` inside `describe("NoMatches", ...)` (extend `render`'s props type with `view?: "open" | "approval" | "all" | "closed"` and pass `view: props.view`):

```ts
  it("speaks of the view when nothing else filters it, with nothing to clear", () => {
    const open = render({ view: "open" });
    expect(open).toContain("Nothing open");
    expect(open).not.toContain(">Clear filters<");
    expect(render({ view: "approval" })).toContain("No requests need approval");
    expect(render({ view: "closed" })).toContain("Nothing closed yet");
    // A search in a view still says what matched nothing.
    expect(render({ view: "open", query: "vest" })).toContain("Nothing matches &quot;vest&quot;.");
  });
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/desk-query.test.ts src/server/desk/read.test.ts "src/app/api/workspaces/[id]/orders/route.test.ts" src/lib/desk-state.test.ts src/components/desk/toolbar.test.ts src/components/desk/empty-states.test.ts`
Expected: FAIL: `Failed to resolve import "./desk-query"`; `loadDesk` ignores the view and returns no `viewCounts` or `queue`; `countNeedsApproval` is not exported; the route has no `view`; `shiftViewCounts`, `crossesClosed` and `chipsForView` are not functions; the toolbar has no views; the empty state has no view copy.

**Step 3: Minimal implementation**

3a. Create `src/lib/desk-query.ts`:

```ts
// The desk's filters as URL parameters (comprehensive desk design section
// 1): view, status, kind, q and sort, so push and email links open the
// exact view. Pure and shared: the orders API reads the view with it (the
// server owns the default: Open), and the desk reads and writes its address
// with it. Unknown values fall back to the defaults.

export const DESK_VIEWS = ["open", "approval", "all", "closed"] as const;
export type DeskView = (typeof DESK_VIEWS)[number];

export const DESK_SORTS = ["newest", "oldest", "waiting"] as const;
export type SortKey = (typeof DESK_SORTS)[number];

// All: every card except requests whose draft Shopify deleted (they have
// their own filter, Deleted).
export const DESK_KINDS = ["all", "drafts", "orders", "deleted"] as const;
export type DeskKind = (typeof DESK_KINDS)[number];

// Cards per view over every card (the server counts them).
export type ViewCounts = { open: number; approval: number; all: number; closed: number };

export type DeskQuery = { view: DeskView; status: string | null; kind: DeskKind; q: string; sort: SortKey };

export const DESK_QUERY_MAX = 200;
const STATUS_KEY = /^[a-z0-9_]{1,64}$/;

type ParamSource = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function read(source: ParamSource, name: string): string | null {
  if (typeof (source as { get?: unknown }).get === "function") {
    return (source as { get(name: string): string | null }).get(name);
  }
  const value = (source as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

// Waiting longest first in the approval queue; newest first elsewhere.
export function defaultSort(view: DeskView): SortKey {
  return view === "approval" ? "waiting" : "newest";
}

export function parseDeskQuery(source: ParamSource): DeskQuery {
  const view = oneOf(read(source, "view"), DESK_VIEWS) ?? "open";
  const status = read(source, "status");
  return {
    view,
    status: status !== null && STATUS_KEY.test(status) ? status : null,
    kind: oneOf(read(source, "kind"), DESK_KINDS) ?? "all",
    q: (read(source, "q") ?? "").slice(0, DESK_QUERY_MAX),
    sort: oneOf(read(source, "sort"), DESK_SORTS) ?? defaultSort(view),
  };
}

// The address's query string for a desk query: defaults left out (the plain
// desk is just its path), the open order kept.
export function deskSearch(query: DeskQuery, order: string | null = null): string {
  const params = new URLSearchParams();
  if (query.view !== "open") {
    params.set("view", query.view);
  }
  if (query.status) {
    params.set("status", query.status);
  }
  if (query.kind !== "all") {
    params.set("kind", query.kind);
  }
  if (query.q.trim().length > 0) {
    params.set("q", query.q);
  }
  if (query.sort !== defaultSort(query.view)) {
    params.set("sort", query.sort);
  }
  if (order) {
    params.set("order", order);
  }
  const text = params.toString();
  return text.length > 0 ? `?${text}` : "";
}
```

3b. `src/server/desk/read.ts`:
- Imports: add `sql, type SQL` to the drizzle import; add `import type { DeskView, ViewCounts } from "@/lib/desk-query";`, `import type { QueueSettingsView } from "@/lib/queue-settings";` and `import { queueSettingsView } from "./queue-settings";`.
- `DeskPayload` gains:

```ts
  // The view this list is (src/lib/desk-query.ts) and every view's count.
  view: DeskView;
  viewCounts: ViewCounts;
  // Age thresholds and price display (src/server/desk/queue-settings.ts).
  queue: QueueSettingsView;
```

- Add above `loadDesk`:

```ts
// A card's status row, for the closed flag (migration 0011). A key with no
// status row (one removed while cards still had it) counts as open.
const statusJoin = and(eq(statuses.workspaceId, orders.workspaceId), eq(statuses.key, orders.statusKey));
const isOpen = sql`coalesce(${statuses.closed}, 0) = 0`;
const isClosed = sql`coalesce(${statuses.closed}, 0) = 1`;

// Which cards a view loads (comprehensive desk design section 1). Deleted
// requests come with Open, All and Closed; the desk's Deleted filter shows
// them. The approval queue is requests still waiting: drafts that are not
// deleted, in an open status.
function viewCondition(view: DeskView): SQL | undefined {
  switch (view) {
    case "all":
      return undefined;
    case "open":
      return isOpen;
    case "closed":
      return isClosed;
    case "approval":
      return and(isNull(orders.shopifyOrderId), isNull(orders.draftDeletedAt), isOpen);
  }
}

// Requests waiting for a manager: the approval view's size (the top bar's
// badge).
export async function countNeedsApproval(db: Db, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(orders)
    .leftJoin(statuses, statusJoin)
    .where(and(eq(orders.workspaceId, workspaceId), viewCondition("approval")));
  return Number(rows[0]?.count ?? 0);
}
```

- `loadDesk(db, workspaceId, opts?: { limit?: number; view?: DeskView })`: add `const view = opts?.view ?? "all";`; replace the list query with

```ts
    // One row past the cap answers hasMore without a second count query.
    db
      .select({ order: orders })
      .from(orders)
      .leftJoin(statuses, statusJoin)
      .where(and(eq(orders.workspaceId, workspaceId), viewCondition(view)))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1),
```

  add as a new last element of the `Promise.all` (destructure it as `viewRows`):

```ts
    // Every view's size over every card. Deleted requests count in none.
    db
      .select({
        all: sql<number>`coalesce(sum(case when ${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is not null then 0 else 1 end), 0)`,
        closed: sql<number>`coalesce(sum(case when ${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is not null then 0 when coalesce(${statuses.closed}, 0) = 1 then 1 else 0 end), 0)`,
        approval: sql<number>`coalesce(sum(case when ${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is null and coalesce(${statuses.closed}, 0) = 0 then 1 else 0 end), 0)`,
      })
      .from(orders)
      .leftJoin(statuses, statusJoin)
      .where(eq(orders.workspaceId, workspaceId)),
```

  and in the result: `orders: orderRows.slice(0, limit).map((row) => summarize(row.order)),` plus

```ts
    view,
    viewCounts: (() => {
      const all = Number(viewRows[0]?.all ?? 0);
      const closed = Number(viewRows[0]?.closed ?? 0);
      return { open: all - closed, approval: Number(viewRows[0]?.approval ?? 0), all, closed };
    })(),
    queue: queueSettingsView(settingsRows[0]),
```

3c. Replace `src/app/api/workspaces/[id]/orders/route.ts` with:

```ts
import { NextResponse } from "next/server";
import { parseDeskQuery } from "@/lib/desk-query";
import { loadDesk } from "@/server/desk/read";
import { AuthError, guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// The desk payload in one round trip: workspace, the caller's role, statuses
// by sort, settings, per-status counts over every order, the view's newest
// order summaries (full snapshots come from GET /api/orders/[orderId]),
// every view's count, the request counts, whether draft orders sync for the
// store, and the work queue settings. ?view=open|approval|all|closed; the
// server owns the default, Open (src/lib/desk-query.ts).
export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, role } = await requireMember(id, "staff");
    const query = parseDeskQuery(new URL(request.url).searchParams);
    const desk = await loadDesk(db, id, { view: query.view });
    if (!desk) {
      throw new AuthError(404, "Not found");
    }
    return NextResponse.json({
      workspace: desk.workspace,
      role,
      statuses: desk.statuses,
      settings: desk.settings,
      statusCounts: desk.statusCounts,
      orders: desk.orders,
      hasMore: desk.hasMore,
      draftCount: desk.draftCount,
      deletedDraftCount: desk.deletedDraftCount,
      drafts: desk.drafts,
      view: desk.view,
      viewCounts: desk.viewCounts,
      queue: desk.queue,
    });
  } catch (e) {
    return guardResponse(e);
  }
}
```

3d. `src/lib/desk-state.ts`:
- Replace the local `SortKey` and `DeskKind` type declarations (265-269) with

```ts
import type { DeskKind, DeskView, SortKey, ViewCounts } from "./desk-query";

export type { DeskKind, DeskView, SortKey, ViewCounts };
```

  (move the `import type` up with the other imports).
- `DeskFilter` becomes `{ query: string; statusKey: string | null; sort: SortKey; kind?: DeskKind; view?: DeskView };`.
- Add after `kindMatches`:

```ts
// Which cards a view shows (the server loads the same set, src/server/desk/
// read.ts): Open leaves closed statuses out, Closed shows only them, the
// approval queue shows requests still waiting. Filtering here too means a
// card that moves into a closed status leaves Open at once.
export function viewMatches(row: OrderSummary, view: DeskView, closedKeys: ReadonlySet<string>): boolean {
  switch (view) {
    case "all":
      return true;
    case "open":
      return !closedKeys.has(row.statusKey);
    case "closed":
      return closedKeys.has(row.statusKey);
    case "approval":
      return row.kind === "draft" && !row.draftDeleted && !closedKeys.has(row.statusKey);
  }
}

// The view counts after a loaded card moved from one status to another.
// Unchanged (the same object) unless it crossed between open and closed; a
// request whose draft Shopify deleted counts in no view.
export function shiftViewCounts(
  counts: ViewCounts,
  row: Pick<OrderSummary, "kind" | "draftDeleted">,
  fromKey: string,
  toKey: string,
  closedKeys: ReadonlySet<string>,
): ViewCounts {
  if (row.kind === "draft" && row.draftDeleted) {
    return counts;
  }
  const wasClosed = closedKeys.has(fromKey);
  const isClosed = closedKeys.has(toKey);
  if (wasClosed === isClosed) {
    return counts;
  }
  const delta = isClosed ? 1 : -1;
  return {
    ...counts,
    open: counts.open - delta,
    closed: counts.closed + delta,
    approval: row.kind === "draft" ? counts.approval - delta : counts.approval,
  };
}

// Whether a status entry for a card the desk has not loaded moved it
// between open and closed (then only a reload can fix the counts).
export function crossesClosed(meta: unknown, closedKeys: ReadonlySet<string>): boolean {
  const move = metaMove(meta);
  return move !== null && closedKeys.has(move.from) !== closedKeys.has(move.to);
}

// The statuses the status filter offers in a view.
export function chipsForView(chips: StatusChip[], view: DeskView, closedKeys: ReadonlySet<string>): StatusChip[] {
  if (view === "all") {
    return chips;
  }
  return chips.filter((chip) => (view === "closed" ? closedKeys.has(chip.key) : !closedKeys.has(chip.key)));
}
```

- Replace `amount()` and `selectOrders` with:

```ts
// The time a card has waited in its status: since its status was set, else
// since it arrived.
function waitingSince(row: OrderSummary): number {
  return row.statusSetAt ?? row.createdAt;
}

export function selectOrders(
  orders: OrderSummary[],
  filter: DeskFilter,
  closedKeys: ReadonlySet<string> = new Set(),
): OrderSummary[] {
  const query = filter.query.trim().toLowerCase();
  const kind = filter.kind ?? "all";
  const view = filter.view ?? "all";
  const matches = orders.filter((row) => {
    if (!viewMatches(row, view, closedKeys) || !kindMatches(row, kind)) {
      return false;
    }
    if (filter.statusKey !== null && row.statusKey !== filter.statusKey) {
      return false;
    }
    if (query.length === 0) {
      return true;
    }
    return (
      row.name.toLowerCase().includes(query) ||
      row.customerName.toLowerCase().includes(query) ||
      row.email.toLowerCase().includes(query) ||
      row.itemTitles.some((title) => title.toLowerCase().includes(query)) ||
      row.searchText.some((text) => text.toLowerCase().includes(query))
    );
  });
  const newest = (a: OrderSummary, b: OrderSummary) =>
    b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  switch (filter.sort) {
    case "newest":
      return matches.sort(newest);
    case "oldest":
      return matches.sort((a, b) => -newest(a, b));
    case "waiting":
      return matches.sort((a, b) => waitingSince(a) - waitingSince(b) || newest(a, b));
  }
}
```

  `formatMoney` stays imported (arrivalNotice uses it).

3e. `src/components/desk/toolbar.tsx`:
- `SORTS` becomes newest "Newest first", oldest "Oldest first", waiting "Waiting longest".
- Imports: `import { defaultSort, type DeskView, type ViewCounts } from "@/lib/desk-query";`.
- `ToolbarProps` gains:

```ts
  view: DeskView;
  onView: (view: DeskView) => void;
  viewCounts: ViewCounts;
  // Managers and platform admins see the Needs approval view.
  showApproval: boolean;
```

- Add:

```ts
function viewOptions(counts: ViewCounts, approval: boolean): SegmentedOption<DeskView>[] {
  return [
    { value: "open", label: "Open", count: counts.open },
    ...(approval ? [{ value: "approval" as const, label: "Needs approval", count: counts.approval }] : []),
    { value: "all", label: "All", count: counts.all },
    { value: "closed", label: "Closed", count: counts.closed },
  ];
}
```

- `RowToolbar` starts with the views, before the status filter:

```tsx
      <Segmented
        name="desk-view"
        legend="Show"
        value={view}
        options={viewOptions(viewCounts, showApproval || view === "approval")}
        onChange={onView}
        className="shrink-0"
      />
```

- `PhoneToolbar`: the first control of the row becomes the view select, and the status filter moves into the filters row (first, above the kind segments):

```tsx
        <NativeSelect id="desk-view" label="Show" value={view} onChange={(value) => onView(value as DeskView)} className="min-w-0 flex-1">
          {viewOptions(viewCounts, showApproval || view === "approval").map((option) => (
            <option key={option.value} value={option.value}>
              {`${option.label} (${(option.count ?? 0).toLocaleString("en-US")})`}
            </option>
          ))}
        </NativeSelect>
```

  and the active filter count becomes `(statusKey ? 1 : 0) + (kindFilter && kindFilter.kind !== "all" ? 1 : 0) + (sort !== defaultSort(view) ? 1 : 0)`. Destructure `view`, `onView`, `viewCounts`, `showApproval` in both toolbars.

3f. `src/components/desk/empty-states.tsx`: import `type { DeskView }` from `@/lib/desk-query`; `noMatchesCopy(query, kind, statusLabel, view)` starts with

```ts
  if (query.length === 0 && kind === "all" && statusLabel === null) {
    switch (view) {
      case "open":
        return { title: "Nothing open", body: "Every card is in a closed status. New requests and orders land here." };
      case "approval":
        return { title: "No requests need approval", body: "New requests from the store show up here." };
      case "closed":
        return {
          title: "Nothing closed yet",
          body: "Cards move here when they reach a closed status, such as Delivered or Rejected.",
        };
      case "all":
        break;
    }
  }
```

`NoMatches` takes `view?: DeskView` (default `"all"`), passes it on, and shows Clear filters (and its hint) only when there is something to clear: `const canClear = query.trim().length > 0 || kind !== "all" || statusLabel !== null;`.

3g. `src/components/desk/desk.tsx`:
- Imports: `import { defaultSort, parseDeskQuery, type DeskView, type ViewCounts } from "@/lib/desk-query";`, `import { DEFAULT_QUEUE_SETTINGS, type QueueSettingsView } from "@/lib/queue-settings";`, and add `chipsForView, crossesClosed, deskKindCounts, shiftViewCounts, viewMatches` to the `@/lib/desk-state` import.
- `DeskPayload` gains `view: DeskView; viewCounts: ViewCounts; queue: QueueSettingsView;`.
- Replace the `filter` state line (137) with:

```ts
  // The view and filters start from the address (src/lib/desk-query.ts);
  // Task 15 makes the address their only home.
  const [filter, setFilter] = useState<DeskFilter>(() => {
    const initial = parseDeskQuery(searchParams);
    return { query: initial.q, statusKey: initial.status, sort: initial.sort, kind: initial.kind, view: initial.view };
  });
  const view: DeskView = filter.view ?? "open";
  const [viewCounts, setViewCounts] = useState<ViewCounts>({ open: 0, approval: 0, all: 0, closed: 0 });
  const [queue, setQueue] = useState<QueueSettingsView>(DEFAULT_QUEUE_SETTINGS);
  // A different view is loading; the list stays while it does.
  const [switching, setSwitching] = useState(false);
  const viewRef = useRef<DeskView>(view);
  const closedRef = useRef<ReadonlySet<string>>(new Set());
```

- `fetchDesk`: read `const requested = viewRef.current;` first, fetch `` `/api/workspaces/${encodeURIComponent(workspace.id)}/orders?view=${requested}` ``, and right after parsing the payload:

```ts
      if (requested !== viewRef.current) {
        // The view changed while this request was out: load the new one.
        reloadAgain.current = true;
        return;
      }
```

  then, next to `setStatuses(payload.statuses);`, add `setViewCounts(payload.viewCounts); setQueue(payload.queue); setSwitching(false);`.
- After `fetchDesk`/`reload`, add:

```ts
  const closedKeys = useMemo(
    () => new Set(statuses.filter((status) => status.closed).map((status) => status.key)),
    [statuses],
  );
  useEffect(() => {
    closedRef.current = closedKeys;
  }, [closedKeys]);

  // A different view: load it (the server filters; the list stays until
  // the new one lands).
  useEffect(() => {
    if (viewRef.current === view) {
      return;
    }
    viewRef.current = view;
    setSwitching(true);
    void reload();
  }, [view, reload]);
```

- `applyEvent` keeps the view counts in step:

```ts
  const applyEvent = useCallback(
    (event: LiveEvent) => {
      const before = event.kind === "order.status" ? deskRef.current.orders.find((row) => row.id === event.order.id) : undefined;
      const { state, effects } = applyLiveEvent(deskRef.current, event, userId);
      if (state !== deskRef.current) {
        commit(state);
      }
      if (event.kind === "order.status") {
        setDetail((current) => withDetailStatus(current, event.order));
        const after = state.orders.find((row) => row.id === event.order.id);
        if (before && after && before.statusKey !== after.statusKey) {
          setViewCounts((current) => shiftViewCounts(current, before, before.statusKey, after.statusKey, closedRef.current));
        } else if (!before && crossesClosed(event.event.meta, closedRef.current)) {
          void reload();
        }
      }
      if (touchesPurchaseOrders(event, openRef.current)) {
        setPoRefresh((count) => count + 1);
      }
      handleEffects(effects);
    },
    [userId, commit, handleEffects, reload],
  );
```

- `changeStatus`: before the optimistic update read `const before = deskRef.current.orders.find((row) => row.id === orderId);`; after `commit(optimistic.state)` add `if (before) { setViewCounts((current) => shiftViewCounts(current, before, optimistic.previousKey, nextKey, closedRef.current)); }`; in the `catch`, replace the rollback with

```ts
        if (optimistic) {
          const rolled = rollbackStatus(deskRef.current, orderId, nextKey, optimistic.previousKey);
          if (rolled !== deskRef.current) {
            commit(rolled);
            if (before) {
              setViewCounts((current) => shiftViewCounts(current, before, nextKey, optimistic.previousKey, closedRef.current));
            }
          }
        }
```

- Derived values (replace the `visible` line and add):

```ts
  const visible = useMemo(
    () => selectOrders(desk.orders, view === "approval" ? { ...filter, kind: "all" } : filter, closedKeys),
    [desk.orders, filter, view, closedKeys],
  );
  const viewChips = useMemo(() => chipsForView(chips, view, closedKeys), [chips, view, closedKeys]);
  // Drafts and Deleted counts for what this view holds.
  const kindCounts = useMemo(
    () => deskKindCounts(desk.orders.filter((row) => viewMatches(row, view === "approval" ? "open" : view, closedKeys))),
    [desk.orders, view, closedKeys],
  );
```

- Toolbar props: add `view={view}`, `onView={(next) => setFilter((current) => ({ ...current, view: next, statusKey: null, sort: current.sort === defaultSort(current.view ?? "open") ? defaultSort(next) : current.sort }))}`, `viewCounts={viewCounts}`, `showApproval={roleAtLeast(role, "manager")}`, `statusChips={viewChips}`, and the kind filter only outside the approval view with this view's counts: `kindFilter={showKindFilter && view !== "approval" ? { kind: filter.kind ?? "all", onKind: ..., draftCount: kindCounts.drafts, deletedCount: kindCounts.deleted } : null}`.
- `NoMatches` gets `view={view}`.
- Wrap the `OrderList` in `<div aria-busy={switching || undefined} className={switching ? "opacity-60 transition-opacity" : undefined}>...</div>`.

**Step 4: Run them and see them pass**

Run the six test files from Step 2.
Expected: PASS. Then `npm run test`.

Local visual check: the desk opens on Open with its count; Closed shows Delivered and Rejected cards; moving a card to Delivered drops it from Open and moves the counts at once; at 375 the view select leads the row; light and dark.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/desk-query.ts src/lib/desk-query.test.ts src/server/desk/read.ts src/server/desk/read.test.ts src/app/api/workspaces/[id]/orders/route.ts src/app/api/workspaces/[id]/orders/route.test.ts src/lib/desk-state.ts src/lib/desk-state.test.ts src/components/desk/toolbar.tsx src/components/desk/toolbar.test.ts src/components/desk/empty-states.tsx src/components/desk/empty-states.test.ts src/components/desk/desk.tsx"
git add $FILES
git commit -m "feat: open by default (server-owned views and counts, view switcher, Waiting longest sort)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 13: Age on every card

"New, 2d" from `status_set_at` (the arrival when no status was ever set), amber at 2 days and red at 4 by default, from the workspace's settings; closed cards show their age without a warning color. @design-taste-frontend

**Files:**
- Create: `src/lib/age.ts`
- Modify: `src/components/desk/order-list.tsx` (from Task 10: `ListProps`, `OrderTable` columns, `OrderCards` header)
- Modify: `src/components/desk/desk-skeleton.tsx` (row grid from Task 10)
- Modify: `src/components/desk/desk.tsx` (`OrderList` props)
- Test: `src/lib/age.test.ts` (new), `src/components/desk/order-list.test.ts`

**Step 1: Write the failing tests**

Create `src/lib/age.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cardAge } from "./age";

const NOW = Date.parse("2026-10-05T15:00:00.000Z");
const DAY = 86400000;
const rule = { amberDays: 2, redDays: 4, closed: false };

describe("cardAge", () => {
  it("reads minutes, hours and days from the status change, else the arrival", () => {
    expect(cardAge({ statusSetAt: NOW - 30000, createdAt: 0 }, NOW, rule)).toMatchObject({ short: "1m", long: "1 minute" });
    expect(cardAge({ statusSetAt: NOW - 59 * 60000, createdAt: 0 }, NOW, rule)).toMatchObject({ short: "59m" });
    expect(cardAge({ statusSetAt: NOW - 5 * 3600000, createdAt: 0 }, NOW, rule)).toMatchObject({ short: "5h", long: "5 hours" });
    expect(cardAge({ statusSetAt: null, createdAt: NOW - 26 * 3600000 }, NOW, rule)).toMatchObject({
      short: "1d",
      long: "1 day",
      since: NOW - 26 * 3600000,
    });
  });

  it("turns amber at the amber threshold and red at the red one", () => {
    expect(cardAge({ statusSetAt: NOW - 2 * DAY + 1000, createdAt: 0 }, NOW, rule).tone).toBe("none");
    expect(cardAge({ statusSetAt: NOW - 2 * DAY, createdAt: 0 }, NOW, rule).tone).toBe("amber");
    expect(cardAge({ statusSetAt: NOW - 4 * DAY, createdAt: 0 }, NOW, rule).tone).toBe("red");
  });

  it("never warns on a closed card, nor on a clock that runs behind", () => {
    expect(cardAge({ statusSetAt: NOW - 30 * DAY, createdAt: 0 }, NOW, { ...rule, closed: true }).tone).toBe("none");
    expect(cardAge({ statusSetAt: NOW + 60000, createdAt: 0 }, NOW, rule)).toMatchObject({ short: "1m", tone: "none" });
  });
});
```

In `src/components/desk/order-list.test.ts` add `ageRule: { amberDays: 2, redDays: 4 }, closedKeys: new Set(),` to `base` and append:

```ts
const DAY = 86400000;

describe("OrderList ages", () => {
  it("shows each card's age in its status, amber and red past the thresholds, plain once closed", () => {
    const statuses: StatusView[] = [
      ...STATUSES,
      { key: "delivered", label: "Delivered", color: "slate", sort: 1, triggersPo: false, shopifyLink: "delivered", closed: true },
    ];
    const orders = [
      card("fresh", { statusSetAt: NOW - 3 * 3600000 }),
      card("late", { statusSetAt: NOW - 2 * DAY }),
      card("old", { statusSetAt: NOW - 5 * DAY }),
      card("done", { statusKey: "delivered", statusSetAt: NOW - 9 * DAY }),
    ];
    const props = { orders, statuses, closedKeys: new Set(["delivered"]) };
    const table = render("table", props);
    expect(table).toContain(">Age</th>");
    expect(table).toContain('<span aria-hidden="true">3h</span>');
    expect(table).toMatch(/data-tone="amber"[^>]*><span aria-hidden="true">2d</);
    expect(table).toMatch(/data-tone="red"[^>]*><span aria-hidden="true">5d</);
    expect(table).toContain("In Delivered for 9 days");
    expect(table).not.toMatch(/data-tone="red"[^>]*><span aria-hidden="true">9d</);
    expect(render("cards", props)).toContain('<span aria-hidden="true">New, 3h</span>');
  });
});
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/age.test.ts src/components/desk/order-list.test.ts`
Expected: FAIL: `Failed to resolve import "./age"`; `npx tsc` also rejects `ageRule` and `closedKeys` on `ListProps`.

**Step 3: Minimal implementation**

3a. Create `src/lib/age.ts`:

```ts
// How long a card has waited in its status (comprehensive desk design
// section 1): "12m", "5h" or "2d" since status_set_at, else since it
// arrived; amber and red past the workspace's thresholds (Settings >
// Statuses). A closed card shows its age without a warning color. Pure, so
// the rules are tested; the desk list renders it.

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type AgeTone = "none" | "amber" | "red";

export type CardAge = {
  short: string;
  // "2 days", for screen readers.
  long: string;
  tone: AgeTone;
  // When the wait started.
  since: number;
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function cardAge(
  card: { statusSetAt: number | null; createdAt: number },
  now: number,
  rule: { amberDays: number; redDays: number; closed: boolean },
): CardAge {
  const since = card.statusSetAt ?? card.createdAt;
  const elapsed = Math.max(0, now - since);
  let short: string;
  let long: string;
  if (elapsed < HOUR) {
    const minutes = Math.max(1, Math.floor(elapsed / MINUTE));
    short = `${minutes}m`;
    long = plural(minutes, "minute");
  } else if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    short = `${hours}h`;
    long = plural(hours, "hour");
  } else {
    const days = Math.floor(elapsed / DAY);
    short = `${days}d`;
    long = plural(days, "day");
  }
  const tone: AgeTone = rule.closed
    ? "none"
    : elapsed >= rule.redDays * DAY
      ? "red"
      : elapsed >= rule.amberDays * DAY
        ? "amber"
        : "none";
  return { short, long, tone, since };
}
```

3b. `src/components/desk/order-list.tsx`:
- Import `cardAge` from `@/lib/age`.
- `ListProps` gains:

```ts
  // When ages turn amber and red (the workspace's work queue settings).
  ageRule: { amberDays: number; redDays: number };
  // Status keys whose cards are finished (no warning color on their age).
  closedKeys: ReadonlySet<string>;
```

- Add:

```tsx
// "2d" (the table) or "New, 2d" (a card's header), amber or red when the
// card has waited too long. Spoken as "In New for 2 days".
function AgeBadge({
  order,
  statuses,
  ageRule,
  closedKeys,
  now,
  withLabel,
}: {
  order: OrderSummary;
  statuses: StatusView[];
  ageRule: ListProps["ageRule"];
  closedKeys: ReadonlySet<string>;
  now: number;
  withLabel: boolean;
}) {
  if (now === 0) {
    return null;
  }
  const age = cardAge(order, now, { ...ageRule, closed: closedKeys.has(order.statusKey) });
  const label = statuses.find((status) => status.key === order.statusKey)?.label ?? "Unknown status";
  const text = withLabel ? `${label}, ${age.short}` : age.short;
  const spoken = `In ${label} for ${age.long}${age.tone === "red" ? ", overdue" : age.tone === "amber" ? ", waiting long" : ""}`;
  const title = `In ${label} since ${formatDateTime(age.since)}`;
  if (age.tone === "none") {
    return (
      <span title={title} className="shrink-0 text-xs font-medium tabular-nums text-ink-2">
        <span aria-hidden>{text}</span>
        <span className="sr-only">{spoken}</span>
      </span>
    );
  }
  return (
    <Chip tone={age.tone} size="sm" title={title}>
      <span aria-hidden>{text}</span>
      <span className="sr-only">{spoken}</span>
    </Chip>
  );
}
```

- `OrderTable`: destructure `ageRule` and `closedKeys`; add `<col className="w-[5.5rem]" />` after the Items column, `<th scope="col" className="px-3 font-semibold">Age</th>` after Items, and the cell after the Items cell:

```tsx
                <td className={`px-3 ${flash}`}>
                  <AgeBadge order={order} statuses={statuses} ageRule={ageRule} closedKeys={closedKeys} now={now} withLabel={false} />
                </td>
```

- `OrderCards`: destructure them too and replace the header's date span with:

```tsx
            <span className="ml-auto shrink-0">
              <AgeBadge order={order} statuses={statuses} ageRule={ageRule} closedKeys={closedKeys} now={now} withLabel />
            </span>
```

3c. `src/components/desk/desk-skeleton.tsx`: the row grid becomes `grid-cols-[10rem_6.5rem_24%_1fr_5.5rem_7rem_11rem]` with one more cell `<div className="px-3"><Bar className="h-5 w-10" /></div>` after the items cell.

3d. `src/components/desk/desk.tsx`: pass `ageRule={{ amberDays: queue.ageAmberDays, redDays: queue.ageRedDays }}` and `closedKeys={closedKeys}` to `OrderList`.

**Step 4: Run them and see them pass**

Run: `npx vitest run src/lib/age.test.ts src/components/desk/order-list.test.ts`
Expected: PASS.

Local visual check: on a local card, set `status_set_at` 3 days back (`npx wrangler d1 execute orderingdesk --local --command "UPDATE orders SET status_set_at = (strftime('%s','now') - 259200) * 1000 WHERE name = '#1010'"`) and see an amber "3d"; set Red after to 3 in Settings and it turns red; light and dark contrast holds; Waiting longest puts it first.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/age.ts src/lib/age.test.ts src/components/desk/order-list.tsx src/components/desk/order-list.test.ts src/components/desk/desk-skeleton.tsx src/components/desk/desk.tsx"
git add $FILES
git commit -m "feat: age on every card, amber and red by the workspace's thresholds" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 14: Needs approval queue and Approve and next

For managers and platform admins: a Needs approval link with a count badge in the top bar that opens the approval view (waiting longest first), and Approve and next in the review panel, which approves through the same confirmation step (focus on the question, 400 ms arming) and then opens the next waiting request. New request push and email links open the approval view. @design-taste-frontend

**Files:**
- Create: `src/app/api/workspaces/[id]/queue/route.ts`
- Modify: `src/components/shell/workspace-provider.tsx` (context type 33-43, provider 65-225)
- Modify: `src/components/shell/top-bar.tsx` (add `ApprovalLink` before the Settings link)
- Modify: `src/lib/desk-state.ts` (add `nextWaitingRequest`)
- Modify: `src/components/desk/review-panel.tsx` (whole file)
- Modify: `src/components/desk/order-drawer.tsx` (props 450-504, skeleton heading 607-609, `ReviewPanel` use 702-720)
- Modify: `src/components/desk/desk.tsx` (`useWorkspace` line 127, `approve` 507-554, `reject` 557-593, drawer props 738-767)
- Modify: `src/server/notify.ts` (`orderQuery` 111-113, `pushLink` 128-133, `emailLink` 136-141, `notifyNewOrders` 412-432)
- Test: `src/app/api/workspaces/[id]/queue/route.test.ts` (new), `src/components/shell/top-bar.test.ts`, `src/lib/desk-state.test.ts`, `src/components/desk/review-panel.test.ts`, `src/components/desk/order-drawer.test.ts`, `src/server/notify.test.ts`

**Step 1: Write the failing tests**

Create `src/app/api/workspaces/[id]/queue/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedDraft, seedDraftStatuses, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test" }, ctx: { waitUntil: () => {} } }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { GET } = await import("./route");
const context = { params: Promise.resolve({ id: "ws_impact" }) };
const get = () => new Request("https://orderingdesk.test/api/workspaces/ws_impact/queue");
const as = (id: string) => {
  state.session = { user: { id, email: `${id}@example.com` } };
};

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedDraftStatuses(db, "ws_impact");
  await seedDraft(db, "ws_impact", { id: "d1" });
  await seedDraft(db, "ws_impact", { id: "d2", statusKey: "rejected" });
  for (const id of ["u_manager", "u_staff", "u_stranger"]) {
    await seedUser(db, id, `${id}@example.com`);
  }
  await seedMember(db, "ws_impact", "u_manager", "manager");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("GET /api/workspaces/[id]/queue", () => {
  it("answers 401 signed out and 404 to staff and outsiders", async () => {
    expect((await GET(get(), context)).status).toBe(401);
    as("u_staff");
    expect((await GET(get(), context)).status).toBe(404);
    as("u_stranger");
    expect((await GET(get(), context)).status).toBe(404);
  });

  it("tells a manager how many requests wait (a rejected one does not)", async () => {
    as("u_manager");
    const response = await GET(get(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ needsApproval: 1 });
  });
});
```

In `src/components/shell/top-bar.test.ts` add `needsApproval: 3, refreshQueue: () => {},` to the hoisted value and append:

```ts
describe("TopBar Needs approval", () => {
  it("shows those who approve the queue with its count, and staff nothing", () => {
    state.value = { ...state.value, role: "manager", needsApproval: 3 };
    const html = render();
    expect(html).toContain('href="/?view=approval"');
    expect(html).toContain('aria-label="Needs approval, 3 waiting"');
    state.value = { ...state.value, role: "staff" };
    expect(render()).not.toContain("view=approval");
  });
});
```

Append to `src/lib/desk-state.test.ts` (import `nextWaitingRequest`):

```ts
describe("nextWaitingRequest", () => {
  it("finds the next request waiting after the current one, wrapping to the top", () => {
    const closed = new Set(["rejected"]);
    const list = [
      order("d1", { kind: "draft", name: "#D1" }),
      order("o1"),
      order("d2", { kind: "draft", name: "#D2", statusKey: "rejected" }),
      order("d3", { kind: "draft", name: "#D3" }),
      order("d4", { kind: "draft", name: "#D4", draftDeleted: true }),
    ];
    expect(nextWaitingRequest(list, "d1", closed)).toEqual({ id: "d3", name: "#D3" });
    expect(nextWaitingRequest(list, "d3", closed)).toEqual({ id: "d1", name: "#D1" });
    expect(nextWaitingRequest(list, "zz", closed)).toEqual({ id: "d1", name: "#D1" });
    expect(nextWaitingRequest([order("d1", { kind: "draft" })], "d1", closed)).toBeNull();
  });
});
```

Append to `src/components/desk/review-panel.test.ts`:

```ts
  it("offers Approve and next while another request waits, through the same confirmation", () => {
    const html = render({ next: { id: "d13", name: "#D13" }, onApproveAndNext: async () => null });
    expect(html).toContain(">Approve and next<");
    expect(html).toContain("Then request #D13 opens.");
    expect(render({ next: null })).not.toContain("Approve and next");
    expect(
      render({ next: { id: "d13", name: "#D13" }, onApproveAndNext: async () => null, completeInShopify: { url: null } }),
    ).not.toContain("Approve and next");
  });
```

In `src/components/desk/order-drawer.test.ts`, let `render` take `extra?: Record<string, unknown>` in its options and spread `...(opts.extra ?? {})` last into the props, then append inside the describe:

```ts
  it("offers Approve and next for the next request waiting", () => {
    const html = render({
      order: draftCard({ statusKey: "new" }),
      extra: { nextRequest: { id: "d13", name: "#D13" }, onApproveAndNext: async () => null },
    });
    expect(html).toContain(">Approve and next<");
  });
```

In `src/server/notify.test.ts`, in "announces a new request by push and email as a request", change the expected phone url to `"https://orders.impactrentals.store/?view=approval&order=12"` and add after the email loop:

```ts
    // The approver lands on the approval queue with the request open.
    for (const message of sent) {
      expect(message.html).toContain("view=approval");
    }
```

and in "pushes to members who allow it..." (an order, not a request) keep the `?order=o1` links unchanged: orders do not open the approval view.

**Step 2: Run them and see them fail**

Run: `npx vitest run "src/app/api/workspaces/[id]/queue/route.test.ts" src/components/shell/top-bar.test.ts src/lib/desk-state.test.ts src/components/desk/review-panel.test.ts src/components/desk/order-drawer.test.ts src/server/notify.test.ts`
Expected: FAIL: `Failed to resolve import "./route"`; no Needs approval link; `nextWaitingRequest is not a function`; no Approve and next; the request push url is `?order=12`.

**Step 3: Minimal implementation**

3a. Create `src/app/api/workspaces/[id]/queue/route.ts`:

```ts
import { NextResponse } from "next/server";
import { countNeedsApproval } from "@/server/desk/read";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Managers and platform admins: how many requests wait for approval (the
// top bar's Needs approval badge). 401 signed out, 404 for staff and
// outsiders. 200 {needsApproval}.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "manager");
    return NextResponse.json({ needsApproval: await countNeedsApproval(db, id) });
  } catch (e) {
    return guardResponse(e);
  }
}
```

3b. `src/components/shell/workspace-provider.tsx`:
- Add to `WorkspaceContextValue`:

```ts
  // Requests waiting for approval (managers and platform admins; null for
  // staff and until it loads).
  needsApproval: number | null;
  // Ask for the count again soon (after an approve, a reject, a bulk move).
  refreshQueue: () => void;
```

- In the provider (import `roleAtLeast` from `@/lib/roles`):

```ts
  const canApprove = roleAtLeast(role, "manager");
  const [needsApproval, setNeedsApproval] = useState<number | null>(null);
  const queueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadQueue = useCallback(async () => {
    if (!canApprove) {
      return;
    }
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/queue`, { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { needsApproval?: unknown };
      setNeedsApproval(typeof body.needsApproval === "number" ? body.needsApproval : null);
    } catch {
      // Keep the last count through a blip.
    }
  }, [workspace.id, canApprove]);

  // Many live events can land together (a sync): one reload for all of them.
  const refreshQueue = useCallback(() => {
    if (queueTimer.current) {
      clearTimeout(queueTimer.current);
    }
    queueTimer.current = setTimeout(() => {
      queueTimer.current = null;
      void loadQueue();
    }, 400);
  }, [loadQueue]);

  useEffect(() => {
    void loadQueue();
    return () => {
      if (queueTimer.current) {
        clearTimeout(queueTimer.current);
      }
    };
  }, [loadQueue]);
```

- In `useLive`'s `onEvent` add `if (event.kind !== "order.note") { refreshQueue(); }`, and in `onResync` add `refreshQueue();`.
- Add `needsApproval` and `refreshQueue` to the memoized context value and its dependency list.

3c. `src/components/shell/top-bar.tsx`: import `ClipboardTextIcon` from `@phosphor-icons/react/ClipboardText` and `roleAtLeast` from `@/lib/roles`, add

```tsx
// Managers and platform admins: the approval queue, with how many wait.
function ApprovalLink() {
  const { workspace, role, needsApproval } = useWorkspace();
  if (!roleAtLeast(role, "manager")) {
    return null;
  }
  const count = needsApproval ?? 0;
  const href = `${workspace.basePath === "" ? "/" : workspace.basePath}?view=approval`;
  return (
    <Link
      href={href}
      aria-label={count > 0 ? `Needs approval, ${count} waiting` : "Needs approval"}
      className={`${ui.buttonQuiet} h-10 max-lg:px-2.5`}
    >
      <ClipboardTextIcon size={18} aria-hidden />
      <span aria-hidden className="max-lg:hidden">
        Needs approval
      </span>
      {count > 0 ? (
        <span
          aria-hidden
          className="grid h-5 min-w-5 place-items-center rounded-control bg-primary px-1 text-xs font-semibold tabular-nums text-primary-ink"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
```

and render `<ApprovalLink />` right before the Settings link in the controls row.

3d. Append to `src/lib/desk-state.ts`:

```ts
// The request to open after an approval (comprehensive desk design section
// 1, Approve and next): the next waiting request after the current card in
// the list's order, wrapping round to the top; null when none waits.
export function nextWaitingRequest(
  visible: OrderSummary[],
  currentId: string,
  closedKeys: ReadonlySet<string>,
): { id: string; name: string } | null {
  const index = visible.findIndex((row) => row.id === currentId);
  const ordered = index === -1 ? visible : [...visible.slice(index + 1), ...visible.slice(0, index)];
  const next = ordered.find((row) => row.id !== currentId && viewMatches(row, "approval", closedKeys));
  return next ? { id: next.id, name: next.name } : null;
}
```

3e. Replace `src/components/desk/review-panel.tsx` with:

```tsx
"use client";

// Approve and Reject on a request card (draft orders spec sections 9 and
// 11.3 with section 18 item 8; Approve and next from the comprehensive desk
// design section 1). ReviewSummary says where the request stands;
// ReviewActions holds the buttons and their steps (managers and platform
// admins; staff see who decides). ReviewPanel puts both in one panel. The
// server enforces every rule again.
//
// Approve completes the draft in Shopify, which cannot be undone, so its
// in-page confirmation follows the purchase order send step: focus lands on
// the question (never on the button that commits), and a press within
// CONFIRM_ARM_MS of opening is ignored, so a double click or a held Enter
// cannot create the order. Approve and next uses the same step and then
// opens the next request waiting; that request's own confirmation is never
// opened for it. Escape or Cancel closes a step and focus returns to the
// button that opened it. A failure stays in the step, announced, with focus
// on it.
//
// Reject opens a small form: the reason is required (it becomes a note),
// focus starts in it, and Escape or Cancel returns focus to Reject.

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { NOTE_MAX } from "@/lib/limits";
import { InlineMessage, Spinner } from "@/components/kit";
import { ui } from "@/components/ui";
import { focusSoon } from "@/components/settings/kit";
import { confirmArmed } from "./po-send-confirm";
import { ShopifyLink } from "./request-parts";

const REASON_REQUIRED = "Give a reason (up to 4000 characters). It is saved as a note.";

export type NextRequest = { id: string; name: string };

function ApproveConfirm({
  name,
  email,
  nextName,
  onConfirm,
  onCancel,
}: {
  name: string;
  email: string;
  // Approve and next: the request that opens afterwards.
  nextName: string | null;
  onConfirm: () => Promise<string | null>;
  onCancel: () => void;
}) {
  const id = useId();
  const questionRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const openedAt = useRef<number | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    openedAt.current = Date.now();
    questionRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  async function confirm() {
    if (busy || !confirmArmed(openedAt.current, Date.now())) {
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onConfirm();
    if (!mounted.current) {
      return;
    }
    setBusy(false);
    if (failure) {
      setError(failure);
      focusSoon(() => errorRef.current);
    }
  }

  return (
    <div
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={`${id}-question`} ref={questionRef} tabIndex={-1} className="text-sm text-ink outline-none">
        <span className="font-semibold">Approve request {name}?</span> Shopify completes the draft at $0.00 and creates
        the order, the same as Mark as paid. Shopify may email its order confirmation to {email || "the requester"}, as
        Mark as paid does.{nextName ? ` Then request ${nextName} opens.` : ""}
      </p>
      {error ? (
        <p id={`${id}-error`} ref={errorRef} tabIndex={-1} role="alert" className={`${ui.errorText} outline-none`}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-describedby={`${id}-question${error ? ` ${id}-error` : ""}`}
          className={ui.buttonPrimary}
        >
          {busy ? <Spinner /> : <CheckCircleIcon size={16} aria-hidden />}
          {busy ? "Approving" : nextName ? `Approve and open ${nextName}` : "Approve and create order"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RejectForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (reason: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const id = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const mounted = useRef(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    fieldRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit() {
    if (busy) {
      return;
    }
    if (reason.trim().length === 0 || reason.trim().length > NOTE_MAX) {
      setError(REASON_REQUIRED);
      focusSoon(() => fieldRef.current);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onSubmit(reason);
    if (!mounted.current) {
      return;
    }
    setBusy(false);
    if (failure) {
      setError(failure);
      focusSoon(() => errorRef.current);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={`${id}-reason`} className={ui.label}>
        Reason (saved as a note on this request)
      </label>
      <p id={`${id}-help`} className="-mt-1 text-sm text-ink-2">
        The draft stays in Shopify with the tag Ordering Desk: Rejected. Nobody is emailed.
      </p>
      <textarea
        id={`${id}-reason`}
        ref={fieldRef}
        rows={3}
        required
        maxLength={NOTE_MAX}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          if (error === REASON_REQUIRED && event.target.value.trim().length > 0) {
            setError(null);
          }
        }}
        aria-describedby={`${id}-help ${id}-count${error ? ` ${id}-error` : ""}`}
        aria-invalid={error ? true : undefined}
        className={ui.textarea}
      />
      <p id={`${id}-count`} className="text-xs tabular-nums text-ink-2">
        {reason.length.toLocaleString("en-US")} of {NOTE_MAX.toLocaleString("en-US")} characters
      </p>
      {error ? (
        <p id={`${id}-error`} ref={errorRef} tabIndex={-1} role="alert" className={`${ui.errorText} outline-none`}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2" data-tone="red">
        <button type="submit" disabled={busy} aria-busy={busy || undefined} className={ui.buttonDanger}>
          {busy ? <Spinner /> : <XCircleIcon size={16} aria-hidden />}
          {busy ? "Rejecting" : "Reject request"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export type ReviewSummaryProps = {
  // A manager or platform admin.
  canReview: boolean;
  // The card sits in the status Reject uses.
  rejected: boolean;
  // The total is not exactly 0: Approve is not offered; the draft is
  // completed in Shopify instead (url: the draft in Shopify admin).
  completeInShopify: { url: string | null } | null;
  // The heading's id (focus returns to it after a reject).
  titleId?: string;
};

// Where the request stands: the heading, who may decide, and the note to
// complete a priced draft in Shopify.
export function ReviewSummary({ canReview, rejected, completeInShopify, titleId }: ReviewSummaryProps) {
  const title = rejected ? "This request was rejected" : "Waiting for review";
  const lead = !canReview
    ? rejected
      ? "Only a manager can approve it or move it out of Rejected."
      : "Waiting for a manager to approve or reject."
    : rejected
      ? "A manager can still approve it."
      : completeInShopify
        ? "Reject asks for a reason and saves it as a note."
        : "Approve creates the order in Shopify. Reject asks for a reason and saves it as a note.";
  return (
    <>
      <h3 id={titleId} tabIndex={-1} className="font-display text-sm font-semibold text-ink outline-none">
        {title}
      </h3>
      <p className="mt-1 text-sm text-ink-2">{lead}</p>
      {canReview && completeInShopify ? (
        <div className="mt-3">
          <InlineMessage tone="warn">
            Complete this draft in Shopify. The card follows when you do.{" "}
            {completeInShopify.url ? <ShopifyLink href={completeInShopify.url}>Open the draft in Shopify</ShopifyLink> : null}
          </InlineMessage>
        </div>
      ) : null}
    </>
  );
}

export type ReviewActionsProps = {
  name: string;
  email: string;
  rejected: boolean;
  // Why Approve or Reject cannot be used right now (null when it can).
  approveBlock: string | null;
  rejectBlock: string | null;
  completeInShopify: { url: string | null } | null;
  // The next request waiting, for Approve and next (null: none waits).
  next?: NextRequest | null;
  onApprove: () => Promise<string | null>;
  onApproveAndNext?: () => Promise<string | null>;
  onReject: (reason: string) => Promise<string | null>;
  // Where focus goes once a reject is saved.
  afterReject?: () => HTMLElement | null;
};

type Mode = "idle" | "approve" | "approve-next" | "reject";

export function ReviewActions({
  name,
  email,
  rejected,
  approveBlock,
  rejectBlock,
  completeInShopify,
  next = null,
  onApprove,
  onApproveAndNext,
  onReject,
  afterReject,
}: ReviewActionsProps) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("idle");
  const approveRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const approveWhyShown = approveBlock !== null && !completeInShopify;
  // One reason line when both buttons are blocked for the same reason.
  const rejectWhyId = approveWhyShown && rejectBlock === approveBlock ? `${id}-approve-why` : `${id}-reject-why`;
  const rejectWhyShown = rejectBlock !== null && !rejected && rejectWhyId === `${id}-reject-why`;
  const andNext = !completeInShopify && next !== null && onApproveAndNext !== undefined ? { next, run: onApproveAndNext } : null;

  if (mode === "approve" || (mode === "approve-next" && andNext)) {
    const withNext = mode === "approve-next" && andNext !== null;
    return (
      <ApproveConfirm
        name={name}
        email={email}
        nextName={withNext && andNext ? andNext.next.name : null}
        onConfirm={async () => {
          const failure = await (withNext && andNext ? andNext.run() : onApprove());
          if (!failure) {
            setMode("idle");
          }
          return failure;
        }}
        onCancel={() => {
          const back = withNext ? nextRef : approveRef;
          setMode("idle");
          focusSoon(() => back.current);
        }}
      />
    );
  }

  if (mode === "reject") {
    return (
      <RejectForm
        onSubmit={async (reason) => {
          const failure = await onReject(reason);
          if (!failure) {
            setMode("idle");
            if (afterReject) {
              focusSoon(afterReject);
            }
          }
          return failure;
        }}
        onCancel={() => {
          setMode("idle");
          focusSoon(() => rejectRef.current);
        }}
      />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {completeInShopify ? null : (
          <button
            ref={approveRef}
            type="button"
            onClick={() => setMode("approve")}
            disabled={approveBlock !== null}
            aria-describedby={approveBlock ? `${id}-approve-why` : undefined}
            className={ui.buttonPrimary}
          >
            <CheckCircleIcon size={16} aria-hidden />
            Approve
          </button>
        )}
        {andNext ? (
          <button
            ref={nextRef}
            type="button"
            onClick={() => setMode("approve-next")}
            disabled={approveBlock !== null}
            aria-describedby={approveBlock ? `${id}-approve-why` : `${id}-next`}
            className={ui.buttonSecondary}
          >
            <ArrowRightIcon size={16} aria-hidden />
            Approve and next
          </button>
        ) : null}
        {rejected ? null : (
          <button
            ref={rejectRef}
            type="button"
            onClick={() => setMode("reject")}
            disabled={rejectBlock !== null}
            aria-describedby={rejectBlock ? rejectWhyId : undefined}
            className={ui.buttonDangerSecondary}
          >
            <XCircleIcon size={16} aria-hidden />
            Reject
          </button>
        )}
      </div>
      {andNext && approveBlock === null ? (
        <p id={`${id}-next`} className="sr-only">
          {`Then request ${andNext.next.name} opens.`}
        </p>
      ) : null}
      {approveWhyShown ? (
        <p id={`${id}-approve-why`} className="mt-2 text-sm text-ink-2">
          {approveBlock}
        </p>
      ) : null}
      {rejectWhyShown ? (
        <p id={`${id}-reject-why`} className="mt-2 text-sm text-ink-2">
          {rejectBlock}
        </p>
      ) : null}
    </div>
  );
}

export type ReviewPanelProps = ReviewSummaryProps & Omit<ReviewActionsProps, "afterReject">;

// Both in one panel (the drawer's body until the phone action bar, Task 19,
// moves the actions to its footer).
export function ReviewPanel(props: ReviewPanelProps) {
  const id = useId();
  const titleId = `${id}-title`;
  return (
    <section aria-labelledby={titleId} className="mb-5 rounded-panel border border-line bg-surface-2 p-4">
      <ReviewSummary canReview={props.canReview} rejected={props.rejected} completeInShopify={props.completeInShopify} titleId={titleId} />
      {props.canReview ? (
        <div className="mt-3">
          <ReviewActions {...props} afterReject={() => document.getElementById(titleId)} />
        </div>
      ) : null}
    </section>
  );
}
```

3f. `src/components/desk/order-drawer.tsx`:
- Props: add `nextRequest?: NextRequest | null;` and `onApproveAndNext?: () => Promise<string | null>;` (import `type NextRequest` from `./review-panel`).
- The skeleton heading (`<h2 id={labelId} className="sr-only">Order details</h2>`) gets `tabIndex={-1}`, so focus can land on it while the next request loads.
- Pass to `ReviewPanel`:

```tsx
                next={nextRequest ?? null}
                onApproveAndNext={
                  onApproveAndNext
                    ? async () => {
                        const failure = await onApproveAndNext();
                        if (!failure) {
                          focusSoon(() => document.getElementById(labelId));
                        }
                        return failure;
                      }
                    : undefined
                }
```

3g. `src/components/desk/desk.tsx`:
- `const { workspace, userId, role, connection, subscribe, refreshQueue } = useWorkspace();`
- `approve` takes options and skips the automatic purchase order review for Approve and next:

```ts
  const approve = useCallback(
    async (orderId: string, opts: { openPo: boolean } = { openPo: true }): Promise<string | null> => {
```

  In the `approved` branch replace the toast and PO lines with:

```ts
        const poLater = !opts.openPo && body.triggersPo === true && canManagePos;
        toast({
          title: `Approved. Order ${body.orderName ?? ""} created in Shopify.`,
          body: poLater ? "Create its purchase order from the order when you are ready." : undefined,
          tone: "good",
        });
        if (body.triggersPo && canManagePos && opts.openPo) {
          setPoModal({ orderId, po: null });
        }
```

  and add `refreshQueue();` after `void reload();` (add `refreshQueue` to the deps). In `reject`, call `refreshQueue();` after a `rejected` result.
- Add after `reject`:

```ts
  // Approve and next (comprehensive desk design section 1): approve, then
  // open the next waiting request in place of this one (no extra history
  // entry, so Back still closes the drawer).
  const approveAndNext = useCallback(
    async (orderId: string, nextId: string): Promise<string | null> => {
      const failure = await approve(orderId, { openPo: false });
      if (failure) {
        return failure;
      }
      const params = new URLSearchParams(window.location.search);
      params.set("order", nextId);
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      return null;
    },
    [approve],
  );
```

- Next to `drawerSummary` add `const nextRequest = drawerOrderId ? nextWaitingRequest(visible, drawerOrderId, closedKeys) : null;` (import `nextWaitingRequest`), and pass to `OrderDrawerContent`:

```tsx
            nextRequest={nextRequest}
            onApproveAndNext={nextRequest ? () => approveAndNext(drawerOrderId, nextRequest.id) : undefined}
```

3h. `src/server/notify.ts`:

```ts
// A desk link's query: the approval queue for a new request (the approver
// lands on the queue with the request open), the order alone otherwise.
function orderQuery(orderId: string | null, view: "approval" | null = null): string {
  const params = new URLSearchParams();
  if (view) {
    params.set("view", view);
  }
  if (orderId) {
    params.set("order", orderId);
  }
  const text = params.toString();
  return text.length > 0 ? `?${text}` : "";
}
```

`pushLink` and `emailLink` take a last parameter `view: "approval" | null = null` and pass it to `orderQuery`. In `notifyNewOrders`:

```ts
    // A request opens the approval queue; a digest of requests only, too.
    const viewFor = (order: OrderSummaryForEmail | null) =>
      (order ? order.kind === "draft" : fresh.every((entry) => entry.kind === "draft")) ? ("approval" as const) : null;
    const context = (target: PushTarget, order: OrderSummaryForEmail | null) => ({
      workspaceName: workspace.name,
      ownHost: onOwnHost(workspace, target.host),
      url: pushLink(env, workspace, order?.id ?? null, target.host, viewFor(order)),
    });
    const noticeBuilders: Array<(target: PushTarget) => PushNotice> = digest
      ? [(target) => digestNotice(fresh, context(target, null))]
      : fresh.map((order) => (target: PushTarget) => newOrderNotice(order, context(target, order)));
```

and the emails:

```ts
    const emails = digest
      ? [newOrdersDigestEmail(env, workspace, fresh, emailLink(env, workspace, null, viewFor(null)))]
      : fresh.map((order) => newOrderEmail(env, workspace, order, emailLink(env, workspace, order.id, viewFor(order))));
```

(Import `type OrderSummaryForEmail` if `notify.ts` does not already name it; `summaryOf` returns it.)

**Step 4: Run them and see them pass**

Run the six test files from Step 2.
Expected: PASS. Then `npm run test` (other notify tests keep `?order=` for orders and activity).

Local visual check as a manager: the top bar shows Needs approval with the count (icon and badge at 375); it opens the approval view, waiting longest first; in a request's drawer, Approve and next opens the confirmation with focus on the question, a press within 400 ms does nothing, Escape returns focus to Approve and next; after it (on the local sample store the approve call fails without real credentials, so check the error stays in the step) the next card opens. As staff: no link, no buttons.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/app/api/workspaces/[id]/queue/route.ts src/app/api/workspaces/[id]/queue/route.test.ts src/components/shell/workspace-provider.tsx src/components/shell/top-bar.tsx src/components/shell/top-bar.test.ts src/lib/desk-state.ts src/lib/desk-state.test.ts src/components/desk/review-panel.tsx src/components/desk/review-panel.test.ts src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/components/desk/desk.tsx src/server/notify.ts src/server/notify.test.ts"
git add $FILES
git commit -m "feat: Needs approval queue with a top bar count and Approve and next" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 15: Filters in the URL

View, status, kind, search and sort live in the address, so push and email links open the exact view, reloads keep it, and the top bar's Needs approval link switches the open desk. Changes replace the history entry (typing a search adds no Back steps). @design-taste-frontend

**Files:**
- Modify: `src/lib/desk-query.ts` (add `mergeDeskSearch`)
- Create: `src/components/desk/use-desk-filter.ts`
- Modify: `src/components/desk/desk.tsx` (the filter state from Task 12 and every `setFilter` call)
- Test: `src/lib/desk-query.test.ts`

**Step 1: Write the failing test**

Append to `src/lib/desk-query.test.ts` (import `mergeDeskSearch`):

```ts
describe("mergeDeskSearch", () => {
  it("applies a change and keeps everything else, the open order included", () => {
    expect(mergeDeskSearch("?status=new&order=d12", { q: "vest" })).toBe("?status=new&q=vest&order=d12");
    expect(mergeDeskSearch("?q=vest", { q: "" })).toBe("");
  });

  it("moves a default sort along with the view, and keeps a chosen one", () => {
    expect(mergeDeskSearch("", { view: "approval", status: null })).toBe("?view=approval");
    expect(mergeDeskSearch("?view=approval", { view: "open" })).toBe("");
    expect(mergeDeskSearch("?sort=oldest", { view: "approval" })).toBe("?view=approval&sort=oldest");
  });
});
```

**Step 2: Run it and see it fail**

Run: `npx vitest run src/lib/desk-query.test.ts`
Expected: FAIL, `mergeDeskSearch is not a function`.

**Step 3: Minimal implementation**

3a. Append to `src/lib/desk-query.ts`:

```ts
// The address's query string after a filter change: the current query with
// patch applied, the open order kept. A sort left at its view's default
// follows the view (the approval queue waits longest first).
export function mergeDeskSearch(currentSearch: string, patch: Partial<DeskQuery>): string {
  const params = new URLSearchParams(currentSearch);
  const current = parseDeskQuery(params);
  const next: DeskQuery = { ...current, ...patch };
  if (patch.view !== undefined && patch.sort === undefined && current.sort === defaultSort(current.view)) {
    next.sort = defaultSort(patch.view);
  }
  return deskSearch(next, params.get("order"));
}
```

3b. Create `src/components/desk/use-desk-filter.ts`:

```ts
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
```

3c. `src/components/desk/desk.tsx`:
- Import `useDeskFilter` from `./use-desk-filter`; drop `parseDeskQuery` and `defaultSort` from the `@/lib/desk-query` import (keep the types).
- Replace the `filter` state from Task 12 (the `useState<DeskFilter>(() => { const initial = parseDeskQuery(...` block and the `const view` line) with:

```ts
  // The view and filters live in the address (use-desk-filter.ts).
  const [deskQuery, updateDeskQuery] = useDeskFilter();
  const filter = useMemo<DeskFilter>(
    () => ({ query: deskQuery.q, statusKey: deskQuery.status, sort: deskQuery.sort, kind: deskQuery.kind, view: deskQuery.view }),
    [deskQuery],
  );
  const view: DeskView = deskQuery.view;
```

- Replace every `setFilter` call:
  - `onStatus={(statusKey) => updateDeskQuery({ status: statusKey })}`
  - `onQuery={(query) => updateDeskQuery({ q: query })}`
  - `onSort={(sort) => updateDeskQuery({ sort })}`
  - `onKind: (kind: DeskKind) => updateDeskQuery({ kind })`
  - `onView={(next) => updateDeskQuery({ view: next, status: null })}`
  - `NoMatches` `onClear={() => updateDeskQuery({ q: "", status: null, kind: "all" })}`
  - the Deleted effect: `if (deskQuery.kind === "deleted" && drafts.deletedDraftCount === 0) { updateDeskQuery({ kind: "all" }); }` with deps `[deskQuery.kind, drafts.deletedDraftCount, updateDeskQuery]`.
- `grep -n "setFilter" src/components/desk/desk.tsx` must print nothing.

**Step 4: Run it and see it pass**

Run: `npx vitest run src/lib/desk-query.test.ts`
Expected: PASS. Then `npm run test`.

Local visual check: pick Closed, a status and a search; the address shows `?view=closed&status=...&q=...`; reload keeps them; open a card (the address gains `order=`), Back closes the drawer and keeps the filters; the top bar's Needs approval switches the open desk to the approval view; a fresh tab on `/w/<slug>?view=approval&order=<id>` opens that request in the queue.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/desk-query.ts src/lib/desk-query.test.ts src/components/desk/use-desk-filter.ts src/components/desk/desk.tsx"
git add $FILES
git commit -m "feat: desk filters in the URL (view, status, kind, search, sort)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 16: Bulk status change with server re-check

Row checkboxes and shift-click select cards; one confirmation lists every selected card and says which will stay where they are. Drafts keep their rules (no bulk approve or reject, never into a fulfilled or delivered status) and the server re-checks every card with the same rule set as one change. At most 25 cards at a time. @design-taste-frontend

**Files:**
- Create: `src/lib/status-rules.ts`, `src/lib/selection.ts`, `src/app/api/workspaces/[id]/orders/status/route.ts`, `src/components/desk/bulk-bar.tsx`
- Modify: `src/server/desk/mutations.ts` (imports 6-12, `changeOrderStatus` 70-170; add `changeOrderStatuses`)
- Modify: `src/components/kit.tsx` (add `SelectBox`)
- Modify: `src/components/desk/order-list.tsx` (from Tasks 10 and 13: `ListProps`, table head and rows, card header)
- Modify: `src/components/desk/desk-skeleton.tsx` (row grid), `src/components/desk/desk.tsx` (selection state, bulk move, render)
- Test: `src/lib/status-rules.test.ts`, `src/lib/selection.test.ts`, `src/app/api/workspaces/[id]/orders/status/route.test.ts`, `src/components/desk/bulk-bar.test.ts` (all new), `src/server/desk/mutations.test.ts`, `src/components/kit.test.ts`, `src/components/desk/order-list.test.ts`

**Step 1: Write the failing tests**

Create `src/lib/status-rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { StatusView } from "@/server/desk/shapes";
import { checkStatusMove, planBulkMove } from "./status-rules";

const status = (label: string, shopifyLink: string | null = null) => ({ label, shopifyLink });

describe("checkStatusMove", () => {
  it("lets a request move between unlinked statuses, staff included", () => {
    expect(checkStatusMove({ isDraft: true, role: "staff", current: status("New"), target: status("On Hold") })).toEqual({ ok: true });
  });

  it("keeps a request out of fulfilled, delivered, Draft approved and Draft rejected statuses", () => {
    const move = (target: { label: string; shopifyLink: string | null }) =>
      checkStatusMove({ isDraft: true, role: "manager", current: status("New"), target });
    expect(move(status("Shipped", "fulfilled"))).toEqual({
      ok: false,
      forbidden: false,
      error: "A draft cannot be marked Shipped until it is approved and becomes an order.",
    });
    expect(move(status("Delivered", "delivered"))).toMatchObject({ ok: false });
    expect(move(status("Approved", "draft_completed"))).toEqual({
      ok: false,
      forbidden: false,
      error: "Use Approve to approve this request. It creates the order in Shopify.",
    });
    expect(move(status("Rejected", "draft_rejected"))).toEqual({
      ok: false,
      forbidden: false,
      error: "Use Reject to reject this request. It asks for a reason.",
    });
  });

  it("lets only a manager reopen a rejected request", () => {
    const current = status("Rejected", "draft_rejected");
    expect(checkStatusMove({ isDraft: true, role: "staff", current, target: status("New") })).toEqual({
      ok: false,
      forbidden: true,
      error: "Only a manager can reopen a rejected request.",
    });
    expect(checkStatusMove({ isDraft: true, role: "manager", current, target: status("New") })).toEqual({ ok: true });
  });

  it("keeps an order out of Rejected and lets it go anywhere else", () => {
    expect(checkStatusMove({ isDraft: false, role: "staff", current: status("New"), target: status("Rejected", "draft_rejected") })).toEqual({
      ok: false,
      forbidden: false,
      error: "Rejected is for requests that are still drafts.",
    });
    expect(checkStatusMove({ isDraft: false, role: "staff", current: status("New"), target: status("Shipped", "fulfilled") })).toEqual({ ok: true });
  });
});

describe("planBulkMove", () => {
  it("says which selected cards will stay, and why", () => {
    const statuses: StatusView[] = [
      { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
      { key: "shipped", label: "Shipped", color: "violet", sort: 1, triggersPo: false, shopifyLink: "fulfilled", closed: false },
    ];
    const plan = planBulkMove(
      [
        { id: "o1", name: "#1001", customerName: "Jordan Vale", kind: "order", statusKey: "new" },
        { id: "d1", name: "#D12", customerName: "Casey Lin", kind: "draft", statusKey: "new" },
        { id: "o2", name: "#1002", customerName: "Sam Ortiz", kind: "order", statusKey: "shipped" },
      ],
      statuses[1],
      statuses,
      "staff",
    );
    expect(plan.map((row) => [row.card.id, row.stays])).toEqual([
      ["o1", null],
      ["d1", "A draft cannot be marked Shipped until it is approved and becomes an order."],
      ["o2", "Already in Shipped."],
    ]);
  });
});
```

Create `src/lib/selection.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectAll, toggleSelection } from "./selection";

const ids = ["a", "b", "c", "d", "e"];
const none = { selected: new Set<string>(), anchor: null };

describe("toggleSelection", () => {
  it("toggles one card and remembers it as the anchor", () => {
    const one = toggleSelection(none, ids, "b", { range: false, max: 25 });
    expect([...one.selected]).toEqual(["b"]);
    expect(one.anchor).toBe("b");
    expect([...toggleSelection(one, ids, "b", { range: false, max: 25 }).selected]).toEqual([]);
  });

  it("selects or clears every card between the anchor and a shift-clicked one, in list order", () => {
    const anchored = toggleSelection(none, ids, "b", { range: false, max: 25 });
    const range = toggleSelection(anchored, ids, "d", { range: true, max: 25 });
    expect([...range.selected].sort()).toEqual(["b", "c", "d"]);
    const cleared = toggleSelection(range, ids, "c", { range: true, max: 25 });
    expect([...cleared.selected].sort()).toEqual(["b"]);
  });

  it("stops at the cap and says so", () => {
    const capped = toggleSelection({ selected: new Set(["a"]), anchor: "a" }, ids, "e", { range: true, max: 3 });
    expect(capped.selected.size).toBe(3);
    expect(capped.capped).toBe(true);
  });
});

describe("selectAll", () => {
  it("selects every card shown up to the cap", () => {
    expect(selectAll(ids, 25)).toEqual({ selected: new Set(ids), capped: false });
    expect(selectAll(ids, 2)).toEqual({ selected: new Set(["a", "b"]), capped: true });
  });
});
```

Append to `src/server/desk/mutations.test.ts` (import `changeOrderStatuses`):

```ts
describe("changeOrderStatuses (bulk)", () => {
  const bulk = (role: "staff" | "manager" = "staff") => ({ workspaceId: WS, userId: USER, role, now: NOW });

  it("moves every card it may in one batch, each with its own status entry", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o2", name: "#1002", statusKey: "processing" });
    const record: unknown[][] = [];
    const result = await changeOrderStatuses(withBatch(db, record), bulk(), { orderIds: ["o1", "o2"], statusKey: "shipped" });
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.results).toEqual([
      { orderId: "o1", name: "#1001", outcome: "changed" },
      { orderId: "o2", name: "#1002", outcome: "changed" },
    ]);
    expect(record).toHaveLength(1);
    expect(record[0]).toHaveLength(4);
    expect((await orderRow(db, "o2")).statusKey).toBe("shipped");
    expect((await orderRow(db, "o2")).statusSetBy).toBe(USER);
    const entries = (await eventsOf(db)).map((entry) => [entry.orderId, entry.text, entry.meta]);
    expect(entries).toEqual(
      expect.arrayContaining([
        ["o1", "Status set to Shipped", { from: "new", to: "shipped", bulk: true }],
        ["o2", "Status set to Shipped", { from: "processing", to: "shipped", bulk: true }],
      ]),
    );
    expect(result.changed.map((change) => change.order.id)).toEqual(["o1", "o2"]);
    expect(result.statusLabel).toBe("Shipped");
  });

  it("re-checks every card: no request into a fulfilled status or Approved, no staff reopening a rejected one", async () => {
    const db = await setup();
    await seedDraftStatuses(db, WS);
    await seedDraft(db, WS, { id: "d1" });
    await seedDraft(db, WS, { id: "d2", statusKey: "rejected" });
    const shipped = await changeOrderStatuses(db, bulk(), { orderIds: ["o1", "d1"], statusKey: "shipped" });
    if (shipped.kind !== "ok") throw new Error(shipped.kind);
    expect(shipped.results.map((row) => [row.orderId, row.outcome, row.error ?? null])).toEqual([
      ["o1", "changed", null],
      ["d1", "refused", "A draft cannot be marked Shipped until it is approved and becomes an order."],
    ]);
    const approved = await changeOrderStatuses(db, bulk("manager"), { orderIds: ["d1"], statusKey: "approved" });
    if (approved.kind !== "ok") throw new Error(approved.kind);
    expect(approved.results[0]).toMatchObject({ outcome: "refused", error: "Use Approve to approve this request. It creates the order in Shopify." });
    const reopen = await changeOrderStatuses(db, bulk("staff"), { orderIds: ["d2"], statusKey: "processing" });
    if (reopen.kind !== "ok") throw new Error(reopen.kind);
    expect(reopen.results[0]).toMatchObject({ outcome: "refused", error: "Only a manager can reopen a rejected request." });
    expect((await orderRow(db, "d1")).statusKey).toBe("new");
    expect((await orderRow(db, "d2")).statusKey).toBe("rejected");
  });

  it("says which cards were already there or are not in this workspace", async () => {
    const db = await setup();
    const result = await changeOrderStatuses(db, bulk(), { orderIds: ["o1", "x1", "nope"], statusKey: "new" });
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.results).toEqual([
      { orderId: "o1", name: "#1001", outcome: "unchanged" },
      { orderId: "x1", name: null, outcome: "not-found" },
      { orderId: "nope", name: null, outcome: "not-found" },
    ]);
    expect(result.changed).toEqual([]);
  });

  it("refuses an empty list, more than 25 cards and an unknown status, changing nothing", async () => {
    const db = await setup();
    expect(await changeOrderStatuses(db, bulk(), { orderIds: [], statusKey: "shipped" })).toEqual({
      kind: "invalid",
      error: "Pick at least one card",
    });
    const many = Array.from({ length: 26 }, (_, i) => `o${i}`);
    expect(await changeOrderStatuses(db, bulk(), { orderIds: many, statusKey: "shipped" })).toEqual({
      kind: "invalid",
      error: "Move up to 25 cards at a time",
    });
    expect(await changeOrderStatuses(db, bulk(), { orderIds: ["o1"], statusKey: "gone" })).toEqual({
      kind: "invalid",
      error: "Unknown status for this workspace",
    });
    expect((await orderRow(db, "o1")).statusKey).toBe("new");
  });

  it("asks for a purchase order only when an order moved into a status that starts one", async () => {
    const db = await setup();
    const result = await changeOrderStatuses(db, bulk(), { orderIds: ["o1"], statusKey: "approved" });
    expect(result).toMatchObject({ kind: "ok", triggersPo: true });
  });
});
```

Create `src/app/api/workspaces/[id]/orders/status/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import {
  openTestDb,
  seedDraft,
  seedDraftStatuses,
  seedMember,
  seedOrder,
  seedUser,
  seedWorkspace,
} from "@/server/desk/test-helpers";

const state: {
  db: Db | null;
  session: { user: { id: string; email: string } } | null;
  after: Promise<unknown>[];
} = { db: null, session: null, after: [] };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test" },
    ctx: { waitUntil: (promise: Promise<unknown>) => state.after.push(promise) },
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));
vi.mock("@/server/broadcast", () => ({ broadcast: vi.fn(async () => undefined) }));
vi.mock("@/server/shopify/fanout", () => ({ pushAndShare: vi.fn(async () => undefined) }));
vi.mock("@/server/notify", () => ({ notifyActivity: vi.fn(async () => ({ pushed: 0 })) }));

const { POST } = await import("./route");
const { broadcast } = await import("@/server/broadcast");
const { pushAndShare } = await import("@/server/shopify/fanout");
const { notifyActivity } = await import("@/server/notify");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const post = (body: unknown) =>
  new Request("https://orderingdesk.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.after = [];
  vi.mocked(broadcast).mockClear();
  vi.mocked(pushAndShare).mockClear();
  vi.mocked(notifyActivity).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedDraftStatuses(db, "ws_impact");
  await seedOrder(db, "ws_impact", { id: "o1", name: "#1001" });
  await seedOrder(db, "ws_impact", { id: "o2", name: "#1002", statusKey: "processing" });
  await seedDraft(db, "ws_impact", { id: "d1" });
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("POST /api/workspaces/[id]/orders/status", () => {
  it("answers 401 signed out and 404 to a non-member, moving nothing", async () => {
    const body = { orderIds: ["o1"], statusKey: "shipped" };
    expect((await POST(post(body), context)).status).toBe(401);
    state.session = { user: { id: "u_stranger", email: "stranger@example.com" } };
    expect((await POST(post(body), context)).status).toBe(404);
    expect(state.after).toEqual([]);
  });

  it("moves every card it may, says why the others stay, and writes each to Shopify once after the response", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const response = await POST(post({ orderIds: ["o1", "o2", "d1"], statusKey: "shipped" }), context);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: { orderId: string; outcome: string; error?: string }[] };
    expect(body.results.map((row) => [row.orderId, row.outcome])).toEqual([
      ["o1", "changed"],
      ["o2", "changed"],
      ["d1", "refused"],
    ]);
    await Promise.all(state.after);
    expect(vi.mocked(pushAndShare).mock.calls.map((call) => call[3])).toEqual(["o1", "o2"]);
    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(2);
    // One push per card would flood phones: a bulk move pushes nothing.
    expect(notifyActivity).not.toHaveBeenCalled();
  });

  it("refuses more than 25 cards at once", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const response = await POST(post({ orderIds: Array.from({ length: 26 }, (_, i) => `o${i}`), statusKey: "shipped" }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Move up to 25 cards at a time" });
  });
});
```

Create `src/components/desk/bulk-bar.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { planBulkMove, type BulkCard } from "@/lib/status-rules";
import type { StatusView } from "@/server/desk/shapes";
import { BulkBar, BulkConfirm } from "./bulk-bar";

const STATUSES: StatusView[] = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
  { key: "shipped", label: "Shipped", color: "violet", sort: 1, triggersPo: false, shopifyLink: "fulfilled", closed: false },
  { key: "rejected", label: "Rejected", color: "pink", sort: 2, triggersPo: false, shopifyLink: "draft_rejected", closed: true },
];
const CARDS: BulkCard[] = [
  { id: "o1", name: "#1001", customerName: "Jordan Vale", kind: "order", statusKey: "new" },
  { id: "d1", name: "#D12", customerName: "Casey Lin", kind: "draft", statusKey: "new" },
];

describe("BulkConfirm", () => {
  it("lists every selected card, says which stay and why, and counts only the ones that move", () => {
    const html = renderToStaticMarkup(
      createElement(BulkConfirm, {
        target: STATUSES[1],
        plan: planBulkMove(CARDS, STATUSES[1], STATUSES, "staff"),
        busy: false,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain("Move 1 of 2 selected cards to Shipped?");
    expect(html).toContain(">#1001<");
    expect(html).toContain(">#D12<");
    expect(html).toContain("Stays: A draft cannot be marked Shipped until it is approved and becomes an order.");
    expect(html).toContain(">Move 1 card</button>");
  });
});

describe("BulkBar", () => {
  it("offers every status except Rejected for the selected cards", () => {
    const html = renderToStaticMarkup(
      createElement(BulkBar, {
        cards: CARDS,
        statuses: STATUSES,
        role: "staff",
        busy: false,
        result: null,
        onMove: async () => {},
        onClear: () => {},
        onDismissResult: () => {},
      }),
    );
    expect(html).toContain("2 selected");
    expect(html).toContain(">Shipped</option>");
    expect(html).not.toContain(">Rejected</option>");
    expect(html).toContain(">Clear</button>");
  });

  it("shows the outcome with every card that stayed", () => {
    const html = renderToStaticMarkup(
      createElement(BulkBar, {
        cards: [],
        statuses: STATUSES,
        role: "staff",
        busy: false,
        result: { tone: "warn", text: "Moved 1 card to Shipped.", refusals: [{ name: "#D12", error: "A draft cannot be marked Shipped." }] },
        onMove: async () => {},
        onClear: () => {},
        onDismissResult: () => {},
      }),
    );
    expect(html).toContain("Moved 1 card to Shipped.");
    expect(html).toContain("#D12: A draft cannot be marked Shipped.");
  });
});
```

Append to `src/components/kit.test.ts` (import `SelectBox`):

```ts
describe("SelectBox", () => {
  it("is a labeled native checkbox with a 40px hit area", () => {
    const html = renderToStaticMarkup(createElement(SelectBox, { label: "Select #1001", checked: true, onToggle: () => {} }));
    expect(html).toMatch(/<input type="checkbox" aria-label="Select #1001" checked=""/);
    expect(html).toContain("size-10");
  });
});
```

In `src/components/desk/order-list.test.ts` add `selection: null,` to `base` and append:

```ts
describe("OrderList selection", () => {
  it("puts a selection box on every row and card, and select-all in the table head", () => {
    const selection = { selected: new Set(["1001"]), onToggle: () => {}, onToggleAll: () => {} };
    const table = render("table", { selection });
    expect(table).toContain('aria-label="Select every card shown"');
    expect(table.match(/aria-label="Select #/g)).toHaveLength(3);
    expect(table).toMatch(/<input type="checkbox" aria-label="Select #1001" checked=""/);
    expect(render("cards", { selection }).match(/aria-label="Select #/g)).toHaveLength(3);
  });
});
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/status-rules.test.ts src/lib/selection.test.ts src/server/desk/mutations.test.ts "src/app/api/workspaces/[id]/orders/status/route.test.ts" src/components/desk/bulk-bar.test.ts src/components/kit.test.ts src/components/desk/order-list.test.ts`
Expected: FAIL: the new modules do not resolve; `changeOrderStatuses` and `SelectBox` are not exported; `selection` is not a list prop.

**Step 3: Minimal implementation**

3a. Create `src/lib/status-rules.ts`:

```ts
// The status rules every change obeys (draft orders spec section 8.2 with
// section 18 item 5; bulk moves from the comprehensive desk design section
// 1), in one place: one change and a bulk move on the server
// (src/server/desk/mutations.ts), and the bulk confirmation on the desk,
// which says which cards will stay before anything is sent. The server
// checks every card again.

import type { StatusView } from "../server/desk/shapes";
import { roleAtLeast, type Role } from "./roles";

// A bulk move takes at most this many cards: after the response each moved
// card's status is written to Shopify one card at a time, within the time a
// Worker has after its response.
export const BULK_STATUS_MAX = 25;

type RuleStatus = { label: string; shopifyLink: string | null };

export type MoveCheck = { ok: true } | { ok: false; forbidden: boolean; error: string };

// - A request moves freely between statuses with no Shopify link, staff
//   included; never into a status linked to fulfilled or delivered (it is
//   not an order yet), nor to draft_completed or draft_rejected (Approve and
//   Reject do that, with their own checks and the reason).
// - Out of the draft_rejected status only for a manager or platform admin
//   (forbidden: the single change answers 403, as before).
// - An order never moves into the draft_rejected status.
export function checkStatusMove(input: {
  isDraft: boolean;
  role: Role;
  current: RuleStatus | undefined;
  target: RuleStatus;
}): MoveCheck {
  const { isDraft, role, current, target } = input;
  if (isDraft) {
    if (current?.shopifyLink === "draft_rejected" && !roleAtLeast(role, "manager")) {
      return { ok: false, forbidden: true, error: "Only a manager can reopen a rejected request." };
    }
    switch (target.shopifyLink) {
      case "fulfilled":
      case "delivered":
        return {
          ok: false,
          forbidden: false,
          error: `A draft cannot be marked ${target.label} until it is approved and becomes an order.`,
        };
      case "draft_completed":
        return { ok: false, forbidden: false, error: "Use Approve to approve this request. It creates the order in Shopify." };
      case "draft_rejected":
        return { ok: false, forbidden: false, error: "Use Reject to reject this request. It asks for a reason." };
      default:
        return { ok: true };
    }
  }
  if (target.shopifyLink === "draft_rejected") {
    return { ok: false, forbidden: false, error: "Rejected is for requests that are still drafts." };
  }
  return { ok: true };
}

export type BulkCard = { id: string; name: string; customerName: string; kind: "draft" | "order"; statusKey: string };
export type BulkPlanRow = { card: BulkCard; stays: string | null };

// Each selected card and, when it will not move, why: already there, or
// the rule that keeps it.
export function planBulkMove(cards: BulkCard[], target: StatusView, statuses: StatusView[], role: Role): BulkPlanRow[] {
  return cards.map((card) => {
    if (card.statusKey === target.key) {
      return { card, stays: `Already in ${target.label}.` };
    }
    const check = checkStatusMove({
      isDraft: card.kind === "draft",
      role,
      current: statuses.find((status) => status.key === card.statusKey),
      target,
    });
    return { card, stays: check.ok ? null : check.error };
  });
}
```

3b. Create `src/lib/selection.ts`:

```ts
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
```

3c. `src/server/desk/mutations.ts`:
- Imports: `import { and, eq, inArray, sql } from "drizzle-orm";`, `import { BULK_STATUS_MAX, checkStatusMove } from "@/lib/status-rules";` (keep `roleAtLeast` only if still used; it is not after the refactor).
- Add above `changeOrderStatus`:

```ts
type StatusEvent = {
  id: string;
  workspaceId: string;
  orderId: string;
  type: "status";
  text: string;
  actorId: string;
  meta: Record<string, unknown>;
  createdAt: number;
  source: "app";
};

// The two statements of one status change: the order update and its status
// entry. The status was read before, but replaceStatuses may remove it
// before this write lands, so both re-check in SQL that it still exists:
// the update only matches while it does, and the entry is an insert-select
// that yields its one row only while it does. On D1 a batch is one
// transaction, so the two agree; the update's rows-affected tells which way
// it went.
function statusWrites(db: Db, event: StatusEvent, statusKey: string) {
  const statusStillExists = sql`exists (select 1 from ${statuses} where ${statuses.workspaceId} = ${event.workspaceId} and ${statuses.key} = ${statusKey})`;
  return [
    db
      .update(orders)
      .set({ statusKey, statusSetBy: event.actorId, statusSetAt: event.createdAt })
      .where(and(eq(orders.id, event.orderId), eq(orders.workspaceId, event.workspaceId), statusStillExists)),
    // Values in the events table's column order (schema.ts declares the
    // columns in that order; drizzle names them all in the insert).
    db
      .insert(events)
      .select(
        sql`select ${event.id}, ${event.workspaceId}, ${event.orderId}, ${event.type}, ${event.text}, ${event.actorId}, ${JSON.stringify(event.meta)}, ${event.createdAt}, ${event.source} where ${statusStillExists}`,
      ),
  ];
}
```

- In `changeOrderStatus`, replace the draft and order rules (from `const isDraft = ...` through the `else if (status.shopifyLink === "draft_rejected")` block) with:

```ts
  const isDraft = order.shopifyOrderId === null;
  const check = checkStatusMove({
    isDraft,
    role: ctx.role,
    current: statusRows.find((row) => row.key === order.statusKey),
    target: status,
  });
  if (!check.ok) {
    return check.forbidden ? { kind: "forbidden", error: check.error } : { kind: "invalid", error: check.error };
  }
```

  type the event as `StatusEvent` (`const event: StatusEvent = { ... }`), and replace the `statusStillExists` constant and the `applyBatch(db, [...])` call with `const [updateResult] = await applyBatch(db, statusWrites(db, event, statusKey));`. Shorten its header comment to point at `src/lib/status-rules.ts` for the rules.
- Append:

```ts
export type BulkContext = { workspaceId: string; userId: string; role: Role; now?: number };

export type BulkOutcome = {
  orderId: string;
  // The card's name, or null when it is not in this workspace.
  name: string | null;
  outcome: "changed" | "unchanged" | "refused" | "not-found";
  error?: string;
};

export type BulkStatusResult =
  | { kind: "invalid"; error: string }
  | {
      kind: "ok";
      statusLabel: string;
      results: BulkOutcome[];
      changed: Array<{
        event: EventView;
        order: { id: string; statusKey: string; statusSetBy: string; statusSetAt: number };
      }>;
      // An order moved into a status that starts a purchase order.
      triggersPo: boolean;
    };

function parseBulk(body: unknown): { orderIds: string[]; statusKey: string } | string {
  if (!isRecord(body)) {
    return "Send orderIds and statusKey";
  }
  const { orderIds, statusKey } = body;
  if (typeof statusKey !== "string" || statusKey.length === 0) {
    return "statusKey is required";
  }
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return "Pick at least one card";
  }
  if (orderIds.length > BULK_STATUS_MAX) {
    return `Move up to ${BULK_STATUS_MAX} cards at a time`;
  }
  const ids: string[] = [];
  for (const id of orderIds) {
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      return "orderIds must be card ids";
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return { orderIds: ids, statusKey };
}

// Bulk status change (comprehensive desk design section 1): every card
// checked with the same rules as one change (src/lib/status-rules.ts),
// then every allowed change written in one batch (two statements each, at
// most 50; each statement binds 11 parameters or fewer). Cards outside the
// workspace answer not-found, like an unknown id.
export async function changeOrderStatuses(db: Db, ctx: BulkContext, body: unknown): Promise<BulkStatusResult> {
  const parsed = parseBulk(body);
  if (typeof parsed === "string") {
    return { kind: "invalid", error: parsed };
  }
  const [orderRows, statusRows] = await Promise.all([
    db
      .select({ id: orders.id, name: orders.name, statusKey: orders.statusKey, shopifyOrderId: orders.shopifyOrderId })
      .from(orders)
      .where(and(eq(orders.workspaceId, ctx.workspaceId), inArray(orders.id, parsed.orderIds))),
    db
      .select({ key: statuses.key, label: statuses.label, triggersPo: statuses.triggersPo, shopifyLink: statuses.shopifyLink })
      .from(statuses)
      .where(eq(statuses.workspaceId, ctx.workspaceId)),
  ]);
  const target = statusRows.find((row) => row.key === parsed.statusKey);
  if (!target) {
    return { kind: "invalid", error: "Unknown status for this workspace" };
  }
  const now = ctx.now ?? Date.now();
  const results: BulkOutcome[] = [];
  const planned: Array<{ order: (typeof orderRows)[number]; event: StatusEvent }> = [];
  for (const id of parsed.orderIds) {
    const order = orderRows.find((row) => row.id === id);
    if (!order) {
      results.push({ orderId: id, name: null, outcome: "not-found" });
      continue;
    }
    if (order.statusKey === target.key) {
      results.push({ orderId: id, name: order.name, outcome: "unchanged" });
      continue;
    }
    const check = checkStatusMove({
      isDraft: order.shopifyOrderId === null,
      role: ctx.role,
      current: statusRows.find((row) => row.key === order.statusKey),
      target,
    });
    if (!check.ok) {
      results.push({ orderId: id, name: order.name, outcome: "refused", error: check.error });
      continue;
    }
    planned.push({
      order,
      event: {
        id: crypto.randomUUID(),
        workspaceId: ctx.workspaceId,
        orderId: order.id,
        type: "status",
        text: `Status set to ${target.label}`,
        actorId: ctx.userId,
        meta: { from: order.statusKey, to: target.key, bulk: true },
        createdAt: now,
        source: "app",
      },
    });
    results.push({ orderId: id, name: order.name, outcome: "changed" });
  }

  const writes = await applyBatch(
    db,
    planned.flatMap(({ event }) => statusWrites(db, event, target.key)),
  );
  const changed: Extract<BulkStatusResult, { kind: "ok" }>["changed"] = [];
  let triggersPo = false;
  planned.forEach(({ order, event }, index) => {
    if (rowsAffected(writes[index * 2], "desk") === 0) {
      const result = results.find((entry) => entry.orderId === order.id);
      if (result) {
        result.outcome = "refused";
        result.error = "Unknown status for this workspace";
      }
      return;
    }
    changed.push({
      event: eventView(event),
      order: { id: order.id, statusKey: target.key, statusSetBy: ctx.userId, statusSetAt: now },
    });
    triggersPo ||= target.triggersPo && order.shopifyOrderId !== null;
  });
  return { kind: "ok", statusLabel: target.label, results, changed, triggersPo };
}
```

3d. Create `src/app/api/workspaces/[id]/orders/status/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { broadcast } from "@/server/broadcast";
import { changeOrderStatuses } from "@/server/desk/mutations";
import { guardResponse, requireMember } from "@/server/guard";
import { pushAndShare } from "@/server/shopify/fanout";

type RouteContext = { params: Promise<{ id: string }> };

// Bulk status change (comprehensive desk design section 1). Body {orderIds
// (up to 25), statusKey}. Every member who can change one card's status
// (staff included); 401 signed out, 404 for outsiders. The server checks
// every card with the rules of one change (src/lib/status-rules.ts): no
// bulk approve or reject, no request into a fulfilled or delivered status,
// no staff reopening a rejected request; cards it refuses are listed with
// why, and nothing about them changes. 200 {statusLabel, results:
// [{orderId, name, outcome, error?}], changed: [{event, order}],
// triggersPo}; 400 {error}. After the response each moved card is
// broadcast, then its status goes to Shopify one card at a time, each write
// sent once (pushAndShare, as for one change). A bulk move sends no
// all-activity pushes: one per card would flood phones.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId, role } = await requireMember(id, "staff");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await changeOrderStatuses(db, { workspaceId: id, userId, role }, body);
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    if (result.changed.length > 0) {
      const { env, ctx } = getCloudflareContext();
      ctx.waitUntil(
        (async () => {
          for (const change of result.changed) {
            await broadcast(env, id, { kind: "order.status", event: change.event, order: change.order });
          }
          for (const change of result.changed) {
            await pushAndShare(db, env, id, change.order.id);
          }
        })(),
      );
    }
    return NextResponse.json({
      statusLabel: result.statusLabel,
      results: result.results,
      changed: result.changed,
      triggersPo: result.triggersPo,
    });
  } catch (e) {
    return guardResponse(e);
  }
}
```

3e. Append to `src/components/kit.tsx`:

```tsx
// A list row's selection box: a native checkbox drawn at 16px with a 40px
// hit area. onToggle says whether shift was held (a range). Clicks stop
// here, so the row under it does not open.
export function SelectBox({
  label,
  checked,
  indeterminate = false,
  onToggle,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  onToggle: (range: boolean) => void;
}) {
  return (
    <label
      onClick={(event) => event.stopPropagation()}
      className="inline-grid size-10 shrink-0 cursor-pointer place-items-center rounded-control hover:bg-surface-2"
    >
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        ref={(element) => {
          if (element) {
            element.indeterminate = indeterminate && !checked;
          }
        }}
        onChange={(event) => onToggle((event.nativeEvent as MouseEvent).shiftKey === true)}
        className="size-4 cursor-pointer accent-[var(--primary-strong)]"
      />
    </label>
  );
}
```

3f. `src/components/desk/order-list.tsx`:
- `ListProps` gains:

```ts
  // Bulk selection (null: no selection boxes).
  selection: {
    selected: ReadonlySet<string>;
    onToggle: (orderId: string, range: boolean) => void;
    onToggleAll: () => void;
  } | null;
```

- `OrderTable`: destructure `selection`; first column `<col className="w-14" />`; first header cell:

```tsx
            <th scope="col" className="pl-2.5">
              {selection ? (
                <SelectBox
                  label="Select every card shown"
                  checked={orders.length > 0 && orders.every((order) => selection.selected.has(order.id))}
                  indeterminate={orders.some((order) => selection.selected.has(order.id))}
                  onToggle={() => selection.onToggleAll()}
                />
              ) : (
                <span className="sr-only">Select</span>
              )}
            </th>
```

  and first cell of each row:

```tsx
                <td className={`pl-2.5 ${flash}`}>
                  {selection ? (
                    <SelectBox
                      label={`Select ${order.name}`}
                      checked={selection.selected.has(order.id)}
                      onToggle={(range) => selection.onToggle(order.id, range)}
                    />
                  ) : null}
                </td>
```

  The order cell's left padding becomes `px-2`.
- `OrderCards`: destructure `selection`; first child of the header row:

```tsx
            {selection ? (
              <span className="relative z-10 -my-2 -ml-2.5">
                <SelectBox
                  label={`Select ${order.name}`}
                  checked={selection.selected.has(order.id)}
                  onToggle={(range) => selection.onToggle(order.id, range)}
                />
              </span>
            ) : null}
```

- Import `SelectBox` with `Chip` from `@/components/kit`.

3g. `src/components/desk/desk-skeleton.tsx`: the row grid gains a leading `3.5rem` column (`grid-cols-[3.5rem_10rem_6.5rem_24%_1fr_5.5rem_7rem_11rem]`) and a first cell `<div className="pl-4"><Bar className="size-4" /></div>`.

3h. Create `src/components/desk/bulk-bar.tsx`:

```tsx
"use client";

// Bulk status change (comprehensive desk design section 1): the bar at the
// bottom of the desk while cards are selected. Pick a status, then one
// confirmation lists every selected card and says which will stay where
// they are and why (src/lib/status-rules.ts; the server checks each card
// again). The outcome stays in the bar until dismissed, with every card
// that did not move.

import { useEffect, useId, useRef, useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { XIcon } from "@phosphor-icons/react/X";
import type { Role } from "@/lib/roles";
import { BULK_STATUS_MAX, planBulkMove, type BulkCard, type BulkPlanRow } from "@/lib/status-rules";
import type { StatusView } from "@/server/desk/shapes";
import { InlineMessage, Spinner } from "@/components/kit";
import { ui } from "@/components/ui";

export type BulkResult = { tone: "good" | "warn"; text: string; refusals: { name: string; error: string }[] };

export function BulkConfirm({
  target,
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  target: StatusView;
  plan: BulkPlanRow[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const questionRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    questionRef.current?.focus();
  }, []);
  const movable = plan.filter((row) => row.stays === null).length;
  return (
    <div
      role="group"
      aria-labelledby={`${id}-question`}
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={`${id}-question`} ref={questionRef} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
        {`Move ${movable} of ${plan.length} selected ${plan.length === 1 ? "card" : "cards"} to ${target.label}?`}
      </p>
      <ul aria-label="Selected cards" className="flex max-h-48 flex-col divide-y divide-line overflow-y-auto rounded-panel border border-line bg-surface text-sm">
        {plan.map(({ card, stays }) => (
          <li key={card.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
            <span className="font-mono font-semibold tabular-nums text-ink">{card.name}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2">{card.customerName || "No customer name"}</span>
            {stays ? <span className="w-full text-xs text-warn">{`Stays: ${stays}`}</span> : null}
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || movable === 0}
          aria-busy={busy || undefined}
          aria-describedby={`${id}-question`}
          className={ui.buttonPrimary}
        >
          {busy ? <Spinner /> : null}
          {busy ? "Moving" : `Move ${movable} ${movable === 1 ? "card" : "cards"}`}
        </button>
      </div>
    </div>
  );
}

export function BulkBar({
  cards,
  statuses,
  role,
  busy,
  result,
  onMove,
  onClear,
  onDismissResult,
}: {
  // The selected cards, in list order.
  cards: BulkCard[];
  statuses: StatusView[];
  role: Role;
  busy: boolean;
  result: BulkResult | null;
  onMove: (statusKey: string) => Promise<void>;
  onClear: () => void;
  onDismissResult: () => void;
}) {
  const [target, setTarget] = useState<StatusView | null>(null);
  // Reject has its own step with a reason; it is never a bulk move.
  const options = statuses.filter((status) => status.shopifyLink !== "draft_rejected");
  if (cards.length === 0 && !result) {
    return null;
  }
  return (
    // z-20: under the top bar (z-30), the drawer (z-40) and toasts (z-50);
    // the open drawer makes it inert with the rest of the page.
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface shadow-lift">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
        {result ? (
          <InlineMessage
            tone={result.tone === "good" ? "good" : "warn"}
            action={
              <button type="button" onClick={onDismissResult} className={`${ui.iconButton} size-9 text-tone-text`}>
                <XIcon size={16} aria-hidden />
                <span className="sr-only">Dismiss</span>
              </button>
            }
          >
            {result.text}
            {result.refusals.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {result.refusals.map((refusal, index) => (
                  <li key={index}>{`${refusal.name}: ${refusal.error}`}</li>
                ))}
              </ul>
            ) : null}
          </InlineMessage>
        ) : null}
        {cards.length > 0 && target ? (
          <BulkConfirm
            target={target}
            plan={planBulkMove(cards, target, statuses, role)}
            busy={busy}
            onConfirm={async () => {
              await onMove(target.key);
              setTarget(null);
            }}
            onCancel={() => setTarget(null)}
          />
        ) : cards.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-ink" aria-live="polite">
              {`${cards.length} selected`}
            </p>
            <div className="relative ml-auto">
              <label htmlFor="bulk-status" className="sr-only">
                Move the selected cards to
              </label>
              <select
                id="bulk-status"
                value=""
                onChange={(event) => {
                  const next = options.find((status) => status.key === event.target.value);
                  if (next) {
                    setTarget(next);
                  }
                }}
                className={`${ui.input} w-auto cursor-pointer appearance-none pr-9 font-medium`}
              >
                <option value="" disabled>
                  Move to a status
                </option>
                {options.map((status) => (
                  <option key={status.key} value={status.key}>
                    {status.label}
                  </option>
                ))}
              </select>
              <CaretDownIcon size={12} aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-2" />
            </div>
            <button type="button" onClick={onClear} className={ui.buttonQuiet}>
              Clear
            </button>
            <p className="w-full text-xs text-ink-2">
              {`Up to ${BULK_STATUS_MAX} at a time.`}
              <span className="max-desk:hidden"> Shift-click selects a range.</span>
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

3i. `src/components/desk/desk.tsx`:
- Imports: `import { BULK_STATUS_MAX, type BulkCard } from "@/lib/status-rules";`, `import { selectAll, toggleSelection, type Selection } from "@/lib/selection";`, `import { BulkBar, type BulkResult } from "./bulk-bar";`.
- State:

```ts
  // Bulk selection (comprehensive desk design section 1).
  const [selection, setSelection] = useState<Selection>({ selected: new Set(), anchor: null });
  const selectionRef = useRef(selection);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  const replaceSelection = useCallback((next: Selection) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  // A different filter shows different cards: start the selection over.
  useEffect(() => {
    replaceSelection({ selected: new Set(), anchor: null });
  }, [deskQuery.view, deskQuery.status, deskQuery.kind, deskQuery.q, replaceSelection]);
```

- After `visible`:

```ts
  const visibleIds = useMemo(() => visible.map((row) => row.id), [visible]);
  const selectedCards: BulkCard[] = useMemo(
    () =>
      visible
        .filter((row) => selection.selected.has(row.id))
        .map((row) => ({ id: row.id, name: row.name, customerName: row.customerName, kind: row.kind, statusKey: row.statusKey })),
    [visible, selection],
  );

  const capNotice = useCallback(() => {
    toast({ title: `Up to ${BULK_STATUS_MAX} cards at a time`, body: "Move these, then pick the rest.", tone: "info" });
  }, [toast]);

  const toggleCard = useCallback(
    (orderId: string, range: boolean) => {
      const next = toggleSelection(selectionRef.current, visibleIds, orderId, { range, max: BULK_STATUS_MAX });
      replaceSelection({ selected: next.selected, anchor: next.anchor });
      if (next.capped) {
        capNotice();
      }
    },
    [visibleIds, replaceSelection, capNotice],
  );

  const toggleAll = useCallback(() => {
    const everyShown = visibleIds.length > 0 && visibleIds.every((id) => selectionRef.current.selected.has(id));
    if (everyShown) {
      replaceSelection({ selected: new Set(), anchor: null });
      return;
    }
    const next = selectAll(visibleIds, BULK_STATUS_MAX);
    replaceSelection({ selected: next.selected, anchor: null });
    if (next.capped) {
      capNotice();
    }
  }, [visibleIds, replaceSelection, capNotice]);

  const moveSelected = useCallback(
    async (statusKey: string) => {
      const ids = visibleIds.filter((id) => selectionRef.current.selected.has(id));
      setBulkBusy(true);
      setBulkResult(null);
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/orders/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderIds: ids, statusKey }),
        });
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          statusLabel?: string;
          results?: { orderId: string; name: string | null; outcome: string; error?: string }[];
          changed?: { event: EventView; order: LiveOrderStatus }[];
          triggersPo?: boolean;
        } | null;
        if (!response.ok || !body?.results || !body.changed) {
          setBulkResult({ tone: "warn", text: body?.error ?? "Nothing moved. Try again.", refusals: [] });
          return;
        }
        for (const change of body.changed) {
          applyEvent({ kind: "order.status", event: change.event, order: change.order });
        }
        const moved = body.results.filter((row) => row.outcome === "changed").length;
        const refusals = body.results
          .filter((row) => row.outcome === "refused" || row.outcome === "not-found")
          .map((row) => ({ name: row.name ?? "A card", error: row.error ?? "It is no longer in this workspace." }));
        setBulkResult({
          tone: refusals.length > 0 ? "warn" : "good",
          text: `Moved ${moved} ${moved === 1 ? "card" : "cards"} to ${body.statusLabel ?? "the status"}.`,
          refusals,
        });
        replaceSelection({ selected: new Set(), anchor: null });
        if (body.triggersPo) {
          toast({
            title: `${body.statusLabel ?? "This status"} usually needs a purchase order`,
            body: canManagePos ? "Create one from each order." : "A manager creates them from each order.",
            tone: "info",
          });
        }
        refreshQueue();
      } catch {
        setBulkResult({
          tone: "warn",
          text: "Could not reach the server, so it is not known what moved. Check the cards; moving them again is safe.",
          refusals: [],
        });
      } finally {
        setBulkBusy(false);
      }
    },
    [visibleIds, workspace.id, applyEvent, replaceSelection, toast, canManagePos, refreshQueue],
  );
```

- Pass to `OrderList`: `selection={{ selected: selection.selected, onToggle: toggleCard, onToggleAll: toggleAll }}`.
- After the list section (still inside `<main>`), render:

```tsx
      <BulkBar
        cards={selectedCards}
        statuses={statuses}
        role={role}
        busy={bulkBusy}
        result={bulkResult}
        onMove={moveSelected}
        onClear={() => replaceSelection({ selected: new Set(), anchor: null })}
        onDismissResult={() => setBulkResult(null)}
      />
```

- Keep the last rows clear of the bar: the `<main>` class gains `${selectedCards.length > 0 || bulkResult ? "pb-40 sm:pb-40" : ""}` (the `sm:` copy beats `sm:py-5`).

**Step 4: Run them and see them pass**

Run the seven test files from Step 2.
Expected: PASS. Then `npm run test` (the existing single-change tests in `mutations.test.ts` and `routes.test.ts` still pass: the rules moved, not changed).

Local visual check: select three rows, shift-click to extend, the bar appears at the bottom (light and dark, 1440 and 375); pick Shipped with a request in the selection: the confirmation lists all three and says the request stays and why; Move 2 cards; the outcome lists the request; the moved rows update and leave Open if Shipped is closed. Select 26 rows with select-all: the cap notice shows.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/status-rules.ts src/lib/status-rules.test.ts src/lib/selection.ts src/lib/selection.test.ts src/server/desk/mutations.ts src/server/desk/mutations.test.ts src/app/api/workspaces/[id]/orders/status/route.ts src/app/api/workspaces/[id]/orders/status/route.test.ts src/components/kit.tsx src/components/kit.test.ts src/components/desk/order-list.tsx src/components/desk/order-list.test.ts src/components/desk/desk-skeleton.tsx src/components/desk/bulk-bar.tsx src/components/desk/bulk-bar.test.ts src/components/desk/desk.tsx"
git add $FILES
git commit -m "feat: bulk status change with one confirmation and a server re-check of every card" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 17: $0 price display

A workspace "Show prices" mode, automatic by default: totals and the Paid chip hide when nearly every card is $0 (more than 95% of the loaded cards). A card that does have a price still says so (an amber price chip), and its drawer keeps its totals. @design-taste-frontend

**Files:**
- Modify: `src/lib/queue-settings.ts` (append `isPriced`, `pricesShown`)
- Modify: `src/components/desk/order-list.tsx` (from Tasks 10, 13 and 16: `ListProps`, table Total column, card footer)
- Modify: `src/components/desk/request-parts.tsx` (`ItemRow` 128-162, `ItemsSection` 164-247)
- Modify: `src/components/desk/order-drawer.tsx` (props, financial chip 624-629, `ItemsSection` use 744)
- Modify: `src/components/desk/desk-skeleton.tsx` (none needed: it keeps the widest layout), `src/components/desk/desk.tsx` (`showPrices`)
- Test: `src/lib/queue-settings.test.ts`, `src/components/desk/order-list.test.ts`, `src/components/desk/order-drawer.test.ts`, `src/components/desk/request-parts.test.ts`

**Step 1: Write the failing tests**

Append to `src/lib/queue-settings.test.ts` (import `isPriced`, `pricesShown`):

```ts
describe("pricesShown", () => {
  it("follows show and hide, and in auto shows prices only when more than 5% of cards have one", () => {
    const free = Array.from({ length: 40 }, () => "0.00");
    expect(pricesShown("show", free)).toBe(true);
    expect(pricesShown("hide", ["48.00"])).toBe(false);
    expect(pricesShown("auto", free)).toBe(false);
    expect(pricesShown("auto", [...free.slice(0, 39), "48.00"])).toBe(false);
    expect(pricesShown("auto", [...free.slice(0, 18), "48.00", "12.00"])).toBe(true);
    expect(pricesShown("auto", [])).toBe(false);
  });

  it("counts a total as a price only when it is a number other than 0", () => {
    expect(isPriced("0.00")).toBe(false);
    expect(isPriced("")).toBe(false);
    expect(isPriced("n/a")).toBe(false);
    expect(isPriced("12.50")).toBe(true);
  });
});
```

In `src/components/desk/order-list.test.ts` add `showPrices: true,` to `base` and append:

```ts
describe("OrderList prices", () => {
  it("drops the Total column when prices are hidden, and still marks a card that has a price", () => {
    const orders = [card("free"), card("priced", { total: "48.00" })];
    const shown = render("table", { orders, showPrices: true });
    expect(shown).toContain(">Total</th>");
    expect(shown).toContain("$0.00");
    const hidden = render("table", { orders, showPrices: false });
    expect(hidden).not.toContain(">Total</th>");
    expect(hidden).not.toContain("$0.00");
    expect(hidden).toContain("$48.00");
    expect(hidden).toContain('title="This card has a price"');
    expect(render("cards", { orders, showPrices: false })).not.toContain("$0.00");
  });
});
```

In `src/components/desk/order-drawer.test.ts`: import `ToastProvider` from `@/components/toasts` and `snapshotOf` from `@/server/desk/test-helpers`; make `render` wrap the drawer in `createElement(ToastProvider, null, ...)` (an order card renders the purchase orders section, which needs it); append:

```ts
  it("hides the Paid chip and a $0 order's totals when prices are hidden", () => {
    const order = draftCard({
      shopifyOrderId: "5001",
      name: "#1001",
      shopify: snapshotOf({ total: "0.00", currency: "USD" }),
      statusKey: "new",
      draftName: null,
      shopifyDraftId: null,
    });
    const shown = render({ order, extra: { showPrices: true } });
    expect(shown).toContain(">Paid</span>");
    expect(shown).toContain("Order total");
    const hidden = render({ order, extra: { showPrices: false } });
    expect(hidden).not.toContain(">Paid</span>");
    expect(hidden).not.toContain("Order total");
  });
```

Append to `src/components/desk/request-parts.test.ts` (import `ItemsSection` and `readSnapshot` from `@/lib/order-snapshot`, `snapshotOf` from `@/server/desk/test-helpers`):

```ts
describe("ItemsSection prices", () => {
  it("leaves the prices out of a $0 card when the workspace hides them, and keeps them for a priced one", () => {
    const free = readSnapshot(snapshotOf({ total: "0.00", items: [{ title: "Hard Hat", qty: 2, price: "0.00", sku: "HH-1" }] }));
    expect(renderToStaticMarkup(createElement(ItemsSection, { snapshot: free, itemsTruncated: false, shopifyUrl: null, showPrices: false }))).not.toContain(
      "Order total",
    );
    const priced = readSnapshot(snapshotOf({ total: "48.00" }));
    expect(renderToStaticMarkup(createElement(ItemsSection, { snapshot: priced, itemsTruncated: false, shopifyUrl: null, showPrices: false }))).toContain(
      "Order total",
    );
  });
});
```

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/queue-settings.test.ts src/components/desk/order-list.test.ts src/components/desk/order-drawer.test.ts src/components/desk/request-parts.test.ts`
Expected: FAIL: `pricesShown is not a function`; the list and drawer ignore `showPrices` (the Total column, the Paid chip and the totals stay).

**Step 3: Minimal implementation**

3a. Append to `src/lib/queue-settings.ts`:

```ts
// A total is a price when it is a number other than 0.
export function isPriced(total: string): boolean {
  const value = Number(total);
  return total.trim().length > 0 && Number.isFinite(value) && value !== 0;
}

// Auto shows prices only when more than this share of the loaded cards has
// one: a company store where nearly every order is $0 reads cleaner
// without them (comprehensive desk design section 1).
export const AUTO_PRICE_SHARE = 0.05;

export function pricesShown(mode: PriceDisplay, totals: readonly string[]): boolean {
  if (mode !== "auto") {
    return mode === "show";
  }
  if (totals.length === 0) {
    return false;
  }
  return totals.filter(isPriced).length / totals.length > AUTO_PRICE_SHARE;
}
```

3b. `src/components/desk/order-list.tsx`:
- Import `isPriced` from `@/lib/queue-settings`.
- `ListProps` gains `showPrices: boolean;` (totals and the Total column; when false, a card with a price shows it as an amber chip).
- Add:

```tsx
// A card with a price while prices are hidden: worth noticing on a $0 store.
function PricedMark({ order }: { order: OrderSummary }) {
  return isPriced(order.total) ? (
    <Chip tone="amber" size="sm" title="This card has a price">
      <span className="sr-only">Price </span>
      {formatMoney(order.total, order.currency)}
    </Chip>
  ) : null;
}
```

- `OrderTable` (destructure `showPrices`): the Total `<col>`, `<th>` and `<td>` render only when `showPrices`; when it is false, `<PricedMark order={order} />` follows `<KindMark order={order} />` in the order cell.
- `OrderCards`: the footer's `<Total order={order} />` becomes `{showPrices ? <Total order={order} /> : <PricedMark order={order} />}`.

3c. `src/components/desk/request-parts.tsx`:
- Import `isPriced` from `@/lib/queue-settings`.
- `ItemRow` takes `showPrices: boolean` and renders its right-hand price column only when it is true.
- `ItemsSection` takes `showPrices?: boolean` (default `true`) and works out `const pricesHere = showPrices || isPriced(snapshot.total);` (a card with a price always shows its prices); it passes `pricesHere` to each `ItemRow` and renders both totals blocks (the draft `dl` and the order `dl` with its note) only when `pricesHere` is true.

3d. `src/components/desk/order-drawer.tsx`:
- Props: `showPrices?: boolean;` (default `true` in the destructuring).
- The financial chip renders only when prices show: `{financial && showPrices ? <Chip tone={financialTone(financial)}>{sentenceCase(financial)}</Chip> : null}`, and the chip row's condition becomes `(financial && showPrices) || fulfillment`.
- `<ItemsSection snapshot={snapshot} itemsTruncated={itemsTruncated} shopifyUrl={shopifyUrl} showPrices={showPrices} />` (the section itself keeps a priced card's totals).

3e. `src/components/desk/desk.tsx`: import `pricesShown` from `@/lib/queue-settings`; add

```ts
  // Totals and the Paid chip (the workspace's Show prices setting).
  const showPrices = useMemo(
    () => pricesShown(queue.priceDisplay, desk.orders.map((row) => row.total)),
    [queue.priceDisplay, desk.orders],
  );
```

and pass `showPrices={showPrices}` to `OrderList` and to `OrderDrawerContent`.

**Step 4: Run them and see them pass**

Run the four test files from Step 2.
Expected: PASS.

Local visual check: with the local sample data (mostly $0, one $48 request) the Total column is gone and the $48 card carries an amber price chip; Settings > Statuses > Show prices: Show brings the column back, Hide removes it everywhere; the $48 drawer keeps its totals and the "Complete this draft in Shopify" notice.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/queue-settings.ts src/lib/queue-settings.test.ts src/components/desk/order-list.tsx src/components/desk/order-list.test.ts src/components/desk/request-parts.tsx src/components/desk/request-parts.test.ts src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/components/desk/desk.tsx"
git add $FILES
git commit -m "feat: Show prices mode (automatic on a \$0 store) for totals and the Paid chip" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 18: Request state copy

The rejected panel quotes the reason, who rejected it and when; a request whose draft Shopify deleted is titled "Deleted in Shopify"; the blue Open draft chip moves into the meta line; a purchase order that has no number yet says "Not numbered yet" instead of "Draft Draft". @design-taste-frontend

**Files:**
- Create: `src/lib/rejection.ts`
- Modify: `src/components/desk/review-panel.tsx` (`ReviewSummaryProps`, `ReviewSummary` from Task 14)
- Modify: `src/components/desk/order-drawer.tsx` (meta line 595-603, draft status chip 620-623, ReviewPanel props)
- Modify: `src/lib/po-client.ts` (after `poStateChip` 146-157), `src/components/desk/po-history.tsx` (number 225-227)
- Test: `src/lib/rejection.test.ts` (new), `src/components/desk/review-panel.test.ts`, `src/components/desk/order-drawer.test.ts`, `src/lib/po-client.test.ts`

**Step 1: Write the failing tests**

Create `src/lib/rejection.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { EventView } from "@/server/desk/shapes";
import { rejectionOf } from "./rejection";

const note = (id: string, createdAt: number, meta: unknown): EventView => ({
  id,
  orderId: "d1",
  type: "note",
  text: `reason ${id}`,
  actorId: "u_manager",
  meta,
  createdAt,
  source: "app",
});

describe("rejectionOf", () => {
  it("finds the newest Reject reason and ignores plain notes", () => {
    expect(rejectionOf([note("a", 10, { rejectReason: true }), note("b", 30, null), note("c", 20, { rejectReason: true })])?.id).toBe("c");
    expect(rejectionOf([note("b", 30, null)])).toBeNull();
    expect(rejectionOf([])).toBeNull();
  });
});
```

Append to `src/components/desk/review-panel.test.ts`:

```ts
  it("quotes a rejection's reason, who rejected it and when", () => {
    const html = render({
      rejected: true,
      rejection: { reason: "Duplicate of #D11", by: "Ryan Hale", at: Date.parse("2026-10-05T12:00:00.000Z") },
    });
    expect(html).toContain(">Duplicate of #D11</blockquote>");
    expect(html).toContain("Rejected by Ryan Hale, Oct 5, 2026");
  });

  it("titles a request whose draft Shopify deleted as Deleted in Shopify", () => {
    const html = render({ deleted: true, approveBlock: "Shopify no longer has this draft." });
    expect(html).toContain(">Deleted in Shopify</h3>");
    expect(html).not.toContain("Waiting for review");
    expect(html).toContain("Reject still records a decision.");
  });
```

In `src/components/desk/order-drawer.test.ts`, change the "shows only Deleted in Shopify, never the Open draft status" test's two Open assertions to `expect(deleted).not.toContain("Draft open");` and `expect(open).toContain("· Draft open");`, and append:

```ts
  it("quotes the rejection reason with who rejected the request", () => {
    const html = render({
      timeline: [
        { ...statusEvent(), actorName: "Ryan Hale" },
        { ...statusEvent({ id: "e2", type: "note", text: "Duplicate of #D11", meta: { rejectReason: true } }), actorName: "Ryan Hale" },
      ],
    });
    expect(html).toContain(">Duplicate of #D11</blockquote>");
    expect(html).toContain("Rejected by Ryan Hale,");
  });
```

Append to `src/lib/po-client.test.ts` (import `poNumberLabel`):

```ts
  it("names a purchase order by its number, or says it has none yet", () => {
    expect(poNumberLabel({ number: "IMP-2026-0042" })).toBe("IMP-2026-0042");
    expect(poNumberLabel({ number: null })).toBe("Not numbered yet");
  });
```

(inside an existing `describe`, or wrap it in `describe("poNumberLabel", ...)`.)

**Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/rejection.test.ts src/components/desk/review-panel.test.ts src/components/desk/order-drawer.test.ts src/lib/po-client.test.ts`
Expected: FAIL: `Failed to resolve import "./rejection"`; no blockquote, the deleted request still says "Waiting for review"; the drawer still shows the blue Open chip; `poNumberLabel is not a function`.

**Step 3: Minimal implementation**

3a. Create `src/lib/rejection.ts`:

```ts
import type { EventView } from "../server/desk/shapes";

// The newest Reject decision in a timeline: Reject saves its reason as a
// note marked rejectReason. The review panel quotes it with who and when.
export function rejectionOf(timeline: readonly EventView[]): EventView | null {
  let newest: EventView | null = null;
  for (const event of timeline) {
    const meta = typeof event.meta === "object" && event.meta !== null ? (event.meta as Record<string, unknown>) : {};
    if (event.type === "note" && meta.rejectReason === true && (newest === null || event.createdAt > newest.createdAt)) {
      newest = event;
    }
  }
  return newest;
}
```

3b. `src/components/desk/review-panel.tsx`:
- Import `formatDateTime` from `@/lib/format`.
- `ReviewSummaryProps` gains:

```ts
  // Shopify deleted the draft: the panel says so instead of waiting.
  deleted?: boolean;
  // The Reject decision to quote (reason, who, when), once loaded.
  rejection?: { reason: string; by: string; at: number } | null;
```

- In `ReviewSummary` (destructure `deleted = false, rejection = null`):

```tsx
  const title = deleted ? "Deleted in Shopify" : rejected ? "This request was rejected" : "Waiting for review";
  const lead = deleted
    ? canReview
      ? "Shopify no longer has this draft, so it cannot be approved. Reject still records a decision."
      : "Shopify no longer has this draft."
    : !canReview
      ? rejected
        ? "Only a manager can approve it or move it out of Rejected."
        : "Waiting for a manager to approve or reject."
      : rejected
        ? "A manager can still approve it."
        : completeInShopify
          ? "Reject asks for a reason and saves it as a note."
          : "Approve creates the order in Shopify. Reject asks for a reason and saves it as a note.";
```

  and between the heading and the lead:

```tsx
      {rejected && rejection ? (
        <figure className="mt-3">
          <blockquote className="whitespace-pre-wrap break-words border-l-2 border-line-strong pl-3 text-sm text-ink">{rejection.reason}</blockquote>
          <figcaption className="mt-1.5 text-xs text-ink-2">{`Rejected by ${rejection.by}, ${formatDateTime(rejection.at)}`}</figcaption>
        </figure>
      ) : null}
```

- `ReviewPanel` passes `deleted={props.deleted}` and `rejection={props.rejection}` to `ReviewSummary`.

3c. `src/components/desk/order-drawer.tsx`:
- Import `rejectionOf` from `@/lib/rejection`.
- The meta line for a draft becomes `` `Submitted ${formatDateTime(createdAt)}${draftStatus ? ` · Draft ${DRAFT_STATUS_LABEL[draftStatus].toLowerCase()}` : ""}` ``, and the `draftStatus ? (<div ...><Chip tone="blue">...` branch of the chip row is removed (the row keeps only the order's financial and fulfillment chips).
- Before the JSX:

```ts
  const isRejected = rejectedStatus !== undefined && statusKey === rejectedStatus.key;
  const rejectionNote = isRejected ? rejectionOf(timeline) : null;
  const rejectedBy = rejectionNote ? actorName(rejectionNote, members, selfUserId) : null;
  const rejection =
    rejectionNote && rejectedBy
      ? { reason: rejectionNote.text, by: rejectedBy === "You" ? "you" : rejectedBy, at: rejectionNote.createdAt }
      : null;
```

- `ReviewPanel` gets `rejected={isRejected}`, `deleted={deleted}` and `rejection={rejection}`.

3d. Append to `src/lib/po-client.ts`:

```ts
// A purchase order's name in the history: its number, or plainly that it
// has none until it is sent (never "Draft" next to a Draft chip).
export function poNumberLabel(po: { number: string | null }): string {
  return po.number ?? "Not numbered yet";
}
```

and in `src/components/desk/po-history.tsx` the number span becomes:

```tsx
                  <span
                    id={rowFocusId(po.id)}
                    tabIndex={-1}
                    className={`text-sm font-semibold text-ink outline-none ${po.number ? "font-mono tabular-nums" : ""}`}
                  >
                    {poNumberLabel(po)}
                  </span>
```

(import `poNumberLabel` with `poDateLine` and `poStateChip`).

**Step 4: Run them and see them pass**

Run the four test files from Step 2.
Expected: PASS.

Local visual check: the local rejected request (#D27) quotes its reason under the title with who and when; the deleted request (#D28) is titled "Deleted in Shopify"; an open request's meta line reads "Submitted ... · Draft open" with no blue chip; a saved PO draft reads "Not numbered yet" beside its Draft chip. Light and dark, 1440 and 375.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/lib/rejection.ts src/lib/rejection.test.ts src/components/desk/review-panel.tsx src/components/desk/review-panel.test.ts src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/lib/po-client.ts src/lib/po-client.test.ts src/components/desk/po-history.tsx"
git add $FILES
git commit -m "feat: request state copy (rejection quote, Deleted in Shopify, draft state in the meta line, Not numbered yet)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 19: Phone ergonomics

A sticky action bar at the bottom of the drawer (the decision and the status stay in reach), the PO send confirmation fits a phone screen with Cancel visible, SKUs never break mid-code, 40px touch targets on touch screens, and chip text of at least 12px (done by the kit, kept by the Task 2 guard). @design-taste-frontend

**Files:**
- Modify: `src/components/desk/order-drawer.tsx` (header status row 631-651, the review panel in the body, a new footer after the body 669-794)
- Modify: `src/components/desk/po-send-confirm.tsx` (SKU 135, button row 261-281)
- Modify: `src/components/desk/request-parts.tsx` (SKU 149)
- Modify: `src/components/desk/status-select.tsx` (height 47), `src/components/desk/drawer-kit.tsx` (CopyButton 64), `src/components/desk/po-history.tsx` (`small` 30), `src/components/shell/bell.tsx` (Mark all read 236), `src/components/toasts.tsx` (close button 70)
- Test: `src/components/desk/order-drawer.test.ts`, `src/components/desk/po-history.test.ts`, `src/components/desk/request-parts.test.ts`, `src/components/desk/status-select.test.ts`

**Step 1: Write the failing tests**

Append to `src/components/desk/order-drawer.test.ts`:

```ts
  it("keeps the decision and the status in a footer within reach, and the header's status row from sm", () => {
    const html = render({ order: draftCard({ statusKey: "new" }) });
    const footer = html.match(/<footer[\s\S]*<\/footer>/)?.[0] ?? "";
    expect(footer).toContain(">Approve<");
    expect(footer).toContain(">Reject<");
    expect(footer).toMatch(/<div class="flex flex-wrap items-center gap-2 sm:hidden"><span data-tone/);
    const header = html.match(/<header[\s\S]*<\/header>/)?.[0] ?? "";
    expect(header).toContain("hidden flex-wrap items-center gap-2 sm:flex");
    expect(html.match(/>Approve</g)).toHaveLength(1);
  });

  it("gives staff the phone footer with the status alone", () => {
    const html = render({ order: draftCard({ statusKey: "new" }), extra: { role: "staff" } });
    expect(html.match(/<footer[^>]*>/)?.[0]).toContain("sm:hidden");
    expect(html).not.toContain(">Approve<");
  });
```

Append to `src/components/desk/po-history.test.ts` (inside the SendConfirm describe that uses `confirmStep`):

```ts
  it("keeps Cancel and the send button side by side at the bottom of a phone screen, and SKUs whole", () => {
    const html = confirmStep(pendingOf());
    const row = html.match(/<div class="sticky bottom-0[^"]*">([\s\S]*?)<\/div>/);
    expect(row).not.toBeNull();
    expect(row?.[0]).toContain("grid-cols-2");
    expect((row?.[1] ?? "").indexOf(">Cancel<")).toBeLessThan((row?.[1] ?? "").indexOf("Send to vendor"));
    expect(html).toContain('whitespace-nowrap font-mono text-xs text-ink-2">HH-1<');
  });
```

Append to `src/components/desk/request-parts.test.ts` (inside `describe("ItemsSection prices", ...)` from Task 17):

```ts
  it("never breaks a SKU in the middle", () => {
    const snapshot = readSnapshot(snapshotOf({ items: [{ title: "Insulated Work Jacket", qty: 1, price: "0.00", sku: "EX-JKT-CH-XL", variant: "XL" }] }));
    const html = renderToStaticMarkup(createElement(ItemsSection, { snapshot, itemsTruncated: false, shopifyUrl: null }));
    expect(html).toContain('class="whitespace-nowrap font-mono">SKU EX-JKT-CH-XL<');
  });
```

In `src/components/desk/status-select.test.ts`, add to the second test: `expect(html).toContain("pointer-coarse:h-10");`.

**Step 2: Run them and see them fail**

Run: `npx vitest run src/components/desk/order-drawer.test.ts src/components/desk/po-history.test.ts src/components/desk/request-parts.test.ts src/components/desk/status-select.test.ts`
Expected: FAIL: the drawer has no footer; the send step's buttons are not in a sticky row; the SKU spans wrap; no `pointer-coarse:h-10`.

**Step 3: Minimal implementation**

3a. `src/components/desk/order-drawer.tsx`:
- Import `ReviewActions` and `ReviewSummary` (instead of `ReviewPanel`) from `./review-panel`.
- Before the JSX, after the Task 18 constants:

```ts
  const completeInShopify = zeroTotal || deleted ? null : { url: shopifyUrl };
  // Managers decide from the footer, which stays in reach while the body
  // scrolls (comprehensive desk design section 1, phone ergonomics).
  const reviewInFooter = kind === "draft" && canReview && snapshot !== null && order !== null;
  const statusControls =
    statusKey !== null && statusOptions ? (
      <>
        <StatusSelect
          statuses={statusOptions.options}
          value={statusKey}
          onChange={onChangeStatus}
          label={`Status for ${kind === "draft" ? "request" : "order"} ${name}`}
          size="md"
          busy={statusBusy}
          disabled={statusOptions.disabled}
          hint={statusOptions.hint}
        />
        {shopifyUrl ? (
          <a href={shopifyUrl} target="_blank" rel="noopener noreferrer" className={`${ui.buttonSecondary} h-9`}>
            <ArrowSquareOutIcon size={16} aria-hidden />
            Open in Shopify
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
      </>
    ) : null;
```

- The header's status row becomes `{statusControls ? <div className="mt-4 hidden flex-wrap items-center gap-2 sm:flex">{statusControls}</div> : null}` (the hint, "Status set by" and the row error stay in the header).
- In the body, replace the `ReviewPanel` block with the summary alone:

```tsx
            {kind === "draft" ? (
              <section aria-labelledby={`${labelId}-review`} className="mb-5 rounded-panel border border-line bg-surface-2 p-4">
                <ReviewSummary
                  canReview={canReview}
                  rejected={isRejected}
                  deleted={deleted}
                  rejection={rejection}
                  completeInShopify={completeInShopify}
                  titleId={`${labelId}-review`}
                />
              </section>
            ) : null}
```

- After the body `</div>`, add the footer:

```tsx
      {statusControls || reviewInFooter ? (
        <footer
          className={`max-h-[60dvh] overflow-y-auto overscroll-contain border-t border-line bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 ${
            reviewInFooter ? "" : "sm:hidden"
          }`}
        >
          {statusControls ? <div className="flex flex-wrap items-center gap-2 sm:hidden">{statusControls}</div> : null}
          {reviewInFooter ? (
            <div className={statusControls ? "mt-3 sm:mt-0" : undefined}>
              <ReviewActions
                key={orderId}
                name={name}
                email={snapshot?.email ?? ""}
                rejected={isRejected}
                approveBlock={approveBlock}
                rejectBlock={rejectBlock}
                completeInShopify={completeInShopify}
                next={nextRequest ?? null}
                onApprove={async () => {
                  const failure = await onApprove();
                  if (!failure) {
                    focusSoon(() => document.getElementById(labelId));
                  }
                  return failure;
                }}
                onApproveAndNext={
                  onApproveAndNext
                    ? async () => {
                        const failure = await onApproveAndNext();
                        if (!failure) {
                          focusSoon(() => document.getElementById(labelId));
                        }
                        return failure;
                      }
                    : undefined
                }
                onReject={onReject}
                afterReject={() => document.getElementById(`${labelId}-review`)}
              />
            </div>
          ) : null}
        </footer>
      ) : null}
```

  (`key={orderId}`: a new card starts with no step open.)

3b. `src/components/desk/po-send-confirm.tsx`:
- SKU (line 135): `{line.sku ? <span className="ml-2 inline-block whitespace-nowrap font-mono text-xs text-ink-2">{line.sku}</span> : null}`.
- Replace the button row (`<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">` and its two buttons) with:

```tsx
      {/* On phones the buttons stay pinned to the bottom of the scrolling
          footer, side by side, Cancel first, so Cancel is always visible. */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 grid grid-cols-2 gap-2 rounded-b-panel border-t border-line bg-surface-2 px-4 py-3 sm:static sm:mx-0 sm:mb-0 sm:flex sm:justify-end sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0">
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={() => {
            if (confirmArmed(openedAt.current, Date.now())) {
              onConfirm();
            }
          }}
          disabled={busy || !sendable}
          aria-busy={busy || undefined}
          aria-describedby={pending.message ? `${questionId} ${messageId}` : questionId}
          className={`${ui.buttonPrimary} min-w-0 max-sm:h-auto max-sm:min-h-10 max-sm:whitespace-normal max-sm:py-2 max-sm:text-center max-sm:leading-tight`}
        >
          {busy ? <Spinner /> : <PaperPlaneTiltIcon size={16} aria-hidden />}
          {busy ? "Sending" : pending.resend ? `Send again to ${pending.vendorName}` : "Send to vendor"}
        </button>
      </div>
```

3c. `src/components/desk/request-parts.tsx` SKU (line 149): `{item.sku ? <span className="whitespace-nowrap font-mono">{`SKU ${item.sku}`}</span> : null}`.

3d. Touch targets (40px on touch screens):
- `src/components/desk/status-select.tsx` line 47: `const height = size === "md" ? "h-9 text-sm pl-3.5 pr-9 pointer-coarse:h-10" : "h-8 text-xs pl-3 pr-8 pointer-coarse:h-10";`
- `src/components/desk/drawer-kit.tsx` CopyButton: add `pointer-coarse:h-10` to its class.
- `src/components/desk/po-history.tsx` line 30: `const small = "h-8 px-3 text-xs pointer-coarse:h-10";`
- `src/components/shell/bell.tsx` Mark all read: add `pointer-coarse:h-10`.
- `src/components/toasts.tsx` close button: add `pointer-coarse:size-10`.

**Step 4: Run them and see them pass**

Run the four test files from Step 2.
Expected: PASS. Then `npm run test`.

Local visual check at 375x812 (with touch emulation in the browser's device mode), light and dark: a request's drawer keeps Approve, Approve and next, Reject and the status at the bottom while the body scrolls; the reject form opens in the footer and scrolls inside it with the keyboard up; the PO review's send step shows Cancel and Send to vendor side by side at the bottom; a long SKU moves to the next line whole; status chips and small buttons are 40px tall under touch.

**Step 5: Gates and commit**

```bash
npm run test
npx tsc --noEmit --incremental false
FILES="src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/components/desk/po-send-confirm.tsx src/components/desk/po-history.test.ts src/components/desk/request-parts.tsx src/components/desk/request-parts.test.ts src/components/desk/status-select.tsx src/components/desk/status-select.test.ts src/components/desk/drawer-kit.tsx src/components/desk/po-history.tsx src/components/shell/bell.tsx src/components/toasts.tsx"
git add $FILES
git commit -m "feat: phone ergonomics (drawer action bar, PO confirm that fits, whole SKUs, 40px touch targets)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- $FILES
```

---

### Task 20: Final verification

Full gates, the build, a migration proof on production-shaped data, a local visual pass at 1440x900 and 375x812 in light and dark, and the handoff note. @superpowers:verification-before-completion

**Files:**
- Modify: `docs/HANDOFF.md` (append a STATE UPDATE section at the end)
- Scratch only (never committed): the proof database under the scratchpad

**Step 1: Gates**

Run from the repo root:

```bash
npm run test
npx tsc --noEmit --incremental false
```

Expected: both green (drizzle-kit check reports the snapshots consistent; every suite passes).

House-style checks over everything this wave changed (`c22b8ca` is the design doc commit this wave starts from):

```bash
# Perl rather than grep -P, which macOS grep lacks.
git diff --name-only --diff-filter=d c22b8ca..HEAD | xargs perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}\x{2600}-\x{27BF}\x{1F300}-\x{1FAFF}]/; close ARGV if eof'
git diff c22b8ca..HEAD | grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}" | grep -v "example\.com" | grep -v "noreply@anthropic.com"
```

Expected: the first prints nothing (no en-dash, em-dash or emoji); the second prints nothing new (any address that is not `@example.com` must go).

**Step 2: Build**

Run: `npm run build`
Expected: success. In the route list, `/_not-found`, `/`, `/settings`, `/w/[slug]` and `/w/[slug]/settings` are dynamic (marked with the server symbol), and nothing fails while prerendering.

**Step 3: Migration proof on production-shaped data**

Run from the repo root (the newest backup is in `../backups/`; it may be older than production: the loop below applies every migration the backup predates first, loads its rows, then applies the rest, 0011 last):

```bash
SCRATCH=/private/tmp/claude-501/-Users-ryboss-Documents-RMH-LLC-Clients-Impact-Rentals/bbd2d467-17d5-4282-b86c-f2209938e381/scratchpad
PROOF="$SCRATCH/proof-0011"
rm -rf "$PROOF" && mkdir -p "$PROOF"
BACKUP=$(ls -t ../backups/orderingdesk-*.sql | head -1); echo "backup: $BACKUP"
LAST=$(grep '^INSERT INTO "d1_migrations"' "$BACKUP" | grep -o "'[0-9]\{4\}_" | tail -1 | tr -d "'_")
LEVEL=$(printf "%04d" $((10#$LAST + 1))); echo "backup rows are in the shape before $LEVEL"
for f in drizzle/0*.sql; do n=$(basename "$f" | cut -c1-4); if [ "$n" \< "$LEVEL" ]; then npx wrangler d1 execute orderingdesk --local --persist-to "$PROOF" --file "$f"; fi; done
{ echo "PRAGMA defer_foreign_keys=TRUE;"; grep '^INSERT INTO' "$BACKUP" | grep -v '^INSERT INTO "sqlite_sequence"' | grep -v '^INSERT INTO "d1_migrations"'; } > "$PROOF/data.sql"
npx wrangler d1 execute orderingdesk --local --persist-to "$PROOF" --file "$PROOF/data.sql"
Q() { npx wrangler d1 execute orderingdesk --local --persist-to "$PROOF" --command "$1"; }
Q "SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM statuses) AS statuses, (SELECT count(*) FROM workspace_settings) AS settings"
for f in drizzle/0*.sql; do n=$(basename "$f" | cut -c1-4); if ! [ "$n" \< "$LEVEL" ]; then npx wrangler d1 execute orderingdesk --local --persist-to "$PROOF" --file "$f"; fi; done
Q "SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM statuses) AS statuses, (SELECT count(*) FROM workspace_settings) AS settings"
Q "SELECT workspace_id, key, shopify_link, closed FROM statuses ORDER BY workspace_id, sort"
Q "SELECT workspace_id, age_amber_days, age_red_days, price_display FROM workspace_settings"
Q "PRAGMA foreign_key_check"
Q "SELECT sum(CASE WHEN coalesce(s.closed, 0) = 0 THEN 1 ELSE 0 END) AS open, sum(CASE WHEN coalesce(s.closed, 0) = 1 THEN 1 ELSE 0 END) AS closed, count(*) AS cards FROM orders o LEFT JOIN statuses s ON s.workspace_id = o.workspace_id AND s.key = o.status_key"
```

Expected: orders and events identical before and after; statuses grow only by the Rejected status 0010 adds when the backup predates 0010 (with the October 5 backup: 7 then 8); every status row has `closed`, and exactly the delivered and rejected ones are 1; every settings row has 2, 4, auto; `foreign_key_check` prints no rows; open plus closed equals cards. Paste the outputs into the handoff note (Step 5). The proof directory stays in the scratchpad; nothing here touches the repo or production.

**Step 4: Local visual pass**

`npm run db:migrate:local`, then `npm run dev`, signed in locally as a platform admin and, in a second browser profile, as staff. Check each item at 1440x900 and at 375x812 (device mode with touch), in light and in dark:

- Desk, Open view: one top bar row; 15 to 18 rows above the fold at 1440x900; one toolbar row; view counts; ages (plain, amber, red); no Total column on the $0 sample data and the $48 card's amber price chip; at 375, one top bar row, the view select with search and filter buttons, compact cards with "New, 2d" in the header; inspect the DOM below 880px: one `<ul>`, no `<table>`.
- Needs approval: the badge count; the view sorted waiting longest; in a request, Approve and next opens the confirmation with focus on the question, a press within 400 ms does nothing, Escape returns focus.
- Bulk: select with checkboxes and shift-click; the confirmation lists every card and why a request stays; the outcome in the bar; the cap notice past 25.
- URL: a view, status and search survive a reload; Back closes a drawer and keeps them.
- Drawer at 375: the footer keeps the status and the review buttons in reach; the reject form scrolls inside it; the rejected request quotes its reason with who and when; the deleted request is titled "Deleted in Shopify"; an open request's meta line reads "· Draft open".
- PO review at 375: the send step's Cancel and Send to vendor sit side by side at the bottom.
- Account menu on the desk, Settings and the hub (and a local client host if you have one set up): name, email, role, theme, Switch workspace only with several workspaces, Sign out works; the hub header at 375 has the title and the menu on one row.
- Honest state: a stale local sync shows the red chip with its tip; `/nope` shows the not-found page.
- Settings > Statuses: the Closed switches and the Waiting time and prices panel; an invalid red threshold shows the red field and the message.
- Contrast: amber and red age chips and the primary hover keep AA in both themes (spot-check with the browser's contrast picker; the status tones in globals.css are AA by design).

Fix anything that fails here test-first (a failing render test, then the fix), with the gates before each commit.

**Step 5: Handoff note and the last commit**

Append to `docs/HANDOFF.md`:

```markdown
## STATE UPDATE, <date> WAVE 1a polish and the work queue (supersedes above)

- Branch build/m1-core on top of c22b8ca (design doc). Commits: <list>. NOT pushed, NOT deployed.
- NEW MIGRATION 0011 (drizzle/0011_work_queue.sql): statuses.closed (Delivered and Rejected closed by link or key), workspace_settings.age_amber_days (2), age_red_days (4), price_display ('auto'). Additive. Proven on production-shaped data: <paste the Step 3 outputs>.
- What shipped: <one line per task, plain words>.
- Deploy order: backup and bookmark, `npm run db:migrate:remote` (0011), then deploy. The sync test pin is now 0011 (drizzle names every column in inserts).
- Known limits: bulk moves take up to 25 cards and write each card's Shopify tag one at a time after the response; bulk moves send no all-activity pushes; Approve and next skips the automatic purchase order review (a toast says to create it from the order); the approval view is reachable by staff through its URL (read only).
```

Then:

```bash
npm run test
npx tsc --noEmit --incremental false
npm run build
git add docs/HANDOFF.md
git commit -m "docs: handoff for Wave 1a (polish and the work queue, migration 0011)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- docs/HANDOFF.md
```

Do not push.

---

## Notes for Waves 1b and 1c

- 1b (migration 0012): add `"cancelled"` to `CLOSED_LINKS` in `src/server/desk/statuses.ts`, give the new Cancelled status `closed: true` in `DEFAULT_STATUSES` and in the 0012 data step, and put the Cancelled rules in `checkStatusMove` in `src/lib/status-rules.ts` (the single change, the bulk change and the bulk confirmation all read it; cancel has its own step). Add looks for `draft_edited` and `order_cancelled` in `src/lib/event-look.ts` and their glyphs in `src/components/event-icon.tsx` (unknown types fall back to a neutral look). `ToneChip` is gone (the kit adoption guard fails on the word): use `Chip` from `@/components/kit`, `ui.buttonDangerSecondary`, `Spinner`, and busy labels without an ellipsis.
- 1b: the Branch column replaces the desktop Total column outright (design section 2), whatever the price display says; a priced card keeps its amber price chip (`PricedMark`) in the order cell, and the phone cards and the drawer keep following `showPrices`. Addresses were not touched in 1a: `AddressBlock` goes into `ShipToSection`, the PO surfaces, emails and the PDF. 1a created `src/components/desk/order-list.test.ts` and `src/components/settings/statuses.test.ts`: 1b appends to them.
- 1b: editing a request must close an open Approve confirmation. `ReviewActions` (not `ReviewPanel`) holds that step's state (modes idle, approve, approve-next, reject) and is keyed by the order id in the drawer footer; 1b adds its edit mode there, and closes approve and approve-next when the request's content changes.
- 1c (migration 0013): `src/lib/desk-query.ts` is the one parser for view, status, kind, q and sort; 1c extends it and keeps 1a's exported names (`parseDeskQuery`, `deskSearch`, `mergeDeskSearch`, `defaultSort`, `DeskQuery`), so their callers and tests still pass. Server search reads the same query, and `viewCondition` in `src/server/desk/read.ts` is the place the closed rule lives (order_search.closed must follow a status's closed flag when Settings changes it). Today `q`, status and kind filter the loaded view in the browser.

---

## Deploy notes

For the operator (Ryan decides when; never push main before step 3, since main auto-deploys):

1. `npm run test`, `npx tsc --noEmit --incremental false` and `npm run build` are green at the final commit.
2. Backup: `npx wrangler d1 export orderingdesk --remote --output "../backups/orderingdesk-before-0011-$(date +%Y-%m-%d).sql"`, then record a time-travel bookmark (`npx wrangler d1 time-travel info orderingdesk`) in HANDOFF.
3. Migrate first: `npm run db:migrate:remote` (production is at 0010; this applies 0011 only). Code from this wave deployed before 0011 fails: every statuses and workspace_settings insert names the new columns and the desk reads `statuses.closed`.
4. Then deploy: `npm run deploy` (or merge to main once step 3 is done).
5. Watch `npx wrangler tail` while checking: the desk opens on Open with Delivered and Rejected under Closed; the Needs approval count matches the waiting requests; Settings > Statuses shows Delivered and Rejected closed and the work queue panel; a status change and a small bulk move of a test card write their Shopify tag (the tail shows the write ok); a new storefront request's push and email open `?view=approval&order=...`.
6. Rollback: the schema change is additive and old code ignores the new columns (its inserts fall back to the column defaults), so `npx wrangler rollback` alone undoes a bad deploy. Use the time-travel bookmark only for damaged data.
