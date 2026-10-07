// Local end-to-end check of the MCP server (Wave 2). Connects like a chat app
// would (discovery, registration, the authorize page with the emailed code,
// tokens) as a platform admin on the hub, so the connection covers every
// workspace with AI on (owner decision 3, Oct 7): list_workspaces, then
// every read tool, a note and a status change in one workspace through a
// real MCP client, the unknown-workspace and AI-off refusals, the echo,
// replay and expiry rules it can, and a revoke in Settings that turns the
// next call into a 401.
//
// LOCAL ONLY. It refuses any host but localhost or 127.0.0.1, and reads
// sign-in links and codes from the `npm run preview` log, where the local
// email fallback writes them ([email-fallback] lines).
//
//   1. .dev.vars: APP_URL=http://localhost:8787, and your address in
//      PLATFORM_ADMIN_EMAILS.
//   2. npm run db:migrate:local, and the sample data
//      (npx wrangler d1 execute orderingdesk --local --file scripts/seed-local.sql).
//      AI connections start off in every workspace (owner decision, Oct 7):
//      turn them on for the sample workspace, locally
//      (npx wrangler d1 execute orderingdesk --local --command "UPDATE workspace_settings SET ai_team = 1 WHERE workspace_id = 'sample-ws-example-co';"),
//      or with the switch in its Settings > AI connections.
//   3. npm run preview > "$SCRATCH/preview.log" 2>&1   (in the background)
//   4. node scripts/mcp-smoke.mjs --email you@example.com --log "$SCRATCH/preview.log" [--workspace "Example Co"]
//
// One PASS or FAIL line per check; exits 1 at the first failure. It writes
// one note and two status changes on a sample card, and switches the
// workspace's AI connections off and back on; nothing else. --workspace
// picks the workspace the tool calls name (default: the first listed).

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const BASE = (arg("base") ?? "http://localhost:8787").replace(/\/$/, "");
const EMAIL = (arg("email") ?? "").toLowerCase();
const LOG = arg("log");
const WORKSPACE = arg("workspace");
const REDIRECT = "http://127.0.0.1:43110/callback";

if (!EMAIL || !LOG) {
  console.error("usage: node scripts/mcp-smoke.mjs --email you@example.com --log /path/to/preview.log [--base http://localhost:8787] [--workspace name]");
  process.exit(2);
}
const hostname = new URL(BASE).hostname;
if (hostname !== "localhost" && hostname !== "127.0.0.1") {
  console.error("Refusing: this script only talks to a local preview.");
  process.exit(2);
}

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) {
    process.exit(1);
  }
}

const jar = new Map();
function remember(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const pair = line.split(";")[0];
    const at = pair.indexOf("=");
    if (at > 0) {
      jar.set(pair.slice(0, at).trim(), pair.slice(at + 1));
    }
  }
}
async function web(url, init = {}) {
  const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), cookie, origin: BASE } });
  remember(response);
  return response;
}
const logLength = () => readFileSync(LOG, "utf8").length;
async function fromLog(pattern, since) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const lines = readFileSync(LOG, "utf8")
      .slice(since)
      .split("\n")
      .filter((line) => line.includes("[email-fallback]") && line.includes(EMAIL));
    for (const line of lines.reverse()) {
      const found = line.match(pattern);
      if (found) {
        return found[1];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}
const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? "";
const form = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

// 1. A signed-in account (creates it for a bootstrap platform admin).
let mark = logLength();
let response = await web(`${BASE}/api/auth/sign-in/magic-link`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, callbackURL: "/" }),
});
check("sign-in link requested", response.ok, String(response.status));
const link = await fromLog(/"url":"([^"]+)"/, mark);
check("sign-in link in the preview log", Boolean(link));
response = await web(link);
check("signed in on the hub", response.status === 302 || response.status === 200, String(response.status));

