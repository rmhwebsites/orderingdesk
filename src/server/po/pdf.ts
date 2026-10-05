// The branded purchase order PDF (US Letter), rendered with pdf-lib on the
// Worker. What it shows:
// - a band in the workspace primary color across the top of every page;
// - the workspace logo (its PNG copy, or a PNG or JPEG upload; never SVG,
//   which the caller never passes) or, without one, the workspace name;
//   the workspace name and reply-to under it;
// - "Purchase order" with the PO number, date and the order it is for;
// - the vendor and ship-to blocks;
// - the line table (description, SKU, quantity, unit cost, line total).
//   Rows never split across pages; a continued page repeats the table
//   header;
// - subtotal, total and notes, then a footer on every page with the PO
//   number, page count, reply-to and "Sent with Ordering Desk".
//
// Text is Helvetica (a standard PDF font, nothing embedded), which covers
// Windows-1252 only: every string is reduced to characters the font has
// (anything else becomes "?"), control characters become spaces, and long
// words break across lines, so no input can make rendering throw. Headings
// use the primary color pulled toward ink until it reads on white (4.5:1);
// rules and the band use the primary color as is.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { contrastRatio, DEFAULT_ACCENT } from "@/lib/accent";
import { APP_NAME } from "@/lib/brand";
import { formatDate } from "@/lib/format";
import { centsToDecimal, costToCents, formatCents, lineTotalCents, subtotalCents, type PoLine } from "@/lib/po";

export type PoPdfInput = {
  workspaceName: string;
  // #rrggbb, or null for the Ordering Desk default.
  primaryColor: string | null;
  replyTo: string | null;
  // PNG or JPEG bytes, or null (the workspace name is shown instead).
  logo: Uint8Array | null;
  poNumber: string;
  // When the PO is sent (ms); shown as a UTC calendar date.
  date: number;
  orderName: string;
  vendor: { name: string; email: string };
  shipTo: string[];
  lines: PoLine[];
  currency: string;
  notes: string | null;
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;
const RIGHT = PAGE_W - MARGIN;
const BAND_H = 6;
// Content stays above this line; the footer lives below it.
const CONTENT_BOTTOM = 76;

const INK_HEX = "#101820";
const MUTED_HEX = "#3b4550";
const LINE_HEX = "#d5dad1";
const WHITE = "#ffffff";

const LOGO_MAX_W = 200;
const LOGO_MAX_H = 48;
const LOGO_MAX_BYTES = 1_000_000;
// A PNG is decoded in memory to embed it; refuse anything bigger than this.
const LOGO_MAX_PIXELS = 4_000_000;

// Table columns: x offset from the margin and width.
const COLUMNS = {
  description: { x: 0, w: 232 },
  sku: { x: 232, w: 96 },
  quantity: { x: 328, w: 48 },
  unit: { x: 376, w: 70 },
  total: { x: 446, w: 70 },
} as const;
const CELL_GAP = 10;
const ROW_SIZE = 10;
const ROW_LEADING = 13;
const ROW_PAD = 6;

const HEX = /^#[0-9a-f]{6}$/i;

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function mix(from: string, to: string, amount: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const channels = [16, 8, 0].map((shift) => {
    const x = (a >> shift) & 255;
    const y = (b >> shift) & 255;
    return Math.round(x + (y - x) * amount);
  });
  return "#" + channels.map((c) => c.toString(16).padStart(2, "0")).join("");
}

// The primary color as heading text on white: unchanged when it reads
// (4.5:1), else moved toward ink in 5% steps until it does.
export function pdfHeadingColor(primary: string): string {
  const base = HEX.test(primary) ? primary.toLowerCase() : DEFAULT_ACCENT;
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(base, INK_HEX, step / 20);
    if (contrastRatio(candidate, WHITE) >= 4.5) {
      return candidate;
    }
  }
  return INK_HEX;
}

type Fonts = { regular: PDFFont; bold: PDFFont; supported: Set<number> };

// Characters Helvetica can draw, control characters as spaces, runs of
// spaces collapsed.
function clean(fonts: Fonts, value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      out += " ";
    } else {
      out += fonts.supported.has(code) ? char : "?";
    }
  }
  return out.replace(/ {2,}/g, " ").trim();
}

// Lines of at most maxWidth at size; a word wider than a line breaks by
// character.
function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  const fits = (value: string) => font.widthOfTextAtSize(value, size) <= maxWidth;
  for (const word of text.split(" ").filter((part) => part.length > 0)) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (fits(word)) {
      current = word;
      continue;
    }
    let piece = "";
    for (const char of word) {
      if (fits(piece + char)) {
        piece += char;
      } else {
        if (piece) {
          lines.push(piece);
        }
        piece = char;
      }
    }
    current = piece;
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

