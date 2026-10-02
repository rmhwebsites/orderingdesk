import { describe, it, expect, vi, afterEach } from "vitest";
import { sendEmail, senderFor, workspaceSenderAddress, DEFAULT_FROM, type SenderWorkspace } from "./send";

function makeEnv(overrides: Record<string, unknown>): CloudflareEnv {
  return { APP_URL: "https://orderdesk.example.com", ...overrides } as unknown as CloudflareEnv;
}

function makeEmailStub() {
  return { send: vi.fn(async (_message: unknown) => ({ messageId: "msg-1" })) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendEmail (Cloudflare Email Service driver)", () => {
  it("maps options onto the Email Service builder shape", async () => {
    const email = makeEmailStub();
    const result = await sendEmail(makeEnv({ EMAIL: email }), {
      from: DEFAULT_FROM,
      to: ["a@example.com", "b@example.com"],
      subject: "Order update",
      html: "<p>Hello</p>",
      cc: ["c@example.com"],
      replyTo: "support@impactrentals.store",
    });
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledWith({
      from: { name: "Ordering Desk", email: "orders@orderingdesk.com" },
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      replyTo: "support@impactrentals.store",
      subject: "Order update",
      html: "<p>Hello</p>",
    });
    expect(result).toEqual({ id: "msg-1" });
  });

  it("passes attachments through with filename, content, MIME type, disposition", async () => {
    const email = makeEmailStub();
    await sendEmail(makeEnv({ EMAIL: email }), {
      from: DEFAULT_FROM,
      to: ["a@example.com"],
      subject: "Your PO",
      html: "<p>PO attached</p>",
      attachments: [{ filename: "po-123.pdf", content: "JVBERi0xLjQ=" }],
    });
    const message = email.send.mock.calls[0][0] as {
      attachments: { filename: string; content: string; type: string; disposition: string }[];
    };
    expect(message.attachments).toEqual([
      {
        filename: "po-123.pdf",
        content: "JVBERi0xLjQ=",
        type: "application/pdf",
        disposition: "attachment",
      },
    ]);
  });

  it("throws in production when the EMAIL binding is missing", async () => {
    await expect(
      sendEmail(makeEnv({}), {
        from: DEFAULT_FROM,
        to: ["a@example.com"],
        subject: "Hi",
        html: "<p>Hi</p>",
      }),
    ).rejects.toThrow("Email sending is not configured (EMAIL binding missing)");
  });

  it("logs the dev fallback instead of sending when APP_URL is localhost", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const email = makeEmailStub();
    const result = await sendEmail(
      makeEnv({ APP_URL: "http://localhost:3000", EMAIL: email }),
      {
        from: DEFAULT_FROM,
        to: ["a@example.com"],
        subject: "Hi",
        html: '<p><a href="http://localhost:3000/verify?token=t">Go</a></p>',
      },
    );
    expect(result).toEqual({ id: "dev-fallback" });
    expect(email.send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[email-fallback]",
      JSON.stringify({
        to: ["a@example.com"],
        subject: "Hi",
        url: "http://localhost:3000/verify?token=t",
      }),
    );
  });
});

