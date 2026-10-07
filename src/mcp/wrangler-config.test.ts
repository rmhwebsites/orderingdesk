import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The Worker config the MCP server needs (Wave 2): a KV namespace bound as
// OAUTH_KV for the OAuth library, the strictly-public fetch flag it needs
// for Client ID Metadata Documents, and never a "build" field (Workers
// Builds would run it instead of the operator's deploy).
const path = join(dirname(fileURLToPath(import.meta.url)), "../../wrangler.jsonc");

function config(): Record<string, unknown> {
  const text = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("wrangler.jsonc for the MCP server", () => {
  it("binds OAUTH_KV, keeps global_fetch_strictly_public and has no build field", () => {
    const parsed = config();
    const namespaces = parsed.kv_namespaces as { binding: string; id: string }[] | undefined;
    expect(namespaces?.map((entry) => entry.binding)).toContain("OAUTH_KV");
    expect(namespaces?.find((entry) => entry.binding === "OAUTH_KV")?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed.compatibility_flags).toEqual(expect.arrayContaining(["nodejs_compat", "global_fetch_strictly_public"]));
    expect(parsed).not.toHaveProperty("build");
  });
});

// wrangler dev serves every request under the host of the config's first
// route (orderingdesk.com) unless told otherwise, so the host gate answered
// 404 to every local request and the MCP and OAuth routes (custom-worker.ts,
// only under `npm run preview`) could not be reached on localhost:8787.
describe("npm run preview for the MCP server", () => {
  it("keeps the request's local host instead of the production route", () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.preview).toBe("opennextjs-cloudflare build && opennextjs-cloudflare preview -- --local-upstream localhost:8787");
    expect(pkg.scripts.deploy).not.toContain("local-upstream");
  });
});
