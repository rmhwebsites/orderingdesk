import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The Worker runs Next.js through OpenNext (@opennextjs/cloudflare), which
// inlines at build time the manifests Next's server loads and throws on any
// it does not know. Next 16.4.0 loads a new one (.next/server/
// preview-props.json) that OpenNext 1.20.9, the newest release on
// 2026-10-07, does not inline: every page and route of the built Worker
// answered 500 ("Unexpected loadManifest(/.next/server/preview-props.json)
// call!") while next build, next dev and these tests all passed. Next is
// pinned exactly to the version production runs; move it only with an
// OpenNext release that supports the new version, after `npm run preview`
// serves pages again.
const PINNED_NEXT = "16.3.8";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;

describe("framework pins for the OpenNext Worker", () => {
  it("pins next exactly, in package.json, the lockfile and node_modules", () => {
    const pkg = json("package.json") as { dependencies: Record<string, string> };
    expect(pkg.dependencies.next).toBe(PINNED_NEXT);
    const lock = json("package-lock.json") as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/next"]?.version).toBe(PINNED_NEXT);
    expect(json("node_modules/next/package.json").version).toBe(PINNED_NEXT);
  });
});
