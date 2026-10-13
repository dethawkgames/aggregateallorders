// Pure logic: no network, no sheet access. Everything here is unit-tested.
import { SUPPLIER_TAGS, TABS, EMAIL_LIFECYCLE_TAGS, INVENTORY_QUEUED_TAG, SUPPLIER_ORDER_TAG, TAGGING_FLOOR_DATE } from './config.js';
import { etDateString } from './time.js';

export function supplierForTags(tags) {
  const set = new Set((tags || []).map(t => String(t).toLowerCase().trim()));
  for (const [tag, supplier] of SUPPLIER_TAGS) if (set.has(tag)) return supplier;
  return null; // untagged: skipped by design
}

export const orderNumber = name => parseInt(String(name).replace(/\D/g, ''), 10);

export const lineKey = (order, sku, supplier) => `${order}|${sku}|${supplier}`;

// What the sheet SHOULD have counted for each (order, sku, supplier), given the
// orders Shopify reports right now. A cancelled order, or a line that was
// refunded or removed, counts 0 (Shopify's currentQuantity is already net of
// refunds and removals; verified against real refunded and cancelled orders).
export function desiredFromOrders(orders, { lastOrder, cutoff }) {
  const desired = new Map();
  const seenOrders = new Set();
  const skipped = { untagged: 0, noSku: 0 };
  for (const o of orders) {
    const num = orderNumber(o.name);
    if (!(num > lastOrder)) continue;
    if (new Date(o.createdAt) > cutoff) continue;
    seenOrders.add(o.name);
    for (const li of o.lines) {
      const sku = (li.sku || '').trim();
      if (!sku) { skipped.noSku++; continue; }
      const supplier = supplierForTags(li.tags);
      if (!supplier) { skipped.untagged++; continue; }
      const qty = o.cancelledAt ? 0 : Math.max(0, li.qty || 0);
      const key = lineKey(o.name, sku, supplier);
      const prev = desired.get(key);
      desired.set(key, { order: o.name, sku, supplier, title: li.title, qty: (prev?.qty || 0) + qty });
    }
  }
  return { desired, seenOrders, skipped };
}

// Compare what the ledger says was already counted with what should be counted
// now. Returns the new ledger plus per-(supplier, sku) quantity deltas.
export function diffLedger(ledger, desired, seenOrders) {
  const next = new Map();
  const deltas = new Map();
  const addDelta = (supplier, sku, title, d) => {
    if (!d) return;
    const k = `${supplier}|${sku}`;
    const cur = deltas.get(k) || { supplier, sku, title, delta: 0 };
    cur.delta += d;
    deltas.set(k, cur);
  };
  for (const [key, old] of ledger) {
    const want = desired.get(key);
    if (want) continue; // handled below
    if (seenOrders.has(old.order)) {
      // Order still exists but this line is gone (tag moved suppliers, line removed): back it out.
      addDelta(old.supplier, old.sku, old.title, -old.qty);
    } else {
      next.set(key, old); // order not looked at this run: leave untouched
    }
  }
  for (const [key, want] of desired) {
    const old = ledger.get(key);
    addDelta(want.supplier, want.sku, want.title, want.qty - (old?.qty || 0));
    if (want.qty > 0) next.set(key, { ...want });
  }
  return { next, deltas: [...deltas.values()] };
}

export function orderNamesBySku(ledger) {
  const m = new Map();
  for (const e of ledger.values()) {
    if (e.qty <= 0) continue;
    const k = `${e.supplier}|${e.sku}`;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(e.order);
  }
  const out = new Map();
  for (const [k, set] of m) out.set(k, [...set].sort((a, b) => orderNumber(a) - orderNumber(b)).join(', '));
  return out;
}

export function buildRow(supplier, { sku, qty, title, orders, acddSku = '' }) {
  if (supplier === 'Asmodee') return [sku, qty, 'Each', '', title, orders, ''];
  if (supplier === 'Universal Dist') return [sku, qty, title, orders, ''];
  if (supplier === 'ACDD') return [acddSku, sku, qty, title, orders, ''];
  throw new Error(`unknown supplier ${supplier}`);
}

