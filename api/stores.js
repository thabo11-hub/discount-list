import { HttpError, query, route, send } from '../lib/http.js';
import { logEvent } from '../lib/log.js';
import { nearbyStores } from '../lib/overpass.js';
import { limit } from '../lib/ratelimit.js';
import * as v from '../lib/validate.js';

// Nearest stores for a location. Coordinates are rounded to about 1 km and never stored.
export default route(['GET'], async (ctx) => {
  const q = query(ctx.req);
  const { lat, lng } = v.coords(q.get('lat'), q.get('lng'));
  await limit(ctx, 'stores_ip', ctx.ipHash);
  let stores;
  try {
    stores = await nearbyStores(lat, lng);
  } catch (err) {
    logEvent('warn', 'stores_lookup_failed', { reqId: ctx.reqId, message: String(err?.message || err) });
    throw new HttpError(502, "We couldn't reach the store map right now. Try again in a minute.", { code: 'upstream' });
  }
  send(ctx.res, 200, { origin: { lat, lng }, stores, attribution: '© OpenStreetMap contributors' }, {
    'Cache-Control': 'public, max-age=3600, s-maxage=21600',
  });
});
