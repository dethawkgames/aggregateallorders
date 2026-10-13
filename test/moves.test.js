import test from 'node:test';
import assert from 'node:assert/strict';
import { runAggregation, closeCycle } from '../src/run.js';
import { parseMove } from '../src/logic.js';
import { MemoryStore, FakeShopify, seedConfig, tags, line, mk, et } from './helpers.js';

const at = (md, hm) => new Date(et(md, hm));
function setup(orders, { acdd = new Map([['A1', 'ACDD-A1'], ['B1', 'ACDD-B1']]) } = {}) {
  const store = new MemoryStore();
  seedConfig(store, { lastOrder: 700, lastCutoff: at('10-12', '15:00') });
  const shopify = new FakeShopify(orders);
  const deps = now => ({ store, shopify, now, loadBins: async () => ({}), loadAcddMap: async () => acdd });
  return { store, shopify, deps };
}
const base = () => [
  mk(700, et('10-12', '10:00'), [line('A1', 1, tags.A)]),
  mk(701, et('10-13', '03:00'), [line('A1', 2, tags.A), line('B1', 1, tags.B)]),
  mk(702, et('10-13', '04:00'), [line('A1', 3, tags.A)]),
];
const rowFor = (store, tab, skuCol, sku) => store.body(tab).find(r => r[skuCol] === sku);
const SUP = 'dhg-status-order-supplier';

test('parseMove', () => {
  assert.equal(parseMove('', 5), null);
  assert.deepEqual(parseMove('all', 5), { units: 5 });
  assert.deepEqual(parseMove('2', 5), { units: 2, clamped: false });
  assert.deepEqual(parseMove('9', 5), { units: 5, clamped: true });
  assert.equal(parseMove('0', 5), null);
  assert.match(parseMove('two', 5).error, /not a whole number/);
});

test('Move to ACDD column: partial move creates the ACDD row, orders stay taggable, lines show ACDD', async () => {
  const { store, shopify, deps } = setup(base());
  await runAggregation(deps(at('10-13', '07:00')));
  assert.equal(store.qty('Asmodee', 'A1'), 5);
  store.tabs.Asmodee[1][7] = '2';                    // move 2 of the 5 units
  const res = await closeCycle(deps(at('10-13', '15:00')), 702);
  assert.deepEqual(res.movedToAcdd.map(m => [m.sku, m.from, m.to, m.units]), [['A1', 'Asmodee', 'ACDD', 2]]);
  assert.deepEqual(res.tagging.tagged, ['#701', '#702']);       // nothing held back
  assert.deepEqual(res.tagging.heldBackBecauseSheetWasReducedByHand, []);
  const arch = store.body('Order placed');
  const a = arch.find(r => r[2] === 'Asmodee' && r[3] === 'A1');
  const c = arch.find(r => r[2] === 'ACDD' && r[3] === 'A1');
  assert.equal(a[5], 3); assert.equal(c[5], 2); assert.equal(c[4], 'ACDD-A1');
  // Oldest first: #701 (2 units) moves entirely to ACDD, #702 stays on Asmodee (3).
  const lines = store.body('Order Lines');
  const l701 = lines.find(r => r[2] === '#701' && r[4] === 'A1');
  const l702 = lines.find(r => r[2] === '#702' && r[4] === 'A1');
  assert.deepEqual([l701[3], l701[5], l701[6]], ['ACDD', 2, 2]);
  assert.deepEqual([l702[3], l702[5], l702[6]], ['Asmodee', 3, 3]);
  assert.equal(c[8], '#701'); assert.equal(a[8], '#702');       // Order Names refreshed
  assert.equal(store.body('Asmodee').length, 0);                 // tabs cleared as usual
  assert.ok(shopify.order('#701').tagList.includes(SUP));
});

