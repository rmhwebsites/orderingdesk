import { describe, it, expect } from "vitest";
import type { MailWorkspace } from "./workspace";
import { newOrderEmail, newOrdersDigestEmail, poSentEmail, type OrderSummaryForEmail } from "./notifications";

const env = { APP_URL: "https://orderingdesk.com" } as CloudflareEnv;

const workspace: MailWorkspace = {
  id: "ws_impact",
  name: "IMPACT Rentals",
  slug: "impact",
  accentColor: "#91d500",
  branding: { colors: { primary: "#1d4ed8", ink: "#0f172a", background: "#f8fafc" } },
  customDomain: "orders.impactrentals.store",
  customDomainStatus: "active",
  sendingAddress: null,
  sendingVerifiedAt: null,
  replyTo: null,
};

const order: OrderSummaryForEmail = {
  id: "o1",
  name: "#1001",
  customerName: "Riley Oakes",
  total: "120.00",
  currency: "CAD",
  items: [
    { title: "Hard Hat", qty: 2, variant: "White" },
    { title: "Safety Vest", qty: 1, variant: "" },
  ],
};

describe("newOrderEmail", () => {
  it("names the order and customer in the subject and summarizes the order", () => {
    const email = newOrderEmail(env, workspace, order, "https://orders.impactrentals.store/?order=o1");
    expect(email.subject).toBe("New order #1001 from Riley Oakes");
    expect(email.html).toContain("New order #1001");
    expect(email.html).toContain("Riley Oakes");
    expect(email.html).toContain("CA$120.00");
    expect(email.html).toContain("2 x Hard Hat (White)");
    expect(email.html).toContain("1 x Safety Vest");
    expect(email.html).toContain('href="https://orders.impactrentals.store/?order=o1"');
    expect(email.text).toContain("Open the order: https://orders.impactrentals.store/?order=o1");
  });

  // Text-only mail clients and watch previews show the plain-text part.
  it("keeps each summary label apart from its value in the plain-text part", () => {
    const email = newOrderEmail(env, workspace, order, "https://orders.impactrentals.store/?order=o1");
    expect(email.text).toContain("Order: #1001");
    expect(email.text).toContain("Customer: Riley Oakes");
    expect(email.text).toContain("Total: CA$120.00");
    expect(email.text).toContain("Items: 2 x Hard Hat (White)\n1 x Safety Vest");
    expect(email.text).not.toContain("Order#1001");
  });

  it("is branded to the workspace (its primary color and name)", () => {
    const email = newOrderEmail(env, workspace, order, "https://orders.impactrentals.store/?order=o1");
    expect(email.html).toContain("#1d4ed8");
    expect(email.html).toContain("IMPACT Rentals");
    expect(email.html).not.toContain("#91d500");
  });

  it("leaves the customer out of the subject when there is none", () => {
    expect(newOrderEmail(env, workspace, { ...order, customerName: "" }, "https://x.test/").subject).toBe("New order #1001");
  });

  it("escapes every value in the HTML and keeps the subject one plain line", () => {
    const hostile = {
      ...order,
      name: "#1001\r\nBcc: victim@example.com",
      customerName: '<img src=x onerror="alert(1)">',
      items: [{ title: "<script>alert(1)</script>", qty: 1, variant: "&" }],
    };
    const email = newOrderEmail(env, { ...workspace, name: "<b>Shop</b>" }, hostile, "https://x.test/");
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain("<b>Shop</b>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it("lists at most eight items and says how many more there are", () => {
    const many = { ...order, items: Array.from({ length: 11 }, (_, i) => ({ title: `Item ${i + 1}`, qty: 1, variant: "" })) };
    const email = newOrderEmail(env, workspace, many, "https://x.test/");
    expect(email.html).toContain("Item 8");
    expect(email.html).not.toContain("Item 9<");
    expect(email.html).toContain("and 3 more items");
  });
});

describe("newOrdersDigestEmail", () => {
  it("lists the orders and links to the desk", () => {
    const orders = Array.from({ length: 7 }, (_, i) => ({ ...order, id: `o${i}`, name: `#10${i}` }));
    const email = newOrdersDigestEmail(env, workspace, orders, "https://orders.impactrentals.store/");
    expect(email.subject).toBe("7 new orders in IMPACT Rentals");
    expect(email.html).toContain("#100");
    expect(email.html).toContain("#106");
    expect(email.html).toContain('href="https://orders.impactrentals.store/"');
    expect(email.text).toContain("#100: Riley Oakes, CA$120.00");
  });
});

// Draft orders spec section 12: a draft announces itself as a request.
describe("new request emails", () => {
  const request: OrderSummaryForEmail = {
    id: "d1",
    name: "#D12",
    customerName: "Jordan Vale",
    total: "0.00",
    currency: "USD",
    items: [{ title: "Business cards", qty: 1, variant: "" }],
    kind: "draft",
    company: "Impact Rentals",
    location: "Buford, GA",
    requestFor: "Casey Lin",
    branch: "Buford HQ",
    attributes: [
      { key: "Ship to Branch", value: "Buford HQ" },
      { key: "For Employee Name", value: "Casey Lin" },
      { key: "Reason for Request", value: "New hire starting Monday" },
    ],
  };

  it("names the request in a Title Case subject and lists its fields and items", () => {
    const email = newOrderEmail(env, workspace, request, "https://orders.impactrentals.store/?order=d1");
    expect(email.subject).toBe("New Request #D12 from Jordan Vale");
    expect(email.html).toContain("New request #D12");
    expect(email.text).toContain("Request: #D12");
    expect(email.text).toContain("Requested by: Jordan Vale");
    expect(email.text).toContain("Company: Impact Rentals");
    expect(email.text).toContain("Ship to Branch: Buford HQ");
    expect(email.text).toContain("Reason for Request: New hire starting Monday");
    expect(email.text).toContain("Items: 1 x Business cards");
    expect(email.text).toContain("Open the request: https://orders.impactrentals.store/?order=d1");
    // A $0 request has no total worth showing.
    expect(email.text).not.toContain("Total:");
  });

  it("escapes request attributes and keeps the requester's email and address out", () => {
    const hostile = {
      ...request,
      attributes: [{ key: "<b>Key</b>", value: '<img src=x onerror="alert(1)">' }],
      company: "<script>x</script>",
    };
    const email = newOrderEmail(env, workspace, hostile, "https://x.test/");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain("<script>x");
    expect(email.html).not.toContain("<b>Key</b>");
    expect(email.html).toContain("&lt;b&gt;Key&lt;/b&gt;");
    expect(email.html).not.toContain("jordan@example.com");
  });

  it("clips long attribute values and shows at most six attributes", () => {
    const many = {
      ...request,
      attributes: Array.from({ length: 8 }, (_, i) => ({ key: `Field ${i + 1}`, value: "v".repeat(300) })),
    };
    const email = newOrderEmail(env, workspace, many, "https://x.test/");
    expect(email.text).toContain("Field 6:");
    expect(email.text).not.toContain("Field 7:");
    expect(email.text).not.toContain("v".repeat(201));
  });

  it("says requests, orders, or orders and requests in a summary", () => {
    const requests = Array.from({ length: 6 }, (_, i) => ({ ...request, id: `d${i}`, name: `#D${i}` }));
    const orders = Array.from({ length: 6 }, (_, i) => ({ ...order, id: `o${i}`, name: `#10${i}` }));
    expect(newOrdersDigestEmail(env, workspace, requests, "https://x.test/").subject).toBe("6 new requests in IMPACT Rentals");
    expect(newOrdersDigestEmail(env, workspace, orders, "https://x.test/").subject).toBe("6 new orders in IMPACT Rentals");
    const mixed = newOrdersDigestEmail(env, workspace, [...requests.slice(0, 3), ...orders.slice(0, 4)], "https://x.test/");
    expect(mixed.subject).toBe("7 new orders and requests in IMPACT Rentals");
    expect(mixed.html).toContain("7 new orders and requests");
  });
});

describe("poSentEmail", () => {
  it("says which purchase order went to which vendor", () => {
    const email = poSentEmail(
      env,
      workspace,
      { poId: "po1", poNumber: "IMP-2026-0041", orderId: "o1", orderName: "#1001", vendorName: "North Supply", actorId: "u1" },
      "https://orders.impactrentals.store/?order=o1",
    );
    expect(email.subject).toBe("Purchase order IMP-2026-0041 sent to North Supply");
    expect(email.html).toContain("IMP-2026-0041");
    expect(email.html).toContain("North Supply");
    expect(email.html).toContain("#1001");
    expect(email.text).toContain("Purchase order: IMP-2026-0041");
    expect(email.text).toContain("Order: #1001");
    expect(email.text).toContain("Vendor: North Supply");
  });
});
