import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SRC, rel } from "@/test/sources";

// custom-worker.ts bundles src/mcp/routes.ts and everything it reaches
// (Wave 2 plan, ground rules 11 and 12): none of it may pull in Next.js, React, the
// session guard or app components, which exist only in the OpenNext build.
const ENTRY = join(SRC, "mcp/routes.ts");
const BANNED_PACKAGES = [/^next(\/|$)/, /^react(-dom)?(\/|$)/, /^server-only$/];
const BANNED_FILES = ["server/guard.ts", "server/auth.ts", "server/request-host.ts"];

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = join(SRC, spec.slice(2));
  } else if (spec.startsWith(".")) {
    base = resolve(dirname(from), spec);
  } else {
    return null;
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && (candidate.endsWith(".ts") || candidate.endsWith(".tsx"))) {
      return candidate;
    }
  }
  return null;
}

function specifiers(source: string): string[] {
  const statements =
    source.match(/(?:import|export)\s[^;]*?from\s*["'][^"']+["']|import\s*["'][^"']+["']|import\(\s*["'][^"']+["']\s*\)/g) ?? [];
  return statements.map((statement) => statement.match(/["']([^"']+)["']/)?.[1] ?? "").filter((spec) => spec.length > 0);
}

describe("the MCP server's worker graph", () => {
  it("never reaches Next.js, React, the session guard or app components", () => {
    const seen = new Set<string>();
    const queue = [ENTRY];
    const problems: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (BANNED_PACKAGES.some((pattern) => pattern.test(spec))) {
          problems.push(`${rel(file)} imports ${spec}`);
        }
        const target = resolveImport(file, spec);
        if (!target) {
          continue;
        }
        const path = rel(target);
        if (BANNED_FILES.includes(path) || path.startsWith("app/") || path.startsWith("components/")) {
          problems.push(`${rel(file)} imports ${path}`);
        }
        queue.push(target);
      }
    }
    expect(problems).toEqual([]);
    expect(seen.size).toBeGreaterThan(20);
  });
});
