import crypto from 'node:crypto';
import { rpc } from '../lib/db.js';
import { clearDealsCache } from '../lib/deals.js';
import { HttpError, query, readJson, readRaw, route, send } from '../lib/http.js';
import { MAX_UPLOAD_BYTES, sniffImage } from '../lib/images.js';
import { audit } from '../lib/log.js';
import { limit } from '../lib/ratelimit.js';
import { requireAdmin, requireCsrf } from '../lib/session.js';
import * as v from '../lib/validate.js';

// Every admin action checks the role on the server (requireAdmin) and, for writes, the CSRF
// token. The database functions check the admin role a second time.

const ALERT_RULES = [
  ['login_failed', 20, 'Many failed sign-ins in the last hour.'],
  ['account_locked', 1, 'An account was locked after repeated wrong passwords.'],
  ['csrf_block', 5, 'Several requests from other websites were blocked.'],
  ['rate_limited', 10, 'Rate limits are being hit often.'],
  ['admin_forbidden', 3, 'Someone without admin access tried admin tools.'],
  ['admin_claim_failed', 3, 'Several wrong admin setup codes were tried.'],
  ['reset_rejected', 5, 'Several invalid password reset links were used.'],
];

async function overview(ctx, s) {
  const [stats, deals, uploads] = await Promise.all([
    rpc('dl_admin_overview', { p_actor: s.user_id }),
    rpc('dl_deals', { p_include_inactive: true }),
    rpc('dl_upload_list', {}),
  ]);
  const alerts = ALERT_RULES.filter(([event, min]) => (stats.counts_1h[event] || 0) >= min).map(([event, , text]) => ({
    event,
    count: stats.counts_1h[event],
    text,
  }));
  send(ctx.res, 200, { ...stats, alerts, deals, uploads });
}

async function saveOffer(ctx, s) {
  const b = await readJson(ctx.req);
  const inStock = v.bool(b.in_stock, 'in_stock');
  const row = await rpc('dl_offer_upsert', {
    p_actor: s.user_id,
    p_product_id: v.slug(b.product_id, 'product_id'),
    p_store_id: v.slug(b.store_id, 'store_id', 30),
    p_brand: v.text(b.brand, 'brand', 60),
    p_deal_text: v.text(b.deal_text, 'deal_text', 80),
    p_deal_qty: v.int(b.deal_qty, 'deal_qty', 1, 100),
    p_deal_price_cents: inStock || b.price ? v.priceCents(b.price, 'price') : null,
    p_pack_amount: v.packAmount(b.pack_amount ?? 1),
    p_in_stock: inStock,
  });
  clearDealsCache();
  send(ctx.res, 200, { offer: row });
}

async function deleteOffer(ctx, s) {
  const b = await readJson(ctx.req);
  await rpc('dl_offer_delete', {
    p_actor: s.user_id,
    p_product_id: v.slug(b.product_id, 'product_id'),
    p_store_id: v.slug(b.store_id, 'store_id', 30),
  });
  clearDealsCache();
  send(ctx.res, 200, { ok: true });
}

async function saveProduct(ctx, s) {
  const b = await readJson(ctx.req);
  const unit = b.unit === 'litre' ? 'litre' : b.unit === 'item' ? 'item' : v.fail('unit', 'Choose item or litre.');
  const row = await rpc('dl_product_upsert', {
    p_actor: s.user_id,
    p_id: v.slug(b.id, 'id'),
    p_name: v.text(b.name, 'name', 60, { required: true }),
    p_unit: unit,
    p_default_qty: v.int(b.default_qty ?? 1, 'default_qty', 1, 99),
    p_sort: v.int(b.sort ?? 500, 'sort', 0, 100000),
    p_active: v.bool(b.active ?? true, 'active'),
  });
  clearDealsCache();
  send(ctx.res, 200, { product: row });
}

async function upload(ctx, s) {
  await limit(ctx, 'upload_user', s.user_id);
  const claimed = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(claimed)) {
    await audit(ctx, 'upload_rejected', 'warn', { why: 'type', claimed: claimed.slice(0, 40) }, s.user_id);
    throw new HttpError(415, 'Upload a JPEG, PNG or WebP image.', { code: 'bad_type' });
  }
  let bytes;
  try {
    bytes = await readRaw(ctx.req, MAX_UPLOAD_BYTES);
  } catch (err) {
    if (err instanceof HttpError && err.status === 413) {
      await audit(ctx, 'upload_rejected', 'warn', { why: 'size' }, s.user_id);
      throw new HttpError(413, 'That image is over 2 MB. Make it smaller and try again.', { code: 'too_large' });
    }
    throw err;
  }
  const actual = sniffImage(bytes);
  if (!actual || actual !== claimed) {
    await audit(ctx, 'upload_rejected', 'warn', { why: 'magic_bytes', claimed }, s.user_id);
    throw new HttpError(415, "That file isn't a real JPEG, PNG or WebP image.", { code: 'bad_type' });
  }
  const caption = v.text(query(ctx.req).get('caption') || '', 'caption', 80);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const r = await rpc('dl_upload_create', {
    p_actor: s.user_id,
    p_mime: actual,
    p_b64: bytes.toString('base64'),
    p_sha256: sha,
    p_caption: caption,
  });
  send(ctx.res, 201, { id: r.id });
}

async function deleteUpload(ctx, s) {
  const b = await readJson(ctx.req);
  await rpc('dl_upload_delete', { p_actor: s.user_id, p_id: v.uuid(b.id) });
  send(ctx.res, 200, { ok: true });
}

const WRITES = {
  offer: saveOffer,
  'offer-delete': deleteOffer,
  product: saveProduct,
  upload,
  'upload-delete': deleteUpload,
};

export default route(['GET', 'POST'], async (ctx) => {
  const s = await requireAdmin(ctx);
  const action = query(ctx.req).get('action') || '';
  if (ctx.req.method === 'GET') {
    if (action !== 'overview') throw new HttpError(404, 'Unknown action.', { code: 'not_found' });
    return overview(ctx, s);
  }
  const fn = Object.hasOwn(WRITES, action) ? WRITES[action] : null;
  if (!fn) throw new HttpError(404, 'Unknown action.', { code: 'not_found' });
  await requireCsrf(ctx, s);
  await limit(ctx, 'admin_write_user', s.user_id);
  await fn(ctx, s);
});
