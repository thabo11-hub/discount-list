import { DbError, rpc } from '../lib/db.js';
import { loadDeals } from '../lib/deals.js';
import { HttpError, query, readJson, route, send } from '../lib/http.js';
import { logEvent } from '../lib/log.js';
import { screenshotEnabled, validGtin } from '../lib/lookup.js';
import { limit } from '../lib/ratelimit.js';
import { requireCsrf, requireUser } from '../lib/session.js';
import * as v from '../lib/validate.js';

// Shelf prices from shoppers in the shops. Signed-in only. A report is private to the shopper
// until the admin approves it (api/admin.js); then everyone sees it in the public deals.

async function report(ctx, s) {
  await requireCsrf(ctx, s);
  await limit(ctx, 'report_user', s.user_id);
  const b = await readJson(ctx.req, 4 * 1024);
  const gtin = String(b.gtin ?? '').replace(/[\s-]/g, '');
  if (!validGtin(gtin)) v.fail('gtin', 'That barcode number looks wrong. Check the digits under the barcode.');
  const deals = await loadDeals();
  if (typeof b.store_id !== 'string' || !deals.stores.some((st) => st.id === b.store_id)) v.fail('store_id', 'Choose the shop you are in.');
  try {
    const r = await rpc('dl_report_create', {
      p_user_id: s.user_id,
      p_gtin: gtin,
      p_store_id: b.store_id,
      p_branch: v.text(b.branch, 'branch', 80),
      p_name: v.text(b.name, 'name', 60, { required: true }),
      p_brand: v.text(b.brand, 'brand', 60),
      p_deal_qty: v.int(b.deal_qty ?? 1, 'deal_qty', 1, 100),
      p_price_cents: v.priceCents(b.price, 'price'),
    });
    logEvent('info', 'price_reported', { reqId: ctx.reqId, userId: s.user_id, store: b.store_id });
    send(ctx.res, 201, { id: r.id });
  } catch (err) {
    if (err instanceof DbError && err.message === 'too_many_pending') {
      throw new HttpError(409, 'You have 40 prices waiting for a check. Try again once some are checked.', { code: 'too_many' });
    }
    throw err;
  }
}

async function mine(ctx, s) {
  send(ctx.res, 200, {
    reports: await rpc('dl_reports_mine', { p_user_id: s.user_id }),
    features: { screenshot: screenshotEnabled(), barcode: true },
  });
}

export default route(['GET', 'POST'], async (ctx) => {
  const s = await requireUser(ctx);
  const action = query(ctx.req).get('action') || '';
  if (ctx.req.method === 'GET' && action === 'mine') return mine(ctx, s);
  if (ctx.req.method === 'POST' && action === 'report') return report(ctx, s);
  throw new HttpError(404, 'Unknown action.', { code: 'not_found' });
});
