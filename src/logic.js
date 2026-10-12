// Pure logic: no network, no sheet access. Everything here is unit-tested.
import { SUPPLIER_TAGS, TABS } from './config.js';

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
