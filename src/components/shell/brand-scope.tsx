import type { CSSProperties, ReactNode } from "react";
import { brandStyle } from "@/lib/brand-theme";
import type { WorkspaceBranding } from "@/lib/branding";

// A workspace's theme scope (platform amendment section 6): the inline CSS
// variables from its branding (src/lib/brand-theme.ts) on one element,
// which globals.css maps onto the tokens every component reads, plus the
// workspace's Google Fonts stylesheet when it uses one. Used by the
// workspace shell, the client host sign-in page and the settings preview;
// the hub never renders one, so it keeps the Ordering Desk look.
//
// No hooks, so server and client components can both render it.
export function BrandScope({
  branding,
  accentColor,
  as: Tag = "div",
  className,
  complete = false,
  forceTheme,
  hoistFonts = true,
  children,
}: {
  branding: WorkspaceBranding | null | undefined;
  accentColor: string;
  as?: "div" | "main" | "section";
  className?: string;
  // Spell out every variable, defaults included (the settings preview).
  complete?: boolean;
  // Render this theme whatever the app theme is (the settings preview).
  forceTheme?: "light" | "dark";
  // Hoist the font stylesheet into <head> (React's precedence). The live
  // preview keeps it in place instead, so a slow font never holds up a
  // re-render.
  hoistFonts?: boolean;
  children: ReactNode;
}) {
  const { style, palette, fontsHref } = brandStyle(branding, accentColor, { complete });
  return (
    <Tag
      data-brand-scope=""
      data-brand-palette={palette ? "" : undefined}
      data-force-theme={forceTheme}
      style={style as CSSProperties}
      className={className}
    >
      {fontsHref ? (
        hoistFonts ? (
          <link rel="stylesheet" href={fontsHref} precedence="default" />
        ) : (
          <link rel="stylesheet" href={fontsHref} />
        )
      ) : null}
      {children}
    </Tag>
  );
}
