// Paths, scopes and lifetimes of the MCP server (Wave 2 plan, Decisions 2,
// 3, 5 and 11). Relative imports only: custom-worker.ts bundles src/mcp.

export const MCP_PATH = "/mcp";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/mcp";
export const AUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const OAUTH_PREFIX = "/oauth/";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";

export const SCOPE_READ = "desk.read";
export const SCOPE_WRITE = "desk.write";
export const SCOPE_OFFLINE = "offline_access";
export const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE];

export const ACCESS_TOKEN_TTL_S = 30 * 60;
// A connection (the grant, its refresh token and the mirror row) lasts 90
// days, fixed, with no idle extension (owner decision 1, Oct 7, 2026).
export const GRANT_TTL_S = 90 * 24 * 60 * 60;
export const GRANT_TTL_MS = GRANT_TTL_S * 1000;
export const GRANT_TTL_DAYS = 90;
// last_used_at is written at most this often per connection.
export const TOUCH_EVERY_MS = 5 * 60 * 1000;

export const ACTION_TTL_MS = 10 * 60 * 1000;
// A request whose create timed out may be looked up again for this long.
export const UNKNOWN_RECHECK_MS = 30 * 60 * 1000;

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_ATTEMPTS = 5;
export const CODES_PER_EMAIL_HOUR = 5;
export const CODES_PER_IP_HOUR = 20;
// The consent page must be answered this soon after the right code.
export const CONSENT_AFTER_CODE_MS = 10 * 60 * 1000;
