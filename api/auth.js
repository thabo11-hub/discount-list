import { DbError, rpc } from '../lib/db.js';
import { HttpError, assertSameOrigin, query, readJson, route, send } from '../lib/http.js';
import { audit } from '../lib/log.js';
import { sendResetEmail } from '../lib/mail.js';
import { limit } from '../lib/ratelimit.js';
import { fakeVerify, hashPassword, maskEmail, randomToken, sha256hex, verifyPassword } from '../lib/security.js';
import { endSession, getSession, requireCsrf, requireUser, startSession } from '../lib/session.js';
import * as v from '../lib/validate.js';

const MAX_FAILS = 8;
const LOCK_S = 15 * 60;
const RESET_TTL_S = 30 * 60;

const publicUser = (s) => (s ? { name: s.name, email: s.email, role: s.role } : null);

async function me(ctx) {
  const s = await getSession(ctx);
  send(ctx.res, 200, { user: publicUser(s), csrf: s ? s.csrf : null });
}

async function signup(ctx) {
  assertSameOrigin(ctx);
  await limit(ctx, 'signup_ip', ctx.ipHash);
  const body = await readJson(ctx.req);
  const name = v.name(body.name);
  const email = v.email(body.email);
  const password = v.password(body.password, email);
  const pwHash = await hashPassword(password);
  let created;
  try {
    created = await rpc('dl_user_create', { p_email: email, p_name: name, p_pw_hash: pwHash });
  } catch (err) {
    if (err instanceof DbError && err.message === 'email_taken') {
      throw new HttpError(409, 'That email already has an account. Sign in, or reset your password.', {
        code: 'email_taken',
        field: 'email',
      });
    }
    throw err;
  }
  const { csrf } = await startSession(ctx, created.id);
  await audit(ctx, 'signup', 'info', { email: maskEmail(email) }, created.id);
  send(ctx.res, 201, { user: { name, email, role: 'user' }, csrf });
}

async function login(ctx) {
  assertSameOrigin(ctx);
  await limit(ctx, 'login_ip', ctx.ipHash);
  const body = await readJson(ctx.req);
  const email = v.email(body.email);
  const password = v.loginPassword(body.password);
  await limit(ctx, 'login_account', email);

  const user = await rpc('dl_user_by_email', { p_email: email });
  if (!user) {
    await fakeVerify(password);
    await audit(ctx, 'login_failed', 'info', { email: maskEmail(email), why: 'no_account' });
    throw new HttpError(401, 'That email and password do not match.', { code: 'bad_login' });
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await fakeVerify(password);
    await audit(ctx, 'login_locked', 'warn', { email: maskEmail(email) }, user.id);
    throw new HttpError(429, 'Too many wrong passwords. This account is paused for 15 minutes.', { code: 'locked' });
  }
  const check = await verifyPassword(password, user.pw_hash);
  const rec = await rpc('dl_login_record', {
    p_user_id: user.id,
    p_success: check.ok,
    p_max_fail: MAX_FAILS,
    p_lock_s: LOCK_S,
  });
  if (!check.ok) {
    if (rec.locked_until) {
      await audit(ctx, 'account_locked', 'alert', { email: maskEmail(email) }, user.id);
    } else {
      await audit(ctx, 'login_failed', 'info', { email: maskEmail(email), why: 'password' }, user.id);
    }
    throw new HttpError(401, 'That email and password do not match.', { code: 'bad_login' });
  }
  if (check.needsRehash) await rpc('dl_user_rehash', { p_user_id: user.id, p_pw_hash: await hashPassword(password) });
  const { csrf } = await startSession(ctx, user.id); // new token every sign-in (no session fixation)
  await audit(ctx, 'login', 'info', {}, user.id);
  send(ctx.res, 200, { user: { name: user.name, email: user.email, role: user.role }, csrf });
}

async function logout(ctx) {
  const s = await getSession(ctx);
  if (s) await requireCsrf(ctx, s);
  else assertSameOrigin(ctx);
  await endSession(ctx);
  send(ctx.res, 200, { ok: true });
}

const RESET_REPLY = {
  ok: true,
  message: "If that email has an account, we've sent a reset link. It works once and expires in 30 minutes.",
};

