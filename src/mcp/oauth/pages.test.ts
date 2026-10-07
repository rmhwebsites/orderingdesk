import { describe, it, expect } from "vitest";
import { lookFor } from "@/server/email/layout";
import { codePage, consentPage, emailPage, messagePage, pageHeaders } from "./pages";

const look = lookFor({ id: "ws_impact", name: "Example Rentals", accentColor: "#91d500", branding: null }, "https://hub.example.com");
const ctx = { look, clientLabel: "Claude", action: "/oauth/authorize?client_id=x&state=s" };

const consent = (overrides: Record<string, unknown> = {}) => ({
  clientName: "Claude",
  clientDomain: "claude.ai",
  redirectHost: "claude.ai",
  redirectIsLoopback: false,
  client: "claude" as const,
  ...overrides,
});

describe("authorize pages", () => {
  it("ask for the email, then the code, posting back to the same authorize URL", () => {
    const email = emailPage(ctx, { error: "Enter a valid email address.", email: "<b>x" });
    expect(email).toContain("Connect Claude to Example Rentals");
    expect(email).toContain('action="/oauth/authorize?client_id=x&amp;state=s"');
    expect(email).toContain('name="step" value="email"');
    expect(email).toContain("&lt;b&gt;x");
    expect(email).toContain('role="alert"');
    const code = codePage(ctx, { handle: "h_1", email: "casey.lin@example.com" });
    expect(code).toContain('name="handle" value="h_1"');
    expect(code).toContain('autocomplete="one-time-code"');
    expect(code).toContain('inputmode="numeric"');
  });

  it("name the app, its verified domain, where access goes, the workspace and the role", () => {
    const page = consentPage(ctx, {
      handle: "c1",
      signin: "s1",
      consent: consent(),
      workspaces: [{ id: "ws_impact", name: "Example Rentals", role: "manager" }],
    });
    expect(page).toContain("Published by <strong>claude.ai</strong>");
    expect(page).toContain("Access will be sent to <strong>claude.ai</strong>");
    expect(page).toContain('name="workspace" value="ws_impact"');
    expect(page).toContain("You connect as <strong>Manager</strong>");
    expect(page).toContain('value="change" checked');
    expect(page).toContain('value="read"');
    expect(page).toContain('name="decision" value="approve"');
    expect(page).toContain('name="decision" value="deny"');
    expect(page).toContain("This connection lasts 90 days, then you connect again.");
    expect(page).not.toContain("on this computer");
  });

  it("warn about local apps and unverified names, escape everything the app chose, and offer a member a workspace choice on the hub", () => {
    const page = consentPage(ctx, {
      handle: "c1",
      signin: "s1",
      consent: consent({ clientName: '<img src=x onerror="alert(1)">', clientDomain: undefined, redirectHost: "localhost", redirectIsLoopback: true }),
      workspaces: [
        { id: "ws_impact", name: "Example Rentals", role: "manager" },
        { id: "ws_other", name: "Another <Co>", role: "staff" },
      ],
    });
    expect(page).toContain("that name is not verified");
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("an app on this computer");
    expect(page).toContain('<select id="workspace" name="workspace" required>');
    expect(page).toContain("Another &lt;Co&gt; (Staff)");
  });

  // Owner decision 3 (Oct 7): a platform admin on the hub connects once for
  // every workspace with AI on; nothing to pick, and the tools ask which one.
  it("name every workspace for a platform admin's hub connection, with no picker", () => {
    const page = consentPage(ctx, {
      handle: "c1",
      signin: "s1",
      consent: consent(),
      workspaces: [
        { id: "ws_impact", name: "Example Rentals", role: "platform" },
        { id: "ws_other", name: "Another <Co>", role: "platform" },
      ],
      everyWorkspace: true,
    });
    expect(page).toContain("every workspace with AI connections on");
    expect(page).toContain("Example Rentals, Another &lt;Co&gt;");
    expect(page).toContain("You connect as <strong>Platform admin</strong>");
    expect(page).toContain("Each request names the workspace");
    expect(page).not.toContain('name="workspace"');
  });

  it("give the code page's other-email link a 44px touch target", () => {
    const code = codePage(ctx, { handle: "h", email: "e@example.com" });
    expect(code).toContain('<a class="text-link" href="/oauth/authorize?client_id=x&amp;state=s">Use a different email</a>');
    expect(code).toMatch(/\.text-link \{[^}]*display: inline-flex;[^}]*min-height: 44px;/);
  });

  it("show plain messages", () => {
    const page = messagePage(look, { title: "AI connections are off", message: "Ask a platform admin." });
    expect(page).toContain("<h1>AI connections are off</h1>");
    expect(page).toContain("You can close this window.");
  });

  it("send no-store, never-framed headers that allow the form to post here and to the app", () => {
    const base = new Headers({ "set-cookie": "__Host-oauth-consent-c1=1; Secure; Path=/" });
    const headers = pageHeaders({ formTargets: ["https://claude.ai"], imageOrigin: "https://hub.example.com", base });
    expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("set-cookie")).toContain("__Host-oauth-consent-c1");
    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://claude.ai");
    expect(csp).toContain("img-src 'self' https://hub.example.com");
    expect(csp).toContain("default-src 'none'");
  });

  it("use no dashes or emoji in the copy", () => {
    const all = [emailPage(ctx), codePage(ctx, { handle: "h", email: "e@example.com" }), consentPage(ctx, { handle: "c", signin: "s", consent: consent(), workspaces: [{ id: "w", name: "W", role: "staff" }] })].join("");
    expect(all.match(/[\u2013\u2014\u2600-\u27bf]/g)).toBeNull();
  });
});
