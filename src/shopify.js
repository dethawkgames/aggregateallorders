import { DEFAULTS } from './config.js';

export class Shopify {
  constructor({ shop = DEFAULTS.shop, clientId, clientSecret, apiVersion = DEFAULTS.shopifyApiVersion }) {
    this.shop = shop; this.clientId = clientId; this.clientSecret = clientSecret; this.apiVersion = apiVersion;
    this.token = null; this.exp = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.exp - 60_000) return this.token;
    const res = await fetch(`https://${this.shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret }),
    });
    if (!res.ok) throw new Error(`Shopify token request failed: ${res.status}`);
    const j = await res.json();
    this.token = j.access_token; this.exp = Date.now() + (j.expires_in || 3600) * 1000;
    return this.token;
  }

  async gql(query, variables = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`https://${this.shop}/admin/api/${this.apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await this.accessToken() },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`Shopify GraphQL failed: ${res.status}`);
      const j = await res.json();
      if (j.errors?.some(e => e.extensions?.code === 'THROTTLED')) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
      if (j.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(j.errors)}`);
      return j.data;
    }
    throw new Error('Shopify GraphQL failed after retries');
  }

  // createdAt of an order by its number. Throws if it does not exist, which
  // catches a mistyped "last submitted order" before anything is cleared.
  async getOrderCreatedAt(num) {
    const d = await this.gql(
      `query($q: String!) { orders(first: 1, query: $q) { edges { node { name createdAt } } } }`,
      { q: `name:${num}` });
    const node = d.orders.edges[0]?.node;
    if (!node || node.name.replace(/\D/g, '') !== String(num)) throw new Error(`Order #${num} not found in Shopify`);
    return node.createdAt;
  }

  // Every order created at/after sinceISO, cancelled ones included (we need
  // them to back out quantities). Line quantity is currentQuantity: net of
  // refunds and removed units.
  async fetchOrders(sinceISO) {
    const out = [];
    let cursor = null;
    for (;;) {
      const d = await this.gql(`
        query($cursor: String, $q: String!) {
          orders(first: 25, after: $cursor, query: $q, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            edges { node {
              name createdAt cancelledAt
              lineItems(first: 50) {
                pageInfo { hasNextPage }
                edges { node { sku title currentQuantity product { id tags } } }
              }
            } }
          }
        }`, { cursor, q: `created_at:>='${sinceISO}'` });
      for (const { node } of d.orders.edges) {
        if (node.lineItems.pageInfo.hasNextPage) {
          throw new Error(`Order ${node.name} has more than 50 line items; refusing to silently drop lines`);
        }
        out.push({
          name: node.name, createdAt: node.createdAt, cancelledAt: node.cancelledAt,
          lines: node.lineItems.edges.map(({ node: li }) => ({
            sku: li.sku, title: li.title, qty: li.currentQuantity,
            tags: li.product?.tags || [], productId: li.product?.id || null,
          })),
        });
      }
      if (!d.orders.pageInfo.hasNextPage) break;
      cursor = d.orders.pageInfo.endCursor;
    }
    return out;
  }
}
