import test from 'node:test';
import assert from 'node:assert/strict';
import { supplierForTags, desiredFromOrders, diffLedger, planTabChanges, binText, binLookupBySku, orderNamesBySku } from '../src/logic.js';
import { cutoffsBetween, etToUtc, etDateString, etWeekday } from '../src/time.js';
import { tags, line, mk, et } from './helpers.js';

test('tag routing: first match wins, case-insensitive, untagged = null', () => {
  assert.equal(supplierForTags(['MAP', 'Asmodee']), 'Asmodee');
  assert.equal(supplierForTags(['ALLIANCE']), 'Universal Dist');
  assert.equal(supplierForTags(['acdd']), 'ACDD');
  assert.equal(supplierForTags(['asmodee', 'alliance']), 'Asmodee');
  assert.equal(supplierForTags(['alliance', 'acdd']), 'Universal Dist');
  assert.equal(supplierForTags(['boardgames']), null);
  assert.equal(supplierForTags(undefined), null);
  assert.equal(supplierForTags(['asmodee-exclusive']), null); // exact match only
});

test('6am ET boundaries handle EDT and EST', () => {
  assert.equal(etToUtc(2026, 10, 12, 6).toISOString(), '2026-10-12T10:00:00.000Z'); // EDT
  assert.equal(etToUtc(2026, 11, 2, 6).toISOString(), '2026-11-02T11:00:00.000Z');  // EST
  assert.equal(etWeekday(etToUtc(2026, 10, 12, 6)), 'Mon');
  assert.equal(etDateString(etToUtc(2026, 10, 12, 6)), '2026-10-12');
  const b = cutoffsBetween(new Date(et('10-05', '14:00')), new Date(et('10-08', '07:00')));
  assert.deepEqual(b.map(x => x.toISOString()), ['2026-10-06T10:00:00.000Z', '2026-10-07T10:00:00.000Z', '2026-10-08T10:00:00.000Z']);
  // exactly on the boundary counts; one second before does not
  assert.equal(cutoffsBetween(new Date(et('10-05', '14:00')), new Date('2026-10-06T10:00:00Z')).length, 1);
  assert.equal(cutoffsBetween(new Date(et('10-05', '14:00')), new Date('2026-10-06T09:59:59Z')).length, 0);
  // across the fall-back weekend
  const w = cutoffsBetween(new Date('2026-10-31T12:00:00Z'), new Date('2026-11-02T12:00:00Z'));
  assert.deepEqual(w.map(x => x.toISOString()), ['2026-11-01T11:00:00.000Z', '2026-11-02T11:00:00.000Z']);
});

test('desiredFromOrders: cancelled=0, refunded line=0, cutoff and last-order filters, skips counted', () => {
  const cutoff = new Date(et('10-06', '06:00'));
  const orders = [
    mk(100, et('10-05', '09:00'), [line('A1', 1, tags.A)]),                       // already submitted
    mk(101, et('10-05', '16:00'), [line('A1', 2, tags.A), line('B1', 1, tags.B), line('D1', 1, tags.D), line('', 1, tags.A)]),
    mk(102, et('10-06', '02:00'), [line('C1', 1, tags.C)], '2026-10-06T08:00:00Z'), // cancelled
    mk(103, et('10-06', '05:59'), [line('A2', 0, tags.A), line('A3', 3, tags.AB)]), // refunded line = 0
    mk(104, et('10-06', '06:01'), [line('A1', 5, tags.A)]),                       // after cutoff
  ];
  const { desired, seenOrders, skipped } = desiredFromOrders(orders, { lastOrder: 100, cutoff });
  assert.deepEqual([...seenOrders].sort(), ['#101', '#102', '#103']);
  assert.equal(desired.get('#101|A1|Asmodee').qty, 2);
  assert.equal(desired.get('#101|B1|Universal Dist').qty, 1);
  assert.equal(desired.get('#102|C1|ACDD').qty, 0);
  assert.equal(desired.get('#103|A2|Asmodee').qty, 0);
  assert.equal(desired.get('#103|A3|Asmodee').qty, 3);
  assert.equal(desired.has('#101|D1|Asmodee'), false);
  assert.deepEqual(skipped, { untagged: 1, noSku: 1 });
});

test('diffLedger: adds, increments, backs out, and moves between suppliers', () => {
  const ledger = new Map([
    ['#1|S|Asmodee', { order: '#1', sku: 'S', supplier: 'Asmodee', qty: 2, title: 'S' }],
    ['#2|T|ACDD', { order: '#2', sku: 'T', supplier: 'ACDD', qty: 1, title: 'T' }],
    ['#9|Z|ACDD', { order: '#9', sku: 'Z', supplier: 'ACDD', qty: 4, title: 'Z' }],
  ]);
  const desired = new Map([
    ['#1|S|Asmodee', { order: '#1', sku: 'S', supplier: 'Asmodee', qty: 3, title: 'S' }],  // +1
    ['#2|T|Universal Dist', { order: '#2', sku: 'T', supplier: 'Universal Dist', qty: 1, title: 'T' }], // tag moved
    ['#3|U|Asmodee', { order: '#3', sku: 'U', supplier: 'Asmodee', qty: 2, title: 'U' }],  // new
  ]);
  const { next, deltas } = diffLedger(ledger, desired, new Set(['#1', '#2', '#3']));
  const d = Object.fromEntries(deltas.map(x => [`${x.supplier}|${x.sku}`, x.delta]));
  assert.deepEqual(d, { 'Asmodee|S': 1, 'ACDD|T': -1, 'Universal Dist|T': 1, 'Asmodee|U': 2 });
  assert.equal(next.get('#9|Z|ACDD').qty, 4);           // order not looked at this run: untouched
  assert.equal(next.has('#2|T|ACDD'), false);
  assert.equal(orderNamesBySku(next).get('Asmodee|S'), '#1');
});

test('planTabChanges: preserves manual quantity, deletes at zero, appends new, ignores reductions for removed rows', () => {
  const rows = [['A1', 5, 'Each', '', 'A1', '#1', ''], ['A2', 1, 'Each', '', 'A2', '#2', '']];
  const names = new Map([['Asmodee|A1', '#1, #3']]);
  const plan = planTabChanges('Asmodee', rows, [
    { supplier: 'Asmodee', sku: 'A1', delta: 2, title: 'A1' },
    { supplier: 'Asmodee', sku: 'A2', delta: -1, title: 'A2' },
    { supplier: 'Asmodee', sku: 'A9', delta: 3, title: 'New' },
    { supplier: 'Asmodee', sku: 'A8', delta: -1, title: 'Gone' },
    { supplier: 'ACDD', sku: 'X', delta: 1, title: 'other tab' },
  ], names);
  assert.deepEqual(plan.updates, [{ row: 2, col: 1, value: 7 }, { row: 2, col: 5, value: '#1, #3' }]);
  assert.deepEqual(plan.deletes, [3]);
  assert.deepEqual(plan.appends, [{ sku: 'A9', qty: 3, title: 'New', orders: '' }]);
  assert.equal(plan.missed.length, 1);
});

test('bin text and lookup', () => {
  const m = binLookupBySku({ 7: [{ sku: 'A1', quantity: 2 }], shelf: [{ sku: 'A1', quantity: 1 }, { sku: 'B', quantity: 0 }] });
  assert.equal(binText(m.get('A1')), '7(2), shelf(1)');
  assert.equal(binText(m.get('B')), '');
  assert.equal(binText(undefined), '');
});