describe("sendEmail extras", () => {
  it("carries the plain-text alternative and a structured sender through the binding", async () => {
    const email = makeEmailStub();
    await sendEmail(makeEnv({ EMAIL: email }), {
      from: { name: "Impact Rentals", email: "accounts@orders.impactrentals.store" },
      to: ["a@example.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(email.send).toHaveBeenCalledWith({
      from: { name: "Impact Rentals", email: "accounts@orders.impactrentals.store" },
      to: ["a@example.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  it("logs the first link's address in dev, not an image, with entities decoded", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendEmail(makeEnv({ APP_URL: "http://localhost:3000" }), {
      from: DEFAULT_FROM,
      to: ["a@example.com"],
      subject: "Hi",
      html: '<img src="http://localhost:3000/api/branding/w/logo.png"><a href="http://localhost:3000/verify?token=t&amp;callbackURL=%2F">Go</a>',
    });
    expect(log).toHaveBeenCalledWith(
      "[email-fallback]",
      JSON.stringify({
        to: ["a@example.com"],
        subject: "Hi",
        url: "http://localhost:3000/verify?token=t&callbackURL=%2F",
      }),
    );
  });
});

describe("senderFor (who workspace mail comes from)", () => {
  const ENV = makeEnv({ EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>" });

  function workspace(overrides: Partial<SenderWorkspace> = {}): SenderWorkspace {
    return {
      name: "Impact Rentals",
      customDomain: null,
      customDomainStatus: null,
      sendingAddress: null,
      sendingVerifiedAt: null,
      replyTo: "office@impactrentals.store",
      ...overrides,
    };
  }

  const PLATFORM_AS_WORKSPACE = {
    from: { name: "Impact Rentals", email: "orders@orderingdesk.com" },
    replyTo: "office@impactrentals.store",
  };

  it("sends hub mail from the platform sender", () => {
    expect(senderFor(ENV, null)).toEqual({ from: "Ordering Desk <orders@orderingdesk.com>" });
    expect(senderFor(makeEnv({}), null)).toEqual({ from: DEFAULT_FROM });
  });

  it("falls back to the platform address with the workspace name and reply-to when there is no domain", () => {
    expect(workspaceSenderAddress(workspace())).toBeNull();
    expect(senderFor(ENV, workspace())).toEqual(PLATFORM_AS_WORKSPACE);
  });

  it("does not derive a sender from a pending or failed domain", () => {
    for (const status of ["pending", "error"] as const) {
      const ws = workspace({ customDomain: "orders.impactrentals.store", customDomainStatus: status, sendingVerifiedAt: 5 });
      expect(workspaceSenderAddress(ws)).toBeNull();
      expect(senderFor(ENV, ws)).toEqual(PLATFORM_AS_WORKSPACE);
    }
  });

  it("derives accounts@<active domain>, but uses it only once verified", () => {
    const unverified = workspace({ customDomain: "orders.impactrentals.store", customDomainStatus: "active" });
    expect(workspaceSenderAddress(unverified)).toEqual({ address: "accounts@orders.impactrentals.store", source: "domain" });
    expect(senderFor(ENV, unverified)).toEqual(PLATFORM_AS_WORKSPACE);

    const verified = { ...unverified, sendingVerifiedAt: 1700000000000 };
    expect(senderFor(ENV, verified)).toEqual({
      from: { name: "Impact Rentals", email: "accounts@orders.impactrentals.store" },
      replyTo: "office@impactrentals.store",
    });
  });

  it("prefers a platform admin's override address over the derived one", () => {
    const ws = workspace({
      customDomain: "orders.impactrentals.store",
      customDomainStatus: "active",
      sendingAddress: "hello@impactrentals.store",
    });
    expect(workspaceSenderAddress(ws)).toEqual({ address: "hello@impactrentals.store", source: "override" });
    expect(senderFor(ENV, ws)).toEqual(PLATFORM_AS_WORKSPACE);
    expect(senderFor(ENV, { ...ws, sendingVerifiedAt: 1 }).from).toEqual({
      name: "Impact Rentals",
      email: "hello@impactrentals.store",
    });
    // The override works without any custom domain.
    const noDomain = workspace({ sendingAddress: "hello@impactrentals.store", sendingVerifiedAt: 1 });
    expect(senderFor(ENV, noDomain).from).toEqual({ name: "Impact Rentals", email: "hello@impactrentals.store" });
  });

  it("omits the reply-to when the workspace has none, and keeps the display name header-safe", () => {
    const ws = workspace({ name: 'Bad <name>\r\n"Co"', replyTo: null });
    expect(senderFor(ENV, ws)).toEqual({ from: { name: "Bad name Co", email: "orders@orderingdesk.com" } });
  });
});
