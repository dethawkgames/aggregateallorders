# DHG Order Aggregation

A clean-slate replacement for the old Order Needs / reconcile pipeline. It keeps
three working sheets (**Asmodee**, **Universal Dist**, **ACDD**) holding what you
owe each supplier for the current weekly cycle.

## The cycle

1. **Every day at 6:00 am ET** the script adds the orders placed since the previous
   run. Cancelled orders count 0; refunded or removed line items count 0
   (Shopify's `currentQuantity`). Each remaining line goes to the supplier its
   product tag names, first match wins: `asmodee` → Asmodee, `Alliance` →
   Universal Dist, `acdd` → ACDD. Untagged products are skipped. The quantity is
   added to the SKU's row or a new row is created.
2. You can add rows or change quantities by hand any time. The script only ever
   adds or subtracts its own contribution, so your edits are kept.
3. If an order is cancelled or refunded after it was added, the next run subtracts
   it (a row that reaches 0 is removed).
4. **Submission day (Monday, or the date in `Config`'s override cell):** the 6:00 am
   run adds orders placed up to 6:00 am, then sets `Cycle Status = Frozen`.
   Nothing more is added while frozen. You edit and submit your supplier orders.
5. **Close the cycle** with the number of the last order you submitted (GitHub
   Actions → "Close cycle", or ask Claude). First, every row on the three supplier
   tabs (including rows you added by hand) is copied to the **Order placed** tab;
   if that copy fails or can't be verified, nothing is cleared. Next the submitted
   Shopify orders are tagged `dhg-status-order-supplier` (see below). Then the three
   sheets and the ledger are cleared, the starting point moves to that order, and with "run now" everything
   placed since is added immediately. Otherwise the next 6:00 am run picks it up.

**Holiday week:** put the submission date in `Config` → "Submission Day Override"
(for example `2026-10-13`). Monday's run then does not freeze; that date's does.
Close-cycle clears the override.

### Order tagging at close

Every order counted this cycle with number ≤ the last submitted order gets the
`dhg-status-order-supplier` tag; its current fulfillment-stage `dhg-status-*` tag is
removed first (the email-lifecycle tags `store-first-order`, `shop-first-order`,
`order-placed`, `preorder` are never touched). Skipped: cancelled orders, fulfilled
orders, orders placed before 2026-04-06, orders already tagged, and orders tagged
`dhg-status-inventory-queued`. **Held back:** if you reduced a row (or deleted it) so
the sheet holds less than the orders needed, orders needing that SKU are not tagged
and are listed in the result. Extra quantity you added by hand does not hold anything back.
Tagging happens after the verified copy to Order placed; a per-order failure is
reported but never blocks closing. Needs the `write_orders` scope; if missing,
close-cycle stops before changing anything. `--no-tag` closes without tagging.

## Sheet layout

| Tab | Columns |
|---|---|
| Asmodee | ProductId, Quantity, UnitOfMeasureId, VariantId, Title, Order Names, In Bins (first four match Asmodee's checkout CSV) |
| Universal Dist | SKU, Quantity, Title, Order Names, In Bins |
| ACDD | ACDD SKU, Shopify SKU, Quantity, Title, Order Names, In Bins |
| Config | Last Submitted Order, Cycle Status, Last Cutoff Processed, Submission Day Override, Last Run |
| Ledger | what each order line has contributed (script-owned; do not edit) |
| Order placed | permanent, append-only record of each locked cycle: Lock Date, Last Order Submitted, Supplier, SKU, ACDD SKU, Quantity, Unit, Title, Order Names, In Bins. Newest cycle at the bottom; every row carries its own lock date and last order, so it can be filtered or cleaned up per row |

**In Bins** is refreshed on every run from the bin tracker (`bin(qty)`), for every
row including ones you add by hand. It is advisory only.

## Setup (one time)

1. Create a blank Google Sheet and share it (Editor) with the `dhg-sheets-bot` service account.
2. Run `node src/cli.js setup <last submitted order number>` with the env vars below.
   It creates the tabs, headers and Config.
3. Add these GitHub repository secrets: `SHEET_ID`, `GOOGLE_SA_EMAIL`,
   `GOOGLE_SA_PRIVATE_KEY`, `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` (the app needs `read_orders`, `read_products` and, for tagging at close, `write_orders`; the script exchanges the client ID/secret for a token).
4. Push. The "Daily order aggregation" workflow runs by itself every day.

Local use: `GOOGLE_SA_KEY_FILE=/path/to/key.json` can replace the two Google vars.

## Commands

```
node src/cli.js setup <last submitted order>
node src/cli.js run [--dry-run] [--now] [--force]
node src/cli.js close-cycle <last submitted order> [--run-now] [--no-tag]
npm test
```

`--now` processes up to this moment instead of the 6:00 am boundary. `--force` runs
even if frozen.

## Safety properties (all covered by tests)

- Re-running never double counts (ledger-based deltas).
- A missed day cannot leak post-6:00 am submission-day orders into the cycle.
- `close-cycle` verifies the order exists in Shopify before clearing anything.
- Orders with more than 50 line items fail loudly rather than dropping lines.
- A bin tracker outage skips only the In Bins column; the run still succeeds.
- Daylight saving is handled (both 10:05 and 11:05 UTC crons are scheduled; the extra one is a no-op).
