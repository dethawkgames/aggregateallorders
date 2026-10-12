import { DEFAULTS } from './config.js';

export async function loadBins(url = process.env.BIN_TRACKER_URL || DEFAULTS.binTrackerUrl) {
  const res = await fetch(`${url}/api/bins`);
  if (!res.ok) throw new Error(`Bin tracker fetch failed: ${res.status}`);
  const j = await res.json();
  return j.bins || j;
}

// Shopify SKU -> ACDD SKU, from the Product SKUs sheet (read-only).
export function makeAcddMapLoader(auth, sheetId = process.env.PRODUCT_SKUS_SHEET_ID || DEFAULTS.productSkusSheetId) {
  return async () => {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Sheet1!A1:F')}`, {
      headers: { Authorization: `Bearer ${await auth.get()}` },
    });
    if (!res.ok) throw new Error(`Product SKUs read failed: ${res.status}`);
    const [header = [], ...rows] = (await res.json()).values || [];
    const sku = header.indexOf('Variant SKU'), acdd = header.indexOf('ACDD SKU');
    if (sku < 0 || acdd < 0) throw new Error('Sheet1 is missing "Variant SKU" or "ACDD SKU" columns');
    const m = new Map();
    for (const r of rows) {
      const s = String(r[sku] ?? '').trim(), a = String(r[acdd] ?? '').trim();
      if (s && a && a !== '#N/A') m.set(s, a);
    }
    return m;
  };
}
