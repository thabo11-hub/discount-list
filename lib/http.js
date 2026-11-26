import crypto from 'node:crypto';
import { checkEnv, debugEnabled, isProd } from './env.js';
import { DbError } from './db.js';
import { audit, logEvent } from './log.js';
import { hashIp } from './security.js';

export class HttpError extends Error {
  constructor(status, message, { code, field, headers } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.headers = headers;
  }
}

// Security headers on every API response (static pages get theirs from vercel.json).
export const API_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function clientIp(req) {
  // Vercel overwrites these with the real client address; a client cannot spoof them there.
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim();
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export const query = (req) => new URL(req.url, 'http://localhost').searchParams;

export async function readRaw(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'That is too large.', { code: 'too_large' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'That is too large.', { code: 'too_large' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 16 * 1024) {
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Send the data as JSON.', { code: 'bad_content_type' });
  }
  const raw = await readRaw(req, limit);
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.', { code: 'bad_json' });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'The request body must be a JSON object.', { code: 'bad_json' });
  }
  return value;
}

function expectedOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = isProd() ? 'https' : String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${host}`;
}

/**
 * CSRF layer 1 for every state-changing request: the browser's Origin must be this site,
 * and our custom header must be present (a cross-site form or image tag cannot add it, and a
 * cross-site fetch that adds it is blocked because we never answer CORS preflights).
 */
export function assertSameOrigin(ctx) {
  const { req } = ctx;
  const origin = req.headers.origin;
  const allowed = new Set([expectedOrigin(req)]);
  if (process.env.APP_ORIGIN) allowed.add(process.env.APP_ORIGIN);
  const okOrigin = origin ? allowed.has(origin) : req.headers['sec-fetch-site'] === 'same-origin';
  const okHeader = req.headers['x-requested-with'] === 'TrolleyScout';
  if (!okOrigin || !okHeader) {
    ctx.securityEvent = { event: 'csrf_block', severity: 'warn', detail: { why: okOrigin ? 'header' : 'origin' } };
    throw new HttpError(403, 'This request was blocked because it did not come from TrolleyScout.', { code: 'csrf' });
  }
}

/**
 * Wraps an API route: method allowlist, CORS refusal, HTTPS enforcement, env checks, security
 * headers, request ids and safe error responses (no stack traces in production).
 */
export function route(methods, fn) {
  return async function handler(req, res) {
    const reqId = crypto.randomUUID();
    const ctx = { req, res, reqId, ip: clientIp(req) };
    ctx.ipHash = hashIp(ctx.ip);
    for (const [k, v] of Object.entries(API_HEADERS)) res.setHeader(k, v);
    res.setHeader('X-Request-Id', reqId);
    try {
      if (req.method === 'OPTIONS') {
        // Same-origin only: no Access-Control-Allow-* headers are ever sent.
        throw new HttpError(403, 'Cross-origin requests are not allowed.', { code: 'cors' });
      }
      if (!methods.includes(req.method)) {
        throw new HttpError(405, 'Method not allowed.', { code: 'method', headers: { Allow: methods.join(', ') } });
      }
      if (isProd() && String(req.headers['x-forwarded-proto'] || 'https').split(',')[0] !== 'https') {
        throw new HttpError(400, 'Use HTTPS.', { code: 'https_required' });
      }
      const env = checkEnv();
      if (!env.ok) {
        logEvent('error', 'env_invalid', { reqId, problems: env.problems });
        throw new HttpError(503, 'TrolleyScout is being set up. Try again soon.', { code: 'not_configured' });
      }
      await fn(ctx);
    } catch (err) {
      await handleError(ctx, err);
    }
  };
}

async function handleError(ctx, err) {
  const { res, reqId } = ctx;
  if (ctx.securityEvent) {
    await audit(ctx, ctx.securityEvent.event, ctx.securityEvent.severity, ctx.securityEvent.detail);
  }
  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (err.code) body.code = err.code;
    if (err.field) body.field = err.field;
    if (err.status >= 500) body.ref = reqId;
    return send(res, err.status, body, err.headers);
  }
  if (err instanceof DbError && err.message === 'forbidden') {
    logEvent('error', 'db_key_rejected', { reqId });
    return send(res, 503, { error: 'TrolleyScout is being set up. Try again soon.', ref: reqId });
  }
  logEvent('error', 'unhandled', { reqId, name: err?.name, message: String(err?.message || err).slice(0, 300), stack: err?.stack });
  const body = { error: 'Something went wrong on our side. Try again.', ref: reqId };
  if (debugEnabled()) body.debug = String(err?.stack || err);
  return send(res, 500, body);
}
