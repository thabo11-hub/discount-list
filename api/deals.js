import { loadDeals } from '../lib/deals.js';
import { HttpError, query, readJson, route, send } from '../lib/http.js';
import * as v from '../lib/validate.js';
import { quote } from '../public/js/pricing.js';

export default route(['GET', 'POST'], async (ctx) => {
  const action = query(ctx.req).get('action') || '';
  const deals = await loadDeals();

  if (ctx.req.method === 'GET' && action === '') {
    return send(ctx.res, 200, deals, { 'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' });
  }

  if (ctx.req.method === 'POST' && action === 'quote') {
    // Server-side price check: the browser sends only product ids and quantities; every price
    // and total comes from the database.
    const body = await readJson(ctx.req);
    const items = v.trolleyItems(body.items, new Set(deals.products.map((p) => p.id)));
    return send(ctx.res, 200, { quote: quote(deals, items), updated_at: deals.updated_at });
  }

  throw new HttpError(404, 'Unknown action.', { code: 'not_found' });
});
