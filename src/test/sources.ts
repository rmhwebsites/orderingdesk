// Test-only: read the app's own .tsx sources, for guard tests that keep a
// rule true everywhere (one component kit, busy buttons). Paths are
// relative to src/ with forward slashes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function tsxUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return tsxUnder(path);
    }
    return name.endsWith(".tsx") ? [path] : [];
  });
}

// Every .tsx file under src/components and src/app.
export function appSources(): string[] {
  return [...tsxUnder(join(SRC, "components")), ...tsxUnder(join(SRC, "app"))];
}

export function readSource(file: string): string {
  return readFileSync(file, "utf8");
}

export function rel(file: string): string {
  return relative(SRC, file).split("\\").join("/");
}
