// One aggregation run. Dependencies are injected so the whole thing can be
// tested against an in-memory sheet and fake Shopify.
import { TABS, SUPPLIERS, CONFIG_TAB, LEDGER_TAB, LEDGER_HEADER, ARCHIVE_TAB, LINES_TAB, SUPPLIER_ORDER_TAG, K } from './config.js';
import { cutoffsBetween, etDateString, etWeekday } from './time.js';
import {
  desiredFromOrders, diffLedger, orderNamesBySku, buildRow, planTabChanges,
  binText, binLookupBySku, orderNumber, archiveRows, ordersToTag, planOrderTag, orderLines, applyMoves, moveRequests,
} from './logic.js';

export async function readConfig(store) {
  const rows = await store.readTab(CONFIG_TAB);
  const cfg = {};
  for (const r of rows.slice(1)) if (r[0]) cfg[String(r[0]).trim()] = r[1] ?? '';
  return cfg;
}

export async function writeConfig(store, values) {
  const rows = await store.readTab(CONFIG_TAB);
  const updates = [], appends = [];
  let next = rows.length + 1;
  for (const [key, value] of Object.entries(values)) {
    const idx = rows.findIndex((r, i) => i > 0 && String(r[0] ?? '').trim() === key);
    if (idx >= 0) updates.push({ row: idx + 1, col: 1, value });
    else { appends.push([key, value]); next++; }
  }
  if (updates.length) await store.updateCells(CONFIG_TAB, updates);
  if (appends.length) await store.appendRows(CONFIG_TAB, appends);
}

export function readLedger(rows) {
  const ledger = new Map();
  for (const r of rows.slice(1)) {
    if (!r[0] || !r[1]) continue;
    const [order, sku, supplier, qty, title] = r;
    ledger.set(`${order}|${sku}|${supplier}`, { order, sku, supplier, qty: Number(qty) || 0, title: title || '' });
  }
  return ledger;
}

// Which 6:00 am boundary this run processes up to, and whether it ends the cycle.
export function decideCutoff({ cfg, now, useNow }) {
  const lastCutoff = new Date(cfg[K.lastCutoff]);
  if (Number.isNaN(lastCutoff.getTime())) throw new Error(`Config "${K.lastCutoff}" is missing or not a date`);
  if (useNow) return { cutoff: now, freeze: false, lastCutoff };
  const bounds = cutoffsBetween(lastCutoff, now);
  if (!bounds.length) return { cutoff: lastCutoff, freeze: false, lastCutoff };
  const override = String(cfg[K.override] || '').trim();
  const isSubmissionDay = b => (override ? etDateString(b) === override : etWeekday(b) === 'Mon');
  const hit = bounds.find(isSubmissionDay);
  // Stop AT the first submission-day boundary even if a run was missed, so
  // orders placed after 6:00 am on submission day never leak into this cycle.
  if (hit) return { cutoff: hit, freeze: true, lastCutoff };
  return { cutoff: bounds[bounds.length - 1], freeze: false, lastCutoff };
}

