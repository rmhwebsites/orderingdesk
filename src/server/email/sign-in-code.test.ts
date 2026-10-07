import { describe, it, expect, vi } from "vitest";
import { sendSignInCodeEmail } from "./sign-in-code";
import type { MailWorkspace } from "./workspace";

type Sent = { from: unknown; to: string[]; subject: string; html: string; text?: string };

function makeEnv() {
  const email = { send: vi.fn(async (_message: Sent) => ({ messageId: "m1" })) };
  const env = { APP_URL: "https://hub.example.com", EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>", EMAIL: email } as unknown as CloudflareEnv;
  return { env, sent: () => email.send.mock.calls.map((call) => call[0]) };
}

const workspace: MailWorkspace = {
  id: "ws_impact",
  name: "Example Rentals",
  slug: "example-rentals",
  accentColor: "#91d500",
  branding: null,
  customDomain: "orders.example.com",
  customDomainStatus: "active",
  sendingAddress: null,
  sendingVerifiedAt: null,
  replyTo: null,
};

describe("sendSignInCodeEmail", () => {
  it("sends the code in the workspace's look, in the subject and the body, with no link", async () => {
    const { env, sent } = makeEnv();
    await sendSignInCodeEmail(env, { to: "casey.lin@example.com", code: "042917", clientLabel: "Claude", workspace });
    const [message] = sent();
    expect(message.to).toEqual(["casey.lin@example.com"]);
    expect(message.subject).toBe("042917 is your code to connect Claude to Example Rentals orders");
    expect(message.html).toContain("042 917");
    expect(message.html).toContain("Example Rentals");
    expect(message.html).not.toContain("href=\"http");
    expect(message.text).toContain("042 917");
  });

  it("is Ordering Desk mail on the hub", async () => {
    const { env, sent } = makeEnv();
    await sendSignInCodeEmail(env, { to: "avery.stone@example.com", code: "123456", clientLabel: "ChatGPT", workspace: null });
    expect(sent()[0].subject).toBe("123456 is your code to connect ChatGPT to Ordering Desk");
  });
});
