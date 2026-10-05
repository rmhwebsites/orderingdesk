import { describe, it, expect } from "vitest";
import { hubView, type HubWorkspace } from "./hub";

function ws(slug: string, role: HubWorkspace["role"] = "staff"): HubWorkspace {
  return { id: `id_${slug}`, name: `Name ${slug}`, slug, accentColor: "#91d500", symbol: null, role };
}

describe("hubView", () => {
  it("shows a platform admin every workspace and the create form, whatever the count", () => {
    for (const list of [[], [ws("a", "platform")], [ws("a", "platform"), ws("b", "platform")]]) {
      expect(hubView({ platformAdmin: true }, list)).toEqual({ kind: "list", workspaces: list, canCreate: true });
    }
  });

  it("sends a client with exactly one workspace straight into it", () => {
    expect(hubView({ platformAdmin: false }, [ws("impact-rentals", "manager")])).toEqual({
      kind: "redirect",
      to: "/w/impact-rentals",
    });
  });

  it("lists only a client's own workspaces, never with the create form", () => {
    const list = [ws("a", "manager"), ws("b", "staff")];
    expect(hubView({ platformAdmin: false }, list)).toEqual({ kind: "list", workspaces: list, canCreate: false });
  });

  it("tells a client with no workspace that they have no access yet", () => {
    expect(hubView({ platformAdmin: false }, [])).toEqual({ kind: "no-access" });
  });

  it("encodes the slug in the redirect", () => {
    expect(hubView({ platformAdmin: false }, [ws("a b")])).toEqual({ kind: "redirect", to: "/w/a%20b" });
  });
});
