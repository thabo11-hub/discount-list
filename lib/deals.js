import { rpc } from './db.js';

// Deals change rarely; keep a short per-instance cache so quotes don't hit the database each time.
let cache = { at: 0, data: null };
const TTL_MS = 30 * 1000;

export async function loadDeals({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  const data = await rpc('dl_deals', { p_include_inactive: false });
  cache = { at: Date.now(), data };
  return data;
}

export function clearDealsCache() {
  cache = { at: 0, data: null };
}
