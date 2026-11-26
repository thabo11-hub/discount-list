// Test harness: a fresh local database, the Data API stand-in, and the dev server (which runs the
// real api/*.js handlers). Each test file gets its own database and ports.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secret = () => crypto.randomBytes(32).toString('base64url');

export async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server did not start: ${url}`);
}

export async function startStack(name, extraEnv = {}) {
  const env = {
    ...process.env,
    TEST_DB: `ts_${name}`,
    TEST_SERVER_KEY: secret(),
    TEST_ADMIN_CODE: crypto.randomBytes(15).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 24),
  };
  const db = spawnSync('bash', [path.join(ROOT, 'scripts/test-db.sh')], { env, encoding: 'utf8' });
  if (db.status !== 0) throw new Error(`test-db.sh failed: ${db.stderr}`);
  const pgrstPort = await freePort();
  const apiKey = `sb_publishable_${secret().slice(0, 24)}`;
  const procs = [];
  procs.push(spawn('node', [path.join(ROOT, 'scripts/fake-postgrest.mjs')], {
    env: { ...env, FAKE_PGRST_PORT: String(pgrstPort), FAKE_PGRST_APIKEY: apiKey },
    stdio: 'ignore',
  }));
  const appPort = await freePort();
  const appEnv = {
    PATH: process.env.PATH,
    PORT: String(appPort),
    SUPABASE_URL: `http://127.0.0.1:${pgrstPort}`,
    SUPABASE_PUBLISHABLE_KEY: apiKey,
    SERVER_KEY: env.TEST_SERVER_KEY,
    IP_HASH_SALT: secret(),
    CRON_SECRET: secret(),
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(appEnv)) if (v === undefined) delete appEnv[k];
  const app = spawn('node', [path.join(ROOT, 'scripts/dev-server.mjs')], { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  app.logs = '';
  app.stdout.on('data', (d) => (app.logs += d));
  app.stderr.on('data', (d) => (app.logs += d));
  procs.push(app);
  await waitFor(`http://127.0.0.1:${pgrstPort}/`);
  await waitFor(`http://127.0.0.1:${appPort}/robots.txt`);
  return {
    base: `http://127.0.0.1:${appPort}`,
    env: appEnv,
    adminCode: env.TEST_ADMIN_CODE,
    app,
    sql: (query, vars = {}) => psql(env.TEST_DB, query, vars),
    stop: () => procs.forEach((p) => p.kill()),
  };
}

export function psql(db, query, vars = {}) {
  const args = ['-h', process.env.PGSOCK_DIR || '/tmp/ts-pgsock', '-p', process.env.PGPORT || '54329', '-U', 'postgres',
    '-d', db, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const r = spawnSync('psql', [...args, '-f', '-'], { input: query, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** A browser-like client with its own cookie jar and IP address. */
export class Client {
  constructor(base, { ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, origin } = {}) {
    this.base = base;
    this.ip = ip;
    this.origin = origin ?? base;
    this.cookies = new Map();
    this.csrf = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req(method, p, { body, headers = {}, raw, csrf = true, sameOrigin = true } = {}) {
    const h = { 'x-real-ip': this.ip, ...headers };
    if (sameOrigin && method !== 'GET') {
      h.origin ??= this.origin;
      h['x-requested-with'] ??= 'TrolleyScout';
    }
    if (csrf && this.csrf && method !== 'GET') h['x-csrf-token'] ??= this.csrf;
    if (this.cookies.size) h.cookie = this.cookieHeader();
    let payload = raw;
    if (body !== undefined) {
      h['content-type'] ??= 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(this.base + p, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (json?.csrf) this.csrf = json.csrf;
    return { status: res.status, headers: res.headers, json, text, setCookie: res.headers.getSetCookie() };
  }

  get(p, o) { return this.req('GET', p, o); }
  post(p, body, o = {}) { return this.req('POST', p, { ...o, body }); }
  put(p, body, o = {}) { return this.req('PUT', p, { ...o, body }); }

  async signup(name, email, password) {
    return this.post('/api/auth?action=signup', { name, email, password });
  }

  async login(email, password) {
    return this.post('/api/auth?action=login', { email, password });
  }
}

export const strongPassword = () => `Shelf-${crypto.randomBytes(6).toString('base64url')}-tag`;
