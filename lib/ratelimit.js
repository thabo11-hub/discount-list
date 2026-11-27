// Rate limiting shared by every serverless instance: counters live in Postgres (fixed windows).
import { rpc } from './db.js';
import { HttpError } from './http.js';
import { audit } from './log.js';
import { sha256hex } from './security.js';

export const LIMITS = {
  login_ip: [20, 15 * 60],
  login_account: [10, 15 * 60],
  signup_ip: [5, 60 * 60],
  forgot_ip: [5, 60 * 60],
  forgot_account: [3, 60 * 60],
  reset_ip: [10, 60 * 60],
  password_user: [5, 60 * 60],
  claim_user: [5, 60 * 60],
  claim_ip: [10, 60 * 60],
  stores_ip: [30, 10 * 60],
  upload_user: [20, 60 * 60],
  admin_write_user: [120, 10 * 60],
  list_write_user: [60, 10 * 60],
  items_write_user: [60, 10 * 60],
  screenshot_user: [30, 60 * 60],
  screenshot_all: [400, 24 * 60 * 60],
  barcode_user: [60, 10 * 60],
  report_user: [40, 60 * 60],
};

/** key: what to count by (ip hash, user id, or an email which is hashed first). */
export async function limit(ctx, name, key) {
  const [max, windowS] = LIMITS[name];
  const bucket = `${name}:${String(key).includes('@') ? sha256hex(key).slice(0, 32) : key}`;
  const r = await rpc('dl_rate_hit', { p_bucket: bucket, p_limit: max, p_window_s: windowS });
  if (!r.allowed) {
    if (r.hits === max + 1) await audit(ctx, 'rate_limited', 'warn', { limit: name });
    const minutes = Math.max(1, Math.ceil(r.retry_after / 60));
    throw new HttpError(429, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, {
      code: 'rate_limited',
      headers: { 'Retry-After': String(r.retry_after) },
    });
  }
}
