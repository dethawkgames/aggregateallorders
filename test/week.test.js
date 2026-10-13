import test from 'node:test';
import assert from 'node:assert/strict';
import { runAggregation, closeCycle } from '../src/run.js';
import { K } from '../src/config.js';
import { MemoryStore, FakeShopify, seedConfig, tags, line, mk, et } from './helpers.js';

const at = (md, hm) => new Date(et(md, hm));
const bins = { 7: [{ sku: 'A1', quantity: 2 }], shelf: [{ sku: 'B1', quantity: 1 }] };

function setup({ orders, lastOrder = 100, lastCutoff = at('10-05', '14:00'), override = '', binsFn } = {}) {
  const store = new MemoryStore();
  seedConfig(store, { lastOrder, lastCutoff, override });
  const shopify = new FakeShopify(orders);
  const deps = (now) => ({
    store, shopify, now, loadBins: binsFn || (async () => bins),
    loadAcddMap: async () => new Map([['C1', 'ACDD-C1']]),
  });
  return { store, shopify, deps };
}

const baseOrders = () => [
  mk(100, et('10-05', '09:00'), [line('A1', 1, tags.A)]),                                    // submitted last cycle
  mk(101, et('10-05', '16:00'), [line('A1', 2, tags.A, 'Alpha'), line('B1', 1, tags.B), line('D1', 1, tags.D)]),
  mk(102, et('10-06', '02:00'), [line('A1', 1, tags.A), line('C1', 2, tags.C)]),
  mk(103, et('10-06', '09:00'), [line('A1', 1, tags.A), line('B1', 3, tags.B)]),            // after Tue 6am
];

test('a normal week: daily adds, idempotent reruns, manual edits kept, late cancel/refund subtract', async () => {
  const { store, shopify, deps } = setup({ orders: baseOrders() });

  // Tuesday 7am: covers 101 and 102 only
  let r = await runAggregation(deps(at('10-06', '07:00')));
  assert.equal(r.ordersConsidered, 2);
  assert.equal(store.qty('Asmodee', 'A1'), 3);
  assert.equal(store.orders('Asmodee', 'A1'), '#101, #102');
  assert.equal(store.qty('Universal Dist', 'B1'), 1);
  assert.equal(store.qty('ACDD', 'C1'), 2);
  assert.equal(store.body('ACDD')[0][0], 'ACDD-C1');             // ACDD SKU mapped
  assert.equal(store.body('Asmodee')[0][2], 'Each');
  assert.equal(store.qty('Asmodee', 'D1'), null);                // untagged skipped
  assert.equal(store.bins('Asmodee', 'A1'), '7(2)');             // in-bins flag
  assert.equal(store.bins('Universal Dist', 'B1'), 'shelf(1)');

  // Rerunning must change nothing in the supplier tabs or ledger
  const snap = JSON.stringify([store.tabs.Asmodee, store.tabs['Universal Dist'], store.tabs.ACDD, store.tabs.Ledger]);
  await runAggregation(deps(at('10-06', '07:30')));
  await runAggregation(deps(at('10-06', '09:00')));
  assert.equal(JSON.stringify([store.tabs.Asmodee, store.tabs['Universal Dist'], store.tabs.ACDD, store.tabs.Ledger]), snap);

  // You add 4 more A1 by hand, then Wednesday's run adds order 103
  const c = store.tabs.Asmodee.findIndex(r => r[0] === 'A1');
  store.tabs.Asmodee[c][1] = 7;
  r = await runAggregation(deps(at('10-07', '07:00')));
  assert.equal(store.qty('Asmodee', 'A1'), 8);                   // 7 manual-adjusted + 1
  assert.equal(store.qty('Universal Dist', 'B1'), 4);

  // Order 101 is cancelled, and 103's B1 line is refunded, before you lock
  shopify.order('#101').cancelledAt = '2026-10-07T15:00:00Z';
  shopify.order('#103').lines.find(l => l.sku === 'B1').qty = 0;
  r = await runAggregation(deps(at('10-08', '07:00')));
  assert.equal(store.qty('Asmodee', 'A1'), 6);                   // 8 - 2 (cancelled 101)
  assert.equal(store.qty('Universal Dist', 'B1'), null);         // 4 - 1 - 3 -> row removed
  assert.equal(store.orders('Asmodee', 'A1'), '#102, #103');
});

