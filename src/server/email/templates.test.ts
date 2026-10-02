import { describe, it, expect, vi } from "vitest";
import { sendPlatformAdminInviteEmail, sendWorkspaceInviteEmail } from "./invite";
import { sendMagicLinkEmail } from "./magic-link";
import type { MailWorkspace } from "./workspace";

type Sent = { from: unknown; to: string[]; subject: string; html: string; text?: string; replyTo?: string };

function makeEnv() {
  const email = { send: vi.fn(async (_message: Sent) => ({ messageId: "m1" })) };
  const env = {
    APP_URL: "https://orderingdesk.test",
    EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>",
    EMAIL: email,
  } as unknown as CloudflareEnv;
  return { env, sent: () => email.send.mock.calls.map((call) => call[0]) };
}

function workspace(overrides: Partial<MailWorkspace> = {}): MailWorkspace {
  return {
    id: "ws_impact",
    name: "Impact Rentals",
    slug: "impact-rentals",
    accentColor: "#91d500",
    branding: {
      logo: {
        light: { key: "branding/ws_impact/logo.svg", contentType: "image/svg+xml", pngKey: "branding/ws_impact/logo.png" },
        dark: null,
      },
    },
    customDomain: "orders.impactrentals.store",
    customDomainStatus: "active",
    sendingAddress: null,
    sendingVerifiedAt: 1,
    replyTo: "office@impactrentals.store",
    ...overrides,
  };
}

const LINK = "https://orders.impactrentals.store/api/auth/magic-link/verify?token=t&callbackURL=%2F";

describe("sign-in email", () => {
  it("comes from and looks like the workspace when requested on its client host", async () => {
    const { env, sent } = makeEnv();
    await sendMagicLinkEmail(env, { to: "crew@example.com", url: LINK, workspace: workspace() });
    const [message] = sent();
    expect(message.from).toEqual({ name: "Impact Rentals", email: "accounts@orders.impactrentals.store" });
    expect(message.replyTo).toBe("office@impactrentals.store");
    expect(message.subject).toBe("Sign in to Impact Rentals orders");
    expect(message.html).toContain('src="https://orderingdesk.test/api/branding/ws_impact/logo.png"');
    expect(message.html).toContain("Sent with Ordering Desk");
    expect(message.html).toContain(LINK.replace(/&/g, "&amp;"));
    expect(message.text).toContain(`Sign in: ${LINK}`);
  });

  it("falls back to the platform address with the workspace name until its sender is verified", async () => {
    const { env, sent } = makeEnv();
    await sendMagicLinkEmail(env, { to: "crew@example.com", url: LINK, workspace: workspace({ sendingVerifiedAt: null }) });
    expect(sent()[0].from).toEqual({ name: "Impact Rentals", email: "orders@orderingdesk.com" });
    expect(sent()[0].subject).toBe("Sign in to Impact Rentals orders");
  });

  it("keeps the Ordering Desk sender and look on the hub", async () => {
    const { env, sent } = makeEnv();
    await sendMagicLinkEmail(env, { to: "boss@example.com", url: "https://orderingdesk.test/api/auth/magic-link/verify?token=t", workspace: null });
    const [message] = sent();
    expect(message.from).toEqual({ name: "Ordering Desk", email: "orders@orderingdesk.com" });
    expect(message.subject).toBe("Sign in to Ordering Desk");
    expect(message.html).not.toContain("<img");
    expect(message.html).toContain(">Ordering Desk</");
  });

  it("strips control characters from a workspace name in the subject", async () => {
    const { env, sent } = makeEnv();
    await sendMagicLinkEmail(env, { to: "a@example.com", url: LINK, workspace: workspace({ name: "Evil\r\nBcc: x@y.z" }) });
    expect(sent()[0].subject).toBe("Sign in to Evil Bcc: x@y.z orders");
  });
});

describe("team invite email", () => {
  it("always carries the workspace's branding and sender, linking to its client host", async () => {
    const { env, sent } = makeEnv();
    await sendWorkspaceInviteEmail(env, "crew@example.com", workspace());
    const [message] = sent();
    expect(message.to).toEqual(["crew@example.com"]);
    expect(message.from).toEqual({ name: "Impact Rentals", email: "accounts@orders.impactrentals.store" });
    expect(message.subject).toBe("You have been added to Impact Rentals orders");
    expect(message.html).toContain('href="https://orders.impactrentals.store/"');
    expect(message.html).toContain("logo.png");
  });

  it("links to the hub when the workspace has no active client host", async () => {
    const { env, sent } = makeEnv();
    await sendWorkspaceInviteEmail(
      env,
      "crew@example.com",
      workspace({ customDomain: null, customDomainStatus: null, sendingVerifiedAt: null }),
    );
    const [message] = sent();
    expect(message.from).toEqual({ name: "Impact Rentals", email: "orders@orderingdesk.com" });
    expect(message.html).toContain('href="https://orderingdesk.test/"');
  });

  it("escapes a hostile workspace name in the invite", async () => {
    const { env, sent } = makeEnv();
    await sendWorkspaceInviteEmail(env, "crew@example.com", workspace({ name: "<img src=x onerror=alert(1)>" }));
    expect(sent()[0].html).not.toContain("<img src=x");
  });
});

describe("platform admin invite email", () => {
  it("is hub mail: Ordering Desk sender and look, linking to the hub", async () => {
    const { env, sent } = makeEnv();
    await sendPlatformAdminInviteEmail(env, "new@example.com");
    const [message] = sent();
    expect(message.from).toEqual({ name: "Ordering Desk", email: "orders@orderingdesk.com" });
    expect(message.subject).toBe("You are now a platform admin on Ordering Desk");
    expect(message.html).toContain('href="https://orderingdesk.test/"');
  });
});
