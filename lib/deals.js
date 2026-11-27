import { withShopperPrices, withUserItems } from '../public/js/pricing.js';
import { rpc } from './db.js';

// Deals change rarely; keep a short per-instance cache so quotes don't hit the database each time.
let cache = { at: 0, data: null };
const TTL_MS = 30 * 1000;

export async function loadDeals({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  const [deals, shopper] = await Promise.all([rpc('dl_deals', { p_include_inactive: false }), rpc('dl_shopper_prices', {})]);
  const data = withShopperPrices(deals, shopper);
  cache = { at: Date.now(), data };
  return data;
}

export function clearDealsCache() {
  cache = { at: 0, data: null };
}

export async function dealsFor(session) {
  const deals = await loadDeals();
  if (!session) return deals;
  return withUserItems(deals, await rpc('dl_user_items', { p_user_id: session.user_id }));
}
