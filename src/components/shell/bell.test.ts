import { describe, it, expect, vi } from "vitest";

vi.mock("./workspace-provider", () => ({ useWorkspace: () => ({}) }));
vi.mock("@/components/toasts", () => ({ useToast: () => () => {} }));

const { BELL_PANEL_CLASS } = await import("./bell");

// On a phone the bell is not the last item of the top bar (the account menu
// follows it), so a panel hung from the bell's right edge ran past the left
// edge of a 375px screen and cut off the heading and the icons. Below sm
// the panel spans the screen under the 56px top bar instead; from sm up it
// hangs from the bell as before.
describe("Bell panel", () => {
  it("spans the screen under the top bar on phones and hangs from the bell from sm up", () => {
    const names = BELL_PANEL_CLASS.split(/\s+/);
    expect(names).toEqual(expect.arrayContaining(["fixed", "inset-x-4", "top-16", "sm:absolute", "sm:inset-x-auto", "sm:right-0", "sm:top-full", "sm:mt-2"]));
    expect(names).toContain("sm:w-[min(24rem,calc(100vw-2rem))]");
    expect(names.filter((name) => ["absolute", "right-0", "top-full", "mt-2"].includes(name))).toEqual([]);
  });
});
