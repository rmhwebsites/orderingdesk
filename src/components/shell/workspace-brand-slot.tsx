import type { BrandImagePaths, BrandImages } from "@/lib/brand-assets";

// One uploaded image with its optional dark-mode version: both are
// rendered and globals.css shows the one for the active theme (.od-logo-*).
// Plain img on purpose: an SVG must not go through the image optimizer.
export function ThemedImage({ paths, className }: { paths: BrandImagePaths; className: string }) {
  if (!paths.dark) {
    return <img src={paths.light} alt="" className={className} />;
  }
  return (
    <>
      <img src={paths.light} alt="" className={`od-logo-light ${className}`} />
      <img src={paths.dark} alt="" className={`od-logo-dark ${className}`} />
    </>
  );
}

function Monogram({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "W";
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-control bg-primary font-display text-sm font-semibold text-primary-ink">
      {initial}
    </span>
  );
}

// The workspace's mark in the top bar, next to its name: the symbol (or a
// monogram tile in the primary color when there is none) on phones, and
// the full logo from the sm breakpoint up when one is uploaded. Everything
// stays 32px tall so the bar never shifts while an image loads. Decorative:
// the name beside it is the label.
export function WorkspaceBrandSlot({ name, images }: { name: string; images: BrandImages }) {
  const mark = images.symbol ? (
    <span className="grid size-8 shrink-0 place-items-center">
      <ThemedImage paths={images.symbol} className="size-8 object-contain" />
    </span>
  ) : (
    <Monogram name={name} />
  );
  if (!images.logo) {
    return <span aria-hidden className="flex shrink-0">{mark}</span>;
  }
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      <span className="flex sm:hidden">{mark}</span>
      <span className="hidden h-8 items-center sm:flex">
        <ThemedImage paths={images.logo} className="h-8 w-auto max-w-[160px] object-contain object-left" />
      </span>
    </span>
  );
}
