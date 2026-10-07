import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { AuthorizationError, type AuthRequest, type CompleteAuthorizationOptions } from "@cloudflare/workers-oauth-provider";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { providerUserId } from "../grants";
import { ADMIN, HOST, HUB, MANAGER, NOW, ORIGIN, WS, setupMcp, testEnv } from "../test-helpers";
import { authorize, type AuthorizeDeps, type AuthorizeHelpers } from "./authorize";

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const QUERY = "?response_type=code&client_id=c&state=st";

function fakeHelpers(consent: Record<string, unknown> = {}, parseError?: Error, request: Partial<AuthRequest> = {}) {
  const authRequest: AuthRequest = {
    responseType: "code",
    clientId: "https://claude.ai/oauth/mcp-client",
    redirectUri: CALLBACK,
    scope: ["desk.read", "desk.write", "offline_access"],
    state: "st",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    resource: `${ORIGIN}/mcp`,
    issuer: ORIGIN,
    ...request,
  };
  const open = new Map<string, AuthRequest>();
  const completed: CompleteAuthorizationOptions[] = [];
  const helpers: AuthorizeHelpers = {
    parseAuthRequest: vi.fn(async () => {
      if (parseError) {
        throw parseError;
      }
      return authRequest;
    }),
    describeConsent: vi.fn(async () => ({
      clientId: authRequest.clientId,
      clientName: "Claude",
      clientDomain: "claude.ai",
      redirectUri: CALLBACK,
      redirectHost: "claude.ai",
      redirectIsLoopback: false,
      scope: authRequest.scope,
      ...consent,
    })),
    beginConsent: vi.fn(async (request: AuthRequest) => {
      const handle = `consent${open.size + 1}`;
      open.set(handle, request);
      return { handle, headers: new Headers({ "set-cookie": `__Host-oauth-consent-${handle}=1; Secure; Path=/` }) };
    }),
    approveConsent: vi.fn(async (_request: Request, handle: string, options?: { scope?: string[] }) => {
      const request = open.get(handle);
      if (!request) {
        throw new AuthorizationError("invalid_request", { description: "This page expired" });
      }
      open.delete(handle);
      return { request: { ...request, scope: options?.scope ?? request.scope }, headers: new Headers() };
    }),
    denyConsent: vi.fn(async (_request: Request, handle: string) => {
      const redirectTo = `${CALLBACK}?error=access_denied&state=st&iss=${encodeURIComponent(ORIGIN)}`;
      open.delete(handle);
      return { request: authRequest, redirectTo, headers: new Headers({ location: redirectTo }) };
    }),
    completeAuthorization: vi.fn(async (options: CompleteAuthorizationOptions) => {
      completed.push(options);
      return { redirectTo: `${CALLBACK}?code=abc&state=st&iss=${encodeURIComponent(ORIGIN)}` };
    }),
  };
  return { helpers, completed };
}

function harness(db: Db, helpers: AuthorizeHelpers, origin = ORIGIN) {
  const codes: { to: string; code: string }[] = [];
  const pending: Promise<unknown>[] = [];
  const deps: AuthorizeDeps = {
    db,
    env: testEnv(),
    helpers,
    now: () => NOW,
    background: (work) => {
      pending.push(work);
    },
    sendCode: async (message) => {
      codes.push({ to: message.to, code: message.code });
    },
  };
  const url = `${origin}/oauth/authorize${QUERY}`;
  const get = () => authorize(new Request(url), deps);
  const post = async (fields: Record<string, string>) => {
    const response = await authorize(
      new Request(url, { method: "POST", body: new URLSearchParams(fields), headers: { "cf-connecting-ip": "203.0.113.7" } }),
      deps,
    );
    await Promise.all(pending);
    return response;
  };
  return { deps, codes, get, post };
}

