import { rpc } from '../lib/db.js';
import { loadDeals } from '../lib/deals.js';
import { readJson, route, send } from '../lib/http.js';
import { limit } from '../lib/ratelimit.js';
import { requireCsrf, requireUser } from '../lib/session.js';
import * as v from '../lib/validate.js';
import { quote } from '../public/js/pricing.js';

// A signed-in user's saved trolley. Always scoped to the session's own user id; the client
// never sends a user id, so one account can't read or change another's list.
export default route(['GET', 'PUT'], async (ctx) => {
  const s = await requireUser(ctx);
  const deals = await loadDeals();
  const productIds = new Set(deals.products.map((p) => p.id));

  if (ctx.req.method === 'GET') {
    const saved = await rpc('dl_list_get', { p_user_id: s.user_id });
    const items = (Array.isArray(saved) ? saved : []).filter((i) => productIds.has(i.id));
    return send(ctx.res, 200, { items, quote: quote(deals, items) });
  }

  await requireCsrf(ctx, s);
  await limit(ctx, 'list_write_user', s.user_id);
  const body = await readJson(ctx.req);
  const items = v.trolleyItems(body.items, productIds);
  await rpc('dl_list_save', { p_user_id: s.user_id, p_items: items });
  send(ctx.res, 200, { items, quote: quote(deals, items) });
});
