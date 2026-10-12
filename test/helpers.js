import { TABS, CONFIG_TAB, LEDGER_TAB, LEDGER_HEADER, K } from '../src/config.js';

// In-memory stand-in for GoogleStore with identical semantics.
export class MemoryStore {
  constructor() {
    this.tabs = {};
    for (const [t, v] of Object.entries(TABS)) this.tabs[t] = [v.header.slice()];
    this.tabs[LEDGER_TAB] = [LEDGER_HEADER.slice()];
    this.tabs[CONFIG_TAB] = [['Setting', 'Value']];
  }
  async readTab(t) { return this.tabs[t].map(r => r.slice()); }
  async updateCells(t, cells) {
    for (const c of cells) {
      while (this.tabs[t].length < c.row) this.tabs[t].push([]);
      const row = this.tabs[t][c.row - 1];
      while (row.length <= c.col) row.push('');
      row[c.col] = typeof c.value === 'number' ? c.value : String(c.value);
    }
  }
  async deleteRows(t, rows) { for (const r of [...new Set(rows)].sort((a, b) => b - a)) this.tabs[t].splice(r - 1, 1); }
  async appendRows(t, rows) { for (const r of rows) this.tabs[t].push(r.map(v => (typeof v === 'number' ? v : String(v)))); }
  async clearBody(t) { this.tabs[t] = [this.tabs[t][0]]; }
  async writeBody(t, rows) { this.tabs[t] = [this.tabs[t][0], ...rows.map(r => r.map(v => (typeof v === 'number' ? v : String(v))))]; }
  // test helpers
  body(t) { return this.tabs[t].slice(1); }
  qty(supplier, sku) {
    const c = TABS[supplier];
    const r = this.body(supplier).find(x => String(x[c.skuCol]) === sku);
    return r ? Number(r[c.qtyCol]) : null;
  }
  orders(supplier, sku) {
    const c = TABS[supplier];
    const r = this.body(supplier).find(x => String(x[c.skuCol]) === sku);
    return r ? r[c.ordersCol] : null;
  }
  bins(supplier, sku) {
    const c = TABS[supplier];
    const r = this.body(supplier).find(x => String(x[c.skuCol]) === sku);
    return r ? (r[c.binsCol] ?? '') : null;
  }
  cfg(key) { const r = this.tabs[CONFIG_TAB].find(x => x[0] === key); return r ? r[1] : undefined; }
  setCfg(key, value) {
    const r = this.tabs[CONFIG_TAB].find(x => x[0] === key);
    if (r) r[1] = value; else this.tabs[CONFIG_TAB].push([key, value]);
  }
}

export function seedConfig(store, { lastOrder, lastCutoff, override = '' }) {
  store.setCfg(K.lastOrder, lastOrder);
  store.setCfg(K.status, 'Collecting');
  store.setCfg(K.lastCutoff, lastCutoff.toISOString());
  store.setCfg(K.override, override);
  store.setCfg(K.lastRun, '');
}

export class FakeShopify {
  constructor(orders = []) { this.orders = orders; }
  async getOrderCreatedAt(num) {
    const o = this.orders.find(x => x.name === `#${num}`);
    if (!o) throw new Error(`Order #${num} not found in Shopify`);
    return o.createdAt;
  }
  async fetchOrders(since) { return this.orders.filter(o => o.createdAt >= since).map(o => JSON.parse(JSON.stringify(o))); }
  order(name) { return this.orders.find(o => o.name === name); }
}

export const tags = {
  A: ['allstore', 'asmodee', 'MAP'],       // -> Asmodee
  B: ['Alliance', 'boardgames'],            // -> Universal Dist
  C: ['ACDD'],                              // -> ACDD
  D: ['boardgames'],                        // untagged -> skipped
  AB: ['asmodee', 'alliance'],              // both -> Asmodee (first match)
};
export const line = (sku, qty, tg, title = sku) => ({ sku, title, qty, tags: tg, productId: `gid://shopify/Product/${sku}` });
// ET wall time (EDT, UTC-4, valid for dates before Nov 1 2026) -> ISO
export const et = (md, hm) => new Date(`2026-${md}T${hm}:00-04:00`).toISOString();
export const mk = (num, createdAt, lines, cancelledAt = null) => ({ name: `#${num}`, createdAt, cancelledAt, lines });
