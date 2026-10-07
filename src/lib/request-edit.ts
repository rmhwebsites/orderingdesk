// Editing a request before approval (comprehensive design section 2): the
// editor the server hands the drawer, the body the drawer sends back, the
// checks both sides share, and the plain before-and-after summary the
// review step shows and the timeline keeps. Pure; relative imports only
// (the server bundles this too).

export const EDIT_LINES_MAX = 50;
export const EDIT_QUANTITY_MAX = 999;

const UUID = /^[A-Za-z0-9-]{1,64}$/;
const LOCATION_ID = /^[1-9]\d{0,19}$/;
const WHOLE = /^\d+$/;

// One draft line as the editor shows it. propertyCount: the personalization
// fields riding on the line (underscore keys left out), kept exactly.
export type EditableLine = {
  uuid: string;
  title: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  propertyCount: number;
};

// A company location the request may ship to; address on one line.
export type EditLocationOption = { shopifyLocationId: string; name: string; address: string };

// updatedAt: Shopify's updatedAt as the editor read it, the token a save
// must repeat. locations: empty when the location cannot change.
export type RequestEditor = {
  updatedAt: string;
  lines: EditableLine[];
  locationId: string | null;
  locationName: string;
  locations: EditLocationOption[];
};

// lines: every line that stays, with its quantity (a line left out is
// removed). locationId: the new company location, or null to keep it.
export type EditRequestBody = { updatedAt: string; lines: { uuid: string; quantity: number }[]; locationId: string | null };

export type EditSummary = {
  changes: string[];
  before: { lines: string[]; shipTo: string };
  after: { lines: string[]; shipTo: string };
};

export const EDIT_COPY = {
  invalid: "The changes could not be read. Close the editor, open it again and make them again.",
  keepOne: "A request keeps at least one item. Reject it instead if nothing should ship.",
  quantity: `Each quantity must be a whole number from 1 to ${EDIT_QUANTITY_MAX}.`,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEditBody(body: unknown): EditRequestBody | { error: string } {
  if (
    !isRecord(body) ||
    typeof body.updatedAt !== "string" ||
    body.updatedAt.length === 0 ||
    body.updatedAt.length > 40 ||
    Number.isNaN(Date.parse(body.updatedAt))
  ) {
    return { error: EDIT_COPY.invalid };
  }
  if (!Array.isArray(body.lines) || body.lines.length > EDIT_LINES_MAX) {
    return { error: EDIT_COPY.invalid };
  }
  if (body.lines.length === 0) {
    return { error: EDIT_COPY.keepOne };
  }
  const lines: { uuid: string; quantity: number }[] = [];
  const seen = new Set<string>();
  for (const raw of body.lines) {
    if (!isRecord(raw) || typeof raw.uuid !== "string" || !UUID.test(raw.uuid) || seen.has(raw.uuid)) {
      return { error: EDIT_COPY.invalid };
    }
    if (typeof raw.quantity !== "number" || !Number.isInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > EDIT_QUANTITY_MAX) {
      return { error: EDIT_COPY.quantity };
    }
    seen.add(raw.uuid);
    lines.push({ uuid: raw.uuid, quantity: raw.quantity });
  }
  let locationId: string | null = null;
  if (body.locationId !== undefined && body.locationId !== null) {
    if (typeof body.locationId !== "string" || !LOCATION_ID.test(body.locationId)) {
      return { error: EDIT_COPY.invalid };
    }
    locationId = body.locationId;
  }
  return { updatedAt: body.updatedAt, lines, locationId };
}

// "Hard Hat (White)"; Shopify's "Default Title" variant is no variant.
export function lineLabel(line: Pick<EditableLine, "title" | "variantTitle">): string {
  const title = line.title.trim() || "Untitled item";
  const variant = line.variantTitle.trim();
  return variant && variant !== "Default Title" ? `${title} (${variant})` : title;
}

function placeName(editor: RequestEditor, locationId: string | null): string {
  if (locationId === null) {
    return editor.locationName || "no company location";
  }
  const option = editor.locations.find((entry) => entry.shopifyLocationId === locationId);
  if (option) {
    return option.name;
  }
  return locationId === editor.locationId && editor.locationName ? editor.locationName : `location ${locationId}`;
}

export function summarizeEdit(editor: RequestEditor, body: EditRequestBody): EditSummary {
  const quantities = new Map(body.lines.map((line) => [line.uuid, line.quantity]));
  const changes: string[] = [];
  for (const line of editor.lines) {
    const next = quantities.get(line.uuid);
    if (next === undefined) {
      changes.push(`Removed ${lineLabel(line)}`);
    } else if (next !== line.quantity) {
      changes.push(`${lineLabel(line)}: quantity ${line.quantity} to ${next}`);
    }
  }
  const moves = body.locationId !== null && body.locationId !== editor.locationId;
  if (moves) {
    changes.push(`Ship to ${placeName(editor, body.locationId)} instead of ${placeName(editor, editor.locationId)}`);
  }
  return {
    changes,
    before: { lines: editor.lines.map((line) => `${line.quantity} x ${lineLabel(line)}`), shipTo: placeName(editor, editor.locationId) },
    after: {
      lines: editor.lines
        .filter((line) => quantities.has(line.uuid))
        .map((line) => `${quantities.get(line.uuid)} x ${lineLabel(line)}`),
      shipTo: placeName(editor, moves ? body.locationId : editor.locationId),
    },
  };
}

// The editor form's state as a body: quantities as typed, removed lines,
// the picked location (sent only when it changed).
export function bodyFromForm(
  editor: RequestEditor,
  form: { quantities: Record<string, string>; removed: ReadonlySet<string>; locationId: string | null },
): EditRequestBody | { error: string } {
  const lines: { uuid: string; quantity: number }[] = [];
  for (const line of editor.lines) {
    if (form.removed.has(line.uuid)) {
      continue;
    }
    const raw = (form.quantities[line.uuid] ?? String(line.quantity)).trim();
    if (!WHOLE.test(raw)) {
      return { error: EDIT_COPY.quantity };
    }
    const quantity = Number(raw);
    if (quantity < 1 || quantity > EDIT_QUANTITY_MAX) {
      return { error: EDIT_COPY.quantity };
    }
    lines.push({ uuid: line.uuid, quantity });
  }
  if (lines.length === 0) {
    return { error: EDIT_COPY.keepOne };
  }
  return { updatedAt: editor.updatedAt, lines, locationId: form.locationId !== editor.locationId ? form.locationId : null };
}

// Whether Shopify's draft now holds exactly the edit (the read after a
// timeout: done, or never sent).
export function editLanded(
  current: { lines: { uuid: string; quantity: number }[]; locationId: string | null },
  body: EditRequestBody,
): boolean {
  if (current.lines.length !== body.lines.length) {
    return false;
  }
  const wanted = new Map(body.lines.map((line) => [line.uuid, line.quantity]));
  return (
    current.lines.every((line) => wanted.get(line.uuid) === line.quantity) &&
    (body.locationId === null || current.locationId === body.locationId)
  );
}

// Changes whenever the request's content changes (items, quantities,
// location, total): an open Approve confirmation closes when it does.
export function requestContentKey(
  summary: { itemTitles: string[]; itemCount: number; locationId: string | null; total: string } | undefined,
): string {
  return summary ? JSON.stringify([summary.itemTitles, summary.itemCount, summary.locationId, summary.total]) : "";
}
