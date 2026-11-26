import { DbError, rpc } from '../lib/db.js';
import { loadDeals } from '../lib/deals.js';
import { HttpError, query, readJson, route, send } from '../lib/http.js';
import { screenshotEnabled } from '../lib/lookup.js';
import { limit } from '../lib/ratelimit.js';
import { requireCsrf, requireUser } from '../lib/session.js';
import * as v from '../lib/validate.js';

// A signed-in shopper's own products with the prices they found. Private: every call is scoped to
// the session's user id, which the browser never sends, so nobody can read or change another
// shopper's items.

async function save(ctx, s) {
  const body = await readJson(ctx.req, 8 * 1024);
  const deals = await loadDeals();
  const storeIds = new Set(deals.stores.map((st) => st.id));
  const id = body.id === undefined || body.id === null || body.id === '' ? null : v.uuid(body.id);
  const name = v.text(body.name, 'name', 60, { required: true });
  const unit = v.unit(body.unit);
  const offers = v.offers(body.offers, storeIds, unit);
  try {
    const r = await rpc('dl_user_item_save', {
      p_user_id: s.user_id,
      p_id: id,
      p_name: name,
      p_unit: unit,
      p_offers: offers,
    });
    send(ctx.res, id ? 200 : 201, { id: r.id });
  } catch (err) {
    if (err instanceof DbError && err.message === 'not_found') {
      throw new HttpError(404, 'That item was not found in your list.', { code: 'not_found' });
    }
    if (err instanceof DbError && err.message === 'too_many_items') {
      throw new HttpError(409, 'You can keep up to 50 of your own items. Delete one to add another.', { code: 'too_many' });
    }
    throw err;
  }
}

async function remove(ctx, s) {
  const body = await readJson(ctx.req);
  const r = await rpc('dl_user_item_delete', { p_user_id: s.user_id, p_id: v.uuid(body.id) });
  if (!r.deleted) throw new HttpError(404, 'That item was not found in your list.', { code: 'not_found' });
  send(ctx.res, 200, { ok: true });
}

const WRITES = { save, delete: remove };

export default route(['GET', 'POST'], async (ctx) => {
  const s = await requireUser(ctx);
  if (ctx.req.method === 'GET') {
    return send(ctx.res, 200, {
      items: await rpc('dl_user_items', { p_user_id: s.user_id }),
      features: { screenshot: screenshotEnabled(), barcode: true },
    });
  }
  const action = query(ctx.req).get('action') || '';
  const fn = Object.hasOwn(WRITES, action) ? WRITES[action] : null;
  if (!fn) throw new HttpError(404, 'Unknown action.', { code: 'not_found' });
  await requireCsrf(ctx, s);
  await limit(ctx, 'items_write_user', s.user_id);
  await fn(ctx, s);
});
