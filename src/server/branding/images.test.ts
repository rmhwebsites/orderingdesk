import { describe, it, expect } from "vitest";
import { pngWidth, sniffImage, unsafeSvgReason } from "./images";
import { pngBytes } from "./test-images";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#91d500"/></svg>';

describe("sniffImage", () => {
  it("recognizes PNG, JPEG and WebP by their magic numbers", () => {
    expect(sniffImage(pngBytes(10, 10))).toEqual({ type: "image/png", ext: "png" });
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toEqual({ type: "image/jpeg", ext: "jpg" });
    expect(sniffImage(bytes("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toEqual({ type: "image/webp", ext: "webp" });
  });

  it("recognizes SVG text, with or without an XML declaration, BOM or leading comment", () => {
    expect(sniffImage(bytes(SVG))).toEqual({ type: "image/svg+xml", ext: "svg" });
    expect(sniffImage(bytes(`﻿<?xml version="1.0"?>\n${SVG}`))).toEqual({ type: "image/svg+xml", ext: "svg" });
    expect(sniffImage(bytes(`<!-- logo -->\n${SVG}`))).toEqual({ type: "image/svg+xml", ext: "svg" });
  });

  it("refuses anything else", () => {
    expect(sniffImage(bytes("GIF89a....."))).toBeNull();
    expect(sniffImage(bytes("<html><body>hi</body></html>"))).toBeNull();
    expect(sniffImage(bytes("%PDF-1.7"))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("pngWidth", () => {
  it("reads the IHDR width, or null for anything that is not a PNG", () => {
    expect(pngWidth(pngBytes(512, 128))).toBe(512);
    expect(pngWidth(bytes(SVG))).toBeNull();
  });
});

describe("unsafeSvgReason", () => {
  it("accepts a plain logo, gradients, internal references and embedded raster images", () => {
    expect(unsafeSvgReason(SVG)).toBeNull();
    expect(
      unsafeSvgReason(
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><use xlink:href="#g"/><image href="data:image/png;base64,iVBORw0KGgo="/><style>.a{fill:red}</style><text>Tom &amp; Jerry</text></svg>',
      ),
    ).toBeNull();
  });

  it("rejects script elements, in any case or namespace", () => {
    expect(unsafeSvgReason('<svg><script>alert(1)</script></svg>')).toMatch(/script/);
    expect(unsafeSvgReason('<svg><SCRIPT>alert(1)</SCRIPT></svg>')).toMatch(/script/);
    expect(unsafeSvgReason('<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>x</s:script></svg>')).toMatch(/script/);
  });

  it("rejects foreignObject and other embedding elements", () => {
    expect(unsafeSvgReason("<svg><foreignObject><div>x</div></foreignObject></svg>")).toMatch(/foreignObject/);
    expect(unsafeSvgReason('<svg><iframe src="https://x"/></svg>')).not.toBeNull();
    expect(unsafeSvgReason("<svg><handler>x</handler></svg>")).not.toBeNull();
  });

  it("rejects event handler attributes", () => {
    expect(unsafeSvgReason('<svg onload="alert(1)"></svg>')).toMatch(/event handler/);
    expect(unsafeSvgReason("<svg><rect ONCLICK='x'/></svg>")).toMatch(/event handler/);
    expect(unsafeSvgReason("<svg><rect\nonmouseover=x/></svg>")).toMatch(/event handler/);
  });

  it("rejects javascript: and data:text URLs anywhere, including entity-encoded ones", () => {
    expect(unsafeSvgReason('<svg><a href="javascript:alert(1)"><rect/></a></svg>')).not.toBeNull();
    expect(unsafeSvgReason('<svg><a href="&#106;avascript:alert(1)"><rect/></a></svg>')).not.toBeNull();
    expect(unsafeSvgReason('<svg><a href="&#x6A;ava&#x09;script:alert(1)"><rect/></a></svg>')).not.toBeNull();
    expect(unsafeSvgReason('<svg><set attributeName="fill" to="javascript:alert(1)"/></svg>')).not.toBeNull();
    expect(unsafeSvgReason('<svg><image href="data:text/html,<b>x</b>"/></svg>')).not.toBeNull();
    expect(unsafeSvgReason('<svg><rect style="background:url(javascript:x)"/></svg>')).not.toBeNull();
  });

  it("rejects external references and nested SVG data", () => {
    expect(unsafeSvgReason('<svg><image href="https://tracker.example/x.png"/></svg>')).toMatch(/external/);
    expect(unsafeSvgReason('<svg><use xlink:href="other.svg#a"/></svg>')).toMatch(/external/);
    expect(unsafeSvgReason('<svg><image href="//cdn.example/x.png"/></svg>')).toMatch(/external/);
    expect(unsafeSvgReason('<svg><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>')).not.toBeNull();
    expect(unsafeSvgReason('<svg><animate attributeName="href" values="https://x"/></svg>')).not.toBeNull();
  });

  it("rejects stylesheet instructions, entity declarations and style imports", () => {
    expect(unsafeSvgReason('<?xml-stylesheet href="x.css"?><svg></svg>')).toMatch(/stylesheet/);
    expect(unsafeSvgReason('<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>')).toMatch(/entit/);
    expect(unsafeSvgReason('<svg><style>@import url(https://x/a.css);</style></svg>')).not.toBeNull();
  });

  it("rejects text that is not an SVG document or cannot be read safely", () => {
    expect(unsafeSvgReason("<html><svg></svg></html>")).toMatch(/svg/i);
    expect(unsafeSvgReason("<svg><rect width='1></svg>")).not.toBeNull();
    expect(unsafeSvgReason("<svg><!-- unclosed")).not.toBeNull();
  });
});