// One line, cut with "..." to fit.
function fitLine(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) {
    return text;
  }
  let out = text;
  while (out.length > 0 && font.widthOfTextAtSize(out + "...", size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + "...";
}

function pngPixels(bytes: Uint8Array): number {
  if (bytes.length < 24) {
    return Infinity;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) * view.getUint32(20);
}

async function embedLogo(pdf: PDFDocument, bytes: Uint8Array | null): Promise<PDFImage | null> {
  if (!bytes || bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) {
    return null;
  }
  try {
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (png) {
      return pngPixels(bytes) <= LOGO_MAX_PIXELS ? await pdf.embedPng(bytes) : null;
    }
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    return jpeg ? await pdf.embedJpg(bytes) : null;
  } catch {
    return null;
  }
}

type Palette = { ink: RGB; muted: RGB; line: RGB; primary: RGB; heading: RGB };

class Writer {
  page!: PDFPage;
  y = 0;
  readonly pages: PDFPage[] = [];

  constructor(
    readonly pdf: PDFDocument,
    readonly fonts: Fonts,
    readonly palette: Palette,
    readonly poNumber: string,
  ) {}

  addPage(continued: boolean): void {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.page.drawRectangle({ x: 0, y: PAGE_H - BAND_H, width: PAGE_W, height: BAND_H, color: this.palette.primary });
    this.y = PAGE_H - MARGIN;
    if (continued) {
      this.text(`Purchase order ${this.poNumber} (continued)`, MARGIN, this.y - 10, { bold: true, size: 10, color: this.palette.heading });
      this.y -= 30;
    }
  }

  // Starts a continued page when `height` does not fit above the footer.
  ensure(height: number): boolean {
    if (this.y - height < CONTENT_BOTTOM) {
      this.addPage(true);
      return true;
    }
    return false;
  }

  text(value: string, x: number, y: number, opts: { bold?: boolean; size?: number; color?: RGB } = {}): void {
    if (value.length === 0) {
      return;
    }
    this.page.drawText(value, {
      x,
      y,
      size: opts.size ?? ROW_SIZE,
      font: opts.bold ? this.fonts.bold : this.fonts.regular,
      color: opts.color ?? this.palette.ink,
    });
  }

  textRight(value: string, right: number, y: number, opts: { bold?: boolean; size?: number; color?: RGB } = {}): void {
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    this.text(value, right - font.widthOfTextAtSize(value, opts.size ?? ROW_SIZE), y, opts);
  }

  rule(y: number, thickness: number, color: RGB): void {
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT, y }, thickness, color });
  }
}

function money(fonts: Fonts, cents: number, currency: string): string {
  const formatted = formatCents(cents, currency);
  return clean(fonts, formatted) === formatted ? formatted : `${centsToDecimal(cents)} ${clean(fonts, currency)}`;
}

function drawHeader(w: Writer, input: PoPdfInput, logo: PDFImage | null): void {
  const { fonts, palette } = w;
  const top = w.y;
  const name = clean(fonts, input.workspaceName) || APP_NAME;
  const leftWidth = 280;

  let left = top;
  if (logo) {
    const scale = Math.min(LOGO_MAX_W / logo.width, LOGO_MAX_H / logo.height, 1);
    const width = logo.width * scale;
    const height = logo.height * scale;
    w.page.drawImage(logo, { x: MARGIN, y: top - height, width, height });
    left = top - height - 18;
    for (const line of wrap(fonts.bold, name, 11, leftWidth).slice(0, 2)) {
      w.text(line, MARGIN, left, { bold: true, size: 11 });
      left -= 14;
    }
  } else {
    left = top - 18;
    for (const line of wrap(fonts.bold, name, 18, leftWidth).slice(0, 3)) {
      w.text(line, MARGIN, left, { bold: true, size: 18 });
      left -= 22;
    }
  }
  const replyTo = input.replyTo ? clean(fonts, input.replyTo) : "";
  if (replyTo) {
    w.text(fitLine(fonts.regular, replyTo, 9.5, leftWidth), MARGIN, left, { size: 9.5, color: palette.muted });
    left -= 13;
  }

  let right = top - 18;
  w.textRight("Purchase order", RIGHT, right, { bold: true, size: 20, color: palette.heading });
  right -= 26;
  const rows: Array<[string, string]> = [
    ["PO number", clean(fonts, input.poNumber)],
    ["Date", formatDate(input.date, "UTC")],
    ["Order", clean(fonts, input.orderName)],
  ];
  for (const [label, value] of rows) {
    const shown = fitLine(fonts.bold, value, 11, 170);
    w.textRight(shown, RIGHT, right, { bold: true, size: 11 });
    w.textRight(label, RIGHT - fonts.bold.widthOfTextAtSize(shown, 11) - 10, right, { size: 9, color: palette.muted });
    right -= 16;
  }

  w.y = Math.min(left, right) - 6;
  w.rule(w.y, 0.75, palette.line);
  w.y -= 22;
}

