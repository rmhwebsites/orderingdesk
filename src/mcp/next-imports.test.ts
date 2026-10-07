import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SRC, rel } from "@/test/sources";

// Ground rule 11: the OAuth library imports cloudflare:workers, and the MCP
// packages are worker-only, so no Next.js page, route or component may load
// them at runtime, directly or through anything it imports. Type-only
// imports are erased and allowed.
const WORKER_ONLY = [/^@cloudflare\/workers-oauth-provider$/, /^agents(\/|$)/, /^@modelcontextprotocol\//, /^cloudflare:/];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return filesUnder(path);
    }
    return (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test.") ? [path] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) {
    return null;
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && (candidate.endsWith(".ts") || candidate.endsWith(".tsx"))) {
      return candidate;
    }
  }
  return null;
}

function runtimeSpecifiers(source: string): string[] {
  const statements = source.match(/(?:import|export)\s[^;]*?from\s*["'][^"']+["']|import\s*["'][^"']+["']|import\(\s*["'][^"']+["']\s*\)/g) ?? [];
  return statements
    .filter((statement) => !statement.match(/^(?:import|export)\s+type\s/))
    .map((statement) => statement.match(/["']([^"']+)["']/)?.[1] ?? "")
    .filter((spec) => spec.length > 0);
}

describe("Next.js code and the worker-only packages", () => {
  it("never loads the OAuth library or the MCP packages at runtime", () => {
    const seen = new Set<string>();
    const queue = [...filesUnder(join(SRC, "app")), ...filesUnder(join(SRC, "components"))];
    const problems: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
        if (WORKER_ONLY.some((pattern) => pattern.test(spec))) {
          problems.push(`${rel(file)} imports ${spec}`);
        }
        const target = resolveImport(file, spec);
        if (target) {
          queue.push(target);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
