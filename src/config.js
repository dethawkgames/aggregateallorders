// Central constants. Nothing here touches the network.

export const TZ = 'America/New_York';
export const CUTOFF_HOUR = 6; // 6:00 am ET: every daily run, and submission day, uses this boundary

// Tab layouts. Column indexes are 0-based. The Asmodee tab's first four columns
// match Asmodee's checkout CSV upload format exactly (ProductId, Quantity,
// UnitOfMeasureId, VariantId); everything after that is for you.
export const TABS = {
  Asmodee: {
    header: ['ProductId', 'Quantity', 'UnitOfMeasureId', 'VariantId', 'Title', 'Order Names', 'In Bins'],
    skuCol: 0, qtyCol: 1, titleCol: 4, ordersCol: 5, binsCol: 6,
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
