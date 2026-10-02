import { NextResponse } from "next/server";
import type { BrandingResult, ThemeResult } from "./assets";

// The HTTP answer for a branding service result.
export function brandingResponse(result: BrandingResult | ThemeResult): NextResponse {
  switch (result.kind) {
    case "invalid":
      return NextResponse.json({ error: result.error }, { status: 400 });
    case "contrast":
      return NextResponse.json({ error: result.error, issues: result.issues }, { status: 400 });
    case "too-large":
      return NextResponse.json({ error: result.error }, { status: 413 });
    case "conflict":
      return NextResponse.json({ error: result.error }, { status: 409 });
    case "not-found":
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    case "saved":
      return NextResponse.json({ branding: result.branding });
  }
}
