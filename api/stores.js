import { rpc } from '../lib/db.js';
import { HttpError, query, route, send } from '../lib/http.js';
import { logEvent } from '../lib/log.js';
import { CHAINS, distanceKm, nearbyStores } from '../lib/overpass.js';
import { limit } from '../lib/ratelimit.js';
import * as v from '../lib/validate.js';

const STORE_ID = Object.fromEntries(CHAINS.map((c) => [c.chain, c.store_id]));

/** OpenStreetMap can map one store twice (a point and a building); keep one per 250 m per chain. */
export function dedupe(stores, perChain = 4) {
  const kept = [];
  for (const s of stores) {
    if (kept.some((k) => k.chain === s.chain && distanceKm(k, s) < 0.25)) continue;
    if (kept.filter((k) => k.chain === s.chain).length >= perChain) continue;
    kept.push(s);
  }
  return kept;
}

// Nearest stores for a location. Coordinates are rounded to about 1 km and never stored.
// Answered from our own copy of OpenStreetMap store data; the live map server is only a fallback.
export default route(['GET'], async (ctx) => {
  const q = query(ctx.req);
  const { lat, lng } = v.coords(q.get('lat'), q.get('lng'));
  await limit(ctx, 'stores_ip', ctx.ipHash);
  let stores = dedupe((await rpc('dl_nearby_stores', { p_lat: lat, p_lng: lng, p_per_chain: 6 }))
    .map((s) => ({ ...s, store_id: STORE_ID[s.chain] })));
  if (!stores.length) {
    try {
      stores = await nearbyStores(lat, lng);
    } catch (err) {
      logEvent('warn', 'stores_lookup_failed', { reqId: ctx.reqId, message: String(err?.message || err) });
      throw new HttpError(502, "We couldn't reach the store map right now. Try again in a minute.", { code: 'upstream' });
    }
  }
  send(ctx.res, 200, { origin: { lat, lng }, stores, attribution: '© OpenStreetMap contributors' }, {
    'Cache-Control': 'public, max-age=3600, s-maxage=21600',
  });
});
