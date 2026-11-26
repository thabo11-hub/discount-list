import { dealsFor, loadDeals } from '../lib/deals.js';
import { HttpError, query, readJson, route, send } from '../lib/http.js';
import { getSession } from '../lib/session.js';
import * as v from '../lib/validate.js';
import { quote } from '../public/js/pricing.js';

export default route(['GET', 'POST'], async (ctx) => {
  const action = query(ctx.req).get('action') || '';
  if (ctx.req.method === 'GET' && action === '') {
    const deals = await loadDeals(); // public products only, never anyone's private items
    return send(ctx.res, 200, deals, { 'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' });
  }

  if (ctx.req.method === 'POST' && action === 'quote') {
    // Server-side price check: the browser sends only product ids and quantities; every price
    // and total comes from the database.
    const body = await readJson(ctx.req);
    const deals = await dealsFor(await getSession(ctx)); // adds the signed-in shopper's own items
    const items = v.trolleyItems(body.items, new Set(deals.products.map((p) => p.id)));
    return send(ctx.res, 200, { quote: quote(deals, items), updated_at: deals.updated_at });
  }

  throw new HttpError(404, 'Unknown action.', { code: 'not_found' });
});
