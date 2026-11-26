// Environment checks. Secrets live only in Vercel environment variables (type "sensitive"),
// never in the repo or the browser bundle. The API refuses to run with missing or unsafe config.

export function isProd() {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
}

const token = (min) => (v) => new RegExp(`^[A-Za-z0-9_-]{${min},}$`).test(v);

const REQUIRED = {
  SUPABASE_URL: (v) =>
    /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(v) ||
    (!isProd() && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v)),
  SUPABASE_PUBLISHABLE_KEY: (v) => v.length >= 20 && v.length <= 600 && !/\s/.test(v),
  SERVER_KEY: token(43),
  IP_HASH_SALT: token(32),
  CRON_SECRET: token(32),
};

const OPTIONAL = {
  APP_ORIGIN: (v) => /^https:\/\/[a-z0-9.-]+$/.test(v) || (!isProd() && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(v)),
  RESEND_API_KEY: (v) => /^re_[A-Za-z0-9_]{10,}$/.test(v),
  MAIL_FROM: (v) => /^[^<>\r\n]{1,80}<[^<>\s@]+@[^<>\s@]+\.[a-z]{2,}>$|^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(v),
};

let cached;

/** Returns { ok, problems } where problems lists variable NAMES only (never values). */
export function checkEnv() {
  if (cached && isProd()) return cached;
  const problems = [];
  for (const [name, valid] of Object.entries(REQUIRED)) {
    const v = process.env[name];
    if (!v) problems.push(`${name} is missing`);
    else if (!valid(v)) problems.push(`${name} has an invalid format`);
  }
  for (const [name, valid] of Object.entries(OPTIONAL)) {
    const v = process.env[name];
    if (v && !valid(v)) problems.push(`${name} has an invalid format`);
  }
  if (process.env.SERVER_KEY && process.env.SERVER_KEY === process.env.CRON_SECRET) {
    problems.push('SERVER_KEY and CRON_SECRET must be different');
  }
  if (isProd()) {
    // Unsafe production config: debug switches must never be on in production.
    if (process.env.APP_DEBUG) problems.push('APP_DEBUG must not be set in production');
    if (!process.env.APP_ORIGIN) problems.push('APP_ORIGIN is missing (needed for reset links)');
  }
  cached = { ok: problems.length === 0, problems };
  return cached;
}

export function debugEnabled() {
  return !isProd() && process.env.APP_DEBUG === '1';
}