test('submission Monday: orders before 6am are in, later ones wait; freeze; close-cycle restarts after the last submitted order', async () => {
  const orders = [
    mk(199, et('10-09', '10:00'), [line('A1', 9, tags.A)]),
    mk(200, et('10-09', '20:00'), [line('A1', 1, tags.A)]),
    mk(201, et('10-12', '05:00'), [line('A1', 2, tags.A), line('B1', 1, tags.B)]),   // before Monday 6am
    mk(202, et('10-12', '09:00'), [line('A1', 4, tags.A)]),                           // after Monday 6am
    mk(203, et('10-12', '22:00'), [line('C1', 1, tags.C)]),
  ];
  const { store, deps } = setup({ orders, lastOrder: 199, lastCutoff: at('10-11', '06:00') });

  let r = await runAggregation(deps(at('10-12', '06:15')));
  assert.equal(r.freezeAfterThisRun, true);
  assert.equal(store.qty('Asmodee', 'A1'), 3);                   // 200 + 201, not 202
  assert.equal(store.cfg(K.status), 'Frozen');

  // Frozen: later runs change nothing, even with new orders around
  r = await runAggregation(deps(at('10-13', '07:00')));
  assert.match(r.skipped, /frozen/i);
  assert.equal(store.qty('Asmodee', 'A1'), 3);

  // You add an item by hand and submit; the last order you submitted was #201
  store.tabs.Asmodee.push(['HAND1', 1, 'Each', '', 'Hand added', '', '']);
  const res = await closeCycle(deps(at('10-12', '15:00')), 201);
  assert.equal(res.closed, true);
  assert.equal(store.body('Asmodee').length, 0);
  assert.equal(store.body('Ledger').length, 0);
  assert.equal(store.cfg(K.status), 'Collecting');
  assert.equal(store.cfg(K.lastOrder), 201);

  // Tuesday 6am run starts at #202 (and 203 is after Mon 22:00? no, before Tue 6am so it is in)
  r = await runAggregation(deps(at('10-13', '07:00')));
  assert.equal(store.qty('Asmodee', 'A1'), 4);                   // only #202
  assert.equal(store.qty('ACDD', 'C1'), 1);                      // #203
  assert.equal(store.qty('Universal Dist', 'B1'), null);         // #201 was submitted
  assert.equal(r.freezeAfterThisRun, false);
});

test('close-cycle --run-now picks up orders placed after the cutoff right away', async () => {
  const orders = [
    mk(300, et('10-11', '10:00'), [line('A1', 9, tags.A)]),
    mk(301, et('10-12', '05:00'), [line('A1', 1, tags.A)]),
    mk(302, et('10-12', '09:00'), [line('A1', 2, tags.A)]),
  ];
  const { store, deps } = setup({ orders, lastOrder: 300, lastCutoff: at('10-11', '06:00') });
  await runAggregation(deps(at('10-12', '06:05')));
  assert.equal(store.qty('Asmodee', 'A1'), 1);
  const res = await closeCycle(deps(at('10-12', '20:00')), 301, { runNow: true });
  assert.equal(store.qty('Asmodee', 'A1'), 2);                   // #302 in immediately
  assert.equal(res.run.freezeAfterThisRun, false);
  assert.equal(store.cfg(K.status), 'Collecting');
  // and the next scheduled run does not double count it
  await runAggregation(deps(at('10-13', '07:00')));
  assert.equal(store.qty('Asmodee', 'A1'), 2);
});