function drawParties(w: Writer, input: PoPdfInput): void {
  const { fonts, palette } = w;
  const columnWidth = (CONTENT_W - 24) / 2;
  const top = w.y;

  let left = top;
  w.text("Vendor", MARGIN, left, { bold: true, size: 9, color: palette.heading });
  left -= 16;
  for (const line of wrap(fonts.bold, clean(fonts, input.vendor.name), 11, columnWidth)) {
    w.text(line, MARGIN, left, { bold: true, size: 11 });
    left -= 14;
  }
  for (const line of wrap(fonts.regular, clean(fonts, input.vendor.email), 10, columnWidth)) {
    w.text(line, MARGIN, left, { size: 10, color: palette.muted });
    left -= 13;
  }

  const x = MARGIN + columnWidth + 24;
  let right = top;
  w.text("Ship to", x, right, { bold: true, size: 9, color: palette.heading });
  right -= 16;
  const shipTo = input.shipTo.map((line) => clean(fonts, line)).filter((line) => line.length > 0);
  if (shipTo.length === 0) {
    w.text("No ship-to address", x, right, { size: 10, color: palette.muted });
    right -= 13;
  }
  for (const [index, entry] of shipTo.entries()) {
    for (const line of wrap(index === 0 ? fonts.bold : fonts.regular, entry, index === 0 ? 11 : 10, columnWidth)) {
      w.text(line, x, right, { bold: index === 0, size: index === 0 ? 11 : 10 });
      right -= index === 0 ? 14 : 13;
    }
  }

  w.y = Math.min(left, right) - 18;
}

function drawTableHeader(w: Writer): void {
  const { palette } = w;
  const y = w.y - 10;
  const opts = { bold: true, size: 9, color: palette.heading };
  w.text("Description", MARGIN + COLUMNS.description.x, y, opts);
  w.text("SKU", MARGIN + COLUMNS.sku.x, y, opts);
  w.textRight("Qty", MARGIN + COLUMNS.quantity.x + COLUMNS.quantity.w, y, opts);
  w.textRight("Unit cost", MARGIN + COLUMNS.unit.x + COLUMNS.unit.w, y, opts);
  w.textRight("Line total", MARGIN + COLUMNS.total.x + COLUMNS.total.w, y, opts);
  w.y = y - 7;
  w.rule(w.y, 1.5, palette.primary);
  w.y -= 2;
}

function drawLines(w: Writer, input: PoPdfInput): void {
  const { fonts, palette } = w;
  // The header needs room for at least one row under it.
  w.ensure(26 + ROW_LEADING + ROW_PAD * 2);
  drawTableHeader(w);
  for (const line of input.lines) {
    const description = wrap(fonts.regular, clean(fonts, line.description) || "Untitled item", ROW_SIZE, COLUMNS.description.w - CELL_GAP);
    const sku = wrap(fonts.regular, clean(fonts, line.sku), ROW_SIZE, COLUMNS.sku.w - CELL_GAP);
    const height = Math.max(description.length, sku.length, 1) * ROW_LEADING + ROW_PAD * 2;
    if (w.ensure(height)) {
      drawTableHeader(w);
    }
    const first = w.y - ROW_PAD - 9;
    description.forEach((text, index) => w.text(text, MARGIN + COLUMNS.description.x, first - index * ROW_LEADING));
    sku.forEach((text, index) => w.text(text, MARGIN + COLUMNS.sku.x, first - index * ROW_LEADING, { color: palette.muted }));
    w.textRight(String(line.quantity), MARGIN + COLUMNS.quantity.x + COLUMNS.quantity.w, first);
    const unit = line.unitCost === null ? null : costToCents(line.unitCost);
    const total = lineTotalCents(line);
    w.textRight(
      unit === null ? "Not priced" : money(fonts, unit, input.currency),
      MARGIN + COLUMNS.unit.x + COLUMNS.unit.w,
      first,
      unit === null ? { color: palette.muted } : {},
    );
    if (total !== null) {
      w.textRight(money(fonts, total, input.currency), MARGIN + COLUMNS.total.x + COLUMNS.total.w, first);
    }
    w.y -= height;
    w.rule(w.y, 0.5, palette.line);
  }
}

