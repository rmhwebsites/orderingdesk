"use client";

// The drawer's request and item sections (draft orders spec sections 11.3
// and 11.4 with section 18): who asked and for what, every item with its
// personalization, a draft's totals, and the ship-to address. Text renders
// through JSX only; images and links come from classifyProperty, which only
// lets https URLs on cdn.shopify.com through.

import { useId, useState } from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { FilePdfIcon } from "@phosphor-icons/react/FilePdf";
import { LinkSimpleIcon } from "@phosphor-icons/react/LinkSimple";
import { formatMoney } from "@/lib/format";
import { classifyProperty, clipText, type PropertyView } from "@/lib/item-properties";
import { itemsSubtotal, shippingLines, type OrderSnapshot, type SnapshotItem } from "@/lib/order-snapshot";
import type { RequestFields } from "@/lib/request-fields";
import { Chip, DetailRow, InlineMessage } from "@/components/kit";
import { CopyButton, Section } from "./drawer-kit";

const NEW_TAB = " (opens in a new tab)";

function TextValue({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const clipped = clipText(value);
  return (
    <>
      <span className="whitespace-pre-line break-words">{open || !clipped.clipped ? value : `${clipped.text}...`}</span>
      {clipped.clipped ? (
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="ml-1 font-semibold text-ink underline underline-offset-2"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

function PropertyValue({ view, itemTitle }: { view: PropertyView; itemTitle: string }) {
  switch (view.kind) {
    case "image":
      return (
        <a href={view.url} target="_blank" rel="noopener noreferrer" className="inline-block rounded-panel">
          <img
            src={view.url}
            alt={`Preview for ${itemTitle || "this item"}`}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="max-h-40 max-w-40 rounded-panel border border-line bg-surface object-contain"
          />
          <span className="sr-only"> Opens the full size image in a new tab.</span>
        </a>
      );
    case "pdf":
      return (
        <a
          href={view.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-semibold text-ink underline underline-offset-2"
        >
          <FilePdfIcon size={16} aria-hidden />
          Print PDF
          <span className="sr-only">{NEW_TAB}</span>
        </a>
      );
    case "link":
      return (
        <a
          href={view.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 break-all font-semibold text-ink underline underline-offset-2"
        >
          <LinkSimpleIcon size={14} aria-hidden />
          {view.host}
          <span className="sr-only">{NEW_TAB}</span>
        </a>
      );
    case "text":
    case "hidden":
      return <TextValue value={view.value} />;
  }
}

// One item's personalization. Underscore keys (an app's own data) stay
// behind "Show all properties".
export function PropertyList({ props, itemTitle }: { props: SnapshotItem["props"]; itemTitle: string }) {
  const id = useId();
  const [showAll, setShowAll] = useState(false);
  const views = props.map(classifyProperty);
  const hiddenCount = views.filter((view) => view.kind === "hidden").length;
  const shown = views.filter((view) => showAll || view.kind !== "hidden");
  if (views.length === 0) {
    return null;
  }
  return (
    <div className="mt-2">
      {shown.length > 0 ? (
        <dl id={`${id}-props`} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          {shown.map((view, index) => (
            <div key={index} className="contents">
              <dt className="break-words text-ink-2">{view.label}</dt>
              <dd className="min-w-0 text-ink">
                <PropertyValue view={view} itemTitle={itemTitle} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          aria-expanded={showAll}
          aria-controls={`${id}-props`}
          className="mt-1.5 text-xs font-semibold text-ink-2 underline underline-offset-2 hover:text-ink"
        >
          {showAll ? "Hide app properties" : `Show all properties (${hiddenCount} more)`}
        </button>
      ) : null}
    </div>
  );
}

function ItemRow({ item, currency }: { item: SnapshotItem; currency: string }) {
  const unit = item.price === null ? null : formatMoney(item.price, currency);
  const line =
    item.price === null || !Number.isFinite(Number(item.price))
      ? null
      : formatMoney((Number(item.price) * item.qty).toFixed(2), currency);
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink">
            <span className="break-words">{item.title || "Untitled item"}</span>
            {item.custom ? (
              <Chip tone="slate" size="sm">
                Custom item
              </Chip>
            ) : null}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-2">
            {item.variant ? <span>{item.variant}</span> : null}
            {item.sku ? <span className="font-mono">SKU {item.sku}</span> : null}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm tabular-nums text-ink">{line ?? "No price"}</p>
          <p className="font-mono text-xs tabular-nums text-ink-2">
            {item.qty} x {unit ?? "?"}
          </p>
        </div>
      </div>
      <PropertyList props={item.props} itemTitle={item.title} />
    </li>
  );
}

// Items with their personalization, then the totals: a draft's subtotal,
// discount and total, or an order's items sum and total.
export function ItemsSection({
  snapshot,
  itemsTruncated,
  shopifyUrl,
}: {
  snapshot: OrderSnapshot;
  itemsTruncated: boolean;
  shopifyUrl: string | null;
}) {
  const subtotal = itemsSubtotal(snapshot.items);
  return (
    <Section title="Items">
      {itemsTruncated ? (
        <div className="mb-3">
          <InlineMessage tone="warn">
            Showing the first {snapshot.items.length} items.{" "}
            {shopifyUrl ? (
              <a href={shopifyUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
                Open in Shopify for the rest
                <span className="sr-only">{NEW_TAB}</span>
              </a>
            ) : (
              "Open it in Shopify for the rest."
            )}
          </InlineMessage>
        </div>
      ) : null}
      {snapshot.items.length === 0 ? (
        <p className="text-sm text-ink-2">No line items.</p>
      ) : (
        <ul className="divide-y divide-line">
          {snapshot.items.map((item, index) => (
            <ItemRow key={index} item={item} currency={snapshot.currency} />
          ))}
        </ul>
      )}
      {snapshot.kind === "draft" ? (
        <dl className="mt-4 flex flex-col gap-1.5 border-t border-line pt-3 text-sm">
          {snapshot.subtotal ? (
            <div className="flex justify-between gap-4">
              <dt className="text-ink-2">Subtotal</dt>
              <dd className="font-mono tabular-nums text-ink">{formatMoney(snapshot.subtotal, snapshot.currency)}</dd>
            </div>
          ) : null}
          {snapshot.discount || snapshot.discountCodes.length > 0 || (snapshot.discounts && Number(snapshot.discounts) !== 0) ? (
            <div className="flex justify-between gap-4">
              <dt className="min-w-0 text-ink-2">
                Discount
                {snapshot.discount?.title ? <span className="text-ink">{` (${snapshot.discount.title})`}</span> : null}
                {snapshot.discountCodes.length > 0 ? (
                  <span className="block font-mono text-xs">{snapshot.discountCodes.join(", ")}</span>
                ) : null}
              </dt>
              <dd className="font-mono tabular-nums text-ink">
                {snapshot.discounts ? `-${formatMoney(snapshot.discounts, snapshot.currency)}` : ""}
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4">
            <dt className="font-semibold text-ink">Total</dt>
            <dd className="font-mono font-semibold tabular-nums text-ink">{formatMoney(snapshot.total, snapshot.currency)}</dd>
          </div>
        </dl>
      ) : (
        <>
          <dl className="mt-4 flex flex-col gap-1.5 border-t border-line pt-3 text-sm">
            {!itemsTruncated && subtotal !== null ? (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-2">Items</dt>
                <dd className="font-mono tabular-nums text-ink">{formatMoney(subtotal, snapshot.currency)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-4">
              <dt className="font-semibold text-ink">Order total</dt>
              <dd className="font-mono font-semibold tabular-nums text-ink">{formatMoney(snapshot.total, snapshot.currency)}</dd>
            </div>
          </dl>
          <p className="mt-1.5 text-xs text-ink-2">
            The order total comes from Shopify and includes shipping, taxes and discounts.
          </p>
        </>
      )}
    </Section>
  );
}

// Who asked and what for: the requester, the B2B company and location,
// every public cart attribute (request keys first), the draft's note and PO
// number. Fields that are empty are left out.
export function RequestSection({
  customerName,
  email,
  fields,
  note,
  poNumber,
}: {
  customerName: string;
  email: string;
  fields: RequestFields;
  note: string;
  poNumber: string;
}) {
  return (
    <Section title="Request">
      <p className="text-sm font-medium text-ink">{customerName || "No requester name"}</p>
      {email ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="select-all break-all text-sm text-ink-2">{email}</span>
          <CopyButton text={email} label="Copy email" />
        </div>
      ) : (
        <p className="mt-1 text-sm text-ink-2">No email on this request.</p>
      )}
      {fields.company || fields.location || fields.attributes.length > 0 || note || poNumber ? (
        <dl className="mt-4 flex flex-col gap-2.5">
          {fields.company ? <DetailRow term="Company">{fields.company}</DetailRow> : null}
          {fields.location ? <DetailRow term="Location">{fields.location}</DetailRow> : null}
          {fields.attributes.map((attribute, index) => (
            <DetailRow key={index} term={attribute.key}>
              <span className="whitespace-pre-line">{attribute.value}</span>
            </DetailRow>
          ))}
          {poNumber ? <DetailRow term="PO number">{poNumber}</DetailRow> : null}
          {note ? (
            <DetailRow term="Note">
              <span className="whitespace-pre-line">{note}</span>
            </DetailRow>
          ) : null}
        </dl>
      ) : null}
    </Section>
  );
}

export function ShipToSection({ shipping }: { shipping: OrderSnapshot["shipping"] }) {
  return (
    <Section title="Ship to">
      {shipping ? (
        <address className="text-sm not-italic leading-relaxed text-ink">
          {shippingLines(shipping).map((line, index) => (
            <span key={index} className="block">
              {line}
            </span>
          ))}
          {shipping.phone ? <span className="mt-1 block font-mono text-ink-2">{shipping.phone}</span> : null}
        </address>
      ) : (
        <p className="text-sm text-ink-2">No shipping address.</p>
      )}
    </Section>
  );
}

// A link that opens an admin page in Shopify, for the drawer's text.
export function ShopifyLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">
      {children}
      <ArrowSquareOutIcon size={14} aria-hidden />
      <span className="sr-only">{NEW_TAB}</span>
    </a>
  );
}