export async function runAggregation(deps, opts = {}) {
  const { store, shopify, loadBins, loadAcddMap, now = new Date(), log = () => {} } = deps;
  const dryRun = !!opts.dryRun;

  const cfg = await readConfig(store);
  const lastOrder = parseInt(cfg[K.lastOrder], 10);
  if (!lastOrder) throw new Error(`Config "${K.lastOrder}" is missing`);
  if (String(cfg[K.status]).trim() === 'Frozen' && !opts.force) {
    return { skipped: 'Cycle is frozen (waiting for close-cycle). Nothing changed.' };
  }

  const { cutoff, freeze, lastCutoff } = decideCutoff({ cfg, now, useNow: !!opts.useNow });

  const sinceISO = await shopify.getOrderCreatedAt(lastOrder);
  const orders = await shopify.fetchOrders(sinceISO);
  const { desired, seenOrders, skipped } = desiredFromOrders(orders, { lastOrder, cutoff });

  const ledger = readLedger(await store.readTab(LEDGER_TAB));
  const { next, deltas } = diffLedger(ledger, desired, seenOrders);
  const names = orderNamesBySku(next);

  const summary = {
    cutoff: cutoff.toISOString(), freezeAfterThisRun: freeze, dryRun,
    ordersConsidered: seenOrders.size, skipped,
    suppliers: {},
  };

  let acddMap = null;
  const tabRows = {};
  for (const supplier of SUPPLIERS) tabRows[supplier] = (await store.readTab(supplier)).slice(1);

  const plans = {};
  for (const supplier of SUPPLIERS) {
    const plan = planTabChanges(supplier, tabRows[supplier], deltas, names);
    plans[supplier] = plan;
    summary.suppliers[supplier] = {
      qtyUpdated: plan.updates.filter(u => u.col === TABS[supplier].qtyCol).length,
      rowsAdded: plan.appends.length,
      rowsRemoved: plan.deletes.length,
      reductionsForRowsYouRemoved: plan.missed.length,
    };
  }

  if (dryRun) { summary.deltas = deltas; return summary; }

  for (const supplier of SUPPLIERS) {
    const plan = plans[supplier];
    if (plan.updates.length) await store.updateCells(supplier, plan.updates);
    if (plan.deletes.length) await store.deleteRows(supplier, plan.deletes);
    if (plan.appends.length) {
      if (supplier === 'ACDD' && !acddMap) acddMap = await loadAcddMap(plan.appends.map(a => a.sku), shopify).catch(e => { log(`ACDD SKU map unavailable: ${e.message}`); return new Map(); });
      await store.appendRows(supplier, plan.appends.map(a => buildRow(supplier, { ...a, acddSku: acddMap?.get(a.sku) || '' })));
    }
  }

  // Bin flag: refreshed for every row on every run, including rows you added by hand.
  let binRows = 0;
  try {
    const lookup = binLookupBySku(await loadBins());
    for (const supplier of SUPPLIERS) {
      const t = TABS[supplier];
      const rows = (await store.readTab(supplier)).slice(1);
      const updates = [];
      rows.forEach((r, i) => {
        const sku = String(r[t.skuCol] ?? '').trim();
        if (!sku) return;
        const want = binText(lookup.get(sku));
        if (String(r[t.binsCol] ?? '') !== want) updates.push({ row: i + 2, col: t.binsCol, value: want });
        if (want) binRows++;
      });
      if (updates.length) await store.updateCells(supplier, updates);
    }
    summary.rowsFlaggedInBins = binRows;
  } catch (e) {
    summary.binFlagError = e.message; // never fail the whole run over the advisory column
    log(`Bin flag skipped: ${e.message}`);
  }

  const ledgerRows = [...next.values()]
    .sort((a, b) => orderNumber(a.order) - orderNumber(b.order) || a.sku.localeCompare(b.sku))
    .map(e => [e.order, e.sku, e.supplier, e.qty, e.title]);
  await store.writeBody(LEDGER_TAB, ledgerRows);

  const newLastCutoff = cutoff > lastCutoff ? cutoff : lastCutoff;
  await writeConfig(store, {
    [K.lastCutoff]: newLastCutoff.toISOString(),
    [K.lastRun]: now.toISOString(),
    ...(freeze ? { [K.status]: 'Frozen' } : {}),
  });
  if (freeze) summary.note = 'Submission day cutoff reached: cycle is now FROZEN. Edit and submit your orders, then run close-cycle with the last order number you submitted.';
  return summary;
}

// Apply the dhg-status-order-supplier tag the way the old Lock & Order did:
// remove the order's current fulfillment-stage tag (never the email-lifecycle
// ones), then add the new one. Per-order problems are collected, not thrown.
export async function applyOrderTags(shopify, names, log = () => {}) {
  const result = { tagged: [], skipped: [], errors: [] };
  if (!names.length) return result;
  const infos = await shopify.getOrdersForTagging(names);
  const byName = new Map(infos.map(i => [i.name, i]));
  for (const name of names) {
    const info = byName.get(name);
    if (!info) { result.errors.push({ order: name, error: 'Order not found in Shopify' }); continue; }
    const plan = planOrderTag(info);
    if (plan.action === 'skip') { result.skipped.push({ order: name, reason: plan.reason }); continue; }
    try {
      if (plan.remove) await shopify.tagsRemove(info.id, [plan.remove]);
      await shopify.tagsAdd(info.id, [SUPPLIER_ORDER_TAG]);
      result.tagged.push(name);
    } catch (e) {
      log(`Tagging ${name} failed: ${e.message}`);
      result.errors.push({ order: name, error: e.message });
    }
  }
  return result;
}

