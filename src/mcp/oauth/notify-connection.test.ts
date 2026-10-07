import { describe, it, expect, vi } from "vitest";
import type { NewConnectionMessage } from "../../server/email/ai-connection";
import { ADMIN, HOST, HUB, MANAGER, WS, setupMcp, testEnv } from "../test-helpers";
import { notifyNewConnection } from "./notify-connection";

describe("notifyNewConnection", () => {
  it("emails the person a link to their AI connections on the host they connected on", async () => {
    const db = await setupMcp();
    const send = vi.fn(async (_env: CloudflareEnv, _message: NewConnectionMessage) => undefined);
    await notifyNewConnection(db, testEnv(), { userId: MANAGER, workspaceId: WS, clientLabel: "Claude", redirectHost: "claude.ai", host: HOST }, send);
    expect(send.mock.calls[0][1]).toMatchObject({
      to: "casey.lin@example.com",
      workspaceName: "Example Rentals",
      settingsUrl: `https://${HOST}/settings#ai`,
    });
    await notifyNewConnection(db, testEnv(), { userId: MANAGER, workspaceId: WS, clientLabel: "ChatGPT", redirectHost: "chatgpt.com", host: HUB }, send);
    expect(send.mock.calls[1][1]).toMatchObject({ workspace: null, settingsUrl: `https://${HUB}/w/${WS}/settings#ai` });
    await notifyNewConnection(db, testEnv(), { userId: ADMIN, workspaceId: null, clientLabel: "Claude", redirectHost: "claude.ai", host: HUB }, send);
    expect(send.mock.calls[2][1]).toMatchObject({ to: "avery.stone@example.com", workspace: null, everyWorkspace: true, settingsUrl: `https://${HUB}/` });
  });

  it("never throws", async () => {
    const db = await setupMcp();
    const send = vi.fn(async () => {
      throw new Error("mail down");
    });
    await expect(notifyNewConnection(db, testEnv(), { userId: MANAGER, workspaceId: WS, clientLabel: "Claude", redirectHost: "claude.ai", host: HOST }, send)).resolves.toBeUndefined();
  });
});
