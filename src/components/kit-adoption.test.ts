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
