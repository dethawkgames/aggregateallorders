import { DEFAULTS } from './config.js';

export async function loadBins(url = process.env.BIN_TRACKER_URL || DEFAULTS.binTrackerUrl) {
  const res = await fetch(`${url}/api/bins`);
  if (!res.ok) throw new Error(`Bin tracker fetch failed: ${res.status}`);
  const j = await res.json();
  return j.bins || j;
}

// Shopify SKU -> ACDD SKU, from the Product SKUs sheet (read-only).
// Shopify SKU -> ACDD item id (what you order by). Two sources, in order:
//  1. the "ACDD SKU" column on the Product SKUs sheet's "Asmodee Only (Clean)" tab
//     (Sheet1 no longer has that column);
//  2. the product's Shopify barcode (UPC) looked up in the ACDD catalog ("Garland" tab:
//     ItemID + UPC). This covers ACDD-only products that are not on the Clean tab.
export function makeAcddMapLoader(auth, sheetId = process.env.PRODUCT_SKUS_SHEET_ID || DEFAULTS.productSkusSheetId) {
  const read = async (range) => {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`, {
      headers: { Authorization: `Bearer ${await auth.get()}` },
    });
    if (!res.ok) throw new Error(`Product SKUs read failed (${range}): ${res.status}`);
    return (await res.json()).values || [];
  };
  return async (skus = [], shopify = null) => {
    const m = new Map();
    const [header = [], ...rows] = await read("'Asmodee Only (Clean)'!A1:F");
    const sku = header.indexOf('Variant SKU'), acdd = header.indexOf('ACDD SKU');
    if (sku >= 0 && acdd >= 0) {
      for (const r of rows) {
        const s = String(r[sku] ?? '').trim(), a = String(r[acdd] ?? '').trim();
        if (s && a && a !== '#N/A') m.set(s, a);
      }
    }
    const missing = skus.filter(s => s && !m.has(s));
    if (missing.length && shopify) {
      const barcodes = await shopify.barcodesForSkus(missing);
      if (barcodes.size) {
        const [gh = [], ...grows] = await read("'Garland'!A1:G");
        const id = gh.indexOf('ItemID'), upc = gh.indexOf('UPC');
        const byUpc = new Map();
        if (id >= 0 && upc >= 0) for (const r of grows) { const u = String(r[upc] ?? '').trim(); if (u) byUpc.set(u, String(r[id] ?? '').trim()); }
        for (const [s, b] of barcodes) { const a = byUpc.get(b); if (a) m.set(s, a); }
      }
    }
    return m;
  };
}
