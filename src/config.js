// Central constants. Nothing here touches the network.

export const TZ = 'America/New_York';
export const CUTOFF_HOUR = 6; // 6:00 am ET: every daily run, and submission day, uses this boundary

// Tab layouts. Column indexes are 0-based. The Asmodee tab's first four columns
// match Asmodee's checkout CSV upload format exactly (ProductId, Quantity,
// UnitOfMeasureId, VariantId); everything after that is for you.
export const TABS = {
  Asmodee: {
    header: ['ProductId', 'Quantity', 'UnitOfMeasureId', 'VariantId', 'Title', 'Order Names', 'In Bins'],
    skuCol: 0, qtyCol: 1, unitCol: 2, titleCol: 4, ordersCol: 5, binsCol: 6,
  },
  'Universal Dist': {
    header: ['SKU', 'Quantity', 'Title', 'Order Names', 'In Bins'],
    skuCol: 0, qtyCol: 1, titleCol: 2, ordersCol: 3, binsCol: 4,
  },
  ACDD: {
    header: ['ACDD SKU', 'Shopify SKU', 'Quantity', 'Title', 'Order Names', 'In Bins'],
    skuCol: 1, qtyCol: 2, titleCol: 3, ordersCol: 4, binsCol: 5,
  },
};
export const SUPPLIERS = Object.keys(TABS);

// First matching tag wins, in this order. Matching is case-insensitive and exact.
export const SUPPLIER_TAGS = [
  ['asmodee', 'Asmodee'],
  ['alliance', 'Universal Dist'],
  ['acdd', 'ACDD'],
];

export const CONFIG_TAB = 'Config';
export const LEDGER_TAB = 'Ledger';
export const LEDGER_HEADER = ['Order', 'SKU', 'Supplier', 'Qty Counted', 'Title'];

// "Order placed": permanent, append-only record of each locked cycle. Every row
// carries its own lock date and last submitted order, so the list stays
// filterable and later clean-up logic (e.g. dropping fulfilled items) can work row by row.
export const ARCHIVE_TAB = 'Order placed';
export const ARCHIVE_HEADER = ['Lock Date', 'Last Order Submitted', 'Supplier', 'SKU', 'ACDD SKU', 'Quantity', 'Unit', 'Title', 'Order Names', 'In Bins'];

export const K = {
  lastOrder: 'Last Submitted Order',
  status: 'Cycle Status',
  lastCutoff: 'Last Cutoff Processed',
  override: 'Submission Day Override (YYYY-MM-DD)',
  lastRun: 'Last Run',
};

export const DEFAULTS = {
  shop: 'detective-hawk-games.myshopify.com',
  binTrackerUrl: 'https://dhg-bin-tracker-app.vercel.app',
  productSkusSheetId: '1yC-oZ-0hD5ReTcOA9iTjTGC6mONbDUCpfbZZA9GrQtI', // read-only: ACDD SKU mapping lives on Sheet1
  shopifyApiVersion: '2025-01',
};

// ── Shopify order tagging at close-cycle (ported from the reconcile app's lock-supplier-order.py) ──
export const SUPPLIER_ORDER_TAG = 'dhg-status-order-supplier';
export const INVENTORY_QUEUED_TAG = 'dhg-status-inventory-queued';
// Set once by the welcome-email system; NOT fulfillment-stage tags despite the
// shared prefix. Tagging must never remove these.
export const EMAIL_LIFECYCLE_TAGS = new Set([
  'dhg-status-store-first-order',
  'dhg-status-shop-first-order',
  'dhg-status-order-placed',
  'dhg-status-preorder',
]);
// Orders placed before this date are never pushed through the dhg-status tagging system.
export const TAGGING_FLOOR_DATE = '2026-04-06';
