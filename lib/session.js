// Server-side sessions. The browser holds only a random token in an HttpOnly, Secure,
// SameSite=Lax, __Host- cookie; the database stores its SHA-256 hash. Sessions expire after
// 7 days (absolute) or 2 days idle, rotate at every sign-in and are revoked server-side.
import { rpc } from './db.js';
import { isProd } from './env.js';
import { HttpError, assertSameOrigin } from './http.js';
import { audit } from './log.js';
import { randomToken, safeEqual, sha256hex } from './security.js';

const TTL_S = 7 * 24 * 60 * 60;
const IDLE_S = 2 * 24 * 60 * 60;
const ADMIN_FRESH_MS = 12 * 60 * 60 * 1000;

function secureCookies(req) {
  return isProd() || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
}
const cookieName = (req) => (secureCookies(req) ? '__Host-ts_session' : 'ts_session');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function setCookie(ctx, value, maxAge) {
  const secure = secureCookies(ctx.req);
  const attrs = [`${cookieName(ctx.req)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) attrs.push('Secure');
  ctx.res.setHeader('Set-Cookie', attrs.join('; '));
}

function readToken(ctx) {
  const t = parseCookies(ctx.req.headers.cookie)[cookieName(ctx.req)];
  return t && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

export async function startSession(ctx, userId) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  await rpc('dl_session_create', {
    p_user_id: userId,
    p_token_hash: sha256hex(token),
    p_csrf: csrf,
    p_ttl_s: TTL_S,
  });
  setCookie(ctx, token, TTL_S);
  ctx.session = null;
  return { csrf };
}

/** Returns { user_id, email, name, role, csrf, created_at, tokenHash } or null. */
export async function getSession(ctx) {
  if (ctx.session !== undefined) return ctx.session;
  const token = readToken(ctx);
  if (!token) return (ctx.session = null);
  const tokenHash = sha256hex(token);
  const s = await rpc('dl_session_get', { p_token_hash: tokenHash, p_idle_s: IDLE_S });
  ctx.session = s ? { ...s, tokenHash } : null;
  if (!s) clearCookie(ctx);
  return ctx.session;
}

export function clearCookie(ctx) {
  setCookie(ctx, '', 0);
}

export async function endSession(ctx) {
  const s = await getSession(ctx);
  if (s) await rpc('dl_session_delete', { p_token_hash: s.tokenHash });
  clearCookie(ctx);
}

export async function requireUser(ctx) {
  const s = await getSession(ctx);
  if (!s) throw new HttpError(401, 'Sign in to do that.', { code: 'signed_out' });
  return s;
}

/** CSRF layer 2 for signed-in writes: the per-session token must come back in a header. */
export async function requireCsrf(ctx, session) {
  assertSameOrigin(ctx);
  if (!safeEqual(ctx.req.headers['x-csrf-token'], session.csrf)) {
    ctx.securityEvent = { event: 'csrf_block', severity: 'warn', detail: { why: 'token' } };
    throw new HttpError(403, 'Your session token did not match. Reload the page and try again.', { code: 'csrf' });
  }
}

/** Admin routes: role is checked on the server for every request, with a recent sign-in. */
export async function requireAdmin(ctx) {
  const s = await requireUser(ctx);
  if (s.role !== 'admin') {
    await audit(ctx, 'admin_forbidden', 'warn', { path: ctx.req.url?.split('?')[0] }, s.user_id);
    throw new HttpError(403, "You don't have access to admin tools.", { code: 'forbidden' });
  }
  if (Date.now() - new Date(s.created_at).getTime() > ADMIN_FRESH_MS) {
    throw new HttpError(401, 'Sign in again to use admin tools.', { code: 'reauth' });
  }
  return s;
}