test('holiday week: override moves the freeze from Monday to Tuesday', async () => {
  const orders = [
    mk(399, et('10-11', '10:00'), [line('A1', 9, tags.A)]),
    mk(400, et('10-12', '04:00'), [line('A1', 1, tags.A)]),
    mk(401, et('10-12', '10:00'), [line('A1', 1, tags.A)]),           // Mon after 6am (holiday)
    mk(402, et('10-13', '05:00'), [line('A1', 1, tags.A)]),           // Tue before 6am
    mk(403, et('10-13', '08:00'), [line('A1', 1, tags.A)]),           // Tue after 6am
  ];
  const { store, deps } = setup({ orders, lastOrder: 399, lastCutoff: at('10-11', '06:00'), override: '2026-10-13' });
  let r = await runAggregation(deps(at('10-12', '06:10')));          // Monday: no freeze
  assert.equal(r.freezeAfterThisRun, false);
  assert.equal(store.cfg(K.status), 'Collecting');
  assert.equal(store.qty('Asmodee', 'A1'), 1);
  r = await runAggregation(deps(at('10-13', '06:10')));              // Tuesday: freeze
  assert.equal(r.freezeAfterThisRun, true);
  assert.equal(store.qty('Asmodee', 'A1'), 3);                       // 400, 401, 402
  assert.equal(store.cfg(K.status), 'Frozen');
});

test('a missed run never lets post-6am submission-day orders leak in', async () => {
  const orders = [
    mk(499, et('10-11', '10:00'), [line('A1', 9, tags.A)]),
    mk(500, et('10-12', '05:00'), [line('A1', 1, tags.A)]),
    mk(501, et('10-12', '12:00'), [line('A1', 5, tags.A)]),
    mk(502, et('10-13', '03:00'), [line('A1', 7, tags.A)]),
  ];
  const { store, deps } = setup({ orders, lastOrder: 499, lastCutoff: at('10-11', '06:00') });
  // The scheduler was down Monday; first run is Wednesday
  const r = await runAggregation(deps(at('10-14', '09:00')));
  assert.equal(r.freezeAfterThisRun, true);
  assert.equal(store.qty('Asmodee', 'A1'), 1);                       // only #500
});

test('tag moves, bin tracker outage, dry run writes nothing', async () => {
  const orders = [mk(599, et('10-11', '10:00'), [line('A1', 9, tags.A)]), mk(600, et('10-12', '04:00'), [line('A1', 2, tags.A), line('C1', 1, tags.C)])];
  const { store, shopify, deps } = setup({ orders, lastOrder: 599, lastCutoff: at('10-11', '06:00'), binsFn: async () => { throw new Error('tracker down'); } });

  const before = JSON.stringify(store.tabs);
  const dry = await runAggregation(deps(at('10-12', '07:00')), { dryRun: true });
  assert.equal(JSON.stringify(store.tabs), before);
  assert.equal(dry.suppliers.Asmodee.rowsAdded, 1);

  const r = await runAggregation(deps(at('10-12', '07:00')));
  assert.match(r.binFlagError, /tracker down/);                      // run still succeeded
  assert.equal(store.qty('Asmodee', 'A1'), 2);

  // Product C1 gets retagged from acdd to alliance before the next cycle run
  store.setCfg(K.status, 'Collecting');
  shopify.order('#600').lines.find(l => l.sku === 'C1').tags = tags.B;
  await runAggregation(deps(at('10-12', '08:00')), { useNow: true });
  assert.equal(store.qty('ACDD', 'C1'), null);
  assert.equal(store.qty('Universal Dist', 'C1'), 1);
});

test('closeCycle rejects an order number Shopify does not know, before clearing anything', async () => {
  const { store, deps } = setup({ orders: baseOrders() });
  await runAggregation(deps(at('10-06', '07:00')));
  const before = JSON.stringify(store.tabs);
  await assert.rejects(() => closeCycle(deps(at('10-06', '08:00')), 99999), /not found/);
  assert.equal(JSON.stringify(store.tabs), before);
});

