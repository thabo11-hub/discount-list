import { HttpError, query, readRaw, route, send } from '../lib/http.js';
import { MAX_UPLOAD_BYTES, sniffImage } from '../lib/images.js';
import { logEvent } from '../lib/log.js';
import { LookupError, lookupBarcode, readScreenshot, screenshotEnabled, validGtin } from '../lib/lookup.js';
import { limit } from '../lib/ratelimit.js';
import { requireCsrf, requireUser } from '../lib/session.js';

// Auto-fill for the "add an item" form. Signed-in only, so it can't be used as an open proxy.

async function screenshot(ctx, s) {
  await requireCsrf(ctx, s);
  if (!screenshotEnabled()) {
    throw new HttpError(503, "Screenshot reading isn't switched on yet.", { code: 'not_enabled' });
  }
  await limit(ctx, 'screenshot_user', s.user_id);
  await limit(ctx, 'screenshot_all', 'all'); // stays inside the free daily quota
  const claimed = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(claimed)) {
    throw new HttpError(415, 'Send a JPEG, PNG or WebP image.', { code: 'bad_type' });
  }
  const bytes = await readRaw(ctx.req, MAX_UPLOAD_BYTES);
  const mime = sniffImage(bytes);
  if (!mime || mime !== claimed) throw new HttpError(415, "That file isn't a real JPEG, PNG or WebP image.", { code: 'bad_type' });
  try {
    const reading = await readScreenshot(bytes, mime);
    logEvent('info', 'screenshot_read', { reqId: ctx.reqId, userId: s.user_id, ok: true });
    send(ctx.res, 200, { reading });
  } catch (err) {
    if (err instanceof LookupError) {
      logEvent('warn', 'screenshot_read_failed', { reqId: ctx.reqId, code: err.code });
      throw new HttpError(err.status, err.message, { code: err.code.startsWith('gemini_') ? 'upstream' : err.code });
    }
    throw err;
  }
}

async function barcode(ctx, s) {
  const code = String(query(ctx.req).get('code') || '').replace(/[\s-]/g, '');
  if (!validGtin(code)) {
    throw new HttpError(400, 'That barcode number looks wrong. Check the digits under the barcode.', { code: 'bad_barcode', field: 'barcode' });
  }
  await limit(ctx, 'barcode_user', s.user_id);
  const product = await lookupBarcode(code);
  if (!product) throw new HttpError(404, "That barcode isn't in the free product database yet. Type the name instead.", { code: 'not_found' });
  send(ctx.res, 200, { product });
}

export default route(['GET', 'POST'], async (ctx) => {
  const s = await requireUser(ctx);
  const action = query(ctx.req).get('action') || '';
  if (ctx.req.method === 'GET' && action === 'barcode') return barcode(ctx, s);
  if (ctx.req.method === 'POST' && action === 'screenshot') return screenshot(ctx, s);
  throw new HttpError(404, 'Unknown action.', { code: 'not_found' });
});
