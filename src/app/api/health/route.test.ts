import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("reports ok and the request's host, lowercased", async () => {
    const response = await GET(
      new Request("https://orders.impactrentals.store/api/health", {
        headers: { host: "Orders.ImpactRentals.Store" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, host: "orders.impactrentals.store" });
  });
});