const field = (html: string, name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? "";

async function signIn(h: ReturnType<typeof harness>, email = "casey.lin@example.com") {
  const codePage = await (await h.post({ step: "email", email })).text();
  const handle = field(codePage, "handle");
  const sent = h.codes.find((entry) => entry.to === email);
  const consent = await h.post({ step: "code", handle, email, code: sent?.code ?? "000000" });
  return { handle, consent, html: await consent.text() };
}

describe("the authorize page", () => {
  it("starts with the email step in the workspace's look, never framed", async () => {
    const db = await setupMcp();
    const response = await harness(db, fakeHelpers().helpers).get();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Connect Claude to Example Rentals");
    expect(html).toContain('name="step" value="email"');
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("sends a code only to someone who may connect, and shows everyone the same next page", async () => {
    const db = await setupMcp();
    const h = harness(db, fakeHelpers().helpers);
    const member = await (await h.post({ step: "email", email: "Casey.Lin@example.com" })).text();
    const stranger = await (await h.post({ step: "email", email: "stranger@example.com" })).text();
    expect(h.codes.map((entry) => entry.to)).toEqual(["casey.lin@example.com"]);
    expect(member.replace(/value="[^"]*"/g, "").replace(/casey\.lin@example\.com|stranger@example\.com/g, "")).toBe(
      stranger.replace(/value="[^"]*"/g, "").replace(/casey\.lin@example\.com|stranger@example\.com/g, ""),
    );
    expect(await db.select().from(schema.aiSignInCodes)).toHaveLength(2);
  });

  it("names the app, the workspace and the role after the right code; Allow records the grant and goes back to the app", async () => {
    const db = await setupMcp();
    const { helpers, completed } = fakeHelpers();
    const h = harness(db, helpers);
    const { handle, consent, html } = await signIn(h);
    expect(consent.status).toBe(200);
    expect(consent.headers.get("set-cookie")).toContain("__Host-oauth-consent-consent1");
    expect(consent.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai");
    expect(html).toContain("Published by <strong>claude.ai</strong>");
    expect(html).toContain("Example Rentals");
    expect(html).toContain("You connect as <strong>Manager</strong>");
    const done = await h.post({ step: "consent", handle: field(html, "handle"), signin: handle, workspace: WS, access: "change", decision: "approve" });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${CALLBACK}?code=abc&state=st&iss=${encodeURIComponent(ORIGIN)}`);
    expect(completed).toHaveLength(1);
    const grantId = (completed[0].props as { grantId: string }).grantId;
    expect(completed[0]).toMatchObject({
      userId: providerUserId(WS, MANAGER),
      scope: ["desk.read", "desk.write", "offline_access"],
      metadata: { aiGrantId: grantId, workspaceId: WS },
      props: { v: 1, kind: "member", grantId, workspaceId: WS, userId: MANAGER },
    });
    const grants = await db.select().from(schema.aiGrants);
    expect(grants).toEqual([
      expect.objectContaining({
        id: grantId,
        workspaceId: WS,
        userId: MANAGER,
        host: HOST,
        clientId: "https://claude.ai/oauth/mcp-client",
        client: "claude",
        clientDomain: "claude.ai",
        redirectHost: "claude.ai",
        scopes: ["desk.read", "desk.write", "offline_access"],
        revokedAt: null,
      }),
    ]);
  });

  it("grants look-up-only access without desk.write", async () => {
    const db = await setupMcp();
    const { helpers, completed } = fakeHelpers();
    const h = harness(db, helpers);
    const { handle, html } = await signIn(h);
    await h.post({ step: "consent", handle: field(html, "handle"), signin: handle, workspace: WS, access: "read", decision: "approve" });
    expect(completed[0].scope).toEqual(["desk.read", "offline_access"]);
  });

  it("says how many tries are left after a wrong code, and asks for a new code after five", async () => {
    const db = await setupMcp();
    const h = harness(db, fakeHelpers().helpers);
    const handle = field(await (await h.post({ step: "email", email: "casey.lin@example.com" })).text(), "handle");
    const right = h.codes[0].code;
    const wrong = right === "000000" ? "111111" : "000000";
    const first = await (await h.post({ step: "code", handle, email: "casey.lin@example.com", code: wrong })).text();
    expect(first).toContain("That code is not right. 4 tries left.");
    for (let i = 0; i < 4; i++) {
      await h.post({ step: "code", handle, email: "casey.lin@example.com", code: wrong });
    }
    const last = await (await h.post({ step: "code", handle, email: "casey.lin@example.com", code: right })).text();
    expect(last).toContain("That code expired or was tried too many times.");
  });

  it("goes back to the app with access_denied on Deny, recording nothing", async () => {
    const db = await setupMcp();
    const { helpers, completed } = fakeHelpers();
    const h = harness(db, helpers);
    const { handle, html } = await signIn(h);
    const denied = await h.post({ step: "consent", handle: field(html, "handle"), signin: handle, workspace: WS, decision: "deny" });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("error=access_denied");
    expect(completed).toEqual([]);
    expect(await db.select().from(schema.aiGrants)).toEqual([]);
  });

  it("uses a sign-in once: a replayed consent form is refused", async () => {
    const db = await setupMcp();
    const { helpers, completed } = fakeHelpers();
    const h = harness(db, helpers);
    const { handle, html } = await signIn(h);
    const form = { step: "consent", handle: field(html, "handle"), signin: handle, workspace: WS, access: "change", decision: "approve" };
    expect((await h.post(form)).status).toBe(302);
    const replay = await h.post(form);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("This page expired");
    expect(completed).toHaveLength(1);
  });

  // OAuth 2.1 and the MCP spec: PKCE with S256 on every authorization
  // request. The library enforces it only for public clients, so a client
  // registered with a secret is held to it here.
  it("refuses a request without an S256 PKCE challenge, from any client", async () => {
    const db = await setupMcp();
    for (const request of [{ codeChallenge: undefined, codeChallengeMethod: undefined }, { codeChallengeMethod: "plain" }]) {
      const response = await harness(db, fakeHelpers({}, undefined, request as Partial<AuthRequest>).helpers).get();
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("This link cannot be used");
    }
  });

  it("refuses apps that send access elsewhere, and workspaces whose AI switch is off", async () => {
    const db = await setupMcp();
    const lookalike = harness(db, fakeHelpers({ redirectUri: "https://evil.example.com/cb", redirectHost: "evil.example.com", clientDomain: undefined }).helpers);
    expect((await lookalike.get()).status).toBe(403);
    await db.update(schema.workspaceSettings).set({ aiTeam: false }).where(eq(schema.workspaceSettings.workspaceId, WS));
    const off = await harness(db, fakeHelpers().helpers).get();
    expect(off.status).toBe(403);
    expect(await off.text()).toContain("AI connections are off");
  });

  it("redirects a bad request back to the app only when the library says that is safe", async () => {
    const db = await setupMcp();
    const safe = new AuthorizationError("invalid_scope", { description: "bad scope", redirectUri: CALLBACK, state: "st", issuer: ORIGIN });
    const redirected = await harness(db, fakeHelpers({}, safe).helpers).get();
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toContain("error=invalid_scope");
    const unsafe = await harness(db, fakeHelpers({}, new AuthorizationError("invalid_request", { description: "Invalid redirect URI" })).helpers).get();
    expect(unsafe.status).toBe(400);
    expect(unsafe.headers.get("location")).toBeNull();
  });

  it("on the hub, binds the workspace picked from the person's own", async () => {
    const db = await setupMcp();
    const { helpers, completed } = fakeHelpers({ redirectUri: CALLBACK }, undefined);
    const h = harness(db, helpers, `https://${HUB}`);
    const { handle, html } = await signIn(h);
    expect(html).toContain(`name="workspace" value="${WS}"`);
    const refused = await h.post({ step: "consent", handle: field(html, "handle"), signin: handle, workspace: "ws_other", decision: "approve" });
    expect(refused.status).toBe(403);
    expect(completed).toEqual([]);
  });

  // Owner decision 3 (Oct 7): a platform admin on the hub gets one
  // connection for every workspace with AI on; a workspace field sent with
  // the form changes nothing.
  it("on the hub, gives a platform admin one connection for every workspace", async () => {
    const db = await setupMcp();
    const { helpers, completed } = fakeHelpers();
    const h = harness(db, helpers, `https://${HUB}`);
    const { handle, html } = await signIn(h, "avery.stone@example.com");
    expect(html).toContain("every workspace with AI connections on");
    expect(html).not.toContain('name="workspace"');
    const done = await h.post({ step: "consent", handle: field(html, "handle"), signin: handle, workspace: WS, access: "change", decision: "approve" });
    expect(done.status).toBe(302);
    const grantId = (completed[0].props as { grantId: string }).grantId;
    expect(completed[0]).toMatchObject({
      userId: providerUserId(null, ADMIN),
      metadata: { aiGrantId: grantId, workspaceId: null },
      props: { v: 1, kind: "member", grantId, workspaceId: null, userId: ADMIN },
    });
    expect(await db.select().from(schema.aiGrants)).toEqual([expect.objectContaining({ id: grantId, workspaceId: null, userId: ADMIN, host: HUB })]);
  });
});