// rows: tab rows EXCLUDING the header; row i is sheet row i + 2.
// Returns edits that preserve every manual change: we only ever add or subtract.
export function planTabChanges(supplier, rows, deltas, names) {
  const t = TABS[supplier];
  const bySku = new Map();
  rows.forEach((r, i) => {
    const sku = String(r[t.skuCol] ?? '').trim();
    if (sku && !bySku.has(sku)) bySku.set(sku, { sheetRow: i + 2, qty: Number(r[t.qtyCol]) || 0 });
  });
  const updates = [], deletes = [], appends = [], missed = [];
  for (const d of deltas.filter(x => x.supplier === supplier)) {
    const existing = bySku.get(d.sku);
    const orders = names.get(`${supplier}|${d.sku}`) || '';
    if (existing) {
      const q = existing.qty + d.delta;
      if (q <= 0) deletes.push(existing.sheetRow);
      else {
        updates.push({ row: existing.sheetRow, col: t.qtyCol, value: q });
        updates.push({ row: existing.sheetRow, col: t.ordersCol, value: orders });
      }
    } else if (d.delta > 0) {
      appends.push({ sku: d.sku, qty: d.delta, title: d.title, orders });
    } else {
      missed.push(d); // a reduction for a row you already removed by hand: nothing to do
    }
  }
  return { updates, deletes, appends, missed };
}

export function binText(entries) {
  if (!entries || !entries.length) return '';
  return entries.filter(e => e.quantity > 0).map(e => `${e.binKey}(${e.quantity})`).join(', ');
}

export function binLookupBySku(bins) {
  const m = new Map();
  for (const [binKey, items] of Object.entries(bins)) {
    for (const it of items) {
      const sku = String(it.sku || '').trim();
      if (!sku) continue;
      if (!m.has(sku)) m.set(sku, []);
      m.get(sku).push({ binKey, quantity: Number(it.quantity) || 0 });
    }
  }
  return m;
}

// Rows for the "Order placed" archive from one supplier tab's body rows
// (header excluded). Blank-SKU rows are skipped.
export function archiveRows(supplier, rows, { lockDate, lastOrder }) {
  const t = TABS[supplier];
  const out = [];
  for (const r of rows) {
    const sku = String(r[t.skuCol] ?? '').trim();
    if (!sku) continue;
    out.push([
      lockDate, lastOrder, supplier, sku,
      supplier === 'ACDD' ? String(r[0] ?? '') : '',
      Number(r[t.qtyCol]) || 0,
      t.unitCol !== undefined ? String(r[t.unitCol] ?? '') : '',
      String(r[t.titleCol] ?? ''), String(r[t.ordersCol] ?? ''), String(r[t.binsCol] ?? ''),
    ]);
  }
  return out;
}