// 2. Discovery.
response = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
const challenge = response.headers.get("www-authenticate") ?? "";
check("401 with this host's resource metadata", response.status === 401 && challenge.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`), challenge);
const resource = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
check("protected resource metadata", resource.resource === `${BASE}/mcp` && resource.authorization_servers?.[0] === BASE);
const server = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
check("authorization server metadata", server.issuer === BASE && server.code_challenge_methods_supported?.includes("S256") && server.authorization_response_iss_parameter_supported === true);

// 3. Registration and the authorize page.
response = await fetch(server.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Ordering Desk smoke test", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
});
const client = await response.json();
check("registered a loopback client", response.status === 201 && typeof client.client_id === "string", String(response.status));
response = await fetch(server.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Lookalike", redirect_uris: ["https://evil.example.com/cb"], token_endpoint_auth_method: "none" }),
});
check("refused a client with a foreign redirect", response.status === 400, String(response.status));

const verifier = randomBytes(32).toString("base64url");
const state = randomBytes(12).toString("base64url");
const authorizeUrl = `${server.authorization_endpoint}?${new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: REDIRECT,
  scope: "desk.read desk.write offline_access",
  state,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
  resource: `${BASE}/mcp`,
})}`;
response = await web(authorizeUrl);
let html = await response.text();
check("authorize page asks for the email", response.status === 200 && html.includes('name="step" value="email"'));
check("authorize page is never framed", (response.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));
mark = logLength();
html = await (await web(authorizeUrl, form({ step: "email", email: EMAIL }))).text();
const handle = field(html, "handle");
check("code page", handle.length > 0);
const code = await fromLog(/"subject":"(\d{6}) is your code/, mark);
check("code in the preview log", Boolean(code));
html = await (await web(authorizeUrl, form({ step: "code", handle, email: EMAIL, code: "000000" === code ? "111111" : "000000" }))).text();
check("a wrong code says how many tries are left", html.includes("tries left"));
html = await (await web(authorizeUrl, form({ step: "code", handle, email: EMAIL, code }))).text();
check("consent page", html.includes('name="decision" value="approve"') && html.includes("an app on this computer"));
check("consent covers every workspace, with nothing to pick", html.includes("every workspace with AI connections on") && !html.includes('name="workspace"'));
check("consent says how long the connection lasts", html.includes("This connection lasts 90 days"));
response = await web(authorizeUrl, form({ step: "consent", handle: field(html, "handle"), signin: field(html, "signin"), access: "change", decision: "approve" }));
const location = response.headers.get("location") ?? "";
check("back to the app with a code", response.status === 302 && location.startsWith(REDIRECT), location.split("?")[0]);
const back = new URL(location);
check("state and issuer returned", back.searchParams.get("state") === state && back.searchParams.get("iss") === BASE);

// 4. Tokens.
response = await fetch(server.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }).toString(),
});
const tokens = await response.json();
check("access token with desk.write", response.ok && typeof tokens.access_token === "string" && String(tokens.scope).includes("desk.write"), String(response.status));

// 5. A real MCP client.
const mcp = new Client({ name: "ordering-desk-smoke", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
const { tools } = await mcp.listTools();
const names = tools.map((tool) => tool.name);
check(
  "tools listed",
  names[0] === "list_workspaces" && names.includes("get_my_access") && names.includes("prepare_status_change") && names.includes("confirm_status_change"),
  `${names.length} tools`,
);
check("annotations", tools.every((tool) => tool.annotations?.openWorldHint === false && tool.annotations?.readOnlyHint === !tool.name.startsWith("confirm_")));
check("every tool but list_workspaces takes workspace", tools.slice(1).every((tool) => tool.inputSchema?.required?.includes("workspace")));
const raw = async (name, args = {}) => {
  const result = await mcp.callTool({ name, arguments: args });
  return { error: result.isError ? (result.structuredContent?.error ?? { code: "unknown" }) : null, data: result.structuredContent ?? {} };
};

let r = await raw("list_workspaces");
check("list_workspaces", !r.error && (r.data.workspaces?.length ?? 0) > 0, `${r.data.workspaces?.length ?? 0} workspaces`);
const picked = WORKSPACE ? r.data.workspaces.find((entry) => entry.name.startsWith(WORKSPACE)) : r.data.workspaces[0];
check("a workspace to work in", Boolean(picked), picked?.name ?? "none");
const workspaceId = picked.id;
// Every other call names the picked workspace.
const call = (name, args = {}) => raw(name, { workspace: workspaceId, ...args });
r = await raw("get_my_access", { workspace: "No Such Workspace (smoke)" });
check("a workspace that does not exist is refused", r.error?.code === "not_found", r.error?.code ?? "answered");

r = await call("get_my_access");
check("get_my_access", !r.error && r.data.role === "Platform admin" && typeof r.data.connection_covers === "string", `${r.data.role}, ${r.data.access}`);
r = await call("search_orders");
check("search_orders (open cards)", !r.error, `${r.data.total} open`);
const card = r.data.cards?.[0];
check("a sample card to work on", Boolean(card), card?.number ?? "none");
r = await call("search_orders", { kind: "requests" });
check("search_orders with filters", !r.error, `${r.data.total} requests`);
r = await call("search_orders", { question: "requests waiting more than two days" });
check("search_orders with a question", !r.error, r.data.understood_as);
r = await call("get_order", { order: card.number });
check("get_order", !r.error && r.data.number === card.number, r.data.you_can?.join(","));
r = await call("list_statuses");
check("list_statuses", !r.error, `${r.data.statuses?.length} statuses`);
const statuses = r.data.statuses ?? [];
r = await call("find_people");
check("find_people", !r.error, `${r.data.total} people`);
if (r.data.people?.[0]) {
  const person = await call("get_person", { person_id: r.data.people[0].id });
  check("get_person", !person.error);
}
r = await call("list_locations");
check("list_locations", !r.error, `${r.data.locations?.length} locations`);
if (r.data.locations?.[0]) {
  const location2 = await call("get_location", { location: r.data.locations[0].id });
  check("get_location", !location2.error);
}
r = await call("find_products", { query: "card" });
check("find_products answers (a structured refusal is fine locally)", !r.error || ["refused", "shopify_unavailable"].includes(r.error.code), r.error?.code ?? "ok");

// 6. A note: preview, a wrong echo, the confirm, a replay.
r = await call("prepare_add_note", { order: card.number, note: "Smoke test note (local sample data)." });
check("prepare_add_note names the workspace to confirm in", !r.error && Boolean(r.data.confirmation_id) && r.data.confirm_with?.workspace === workspaceId);
const noteId = r.data.confirmation_id;
r = await call("confirm_add_note", { confirmation_id: noteId, order: card.number, note: "Something else" });
check("a confirm with another note is refused", r.error?.code === "mismatch");
r = await call("confirm_add_note", { confirmation_id: noteId, order: card.number, note: "Smoke test note (local sample data)." });
check("confirm_add_note", !r.error && r.data.done === true);
r = await call("confirm_add_note", { confirmation_id: noteId, order: card.number, note: "Smoke test note (local sample data)." });
check("a confirmation works once", r.error?.code === "already_used");

// 7. A status change and back.
const isRequest = card.kind === "request";
const target = statuses.find((status) => status.name !== card.status && (isRequest ? status.requests_can_move_here : status.orders_can_move_here) && status.set_by === null);
if (target) {
  r = await call("prepare_status_change", { order: card.number, status: target.name });
  check("prepare_status_change", !r.error);
  r = await call("confirm_status_change", { confirmation_id: r.data.confirmation_id, order: card.number, status: target.name });
  check("confirm_status_change", !r.error && r.data.done === true, target.name);
  r = await call("prepare_status_change", { order: card.number, status: card.status });
  if (!r.error) {
    r = await call("confirm_status_change", { confirmation_id: r.data.confirmation_id, order: card.number, status: card.status });
    check("status changed back", !r.error, card.status);
  }
}

// 8. A manager write that needs Shopify answers with a structured result.
const requests = await call("search_orders", { kind: "requests" });
const request = requests.data.cards?.[0];
if (request) {
  r = await call("prepare_approve", { order: request.number });
  check("prepare_approve answers (a structured refusal is fine locally)", !r.error || ["refused", "shopify_unavailable", "forbidden"].includes(r.error.code), r.error?.code ?? "preview");
}

// 9. AI off for the workspace (Settings, as the signed-in platform admin):
// the connection is refused there, then works again once it is back on.
const aiSettings = `${BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/ai`;
const switchTo = (on) => web(aiSettings, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamAccess: on }) });
response = await switchTo(false);
check("AI connections switched off for the workspace", response.ok, String(response.status));
r = await call("get_my_access");
check("a workspace with AI off is refused", r.error?.code === "forbidden", r.error?.code ?? "answered");
response = await switchTo(true);
check("AI connections switched back on", response.ok, String(response.status));
r = await call("get_my_access");
check("the workspace answers again", !r.error);

// 10. Revoke in Settings, then the next call is refused.
response = await web(aiSettings);
const settings = await response.json();
const mine = settings.ai?.connections?.find((connection) => connection.mine && connection.everyWorkspace && connection.redirectHost === "127.0.0.1");
check("the connection for every workspace is listed in Settings", Boolean(mine));
response = await web(`${BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/ai/connections/${encodeURIComponent(mine.id)}`, { method: "DELETE" });
check("revoked in Settings", response.ok, String(response.status));
const after = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
check("the next call is refused with invalid_token", after.status === 401 && (after.headers.get("www-authenticate") ?? "").includes("invalid_token"), String(after.status));

await mcp.close().catch(() => undefined);
console.log(JSON.stringify({ passed: results.length, workspaceId }));
