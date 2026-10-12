#!/usr/bin/env node
import { GoogleAuth, GoogleStore, loadServiceAccount } from './google.js';
import { Shopify } from './shopify.js';
import { loadBins, makeAcddMapLoader } from './external.js';
import { runAggregation, closeCycle } from './run.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith('--')));
const positional = rest.filter(a => !a.startsWith('--'));
const need = k => { if (!process.env[k]) throw new Error(`Missing env var ${k}`); return process.env[k]; };

async function main() {
  const auth = new GoogleAuth(loadServiceAccount());
  const store = new GoogleStore(auth, need('SHEET_ID'));
  const shopify = () => new Shopify({
    shop: process.env.SHOPIFY_SHOP, clientId: need('SHOPIFY_CLIENT_ID'), clientSecret: need('SHOPIFY_CLIENT_SECRET'),
  });
  const deps = () => ({ store, shopify: shopify(), loadBins, loadAcddMap: makeAcddMapLoader(auth), log: console.error });

  if (cmd === 'setup') {
    const lastOrder = parseInt(positional[0], 10);
    if (!lastOrder) throw new Error('Usage: setup <last submitted order number>');
    console.log(JSON.stringify(await store.setup({ lastOrder }), null, 2));
  } else if (cmd === 'run') {
    const r = await runAggregation(deps(), { dryRun: flags.has('--dry-run'), useNow: flags.has('--now'), force: flags.has('--force') });
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'close-cycle') {
    const r = await closeCycle(deps(), positional[0], { runNow: flags.has('--run-now') });
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.error('Usage:\n  setup <last submitted order>\n  run [--dry-run] [--now] [--force]\n  close-cycle <last submitted order> [--run-now]');
    process.exit(2);
  }
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