function drawTotals(w: Writer, input: PoPdfInput): void {
  const { fonts, palette } = w;
  w.ensure(70);
  const subtotal = subtotalCents(input.lines);
  const amount = subtotal === null ? "Not priced" : money(fonts, subtotal, input.currency);
  const labelRight = RIGHT - 120;
  let y = w.y - 20;
  w.textRight("Subtotal", labelRight, y, { size: 10, color: palette.muted });
  w.textRight(amount, RIGHT, y, { size: 10 });
  y -= 12;
  w.page.drawLine({ start: { x: RIGHT - 220, y }, end: { x: RIGHT, y }, thickness: 1.5, color: palette.primary });
  y -= 18;
  w.textRight("Total", labelRight, y, { bold: true, size: 12 });
  w.textRight(amount, RIGHT, y, { bold: true, size: 12 });
  w.y = y - 26;
}

// Notes keep their line breaks; each paragraph wraps on its own.
function drawNotes(w: Writer, input: PoPdfInput): void {
  const { fonts, palette } = w;
  const paragraphs = (input.notes ?? "").split(/\r?\n/).map((paragraph) => clean(fonts, paragraph));
  if (paragraphs.every((paragraph) => paragraph.length === 0)) {
    return;
  }
  const lines = paragraphs.flatMap((paragraph) => (paragraph ? wrap(fonts.regular, paragraph, 10, CONTENT_W) : [""]));
  w.ensure(16 + ROW_LEADING);
  w.text("Notes", MARGIN, w.y, { bold: true, size: 9, color: palette.heading });
  w.y -= 16;
  for (const line of lines) {
    w.ensure(ROW_LEADING);
    w.text(line, MARGIN, w.y, { size: 10 });
    w.y -= ROW_LEADING;
  }
}

function drawFooters(w: Writer, input: PoPdfInput): void {
  const { fonts, palette } = w;
  const name = clean(fonts, input.workspaceName) || APP_NAME;
  const replyTo = input.replyTo ? clean(fonts, input.replyTo) : "";
  const count = w.pages.length;
  w.pages.forEach((page, index) => {
    w.page = page;
    w.rule(54, 0.5, palette.line);
    const pageLabel = `Page ${index + 1} of ${count}`;
    w.text(fitLine(fonts.regular, `${name} purchase order ${clean(fonts, input.poNumber)}`, 8.5, 380), MARGIN, 40, {
      size: 8.5,
      color: palette.muted,
    });
    w.textRight(pageLabel, RIGHT, 40, { size: 8.5, color: palette.muted });
    if (replyTo) {
      w.text(fitLine(fonts.regular, `Questions? Reply to ${replyTo}`, 8.5, 380), MARGIN, 28, { size: 8.5, color: palette.muted });
    }
    w.textRight(`Sent with ${APP_NAME}`, RIGHT, 28, { size: 8.5, color: palette.muted });
  });
}

export async function renderPoPdf(input: PoPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fonts: Fonts = { regular, bold, supported: new Set(regular.getCharacterSet()) };
  const primary = input.primaryColor && HEX.test(input.primaryColor) ? input.primaryColor.toLowerCase() : DEFAULT_ACCENT;
  const palette: Palette = {
    ink: hexToRgb(INK_HEX),
    muted: hexToRgb(MUTED_HEX),
    line: hexToRgb(LINE_HEX),
    primary: hexToRgb(primary),
    heading: hexToRgb(pdfHeadingColor(primary)),
  };

  pdf.setTitle(`Purchase order ${clean(fonts, input.poNumber)}`);
  pdf.setAuthor(clean(fonts, input.workspaceName) || APP_NAME);
  pdf.setCreator(APP_NAME);
  pdf.setProducer(APP_NAME);
  pdf.setCreationDate(new Date(input.date));
  pdf.setModificationDate(new Date(input.date));

  const logo = await embedLogo(pdf, input.logo);
  const writer = new Writer(pdf, fonts, palette, clean(fonts, input.poNumber));
  writer.addPage(false);
  drawHeader(writer, input, logo);
  drawParties(writer, input);
  drawLines(writer, input);
  drawTotals(writer, input);
  drawNotes(writer, input);
  drawFooters(writer, input);
  return await pdf.save();
}
