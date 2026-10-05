import { describe, it, expect } from "vitest";
import { classifyProperty, clipText, propertyLabel, PROPERTY_TEXT_CLIP } from "./item-properties";

// How a line item property shows in the drawer (draft orders spec section
// 11.4 and section 18): only https URLs on cdn.shopify.com become an image
// or a link; everything else is plain text, and an app's own underscore
// keys stay hidden unless they point at the preview image or the PDF.

const CDN_PNG = "https://cdn.shopify.com/s/files/1/0001/uploads/preview-card.png?v=17";
const CDN_PDF = "https://cdn.shopify.com/s/files/1/0001/uploads/proof.pdf";

describe("classifyProperty", () => {
  it("shows a personalizer preview as an image and its PDF as a print link", () => {
    expect(classifyProperty({ key: "Preview", value: CDN_PNG })).toEqual({ kind: "image", label: "Preview", url: CDN_PNG });
    expect(classifyProperty({ key: "_pdf", value: CDN_PDF })).toEqual({ kind: "pdf", label: "PDF", url: CDN_PDF });
  });

  it("tells images and PDFs by the file name, else by the key", () => {
    expect(classifyProperty({ key: "Artwork", value: "https://cdn.shopify.com/a/b/c.JPEG" }).kind).toBe("image");
    expect(classifyProperty({ key: "Mockup", value: "https://cdn.shopify.com/files/render" }).kind).toBe("image");
    expect(classifyProperty({ key: "Proof", value: "https://cdn.shopify.com/files/render" }).kind).toBe("pdf");
    expect(classifyProperty({ key: "Order sheet", value: "https://cdn.shopify.com/files/sheet.pdf" }).kind).toBe("pdf");
    expect(classifyProperty({ key: "Spec", value: "https://cdn.shopify.com/files/spec.txt" })).toEqual({
      kind: "link",
      label: "Spec",
      url: "https://cdn.shopify.com/files/spec.txt",
      host: "cdn.shopify.com",
    });
  });

  it("renders anything not https on cdn.shopify.com as plain text", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "http://cdn.shopify.com/files/a.png",
      "https://evil.example/preview.png",
      "https://cdn.shopify.com.evil.example/a.png",
      "https://user:pass@cdn.shopify.com/a.png",
      "not a url",
    ]) {
      expect(classifyProperty({ key: "Preview", value }), value).toEqual({ kind: "text", label: "Preview", value });
    }
  });

  it("keeps an app's underscore keys hidden unless they are its image or PDF", () => {
    expect(classifyProperty({ key: "_pplr_preview", value: "Preview" })).toEqual({
      kind: "hidden",
      label: "Pplr preview",
      value: "Preview",
    });
    expect(classifyProperty({ key: "__config", value: '{"a":1}' }).kind).toBe("hidden");
    expect(classifyProperty({ key: "_pdf", value: "https://evil.example/proof.pdf" }).kind).toBe("hidden");
    expect(classifyProperty({ key: "_thumb", value: CDN_PNG }).kind).toBe("image");
  });

  it("keeps personalization text as given, line breaks included", () => {
    expect(classifyProperty({ key: "Office Address", value: "1 Depot Way\r\nBuford, GA" })).toEqual({
      kind: "text",
      label: "Office Address",
      value: "1 Depot Way\r\nBuford, GA",
    });
  });
});

describe("propertyLabel", () => {
  it("shows public keys as given and tidies underscore keys", () => {
    expect(propertyLabel("Full Name")).toBe("Full Name");
    expect(propertyLabel("_pdf")).toBe("PDF");
    expect(propertyLabel("__pplr_preview")).toBe("Pplr preview");
    expect(propertyLabel("_ID")).toBe("ID");
    expect(propertyLabel("_")).toBe("Property");
  });
});

describe("clipText", () => {
  it("clips long text at 500 characters and says so", () => {
    expect(PROPERTY_TEXT_CLIP).toBe(500);
    expect(clipText("short")).toEqual({ text: "short", clipped: false });
    const long = "x".repeat(PROPERTY_TEXT_CLIP + 10);
    expect(clipText(long)).toEqual({ text: "x".repeat(PROPERTY_TEXT_CLIP), clipped: true });
  });
});
