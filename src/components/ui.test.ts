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
