import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// wrangler.jsonc has whole-line comments only; strip them and parse.
function wranglerConfig(): Record<string, unknown> {
  const file = join(dirname(fileURLToPath(import.meta.url)), "../../../wrangler.jsonc");
  const text = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("wrangler.jsonc", () => {
  it("binds Workers AI as AI and never declares a build step", () => {
    const config = wranglerConfig();
    expect(config.ai).toEqual({ binding: "AI" });
    expect(config).not.toHaveProperty("build");
  });
});
