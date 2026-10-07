// The authorize endpoint of the MCP server's OAuth flow (comprehensive desk
// design section 4; Wave 2 plan, Decisions 3 to 7). The OAuth library
// validates the request (client, redirect URI, PKCE, resource) on every step
// (parseAuthRequest reads only the URL, so each form posts back to the same
// URL); this page signs the person in with a 6-digit code, then asks for
// consent naming the app, the workspace and the role, then completes the
// grant and mirrors it in D1. A platform admin on the hub gets one
// connection for every workspace with AI on (owner decision 3, Oct 7): the
// grant, its props and its mirror row carry workspaceId null. Steps (field
// "step"): email, code, consent.
// Refused here: a request without an S256 PKCE challenge (whatever the
// client type), apps outside client-policy.ts, workspaces whose AI switch
// is off, and anyone without a live role. Errors redirect back to the app only
// when the library validated the redirect URI and it is one of the AI apps'
// callbacks (a metadata document can name any page). Logs carry ids only.
// Relative imports only: custom-worker.ts bundles this.

import { AuthorizationError, CimdFetchError, type AuthRequest, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { user } from "../../db/schema";
import { aiClientLabel } from "../../lib/via";
import { lookFor, type Look } from "../../server/email/layout";
import { loadMailWorkspace } from "../../server/email/workspace";
import { appOrigin, hostOrigin, resolveHost, type HostResolution } from "../../server/host";
import { SCOPE_OFFLINE, SCOPE_READ, SCOPE_WRITE } from "../constants";
import { providerUserId, recordGrant } from "../grants";
import { newId } from "../ids";
import { connectableUser, connectableWorkspaces, connectsToEveryWorkspace, teamAiOn } from "./access";
import { clientOf, consentAllowed, isAllowedRedirect } from "./client-policy";
import { consumeSignIn, normalizeEmail, requestSignInCode, verifySignInCode } from "./codes";
import { codePage, consentPage, emailPage, messagePage, pageHeaders } from "./pages";

export type AuthorizeHelpers = Pick<
  OAuthHelpers,
  "parseAuthRequest" | "describeConsent" | "beginConsent" | "approveConsent" | "denyConsent" | "completeAuthorization"
>;

// workspaceId null: a platform admin's hub connection for every workspace.
export type ConnectionNotice = { userId: string; workspaceId: string | null; clientLabel: string; redirectHost: string; host: string };

export type AuthorizeDeps = {
  db: Db;
  env: CloudflareEnv;
  helpers: AuthorizeHelpers;
  now: () => number;
  background: (work: Promise<unknown>) => void;
  sendCode: (message: { to: string; code: string; workspaceId: string | null; clientLabel: string }) => Promise<void>;
  // The "new AI connection" email (Task 33).
  notifyConnection?: (notice: ConnectionNotice) => Promise<void>;
};

const EXPIRED = { title: "This page expired", message: "Start connecting again from your AI app." };

async function lookOf(db: Db, env: CloudflareEnv, resolution: HostResolution): Promise<Look> {
  const workspace = resolution.kind === "workspace" ? await loadMailWorkspace(db, resolution.workspace.id) : null;
  return lookFor(workspace, appOrigin(env));
}

function imageOrigin(look: Look): string | null {
  return look.logoUrl ? new URL(look.logoUrl).origin : null;
}

async function userById(db: Db, id: string): Promise<{ id: string; email: string } | null> {
  const rows = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function authorize(request: Request, deps: AuthorizeDeps): Promise<Response> {
  const { db, env } = deps;
  const url = new URL(request.url);
  const resolution = await resolveHost(db, env, url.host);
  const origin = hostOrigin(env, resolution);
  if (origin === null) {
    return new Response("Not found", { status: 404 });
  }
  const look = await lookOf(db, env, resolution);
  const render = (status: number, body: string, base?: Headers, formTargets: string[] = []) =>
    new Response(body, { status, headers: pageHeaders({ formTargets, imageOrigin: imageOrigin(look), base }) });
  const show = (status: number, text: { title: string; message: string }) => render(status, messagePage(look, text));

  let authRequest: AuthRequest;
  let consent: ConsentDescription;
  try {
    authRequest = await deps.helpers.parseAuthRequest(request);
    consent = await deps.helpers.describeConsent(authRequest);
  } catch (e) {
    // The library sets redirectTo once the redirect URI matches the client's
    // registration, but anyone can publish a Client ID Metadata Document
    // naming any https page, so its error redirect is followed only to the
    // AI apps' own callbacks; anything else would make this host a
    // redirector for phishing links.
    if (e instanceof AuthorizationError && e.redirectTo && e.redirectUri && isAllowedRedirect(e.redirectUri)) {
      return Response.redirect(e.redirectTo, 302);
    }
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      return show(400, { title: "This link cannot be used", message: "Start connecting again from your AI app." });
    }
    throw e;
  }
  // PKCE with S256 from every client, confidential ones included (the
  // library requires it only from public clients).
  if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== "S256") {
    return show(400, { title: "This link cannot be used", message: "Start connecting again from your AI app." });
  }
  if (!consentAllowed(consent)) {
    return show(403, { title: "This app cannot connect", message: "Ordering Desk connects to Claude, ChatGPT and apps on this computer only." });
  }
  if (resolution.kind === "workspace" && !(await teamAiOn(db, resolution.workspace.id))) {
    return show(403, {
      title: "AI connections are off",
      message: `AI connections are turned off for ${resolution.workspace.name}. A platform admin can turn them on in Settings.`,
    });
  }
  const client = clientOf(consent);
  const ctx = { look, clientLabel: aiClientLabel(client), action: url.pathname + url.search };

  if (request.method === "GET") {
    return render(200, emailPage(ctx));
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  const form = await request.formData().catch(() => null);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === "string" ? value : "";
  };
  const now = deps.now();
  try {
    switch (field("step")) {
      case "email": {
        const email = normalizeEmail(field("email"));
        if (!email) {
          return render(400, emailPage(ctx, { error: "Enter a valid email address.", email: field("email").slice(0, 254) }));
        }
        const handle = await requestSignInCode(
          db,
          { origin, email, clientId: authRequest.clientId, ip: request.headers.get("cf-connecting-ip") ?? "" },
          {
            now,
            lookupUser: async (address) => (await connectableUser(db, env, address, resolution))?.id ?? null,
            send: (code) =>
              deps.sendCode({
                to: email,
                code,
                workspaceId: resolution.kind === "workspace" ? resolution.workspace.id : null,
                clientLabel: ctx.clientLabel,
              }),
            background: deps.background,
          },
        );
        return render(200, codePage(ctx, { handle, email }));
      }
      case "code": {
        const handle = field("handle");
        const email = normalizeEmail(field("email")) ?? "";
        const verified = await verifySignInCode(db, { id: handle, origin, clientId: authRequest.clientId, code: field("code").replace(/\D/g, "") }, now);
        if (verified.kind === "wrong") {
          const tries = verified.attemptsLeft === 1 ? "1 try" : `${verified.attemptsLeft} tries`;
          return render(400, codePage(ctx, { handle, email, error: `That code is not right. ${tries} left.` }));
        }
        if (verified.kind === "expired") {
          return render(400, emailPage(ctx, { error: "That code expired or was tried too many times. Ask for a new one.", email }));
        }
        const signedIn = { id: verified.userId, email: verified.email };
        const workspaces = await connectableWorkspaces(db, env, signedIn, resolution);
        if (workspaces.length === 0) {
          return show(403, { title: "No workspace to connect", message: "Your account has no workspace where AI connections are on." });
        }
        const everyWorkspace = await connectsToEveryWorkspace(db, env, signedIn, resolution);
        const transaction = await deps.helpers.beginConsent(authRequest);
        return render(
          200,
          consentPage(ctx, { handle: transaction.handle, signin: handle, consent: { ...consent, client }, workspaces, everyWorkspace }),
          transaction.headers,
          [new URL(consent.redirectUri).origin],
        );
      }
      case "consent": {
        const handle = field("handle");
        if (field("decision") !== "approve") {
          const denied = await deps.helpers.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const signedIn = await consumeSignIn(db, { id: field("signin"), origin, clientId: authRequest.clientId }, now);
        if (!signedIn) {
          return show(400, EXPIRED);
        }
        const person = await userById(db, signedIn.userId);
        const workspaces = person ? await connectableWorkspaces(db, env, person, resolution) : [];
        // A platform admin on the hub connects for every workspace: the
        // workspace field is ignored and the grant names none.
        const everyWorkspace = person !== null && workspaces.length > 0 && (await connectsToEveryWorkspace(db, env, person, resolution));
        const chosen = everyWorkspace
          ? null
          : resolution.kind === "workspace"
            ? workspaces[0]
            : workspaces.find((entry) => entry.id === field("workspace"));
        if (!person || (!everyWorkspace && !chosen)) {
          return show(403, { title: "No access", message: "This account cannot connect an AI app to that workspace." });
        }
        const workspaceId = chosen ? chosen.id : null;
        const scope = [
          SCOPE_READ,
          ...(field("access") === "read" ? [] : [SCOPE_WRITE]),
          ...(authRequest.scope.includes(SCOPE_OFFLINE) ? [SCOPE_OFFLINE] : []),
        ];
        const approved = await deps.helpers.approveConsent(request, handle, { scope });
        const grantId = newId();
        const { redirectTo } = await deps.helpers.completeAuthorization({
          request: approved.request,
          userId: providerUserId(workspaceId, person.id),
          metadata: { aiGrantId: grantId, workspaceId },
          scope,
          props: { v: 1, kind: "member", grantId, workspaceId, userId: person.id },
        });
        await recordGrant(
          db,
          grantId,
          {
            workspaceId,
            userId: person.id,
            host: url.hostname.toLowerCase(),
            clientId: approved.request.clientId,
            client,
            clientDomain: consent.clientDomain ?? null,
            redirectHost: consent.redirectHost,
            scopes: scope,
          },
          now,
        );
        console.log("[oauth] " + JSON.stringify({ workspaceId, grantId, client, connected: true }));
        if (deps.notifyConnection) {
          deps.background(
            deps
              .notifyConnection({ userId: person.id, workspaceId, clientLabel: ctx.clientLabel, redirectHost: consent.redirectHost, host: url.hostname })
              .catch(() => undefined),
          );
        }
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }
      default:
        return show(400, EXPIRED);
    }
  } catch (e) {
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      return show(400, EXPIRED);
    }
    throw e;
  }
}