// Which orders count as "fully ordered" at close-cycle.
//
// Old rule (lock-supplier-order.py): tag an order only when EVERY unit it needs,
// across every supplier, has been ordered. In this model a whole cycle is
// submitted together, so an order is fully ordered when all of its counted lines
// are on the sheets. The one exception is you changing the sheets by hand: if the
// quantity left on a supplier tab for a SKU is LESS than what the ledger counted
// (you pulled units from the bins, or deleted the row), we cannot tell which
// orders those units belonged to, so every order containing that SKU is held back
// and reported instead of being tagged. Orders with no live lines (fully
// cancelled/refunded) are never tagged, the same guard the old code needed
// against Python's all([]) being True.
export function ordersToTag(ledger, tabRows, lastOrder) {
  const sheetQty = new Map();
  for (const supplier of Object.keys(TABS)) {
    const t = TABS[supplier];
    for (const r of tabRows[supplier] || []) {
      const sku = String(r[t.skuCol] ?? '').trim();
      if (!sku) continue;
      const k = `${supplier}|${sku}`;
      sheetQty.set(k, (sheetQty.get(k) || 0) + (Number(r[t.qtyCol]) || 0));
    }
  }
  const ledgerQty = new Map();
  for (const e of ledger.values()) {
    if (e.qty <= 0) continue;
    const k = `${e.supplier}|${e.sku}`;
    ledgerQty.set(k, (ledgerQty.get(k) || 0) + e.qty);
  }
  const short = new Map();
  for (const [k, q] of ledgerQty) if ((sheetQty.get(k) || 0) < q) short.set(k, { sheetQty: sheetQty.get(k) || 0, ledgerQty: q });

  const candidates = new Set();
  const held = [];
  const heldOrders = new Set();
  for (const e of ledger.values()) {
    if (e.qty <= 0 || !(orderNumber(e.order) <= lastOrder)) continue;
    candidates.add(e.order);
    const sh = short.get(`${e.supplier}|${e.sku}`);
    if (sh) { heldOrders.add(e.order); held.push({ order: e.order, sku: e.sku, supplier: e.supplier, ...sh }); }
  }
  const tag = [...candidates].filter(o => !heldOrders.has(o)).sort((a, b) => orderNumber(a) - orderNumber(b));
  held.sort((a, b) => orderNumber(a.order) - orderNumber(b.order) || a.sku.localeCompare(b.sku));
  return { tag, held };
}

// Decide what to do to one order, given its live Shopify state.
export function planOrderTag(info) {
  const tags = info.tags || [];
  if (info.cancelledAt) return { action: 'skip', reason: 'cancelled' };
  if (info.displayFulfillmentStatus === 'FULFILLED') return { action: 'skip', reason: 'already fulfilled' };
  if (etDateString(new Date(info.createdAt)) < TAGGING_FLOOR_DATE) {
    return { action: 'skip', reason: `placed before ${TAGGING_FLOOR_DATE}: handle manually` };
  }
  if (tags.includes(SUPPLIER_ORDER_TAG)) return { action: 'skip', reason: 'already tagged' };
  // Only genuine fulfillment-stage tags count as the order's current status.
  const current = tags.find(t => t.startsWith('dhg-status-') && !EMAIL_LIFECYCLE_TAGS.has(t));
  if (current === INVENTORY_QUEUED_TAG) return { action: 'skip', reason: 'inventory-queued (never downgraded)' };
  return { action: 'tag', remove: current || null };
}

// Per-order record of what was submitted, written at close-cycle so the tracker app
// can tell which ORDERS an invoice's units belong to. `Ordered` is how many of the
// order's units actually made it onto the sheet: the quantity left on a supplier tab
// is shared out oldest order first, so a row you reduced by hand leaves the newest
// orders under-ordered (they can then never be marked fully shipped).
export function orderLines(ledger, tabRows, lastOrder, { lockDate }) {
  const sheetQty = new Map();
  for (const supplier of Object.keys(TABS)) {
    const t = TABS[supplier];
    for (const r of tabRows[supplier] || []) {
      const sku = String(r[t.skuCol] ?? '').trim();
      if (!sku) continue;
      const k = `${supplier}|${sku}`;
      sheetQty.set(k, (sheetQty.get(k) || 0) + (Number(r[t.qtyCol]) || 0));
    }
  }
  const entries = [...ledger.values()]
    .filter(e => e.qty > 0 && orderNumber(e.order) <= lastOrder)
    .sort((a, b) => orderNumber(a.order) - orderNumber(b.order) || a.sku.localeCompare(b.sku));
  const out = [];
  for (const e of entries) {
    const k = `${e.supplier}|${e.sku}`;
    const left = sheetQty.get(k) || 0;
    const ordered = Math.min(e.qty, left);
    sheetQty.set(k, left - ordered);
    out.push([lockDate, lastOrder, e.order, e.supplier, e.sku, e.qty, ordered, 0, 0]);
  }
  return out;
}
