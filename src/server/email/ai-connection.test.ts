import { describe, it, expect, vi } from "vitest";
import { sendNewConnectionEmail } from "./ai-connection";

type Sent = { to: string[]; subject: string; html: string; text?: string };

describe("sendNewConnectionEmail", () => {
  it("tells the person which app connected, from where, and how to revoke it", async () => {
    const email = { send: vi.fn(async (_message: Sent) => ({ messageId: "m1" })) };
    const env = { APP_URL: "https://hub.example.com", EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>", EMAIL: email } as unknown as CloudflareEnv;
    await sendNewConnectionEmail(env, {
      to: "casey.lin@example.com",
      workspace: null,
      workspaceName: "Example Rentals",
      clientLabel: "Claude",
      redirectHost: "claude.ai",
      settingsUrl: "https://orders.example.com/settings#ai",
    });
    const [message] = email.send.mock.calls.map((entry) => entry[0]);
    expect(message.subject).toBe("Claude is connected to Example Rentals orders");
    expect(message.html).toContain("claude.ai");
    expect(message.html).toContain("Not you?");
    expect(message.html).toContain("https://orders.example.com/settings#ai");
  });

  // Owner decision 3 (Oct 7): a platform admin's hub connection covers
  // every workspace with AI on.
  it("names every workspace for a platform admin's hub connection", async () => {
    const email = { send: vi.fn(async (_message: Sent) => ({ messageId: "m2" })) };
    const env = { APP_URL: "https://hub.example.com", EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>", EMAIL: email } as unknown as CloudflareEnv;
    await sendNewConnectionEmail(env, {
      to: "avery.stone@example.com",
      workspace: null,
      workspaceName: "every workspace",
      everyWorkspace: true,
      clientLabel: "Claude",
      redirectHost: "claude.ai",
      settingsUrl: "https://hub.example.com/",
    });
    const [message] = email.send.mock.calls.map((entry) => entry[0]);
    expect(message.subject).toBe("Claude is connected to Ordering Desk in every workspace");
    expect(message.html).toContain("every workspace with AI connections on");
    expect(message.html).toContain("Not you?");
  });
});