test('Move to ACDD "all" removes the source row and adds to an existing ACDD row', async () => {
  const orders = [...base(), mk(703, et('10-13', '04:30'), [line('A1', 1, tags.C)])];
  const { store, deps } = setup(orders);
  await runAggregation(deps(at('10-13', '07:00')));
  assert.equal(store.qty('ACDD', 'A1'), 1);
  store.tabs.Asmodee[1][7] = 'all';
  const res = await closeCycle(deps(at('10-13', '15:00')), 703);
  assert.equal(res.movedToAcdd[0].units, 5);
  const arch = store.body('Order placed');
  assert.equal(arch.filter(r => r[3] === 'A1').length, 1);       // one ACDD row, Asmodee row gone
  assert.deepEqual([arch.find(r => r[3] === 'A1')[2], arch.find(r => r[3] === 'A1')[5]], ['ACDD', 6]);
});

test('move with no known ACDD SKU is skipped and left on the source supplier', async () => {
  const { store, deps } = setup(base(), { acdd: new Map() });
  await runAggregation(deps(at('10-13', '07:00')));
  store.tabs.Asmodee[1][7] = '2';
  const res = await closeCycle(deps(at('10-13', '15:00')), 702);
  assert.equal(res.movedToAcdd.length, 0);
  assert.match(res.moveSkipped[0].reason, /no ACDD SKU/);
  assert.equal(store.body('Order placed').find(r => r[3] === 'A1')[5], 5);
  assert.equal(res.tagging.tagged.length, 2);
});

test('Universal Dist rows can move too, and an oversize number moves the whole row', async () => {
  const { store, deps } = setup(base());
  await runAggregation(deps(at('10-13', '07:00')));
  const ud = store.tabs['Universal Dist'][1];
  assert.equal(ud[0], 'B1');
  ud[5] = '99';
  const res = await closeCycle(deps(at('10-13', '15:00')), 702);
  assert.equal(res.movedToAcdd[0].from, 'Universal Dist');
  assert.equal(res.movedToAcdd[0].units, 1);
  assert.match(res.movedToAcdd[0].note, /whole row/);
});

test('hand-moved rows (reduced on Asmodee, added on ACDD) are reconciled instead of holding orders back', async () => {
  const { store, shopify, deps } = setup(base());
  await runAggregation(deps(at('10-13', '07:00')));
  store.tabs.Asmodee[1][1] = 3;                                   // took 2 off Asmodee by hand
  store.tabs.ACDD.push(['ACDD-A1', 'A1', 2, 'A1', '', '']);        // and added them to ACDD
  const res = await closeCycle(deps(at('10-13', '15:00')), 702);
  assert.equal(res.movedToAcdd[0].reason.startsWith('reconciled'), true);
  assert.deepEqual(res.tagging.tagged, ['#701', '#702']);
  const lines = store.body('Order Lines');
  assert.equal(lines.find(r => r[2] === '#701' && r[4] === 'A1')[3], 'ACDD');
  assert.ok(lines.every(r => r[6] === r[5]));                     // everything fully ordered
  assert.ok(shopify.order('#702').tagList.includes(SUP));
});

test('a real shortfall with no surplus anywhere is still held back', async () => {
  const { store, deps } = setup(base());
  await runAggregation(deps(at('10-13', '07:00')));
  store.tabs.Asmodee[1][1] = 3;
  const res = await closeCycle(deps(at('10-13', '15:00')), 702);
  assert.equal(res.movedToAcdd.length, 0);
  assert.ok(res.tagging.heldBackBecauseSheetWasReducedByHand.length > 0);
});

test('close-cycle --dry-run previews moves and changes nothing', async () => {
  const { store, shopify, deps } = setup(base());
  await runAggregation(deps(at('10-13', '07:00')));
  store.tabs.Asmodee[1][7] = '2';
  const res = await closeCycle(deps(at('10-13', '15:00')), 702, { dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.movedToAcdd[0].units, 2);
  assert.equal(store.body('Order placed').length, 0);
  assert.equal(store.qty('Asmodee', 'A1'), 5);
  assert.equal(shopify.order('#701').tagList, undefined);
  assert.equal(store.cfg('Last Submitted Order'), 700);
});
