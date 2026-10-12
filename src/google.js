import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import { CONFIG_TAB, LEDGER_TAB, LEDGER_HEADER, TABS, K } from './config.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export function loadServiceAccount(env = process.env) {
  if (env.GOOGLE_SA_KEY_FILE) {
    const j = JSON.parse(fs.readFileSync(env.GOOGLE_SA_KEY_FILE, 'utf8'));
    return { email: j.client_email, key: j.private_key };
  }
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY) {
    throw new Error('Set GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY, or GOOGLE_SA_KEY_FILE');
  }
  return { email: env.GOOGLE_SA_EMAIL, key: env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n') };
}

const colLetter = i => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

export class GoogleAuth {
  constructor(sa, scope = 'https://www.googleapis.com/auth/spreadsheets') {
    this.sa = sa; this.scope = scope; this.token = null; this.exp = 0;
  }
  async get() {
    if (this.token && Date.now() < this.exp - 60_000) return this.token;
    const assertion = jwt.sign({ scope: this.scope }, this.sa.key, {
      algorithm: 'RS256', issuer: this.sa.email, audience: 'https://oauth2.googleapis.com/token', expiresIn: '1h',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    this.token = j.access_token; this.exp = Date.now() + (j.expires_in || 3600) * 1000;
    return this.token;
  }
}

async function call(auth, method, url, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await auth.get()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`Sheets ${method} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error(`Sheets ${method} failed after retries`);
}

// The Store interface the run logic depends on. Rows are 1-based, columns 0-based.
export class GoogleStore {
  constructor(auth, spreadsheetId) { this.auth = auth; this.id = spreadsheetId; this.sheetIds = null; }

  async sheetId(tab) {
    if (!this.sheetIds) {
      const meta = await call(this.auth, 'GET', `${API}/${this.id}?fields=sheets.properties(sheetId,title)`);
      this.sheetIds = Object.fromEntries(meta.sheets.map(s => [s.properties.title, s.properties.sheetId]));
    }
    if (!(tab in this.sheetIds)) throw new Error(`Tab "${tab}" not found. Run setup first.`);
    return this.sheetIds[tab];
  }

  async readTab(tab) {
    const r = await call(this.auth, 'GET', `${API}/${this.id}/values/${encodeURIComponent(`'${tab}'`)}?majorDimension=ROWS`);
    return r.values || [];
  }

  async updateCells(tab, cells) {
    if (!cells.length) return;
    await call(this.auth, 'POST', `${API}/${this.id}/values:batchUpdate`, {
      valueInputOption: 'RAW',
      data: cells.map(c => ({ range: `'${tab}'!${colLetter(c.col)}${c.row}`, values: [[c.value]] })),
    });
  }

  async deleteRows(tab, rows) {
    if (!rows.length) return;
    const sheetId = await this.sheetId(tab);
    const requests = [...new Set(rows)].sort((a, b) => b - a).map(r => ({
      deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } },
    }));
    await call(this.auth, 'POST', `${API}/${this.id}:batchUpdate`, { requests });
  }

  async appendRows(tab, rows) {
    if (!rows.length) return;
    await call(this.auth, 'POST',
      `${API}/${this.id}/values/${encodeURIComponent(`'${tab}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: rows });
  }

  async clearBody(tab) {
    await call(this.auth, 'POST', `${API}/${this.id}/values/${encodeURIComponent(`'${tab}'!A2:Z`)}:clear`, {});
  }

  async writeBody(tab, rows) {
    await this.clearBody(tab);
    if (!rows.length) return;
    await call(this.auth, 'PUT',
      `${API}/${this.id}/values/${encodeURIComponent(`'${tab}'!A2`)}?valueInputOption=RAW`, { values: rows });
  }

  // One-time: create missing tabs, headers, formatting, and Config defaults.
  async setup({ lastOrder, now = new Date() }) {
    const meta = await call(this.auth, 'GET', `${API}/${this.id}?fields=sheets.properties(sheetId,title)`);
    const have = new Set(meta.sheets.map(s => s.properties.title));
    const want = [...Object.keys(TABS), CONFIG_TAB, LEDGER_TAB];
    const requests = want.filter(t => !have.has(t)).map(title => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }));
    if (requests.length) await call(this.auth, 'POST', `${API}/${this.id}:batchUpdate`, { requests });
    this.sheetIds = null;

    const headers = { ...Object.fromEntries(Object.entries(TABS).map(([k, v]) => [k, v.header])), [LEDGER_TAB]: LEDGER_HEADER, [CONFIG_TAB]: ['Setting', 'Value'] };
    for (const [tab, header] of Object.entries(headers)) {
      await call(this.auth, 'PUT', `${API}/${this.id}/values/${encodeURIComponent(`'${tab}'!A1`)}?valueInputOption=RAW`, { values: [header] });
    }
    const cfg = await this.readTab(CONFIG_TAB);
    const existing = new Set(cfg.slice(1).map(r => r[0]));
    const defaults = [
      [K.lastOrder, lastOrder], [K.status, 'Collecting'], [K.lastCutoff, now.toISOString()],
      [K.override, ''], [K.lastRun, ''],
    ].filter(([k]) => !existing.has(k));
    if (defaults.length) await this.appendRows(CONFIG_TAB, defaults);

    // Bold, frozen headers on every tab.
    const ids = await Promise.all(want.map(t => this.sheetId(t)));
    await call(this.auth, 'POST', `${API}/${this.id}:batchUpdate`, {
      requests: ids.flatMap(sheetId => [
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      ]),
    });
    return { created: requests.map(r => r.addSheet.properties.title) };
  }
}
