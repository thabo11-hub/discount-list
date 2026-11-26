import crypto from 'node:crypto';

// Password hashing: scrypt (memory-hard) with a random 16-byte salt per password.
// Stored format: scrypt$<log2 N>$<r>$<p>$<salt b64>$<hash b64>
const COST = { logN: 15, r: 8, p: 1 };
const KEYLEN = 64;

function scryptAsync(password, salt, { logN, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      KEYLEN,
      { N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

const normalise = (pw) => String(pw).normalize('NFKC');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(normalise(password), salt, COST);
  return ['scrypt', COST.logN, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Returns { ok, needsRehash }. Never throws on a malformed stored hash. */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, needsRehash: false };
  const [, logN, r, p, saltB64, hashB64] = parts;
  const params = { logN: Number(logN), r: Number(r), p: Number(p) };
  if (!(params.logN >= 10 && params.logN <= 20 && params.r >= 1 && params.r <= 32 && params.p >= 1 && params.p <= 4)) {
    return { ok: false, needsRehash: false };
  }
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length !== KEYLEN) return { ok: false, needsRehash: false };
  const actual = await scryptAsync(normalise(password), Buffer.from(saltB64, 'base64'), params);
  const ok = crypto.timingSafeEqual(actual, expected);
  const needsRehash = ok && (params.logN < COST.logN || params.r < COST.r || params.p < COST.p);
  return { ok, needsRehash };
}

let dummyHash;
/** Burn the same time as a real check when the account does not exist (no user enumeration by timing). */
export async function fakeVerify(password) {
  dummyHash ||= await hashPassword('not-a-real-password-for-timing');
  await verifyPassword(password, dummyHash);
  return { ok: false, needsRehash: false };
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256hex = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

export function hashIp(ip) {
  return crypto
    .createHmac('sha256', process.env.IP_HASH_SALT || 'unset')
    .update(String(ip || 'unknown'))
    .digest('hex')
    .slice(0, 32);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/** Mask an email for logs: t***@gmail.com */
export function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
