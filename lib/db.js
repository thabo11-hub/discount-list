// Database access. Every call goes to a public.dl_* Postgres function through the Supabase
// Data API (HTTPS). Values travel as typed JSON parameters; no SQL text is ever built here.

export class DbError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    this.status = status;
  }
}

const NAME = /^dl_[a-z_]{2,40}$/;

export async function rpc(fn, args = {}) {
  if (!NAME.test(fn)) throw new Error('Invalid database function name');
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ p_key: process.env.SERVER_KEY, ...args }),
    signal: AbortSignal.timeout(9000),
  });
  const text = await res.text();
  if (!res.ok) {
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
    throw new DbError(String(body.message || `db_http_${res.status}`).slice(0, 200), String(body.code || res.status), res.status);
  }
  if (!text) return null;
  return JSON.parse(text);
}
