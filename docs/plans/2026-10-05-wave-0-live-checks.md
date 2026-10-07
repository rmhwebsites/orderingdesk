# Wave 0: Supervised Live Checks (before Wave 1)

Part of docs/plans/2026-10-05-comprehensive-desk-design.md. About half a
day with Ryan, on production (orderingdesk.com and the IMPACT workspace).
Each check either passes or becomes a fix at the top of Wave 1a. Claude
watches the logs and the database while Ryan acts in the app; nothing here
is a Claude action on a real request unless Ryan asks for it in chat.

## Checklist

1. **Refresh connection.** Settings > Store connection > Refresh connection.
   - Pass: the panel shows the draft scopes, the webhooks list includes the
     draft and company location topics, no error. Claude confirms `webhooks_registered_at` moved
     and `canonical_shop_domain` is still `40kra0-b6.myshopify.com`.
2. **Live webhooks.** Ryan changes something small on a test order in
   Shopify (for example adds then removes a tag on #1024).
   - Pass: the card updates within seconds, not at the next 10 minute sync;
     `wrangler tail` shows no 401 for IMPACT deliveries.
3. **First supervised Approve.** Approve #D19 (the owner's TEST request) in
   Ordering Desk.
   - Pass: Shopify shows a new order, Paid and Unfulfilled, tagged
     "Ordering Desk: Approved"; the card shows the order number with "from
     draft #D19"; no "New order" alert for it. Note whether Shopify emailed
     the TEST address its order confirmation (expected, as with Mark as
     paid). Then the PO review opens for managers: Cancel it.
4. **Reject flow** on a new $0 test request (Ryan submits one from the
   store as the TEST account first).
   - Pass: reason saved as a note, card in Rejected, draft tagged
     "Ordering Desk: Rejected" in Shopify, nothing deleted, nobody emailed.
5. **Phone push.** Android: Settings > Notifications > Enable push on this
   device. iPhone: Safari > Share > Add to Home Screen, open it from the Home
   Screen, then enable push.
   - Pass: the next new request (step 4) arrives as a push that opens the
     request; the branded "New request" email arrives too.
6. **Test PO.** On an approved order, create a PO to a vendor whose email is
   an address Ryan reads; review, Send to vendor.
   - Pass: the email arrives from the workspace sender with the PDF
     attached; the PDF opens and shows the logo, lines and ship-to; the
     drawer shows the PO as Sent.
7. **History import.** Settings > Store connection > Order history:
   "Orders since" a date inside the last 60 days.
   - Pass: progress shows, it finishes, imported orders appear with no
     alerts; the regular sync keeps running.
8. **Open in Shopify.** Click it on one order and one draft.
   - Pass: both open the right page in Shopify admin (store 40kra0-b6).

9. **Edit a request (quantity only).** Change one quantity on a test
   draft and save.
   - Pass: in Shopify the draft keeps its shipping address and its $0
     prices (Wave 1b sends the company location on every edit).
10. **Cancel an approved test order** from the desk.
   - Pass: Shopify shows it cancelled with no customer email, no restock and
     no refund; the card moves to Cancelled with the reason as a note.
11. **AI search.** Ask about 50 plain questions on the live desk (for
   example "open requests from Athens", "business cards last month",
   "show me the closed ones").
   - Pass: answers arrive within about 2.5 seconds and the chips match the
     question; anything unreadable falls back to keyword search.
12. **People and locations.** Open an employee page and a location page
   from a card.
   - Pass: history, counts and items look right; the five company
     locations show with their addresses.

## After the checks

- Record the results in a dated STATE UPDATE at the end of docs/HANDOFF.md.
- Anything that fails becomes the first task of Wave 1a.