export async function closeCycle(deps, lastSubmittedOrder, opts = {}) {
  const { store, shopify, loadAcddMap, now = new Date() } = deps;
  const n = parseInt(lastSubmittedOrder, 10);
  if (!n) throw new Error('Pass the last submitted order number, e.g. 5990');
  const createdAt = await shopify.getOrderCreatedAt(n); // throws if the order does not exist

  // Before changing anything: make sure we are actually allowed to tag orders, so a
  // missing permission can never leave the cycle half-closed.
  const tagging = !opts.skipTagging;
  if (tagging) {
    const scopes = await shopify.accessScopes();
    if (!scopes.includes('write_orders')) {
      throw new Error('The Shopify app is missing the write_orders scope, which is needed to tag orders ' +
        `${SUPPLIER_ORDER_TAG}. Nothing was changed. Add write_orders (and approve it on the store), or run with --no-tag.`);
    }
  }
  const rawLedger = readLedger(await store.readTab(LEDGER_TAB));
  const rawRows = {};
  for (const supplier of SUPPLIERS) rawRows[supplier] = (await store.readTab(supplier)).slice(1);

  // Units you moved to ACDD (Move to ACDD column, or rows moved by hand) are applied here, in
  // memory, so the live tabs stay untouched until everything below has been verified.
  const moveSkus = moveRequests(rawRows).filter(r => !r.error).map(r => r.sku);
  let acddMap = new Map();
  if (moveSkus.length && loadAcddMap) {
    acddMap = await loadAcddMap(moveSkus, shopify).catch(e => { deps.log?.(`ACDD SKU map unavailable: ${e.message}`); return new Map(); });
  }
  const moved = applyMoves(rawLedger, rawRows, { acddMap });
  const ledger = moved.ledger, tabRows = moved.tabRows;
  const plan = ordersToTag(ledger, tabRows, n);

  const meta = { lockDate: etDateString(now), lastOrder: n };
  const archived = [];
  for (const supplier of SUPPLIERS) archived.push(...archiveRows(supplier, tabRows[supplier], meta));
  const lines = orderLines(ledger, tabRows, n, meta);

  if (opts.dryRun) {
    return {
      dryRun: true, lastSubmittedOrder: n, wouldCopyToOrderPlaced: archived.length, wouldRecordOrderLines: lines.length,
      movedToAcdd: moved.moves, moveSkipped: moved.skipped,
      wouldTag: tagging ? plan.tag : 'tagging disabled (--no-tag)', heldBackBecauseSheetWasReducedByHand: plan.held,
    };
  }

  // Copy what was ordered into "Order placed" BEFORE anything is cleared. If the
  // copy fails or cannot be verified, we stop here and every tab is left as it was.
  if (archived.length) {
    const before = (await store.readTab(ARCHIVE_TAB)).length;
    await store.appendRows(ARCHIVE_TAB, archived);
    const after = (await store.readTab(ARCHIVE_TAB)).length;
    if (after - before !== archived.length) {
      throw new Error(`"${ARCHIVE_TAB}" copy could not be verified (expected +${archived.length} rows, saw +${after - before}). Nothing was cleared.`);
    }
  }

  // Per-order lines for the tracker app (which orders each unit belongs to). Same rule:
  // verified before anything is cleared.
  if (lines.length) {
    const before = (await store.readTab(LINES_TAB)).length;
    await store.appendRows(LINES_TAB, lines);
    const after = (await store.readTab(LINES_TAB)).length;
    if (after - before !== lines.length) {
      throw new Error(`"${LINES_TAB}" write could not be verified (expected +${lines.length} rows, saw +${after - before}). The Order placed copy was already made; nothing was cleared.`);
    }
  }

  // Tag now that the order record is safely copied. Failures here are reported, never fatal.
  let tagResult = { skipped: [], tagged: [], errors: [] };
  if (tagging) {
    try { tagResult = await applyOrderTags(shopify, plan.tag, deps.log); }
    catch (e) { tagResult = { tagged: [], skipped: [], errors: [{ order: '(all)', error: e.message }] }; }
  }

  for (const supplier of SUPPLIERS) await store.clearBody(supplier);
  await store.clearBody(LEDGER_TAB);
  await writeConfig(store, {
    [K.lastOrder]: n,
    [K.status]: 'Collecting',
    [K.lastCutoff]: now.toISOString(),
    [K.override]: '',
    [K.lastRun]: now.toISOString(),
  });
  const result = { closed: true, lastSubmittedOrder: n, lastSubmittedOrderCreatedAt: createdAt, rowsCopiedToOrderPlaced: archived.length, orderLinesRecorded: lines.length, movedToAcdd: moved.moves, moveSkipped: moved.skipped };
  result.tagging = tagging
    ? { tag: SUPPLIER_ORDER_TAG, tagged: tagResult.tagged, skipped: tagResult.skipped, errors: tagResult.errors, heldBackBecauseSheetWasReducedByHand: plan.held }
    : { skipped: 'tagging disabled (--no-tag)' };
  if (opts.runNow) result.run = await runAggregation({ ...deps, now }, { useNow: true });
  return result;
}
