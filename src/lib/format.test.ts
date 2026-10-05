import { describe, it, expect } from "vitest";
import {
  formatDate,
  formatMoney,
  formatTime,
  relativeTime,
  sentenceCase,
  shopifyAdminDraftUrl,
  shopifyAdminOrderUrl,
} from "./format";

describe("formatMoney", () => {
  it("formats an amount with its currency", () => {
    expect(formatMoney("120", "USD")).toBe("$120.00");
    expect(formatMoney("1234.5", "CAD")).toBe("CA$1,234.50");
  });

  it("falls back to the raw text for an amount or currency it cannot read", () => {
    expect(formatMoney("not a number", "USD")).toBe("not a number USD");
    expect(formatMoney("12.00", "??")).toBe("12.00 ??");
    expect(formatMoney("", "USD")).toBe("");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-02T12:00:00.000Z");

  it("reads recent moments as minutes and hours", () => {
    expect(relativeTime(now - 10000, now)).toBe("just now");
    expect(relativeTime(now - 70000, now)).toBe("1 min ago");
    expect(relativeTime(now - 25 * 60000, now)).toBe("25 min ago");
    expect(relativeTime(now - 3 * 3600000, now)).toBe("3 h ago");
  });

  it("treats a slightly future timestamp (clock skew) as just now", () => {
    expect(relativeTime(now + 5000, now)).toBe("just now");
  });

  it("falls back to a date after a day", () => {
    expect(relativeTime(now - 2 * 86400000, now, "UTC")).toBe("Sep 30");
    expect(relativeTime(Date.parse("2025-12-24T12:00:00Z"), now, "UTC")).toBe("Dec 24, 2025");
  });
});

describe("formatDate and formatTime", () => {
  it("formats in the given time zone", () => {
    const at = Date.parse("2026-10-02T16:05:00.000Z");
    expect(formatDate(at, "UTC")).toBe("Oct 2, 2026");
    expect(formatTime(at, "UTC")).toBe("4:05 PM");
  });
});

describe("sentenceCase", () => {
  it("capitalizes the first letter only", () => {
    expect(sentenceCase("partially refunded")).toBe("Partially refunded");
    expect(sentenceCase("")).toBe("");
  });
});

describe("shopifyAdminOrderUrl", () => {
  it("builds the admin link from the shop handle and legacy order id", () => {
    expect(shopifyAdminOrderUrl("impact-rentals.myshopify.com", "5123456789")).toBe(
      "https://admin.shopify.com/store/impact-rentals/orders/5123456789",
    );
  });

  it("is null without a usable shop domain or order id", () => {
    expect(shopifyAdminOrderUrl(null, "1")).toBeNull();
    expect(shopifyAdminOrderUrl("", "1")).toBeNull();
    expect(shopifyAdminOrderUrl("impact.example.com", "1")).toBeNull();
    expect(shopifyAdminOrderUrl("impact-rentals.myshopify.com", "")).toBeNull();
    expect(shopifyAdminOrderUrl("impact-rentals.myshopify.com", "sample-1001")).toBeNull();
  });
});

describe("shopifyAdminDraftUrl", () => {
  it("builds the admin link to a draft order, or null when it cannot", () => {
    expect(shopifyAdminDraftUrl("impact-rentals.myshopify.com", "1180123")).toBe(
      "https://admin.shopify.com/store/impact-rentals/draft_orders/1180123",
    );
    expect(shopifyAdminDraftUrl(null, "1")).toBeNull();
    expect(shopifyAdminDraftUrl("impact-rentals.myshopify.com", "d-12")).toBeNull();
    expect(shopifyAdminDraftUrl("impact-rentals.myshopify.com", null)).toBeNull();
  });
});