test('close-cycle copies every row (including hand-added ones) to "Order placed" before clearing; appends, never overwrites', async () => {
  const orders = [
    mk(700, et('10-12', '10:00'), [line('A1', 1, tags.A)]),
    mk(701, et('10-13', '03:00'), [line('A1', 2, tags.A, 'Alpha'), line('B1', 1, tags.B, 'Beta'), line('C1', 3, tags.C, 'Gamma')]),
    mk(702, et('10-19', '03:00'), [line('A1', 1, tags.A, 'Alpha')]),
  ];
  const { store, deps } = setup({ orders, lastOrder: 700, lastCutoff: at('10-12', '15:00') });
  await runAggregation(deps(at('10-13', '07:00')));
  store.tabs.Asmodee.push(['HAND1', 4, 'Case', '', 'Hand added', '', '']);               // you add a row by hand
  const res = await closeCycle(deps(at('10-13', '15:00')), 701);
  assert.equal(res.rowsCopiedToOrderPlaced, 4);
  const op = store.body('Order placed');
  assert.equal(op.length, 4);
  const a1 = op.find(r => r[3] === 'A1');
  assert.deepEqual(a1.slice(0, 3), ['2026-10-13', 701, 'Asmodee']);
  assert.equal(a1[5], 2);
  assert.equal(a1[6], 'Each');
  assert.equal(a1[8], '#701');
  assert.equal(op.find(r => r[3] === 'HAND1')[6], 'Case');                                // unit preserved
  const c1 = op.find(r => r[3] === 'C1');
  assert.equal(c1[2], 'ACDD'); assert.equal(c1[4], 'ACDD-C1'); assert.equal(c1[5], 3);
  assert.equal(store.body('Asmodee').length, 0);                                           // working tabs cleared afterwards

  // Next cycle: a second lock appends below the first; the first block is untouched
  await runAggregation(deps(at('10-19', '07:00')), {});
  const res2 = await closeCycle(deps(at('10-19', '15:00')), 702);
  assert.equal(res2.rowsCopiedToOrderPlaced, 1);
  const op2 = store.body('Order placed');
  assert.equal(op2.length, 5);
  assert.deepEqual(op2.slice(0, 4), op);
  assert.deepEqual(op2[4].slice(0, 4), ['2026-10-19', 702, 'Asmodee', 'A1']);

  // Closing again with nothing on the sheets copies nothing and does not duplicate
  const res3 = await closeCycle(deps(at('10-19', '16:00')), 702);
  assert.equal(res3.rowsCopiedToOrderPlaced, 0);
  assert.equal(store.body('Order placed').length, 5);
});

test('if the copy to "Order placed" fails, nothing is cleared and the cycle stays open', async () => {
  const orders = [
    mk(800, et('10-12', '10:00'), [line('A1', 1, tags.A)]),
    mk(801, et('10-13', '03:00'), [line('A1', 2, tags.A)]),
  ];
  const { store, deps } = setup({ orders, lastOrder: 800, lastCutoff: at('10-12', '15:00') });
  await runAggregation(deps(at('10-13', '07:00')));
  const before = JSON.stringify(store.tabs);
  const realAppend = store.appendRows.bind(store);
  store.appendRows = async (tab, rows) => { if (tab === 'Order placed') throw new Error('Sheets down'); return realAppend(tab, rows); };
  await assert.rejects(() => closeCycle(deps(at('10-13', '15:00')), 801), /Sheets down/);
  assert.equal(JSON.stringify(store.tabs), before);
  assert.equal(store.cfg(K.lastOrder), 800);

  // A copy that silently drops rows is caught too
  store.appendRows = async (tab, rows) => { if (tab === 'Order placed') return; return realAppend(tab, rows); };
  await assert.rejects(() => closeCycle(deps(at('10-13', '15:00')), 801), /could not be verified/);
  assert.equal(JSON.stringify(store.tabs), before);
});
