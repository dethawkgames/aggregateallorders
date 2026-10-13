import test from 'node:test';
import assert from 'node:assert/strict';
import { runAggregation, closeCycle } from '../src/run.js';
import { planOrderTag } from '../src/logic.js';
import { MemoryStore, FakeShopify, seedConfig, tags, line, mk, et } from './helpers.js';

const at = (md, hm) => new Date(et(md, hm));
function setup(orders, lastOrder = 700) {
  const store = new MemoryStore();
  seedConfig(store, { lastOrder, lastCutoff: at('10-12', '15:00') });
  const shopify = new FakeShopify(orders);
  const deps = (now) => ({ store, shopify, now, loadBins: async () => ({}), loadAcddMap: async () => new Map() });
  return { store, shopify, deps };
}
const SUP = 'dhg-status-order-supplier';

test('close-cycle tags submitted orders (<= N) and swaps the old status tag; later orders untouched', async () => {
  const orders = [
    mk(700, et('10-12', '10:00'), [line('A1', 1, tags.A)]),
    mk(701, et('10-13', '03:00'), [line('A1', 2, tags.A), line('B1', 1, tags.B)]),
    mk(702, et('10-13', '05:00'), [line('B1', 1, tags.B)]),
    mk(703, et('10-13', '05:30'), [line('B1', 1, tags.B)]),
  ];
  const { shopify, deps } = setup(orders);
  await runAggregation(deps(at('10-13', '07:00')));
  const res = await closeCycle(deps(at('10-13', '15:00')), 702);
  assert.deepEqual(res.tagging.tagged, ['#701', '#702']);
  assert.deepEqual(shopify.order('#701').tagList, ['dhg-status-order-placed', SUP]); // email-lifecycle tag kept
  assert.equal(shopify.order('#703').tagList, undefined);
});

test('held back when the sheet was reduced below what the orders need; hand surplus is fine', async () => {
  const orders = [
    mk(700, et('10-12', '10:00'), [line('A1', 1, tags.A)]),
    mk(701, et('10-13', '03:00'), [line('A1', 2, tags.A)]),
    mk(702, et('10-13', '04:00'), [line('B1', 1, tags.B)]),
  ];
  const { store, shopify, deps } = setup(orders);
  await runAggregation(deps(at('10-13', '07:00')));
  store.tabs.Asmodee[1][1] = 1;            // hand-reduced A1 from 2 to 1
  store.tabs['Universal Dist'][1][1] = 5;  // hand surplus on B1
  const res = await closeCycle(deps(at('10-13', '15:00')), 702);
  assert.deepEqual(res.tagging.tagged, ['#702']);
  assert.equal(res.tagging.heldBackBecauseSheetWasReducedByHand[0].order, '#701');
  assert.equal(shopify.order('#701').tagList, undefined);
});

test('planOrderTag skip rules and tag swapping', () => {
  const base = { cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', createdAt: et('10-13', '03:00'), tags: [] };
  assert.equal(planOrderTag({ ...base, cancelledAt: 'x' }).reason, 'cancelled');
  assert.equal(planOrderTag({ ...base, displayFulfillmentStatus: 'FULFILLED' }).reason, 'already fulfilled');
  assert.match(planOrderTag({ ...base, createdAt: et('03-01', '03:00') }).reason, /before/);
  assert.equal(planOrderTag({ ...base, tags: [SUP] }).reason, 'already tagged');
  assert.match(planOrderTag({ ...base, tags: ['dhg-status-inventory-queued'] }).reason, /inventory-queued/);
  assert.deepEqual(planOrderTag({ ...base, tags: ['dhg-status-order-placed'] }), { action: 'tag', remove: null });
  assert.deepEqual(planOrderTag({ ...base, tags: ['dhg-status-order-placed', 'dhg-status-fulfillment-hold'] }), { action: 'tag', remove: 'dhg-status-fulfillment-hold' });
  assert.deepEqual(planOrderTag({ ...base, tags: ['vip'] }), { action: 'tag', remove: null });
});

test('missing write_orders scope aborts before anything changes; --no-tag skips tagging', async () => {
  const orders = [mk(700, et('10-12', '10:00'), [line('A1', 1, tags.A)]), mk(701, et('10-13', '03:00'), [line('A1', 2, tags.A)])];
  const { store, shopify, deps } = setup(orders);
  await runAggregation(deps(at('10-13', '07:00')));
  shopify.scopes = ['read_orders', 'read_products'];
  await assert.rejects(() => closeCycle(deps(at('10-13', '15:00')), 701), /write_orders.*Nothing was changed/s);
  assert.equal(store.body('Asmodee').length, 1);
  assert.equal(store.body('Order placed').length, 0);
  const res = await closeCycle(deps(at('10-13', '15:00')), 701, { skipTagging: true });
  assert.equal(res.closed, true);
  assert.equal(shopify.order('#701').tagList, undefined);
});

test('a tagging failure on one order is reported but does not stop the close', async () => {
  const orders = [
    mk(700, et('10-12', '10:00'), [line('A1', 1, tags.A)]),
    mk(701, et('10-13', '03:00'), [line('A1', 1, tags.A)]),
    mk(702, et('10-13', '04:00'), [line('A1', 1, tags.A)]),
  ];
  const { store, shopify, deps } = setup(orders);
  await runAggregation(deps(at('10-13', '07:00')));
  shopify.failTagFor = 'gid://shopify/Order/701';
  const res = await closeCycle(deps(at('10-13', '15:00')), 702);
  assert.deepEqual(res.tagging.tagged, ['#702']);
  assert.equal(res.tagging.errors[0].order, '#701');
  assert.equal(store.body('Asmodee').length, 0);
  assert.equal(store.cfg('Last Submitted Order'), 702);
});
