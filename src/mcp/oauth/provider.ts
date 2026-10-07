// One OAuth provider per origin (comprehensive desk design section 4; Wave
// 2 plan, Decision 2). Each allowed host is its own issuer and its own
// resource (<origin>/mcp), so a token issued on a client host never works
// anywhere else, like the per-host session cookies. The library serves the
// metadata, token and registration endpoints and checks bearer tokens on
// /mcp; the authorize page (handlers.ui) and the MCP handler (handlers.api)
// are the app's, wired in src/mcp/routes.ts. Grants, tokens and clients live
// in OAUTH_KV. Relative imports only: custom-worker.ts bundles this.

import { OAuthProvider, getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { appOrigin } from "../../server/host";
import { ACCESS_TOKEN_TTL_S, AUTHORIZE_PATH, GRANT_TTL_S, MCP_PATH, REGISTER_PATH, SCOPES_SUPPORTED, TOKEN_PATH } from "../constants";
import { registrationRefusal } from "./client-policy";

type Options = OAuthProviderOptions<CloudflareEnv>;

export type ProviderHandlers = { api: NonNullable<Options["apiHandler"]>; ui: Options["defaultHandler"] };

export function providerOptions(origin: string, handlers: ProviderHandlers): Options {
  return {
    apiRoute: `${origin}${MCP_PATH}`,
    apiHandler: handlers.api,
    defaultHandler: handlers.ui,
    authorizeEndpoint: `${origin}${AUTHORIZE_PATH}`,
    tokenEndpoint: `${origin}${TOKEN_PATH}`,
    clientRegistrationEndpoint: `${origin}${REGISTER_PATH}`,
    scopesSupported: SCOPES_SUPPORTED,
    // requiredScopes stays unset: the consent page picks the scopes.
    resourceMetadata: {
      resource: `${origin}${MCP_PATH}`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Ordering Desk",
    },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: ACCESS_TOKEN_TTL_S,
    // Fixed 90 days (owner decision 1, Oct 7; no idle extension): people
    // reconnect every 90 days. The mirror's expires_at uses the same value.
    refreshTokenTTL: GRANT_TTL_S,
    clientRegistrationCallback: ({ clientMetadata }) => registrationRefusal(clientMetadata),
    // Ids and reason slugs only, never tokens or client metadata.
    onError: ({ code, status, internal }) => {
      console.warn("[oauth] " + JSON.stringify({ code, status, reason: internal?.reason ?? null }));
    },
  };
}

const providers = new Map<string, OAuthProvider<CloudflareEnv>>();

// The provider for a resolved host's origin, built once per isolate.
export function providerFor(origin: string, handlers: ProviderHandlers): OAuthProvider<CloudflareEnv> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<CloudflareEnv>(providerOptions(origin, handlers));
    providers.set(origin, provider);
  }
  return provider;
}

const NOT_FOUND = { fetch: () => new Response("Not found", { status: 404 }) };

// Helpers for app code outside a provider request (Settings revokes KV
// grants). Grants are filed by user id in the one shared namespace, so the
// hub's options reach every host's grants.
export function oauthHelpers(env: CloudflareEnv): OAuthHelpers {
  return getOAuthApi(providerOptions(appOrigin(env), { api: NOT_FOUND, ui: NOT_FOUND }), env);
}