async function forgot(ctx) {
  assertSameOrigin(ctx);
  await limit(ctx, 'forgot_ip', ctx.ipHash);
  const body = await readJson(ctx.req);
  const email = v.email(body.email);
  await limit(ctx, 'forgot_account', email);
  const user = await rpc('dl_user_by_email', { p_email: email });
  if (user) {
    const token = randomToken(32);
    await rpc('dl_reset_create', { p_user_id: user.id, p_token_hash: sha256hex(token), p_ttl_s: RESET_TTL_S });
    // The token rides in the URL fragment, which browsers never send to servers or in Referer.
    const link = `${process.env.APP_ORIGIN || `http://${ctx.req.headers.host}`}/account#reset=${token}`;
    const mail = await sendResetEmail(user.email, link);
    await audit(ctx, 'reset_requested', 'info', { email: maskEmail(email), sent: mail.sent, why: mail.reason }, user.id);
  } else {
    await audit(ctx, 'reset_requested', 'info', { email: maskEmail(email), why: 'no_account' });
  }
  send(ctx.res, 200, RESET_REPLY);
}

async function resetCheck(ctx) {
  assertSameOrigin(ctx);
  await limit(ctx, 'reset_ip', ctx.ipHash);
  const body = await readJson(ctx.req);
  const token = v.token(body.token);
  const r = await rpc('dl_reset_check', { p_token_hash: sha256hex(token) });
  send(ctx.res, 200, { valid: !!r.valid });
}

async function reset(ctx) {
  assertSameOrigin(ctx);
  await limit(ctx, 'reset_ip', ctx.ipHash);
  const body = await readJson(ctx.req);
  const token = v.token(body.token);
  const password = v.password(body.password);
  const r = await rpc('dl_reset_consume', { p_token_hash: sha256hex(token), p_pw_hash: await hashPassword(password) });
  if (!r.ok) {
    await audit(ctx, 'reset_rejected', 'warn', {});
    throw new HttpError(400, 'This reset link is invalid, used or expired. Ask for a new one.', { code: 'bad_token' });
  }
  await audit(ctx, 'reset_completed', 'info', {}, r.user_id);
  send(ctx.res, 200, { ok: true, message: 'Password changed. Sign in with your new password.' });
}

async function changePassword(ctx) {
  const s = await requireUser(ctx);
  await requireCsrf(ctx, s);
  await limit(ctx, 'password_user', s.user_id);
  const body = await readJson(ctx.req);
  const current = v.loginPassword(body.current);
  const next = v.password(body.password, s.email);
  const user = await rpc('dl_user_by_id', { p_user_id: s.user_id });
  const check = await verifyPassword(current, user?.pw_hash);
  if (!check.ok) {
    await audit(ctx, 'password_change_failed', 'warn', {}, s.user_id);
    throw new HttpError(400, 'Your current password is wrong.', { code: 'bad_password', field: 'current' });
  }
  await rpc('dl_user_change_password', {
    p_user_id: s.user_id,
    p_pw_hash: await hashPassword(next),
    p_keep_token_hash: s.tokenHash,
  });
  await audit(ctx, 'password_changed', 'info', {}, s.user_id);
  send(ctx.res, 200, { ok: true, message: 'Password changed. Other devices have been signed out.' });
}

async function claimAdmin(ctx) {
  const s = await requireUser(ctx);
  await requireCsrf(ctx, s);
  await limit(ctx, 'claim_ip', ctx.ipHash);
  await limit(ctx, 'claim_user', s.user_id);
  const body = await readJson(ctx.req);
  const code = v.text(body.code, 'code', 64, { required: true }).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 20) v.fail('code', 'Enter the full setup code.');
  const r = await rpc('dl_admin_claim', { p_user_id: s.user_id, p_code_hash: sha256hex(code) });
  if (!r.ok) {
    await audit(ctx, 'admin_claim_failed', 'warn', {}, s.user_id);
    throw new HttpError(400, 'That setup code is wrong, used or expired.', { code: 'bad_code', field: 'code' });
  }
  send(ctx.res, 200, { ok: true });
}

const ACTIONS = {
  GET: { me },
  POST: {
    signup,
    login,
    logout,
    forgot,
    'reset-check': resetCheck,
    reset,
    password: changePassword,
    'claim-admin': claimAdmin,
  },
};

export default route(['GET', 'POST'], async (ctx) => {
  const action = query(ctx.req).get('action') || '';
  const fn = Object.hasOwn(ACTIONS[ctx.req.method], action) ? ACTIONS[ctx.req.method][action] : null;
  if (!fn) throw new HttpError(404, 'Unknown action.', { code: 'not_found' });
  await fn(ctx);
});
