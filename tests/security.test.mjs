// Attack tests: each one tries to break a protection over real HTTP against the running app
// (real api/*.js handlers, real SQL functions in Postgres, Data API stand-in in between).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { Client, startStack, strongPassword } from './helpers.mjs';

let S;
before(async () => {
  S = await startStack('security');
});
after(() => S?.stop());

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

async function newUser(prefix = 'user') {
  const c = new Client(S.base);
  const email = `${prefix}-${crypto.randomBytes(4).toString('hex')}@example.com`;
  const password = strongPassword();
  const r = await c.signup('Test User', email, password);
  assert.equal(r.status, 201, r.text);
  return { c, email, password };
}

async function newAdmin() {
  const u = await newUser('admin');
  const code = `ADM${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
  S.sql(`insert into dl.admin_setup (code_hash, expires_at) values (:'h', now() + interval '1 hour');`, {
    h: crypto.createHash('sha256').update(code).digest('hex'),
  });
  const r = await u.c.post('/api/auth?action=claim-admin', { code });
  assert.equal(r.status, 200, r.text);
  return u;
}

describe('security headers, HTTPS and CORS', () => {
  test('pages send a strict CSP and the hardening headers', async () => {
    const r = await new Client(S.base).get('/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /require-trusted-types-for 'script'/);
    assert.match(csp, /trusted-types ts-sw(;|$)/, 'only the one policy that registers /sw.js');
    assert.match(csp, /worker-src 'self'/);
    assert.match(r.headers.get('strict-transport-security'), /max-age=63072000/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  });

  test('API responses carry their own locked-down headers and are not cached', async () => {
    const r = await new Client(S.base).get('/api/auth?action=me');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  test('CORS preflight is refused and no Access-Control-Allow-* header is ever sent', async () => {
    const r = await new Client(S.base).req('OPTIONS', '/api/auth?action=login', {
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const g = await new Client(S.base).get('/api/deals', { headers: { origin: 'https://evil.example' } });
    assert.equal(g.headers.get('access-control-allow-origin'), null);
    assert.equal(g.headers.get('access-control-allow-credentials'), null);
  });

  test('unknown methods are rejected', async () => {
    const r = await new Client(S.base).req('DELETE', '/api/deals');
    assert.equal(r.status, 405);
  });
});

describe('exposed files', () => {
  for (const p of ['/package.json', '/vercel.json', '/.env', '/.env.example', '/lib/db.js', '/sql/001_schema.sql',
    '/.git/config', '/tests/helpers.mjs', '/scripts/test-db.sh', '/api/../lib/db.js', '/README.md', '/SECURITY.md']) {
    test(`GET ${p} is not served`, async () => {
      const r = await new Client(S.base).get(p);
      assert.equal(r.status, 404, `${p} returned ${r.status}`);
    });
  }
});

describe('accounts and passwords', () => {
  test('passwords are stored as salted scrypt hashes, never in plain text', async () => {
    const { email, password } = await newUser();
    const hash = S.sql(`select pw_hash from dl.users where email = :'e';`, { e: email });
    assert.match(hash, /^scrypt\$15\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/);
    assert.ok(!hash.includes(password));
    const { email: e2 } = await newUser();
    const salts = S.sql(`select split_part(pw_hash, '$', 5) from dl.users where email in (:'a', :'b');`, { a: email, b: e2 });
    assert.equal(new Set(salts.split('\n')).size, 2, 'each password gets its own salt');
  });

  test('weak and common passwords are refused on the server', async () => {
    for (const pw of ['short1!', 'password123', 'Password2024!', 'qwertyuiop', 'aaaaaaaaaaaa', '1234567890', 'x'.repeat(129)]) {
      const r = await new Client(S.base).signup('A', `weak-${crypto.randomBytes(3).toString('hex')}@example.com`, pw);
      assert.equal(r.status, 400, `accepted weak password ${pw}`);
      assert.equal(r.json.field, 'password');
    }
  });

  test('form fields are validated on the server', async () => {
    const fresh = () => new Client(S.base); // new IP each time, so the sign-up rate limit doesn't kick in
    const cases = [
      [{ name: 'A', email: 'not-an-email', password: strongPassword() }, 'email'],
      [{ name: '', email: 'a@example.com', password: strongPassword() }, 'name'],
      [{ name: 'x'.repeat(61), email: 'a@example.com', password: strongPassword() }, 'name'],
      [{ name: 'A', email: 123, password: strongPassword() }, 'email'],
      [{ name: 'A', email: 'a@example.com', password: ['array'] }, 'password'],
    ];
    for (const [body, field] of cases) {
      const r = await fresh().post('/api/auth?action=signup', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.field, field);
    }
    assert.equal((await fresh().post('/api/auth?action=signup', 'not json')).status, 400);
    assert.equal((await fresh().post('/api/auth?action=signup', { a: 1 }, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await fresh().post('/api/auth?action=signup', { name: 'x'.repeat(20000) })).status, 413);
  });

  test('wrong password and unknown account get the same answer (no account enumeration)', async () => {
    const { email } = await newUser();
    const a = await new Client(S.base).login(email, 'Wrong-password-123');
    const b = await new Client(S.base).login('nobody-here@example.com', 'Wrong-password-123');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.json.error, b.json.error);
  });

  test('brute force locks the account after 8 wrong passwords, even for the right password', async () => {
    const { email, password } = await newUser();
    for (let i = 0; i < 8; i++) {
      const r = await new Client(S.base).login(email, `Wrong-guess-${i}-xyz`);
      assert.equal(r.status, 401);
    }
    const r = await new Client(S.base).login(email, password);
    assert.equal(r.status, 429);
    assert.equal(r.json.code, 'locked');
    assert.equal(S.sql(`select count(*) from dl.audit_log where event = 'account_locked';`) >= '1', true);
  });

  test('older, weaker hashes are upgraded at sign-in', async () => {
    const { email, password } = await newUser();
    // Recreate the stored hash with a lower cost (logN 14) to simulate an old account.
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password.normalize('NFKC'), salt, 64, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const old = ['scrypt', 14, 8, 1, salt.toString('base64'), key.toString('base64')].join('$');
    S.sql(`update dl.users set pw_hash = :'h' where email = :'e';`, { h: old, e: email });
    const r = await new Client(S.base).login(email, password);
    assert.equal(r.status, 200);
    assert.match(S.sql(`select pw_hash from dl.users where email = :'e';`, { e: email }), /^scrypt\$15\$/);
  });
});

describe('rate limiting (shared in the database)', () => {
  test('sign-in attempts from one IP are capped with Retry-After', async () => {
    const c = new Client(S.base, { ip: '203.0.113.77' });
    let last;
    for (let i = 0; i < 21; i++) last = await c.login(`spray-${i}@example.com`, 'Wrong-password-123');
    assert.equal(last.status, 429);
    assert.equal(last.json.code, 'rate_limited');
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    // a different IP is not affected
    assert.equal((await new Client(S.base, { ip: '203.0.113.78' }).login('x@example.com', 'Wrong-password-123')).status, 401);
  });

  test('sign-ups from one IP are capped', async () => {
    const c = new Client(S.base, { ip: '203.0.113.90' });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await c.signup('A', `rl-${i}-${Date.now()}@example.com`, strongPassword())).status);
    assert.deepEqual(codes.slice(0, 5), [201, 201, 201, 201, 201]);
    assert.equal(codes[5], 429);
  });

  test('password reset requests are capped per email', async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await new Client(S.base).post('/api/auth?action=forgot', { email: 'target@example.com' })).status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429]);
  });
});

describe('sessions and cookies', () => {
  test('session cookie is HttpOnly, SameSite=Lax, Path=/ (and __Host- + Secure over HTTPS)', async () => {
    const r = await new Client(S.base).signup('A', `ck-${Date.now()}@example.com`, strongPassword());
    const c = r.setCookie[0];
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Path=\//);
    const s = await new Client(S.base).post('/api/auth?action=signup',
      { name: 'A', email: `cks-${Date.now()}@example.com`, password: strongPassword() },
      { headers: { 'x-forwarded-proto': 'https', origin: S.base.replace('http:', 'https:') } });
    assert.equal(s.status, 201, s.text);
    assert.match(s.setCookie[0], /^__Host-ts_session=/);
    assert.match(s.setCookie[0], /; Secure/);
  });

  test('the database stores only a hash of the session token', async () => {
    const { c } = await newUser();
    const token = c.cookies.get('ts_session');
    assert.ok(token);
    assert.equal(S.sql(`select count(*) from dl.sessions where token_hash = :'t';`, { t: token }), '0');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    assert.equal(S.sql(`select count(*) from dl.sessions where token_hash = :'t';`, { t: hash }), '1');
  });

  test('a new session token is issued at every sign-in, and sign-out revokes it on the server', async () => {
    const { email, password } = await newUser();
    const c = new Client(S.base);
    await c.login(email, password);
    const first = c.cookies.get('ts_session');
    await c.login(email, password);
    const second = c.cookies.get('ts_session');
    assert.notEqual(first, second);
    const out = await c.post('/api/auth?action=logout', {});
    assert.equal(out.status, 200);
    const replay = new Client(S.base);
    replay.cookies.set('ts_session', second);
    assert.equal((await replay.get('/api/auth?action=me')).json.user, null);
  });

  test('forged and expired sessions are rejected', async () => {
    const forged = new Client(S.base);
    forged.cookies.set('ts_session', crypto.randomBytes(32).toString('base64url'));
    assert.equal((await forged.get('/api/list')).status, 401);
    const { c } = await newUser();
    const hash = crypto.createHash('sha256').update(c.cookies.get('ts_session')).digest('hex');
    S.sql(`update dl.sessions set last_seen_at = now() - interval '3 days' where token_hash = :'t';`, { t: hash });
    assert.equal((await c.get('/api/list')).status, 401, 'idle session should expire');
  });
});

describe('CSRF', () => {
  test('signed-in writes need the CSRF token', async () => {
    const { c } = await newUser();
    const ok = await c.put('/api/list', { items: [{ id: 'domestos', qty: 2 }] });
    assert.equal(ok.status, 200);
    const noToken = await c.put('/api/list', { items: [] }, { csrf: false });
    assert.equal(noToken.status, 403);
    const badToken = await c.put('/api/list', { items: [] }, { headers: { 'x-csrf-token': 'x'.repeat(43) } });
    assert.equal(badToken.status, 403);
  });

  test('requests from another website are blocked (Origin check + custom header)', async () => {
    const { c } = await newUser();
    const evil = await c.put('/api/list', { items: [] }, { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const noHeader = await new Client(S.base).post('/api/auth?action=login', { email: 'a@example.com', password: 'x' },
      { headers: { 'x-requested-with': 'something-else' } });
    assert.equal(noHeader.status, 403);
    const formPost = await new Client(S.base).post('/api/auth?action=login', 'email=a%40example.com&password=x',
      { sameOrigin: false, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' } });
    assert.equal(formPost.status, 403);
    assert.ok(Number(S.sql(`select count(*) from dl.audit_log where event = 'csrf_block';`)) >= 3);
  });
});

describe('SQL injection (parameterized queries)', () => {
  test('injection payloads are treated as plain data', async () => {
    const c = new Client(S.base);
    const name = "O'Brien; DROP TABLE dl.users; --";
    const email = `inj-${Date.now()}@example.com`;
    const r = await c.signup(name, email, strongPassword());
    assert.equal(r.status, 201);
    assert.equal(S.sql(`select name from dl.users where email = :'e';`, { e: email }), name);
    assert.ok(Number(S.sql('select count(*) from dl.users;')) > 1, 'users table still exists');
    for (const e of ["' OR '1'='1", "admin'--@x.com", 'a@b.com\' OR 1=1 --']) {
      assert.equal((await new Client(S.base).login(e, 'whatever-123')).status, 400);
    }
    const q = await c.post('/api/deals?action=quote', { items: [{ id: "domestos'; delete from dl.offers; --", qty: 1 }] });
    assert.equal(q.status, 400);
    const q2 = await c.post('/api/deals?action=quote', { items: [{ id: 'domestos', qty: '1; drop table x' }] });
    assert.equal(q2.status, 400);
    assert.equal(S.sql('select count(*) from dl.offers;'), '33');
  });

  test('the database refuses direct access without the server key', () => {
    assert.throws(() => S.sql("set role anon; select * from dl.users;"), /permission denied/);
    assert.throws(() => S.sql("set role anon; select public.dl_user_by_email('wrong-key-wrong-key-wrong-key-wrong-key-123', 'a@b.c');"), /forbidden/);
    assert.throws(() => S.sql("set role anon; select dl.gate('x');"), /permission denied/);
  });
});

describe('XSS', () => {
  test('markup in names and admin text is refused', async () => {
    const r = await new Client(S.base).signup('<img src=x onerror=alert(1)>', `x-${Date.now()}@example.com`, strongPassword());
    assert.equal(r.status, 400);
    assert.equal(r.json.field, 'name');
    const admin = await newAdmin();
    const o = await admin.c.post('/api/admin?action=offer', {
      product_id: 'domestos', store_id: 'makro', brand: '<script>alert(1)</script>', deal_text: '', deal_qty: 1, price: '10', in_stock: true,
    });
    assert.equal(o.status, 400);
  });

  test('the front end never writes HTML strings into the page', () => {
    for (const f of fs.readdirSync('public/js')) {
      const src = fs.readFileSync(`public/js/${f}`, 'utf8');
      assert.doesNotMatch(src, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, f);
    }
    for (const f of fs.readdirSync('public').filter((x) => x.endsWith('.html'))) {
      const html = fs.readFileSync(`public/${f}`, 'utf8');
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f} has an inline script`);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f} has an inline event handler`);
      assert.doesNotMatch(html, /\sstyle\s*=/i, `${f} has an inline style`);
    }
  });
});

describe('admin routes', () => {
  test('signed-out and non-admin users cannot use admin tools', async () => {
    assert.equal((await new Client(S.base).get('/api/admin?action=overview')).status, 401);
    const { c } = await newUser();
    const r = await c.get('/api/admin?action=overview');
    assert.equal(r.status, 403);
    const w = await c.post('/api/admin?action=offer', { product_id: 'domestos', store_id: 'makro', price: '1', deal_qty: 1, in_stock: true });
    assert.equal(w.status, 403);
    assert.ok(Number(S.sql(`select count(*) from dl.audit_log where event = 'admin_forbidden';`)) >= 2);
  });

  test('the database also refuses admin changes from a non-admin', async () => {
    const { email } = await newUser();
    const id = S.sql(`select id from dl.users where email = :'e';`, { e: email });
    // Even with the real server key, a non-admin actor is refused by the database itself.
    assert.throws(() => S.sql(`set role anon; select test.rpc('dl_offer_delete', jsonb_build_object('p_key', :'k', 'p_actor', :'id', 'p_product_id','domestos','p_store_id','makro'));`,
      { id, k: S.env.SERVER_KEY }), /not_admin/);
  });

  test('admin setup code works once, and wrong codes are refused', async () => {
    const a = await newUser();
    const wrong = await a.c.post('/api/auth?action=claim-admin', { code: 'WRONGWRONGWRONGWRONGWRONG' });
    assert.equal(wrong.status, 400);
    const ok = await a.c.post('/api/auth?action=claim-admin', { code: S.adminCode });
    assert.equal(ok.status, 200, ok.text);
    const b = await newUser();
    const reuse = await b.c.post('/api/auth?action=claim-admin', { code: S.adminCode });
    assert.equal(reuse.status, 400);
    assert.equal((await a.c.get('/api/admin?action=overview')).status, 200);
  });

  test('admin writes still need CSRF and a recent sign-in', async () => {
    const admin = await newAdmin();
    const noCsrf = await admin.c.post('/api/admin?action=offer', { product_id: 'domestos', store_id: 'makro', price: '30', deal_qty: 1, in_stock: true }, { csrf: false });
    assert.equal(noCsrf.status, 403);
    const hash = crypto.createHash('sha256').update(admin.c.cookies.get('ts_session')).digest('hex');
    S.sql(`update dl.sessions set created_at = now() - interval '13 hours' where token_hash = :'t';`, { t: hash });
    const stale = await admin.c.get('/api/admin?action=overview');
    assert.equal(stale.status, 401);
    assert.equal(stale.json.code, 'reauth');
  });
});

describe('prices are verified on the server', () => {
  test('quotes use database prices, never prices sent by the browser', async () => {
    const r = await new Client(S.base).post('/api/deals?action=quote', {
      items: [{ id: 'nivea-body-lotion', qty: 1, price: 1, cents: 1 }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.quote.splitTotal, 5699);
    assert.equal(r.json.quote.savings.vsHighest, 8499 - 5699);
  });

  test('bad quantities and unknown products are refused', async () => {
    const c = new Client(S.base);
    for (const items of [[{ id: 'domestos', qty: 0 }], [{ id: 'domestos', qty: 1000 }], [{ id: 'domestos', qty: 1.5 }],
      [{ id: 'nope', qty: 1 }], [{ id: 'domestos', qty: 1 }, { id: 'domestos', qty: 2 }], 'x', Array(61).fill({ id: 'domestos', qty: 1 })]) {
      assert.equal((await c.post('/api/deals?action=quote', { items })).status, 400, JSON.stringify(items).slice(0, 80));
    }
  });

  test('admin price input is parsed strictly into cents', async () => {
    const admin = await newAdmin();
    const ok = await admin.c.post('/api/admin?action=offer', {
      product_id: 'handy-andy', store_id: 'makro', brand: 'Handy Andy', deal_text: '', deal_qty: 1, price: 'R 1 299,50', in_stock: true,
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(S.sql("select deal_price_cents from dl.offers where product_id='handy-andy' and store_id='makro';"), '129950');
    for (const price of ['-5', 'abc', '1e9', '0', '10.999', '9999999']) {
      const r = await admin.c.post('/api/admin?action=offer', {
        product_id: 'handy-andy', store_id: 'makro', brand: '', deal_text: '', deal_qty: 1, price, in_stock: true,
      });
      assert.equal(r.status, 400, `accepted price ${price}`);
    }
    const qty = await admin.c.post('/api/admin?action=offer', {
      product_id: 'handy-andy', store_id: 'makro', brand: '', deal_text: '', deal_qty: 0, price: '10', in_stock: true,
    });
    assert.equal(qty.status, 400);
    assert.match(S.sql("select detail::text from dl.audit_log where event='offer_changed' order by id desc limit 1;"), /129950/);
  });
});

describe('uploads', () => {
  test('a real PNG is accepted and served with safe headers', async () => {
    const admin = await newAdmin();
    const r = await admin.c.req('POST', '/api/admin?action=upload&caption=Test%20flyer', { raw: PNG, headers: { 'content-type': 'image/png' } });
    assert.equal(r.status, 201, r.text);
    const img = await new Client(S.base).get(`/api/uploads?id=${r.json.id}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.match(img.headers.get('content-security-policy'), /sandbox/);
    assert.match(img.headers.get('content-disposition'), /^inline; filename="flyer-[0-9a-f]{8}\.png"$/);
  });

  test('disguised, dangerous and oversized files are refused', async () => {
    const admin = await newAdmin();
    const up = (raw, type) => admin.c.req('POST', '/api/admin?action=upload', { raw, headers: { 'content-type': type } });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    assert.equal((await up(svg, 'image/png')).status, 415, 'SVG pretending to be PNG');
    assert.equal((await up(svg, 'image/svg+xml')).status, 415, 'SVG');
    assert.equal((await up(html, 'image/jpeg')).status, 415, 'HTML pretending to be JPEG');
    assert.equal((await up(PNG, 'image/jpeg')).status, 415, 'type mismatch');
    assert.equal((await up(Buffer.from('GIF89a......'), 'image/gif')).status, 415, 'GIF');
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    assert.equal((await up(big, 'image/png')).status, 413, 'over 2 MB');
    const { c } = await newUser();
    assert.equal((await c.req('POST', '/api/admin?action=upload', { raw: PNG, headers: { 'content-type': 'image/png' } })).status, 403);
    assert.ok(Number(S.sql(`select count(*) from dl.audit_log where event = 'upload_rejected';`)) >= 5);
  });

  test('image ids are validated', async () => {
    assert.equal((await new Client(S.base).get('/api/uploads?id=../../etc/passwd')).status, 400);
    assert.equal((await new Client(S.base).get(`/api/uploads?id=${crypto.randomUUID()}`)).status, 404);
  });
});

describe('password reset links', () => {
  const tokenRow = (userEmail, token, interval) =>
    S.sql(`insert into dl.reset_tokens (token_hash, user_id, expires_at)
           select :'h', id, now() + interval '${interval}' from dl.users where email = :'e';`,
    { h: crypto.createHash('sha256').update(token).digest('hex'), e: userEmail });

  test('same reply for known and unknown emails; only a hash is stored; expiry is 30 minutes', async () => {
    const { email } = await newUser();
    const a = await new Client(S.base).post('/api/auth?action=forgot', { email });
    const b = await new Client(S.base).post('/api/auth?action=forgot', { email: 'ghost@example.com' });
    assert.deepEqual(a.json, b.json);
    const row = S.sql(`select token_hash, round(extract(epoch from t.expires_at - t.created_at)) from dl.reset_tokens t
                       join dl.users u on u.id = t.user_id where u.email = :'e';`, { e: email });
    const [hash, secs] = row.split('|');
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(secs, '1800');
    await new Client(S.base).post('/api/auth?action=forgot', { email });
    assert.equal(S.sql(`select count(*) from dl.reset_tokens t join dl.users u on u.id = t.user_id where u.email = :'e';`, { e: email }), '1',
      'only the newest link exists');
  });

  test('a valid link works once, signs out other sessions, and expired links fail', async () => {
    const { c, email } = await newUser();
    const expired = crypto.randomBytes(32).toString('base64url');
    tokenRow(email, expired, '-1 minute');
    const r1 = await new Client(S.base).post('/api/auth?action=reset', { token: expired, password: strongPassword() });
    assert.equal(r1.status, 400);
    const good = crypto.randomBytes(32).toString('base64url');
    S.sql(`delete from dl.reset_tokens;`);
    tokenRow(email, good, '30 minutes');
    const newPw = strongPassword();
    const r2 = await new Client(S.base).post('/api/auth?action=reset', { token: good, password: newPw });
    assert.equal(r2.status, 200, r2.text);
    assert.equal((await c.get('/api/list')).status, 401, 'old session revoked after reset');
    const r3 = await new Client(S.base).post('/api/auth?action=reset', { token: good, password: strongPassword() });
    assert.equal(r3.status, 400, 'link is single use');
    assert.equal((await new Client(S.base).login(email, newPw)).status, 200);
    const weak = crypto.randomBytes(32).toString('base64url');
    tokenRow(email, weak, '30 minutes');
    assert.equal((await new Client(S.base).post('/api/auth?action=reset', { token: weak, password: 'password123' })).status, 400);
  });
});

describe('user data is private (no IDOR)', () => {
  test("one account can't read another account's trolley", async () => {
    const a = await newUser();
    const b = await newUser();
    await a.c.put('/api/list', { items: [{ id: 'stasoft', qty: 18 }] });
    const bl = await b.c.get('/api/list');
    assert.deepEqual(bl.json.items, []);
    const al = await a.c.get('/api/list');
    assert.deepEqual(al.json.items, [{ id: 'stasoft', qty: 18 }]);
  });
});

describe('logging and monitoring', () => {
  test('security events are logged without passwords, tokens or full emails', async () => {
    const { email, password } = await newUser();
    await new Client(S.base).login(email, 'Not-the-password-1');
    const dump = S.sql('select detail::text from dl.audit_log;');
    assert.ok(!dump.includes(password));
    assert.ok(!dump.includes('Not-the-password-1'));
    assert.ok(!dump.includes(email), 'emails are masked');
    for (const e of ['login_failed', 'csrf_block', 'rate_limited', 'admin_forbidden', 'upload_rejected', 'signup']) {
      assert.ok(Number(S.sql(`select count(*) from dl.audit_log where event = :'e';`, { e })) > 0, `missing ${e}`);
    }
    assert.ok(!S.app.logs.includes(password), 'server logs never contain passwords');
  });

  test('admin overview raises alerts when attacks pile up', async () => {
    const admin = await newAdmin();
    const o = await admin.c.get('/api/admin?action=overview');
    assert.equal(o.status, 200);
    assert.ok(o.json.alerts.some((a) => a.event === 'account_locked'));
    assert.ok(Array.isArray(o.json.events) && o.json.events.length > 0);
  });
});

describe('cron and housekeeping', () => {
  test('the cron endpoint needs the cron secret', async () => {
    assert.equal((await new Client(S.base).get('/api/cron')).status, 401);
    assert.equal((await new Client(S.base).get('/api/cron', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const ok = await new Client(S.base).get('/api/cron', { headers: { authorization: `Bearer ${S.env.CRON_SECRET}` } });
    assert.equal(ok.status, 200);
  });
});

describe('store lookup input', () => {
  test('locations outside South Africa and junk are refused', async () => {
    const c = new Client(S.base);
    assert.equal((await c.get('/api/stores?lat=51.5&lng=-0.12')).status, 400);
    assert.equal((await c.get('/api/stores?lat=abc&lng=28')).status, 400);
    assert.equal((await c.get('/api/stores?lat=-26.2);out;&lng=28')).status, 400);
  });
});

describe('static CORS', () => {
  test('static files never allow every origin', async () => {
    const r = await new Client(S.base).get('/');
    assert.notEqual(r.headers.get('access-control-allow-origin'), '*');
  });
});

describe('nearby stores from the database', () => {
  test('OpenStreetMap replies are imported safely and nearest stores come back per chain', async () => {
    const reply = {
      elements: [
        { type: 'node', id: 1, lat: -26.19, lon: 28.04, tags: { shop: 'supermarket', brand: 'Checkers', name: 'Checkers Rosebank' } },
        { type: 'way', id: 2, center: { lat: -26.17, lon: 28.06 }, tags: { shop: 'supermarket', brand: 'Pick n Pay', name: 'Pick n Pay <script>x</script>' } },
        { type: 'node', id: 3, lat: -26.05, lon: 28.09, tags: { shop: 'wholesale', brand: 'Makro', name: 'Makro Woodmead' } },
        { type: 'node', id: 4, lat: -26.2, lon: 28.05, tags: { shop: 'alcohol', name: 'Checkers LiquorShop Rosebank' } },
        { type: 'node', id: 5, lat: 51.5, lon: -0.1, tags: { shop: 'wholesale', brand: 'Makro', name: 'Makro abroad' } },
        { type: 'node', id: 6, lat: -26.2, lon: 28.05, tags: { shop: 'supermarket', name: 'Spar' } },
      ],
    };
    const loaded = S.sql(`select dl.import_stores(:'r'::jsonb);`, { r: JSON.stringify(reply) });
    assert.equal(loaded, '3');
    assert.doesNotMatch(S.sql('select string_agg(name, \'|\') from dl.store_locations;'), /</);
    const r = await new Client(S.base).get('/api/stores?lat=-26.20&lng=28.05');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.stores.map((s) => s.chain), ['Checkers', 'Pick n Pay', 'Makro']);
    assert.equal(r.json.stores[0].store_id, 'sixty60');
    assert.ok(r.json.stores[0].km < r.json.stores[2].km);
    assert.throws(() => S.sql("set role anon; select dl.import_stores('{}'::jsonb);"), /permission denied/);
  });
});

describe('private shopper items', () => {
  const sugar = (extra = {}) => ({
    name: 'White sugar 2.5kg',
    unit: 'item',
    offers: [
      { store_id: 'sixty60', price: '49.99' },
      { store_id: 'pnp-asap', price: '2 for R95', deal_qty: 2 },
      { store_id: 'makro', in_stock: false },
    ],
    ...extra,
  });

  test('a shopper adds an item with prices and compares it; nobody else can see it', async () => {
    const a = await newUser();
    const bad = await a.c.post('/api/items?action=save', sugar());
    assert.equal(bad.status, 400, 'a price like "2 for R95" is refused');
    assert.equal(bad.json.field, 'pnp-asap_price');
    const ok = await a.c.post('/api/items?action=save', sugar({ offers: [
      { store_id: 'sixty60', price: '49.99' }, { store_id: 'pnp-asap', price: '95', deal_qty: 2 }, { store_id: 'makro', in_stock: false }] }));
    assert.equal(ok.status, 201, ok.text);
    const pid = `u-${ok.json.id}`;
    const mine = await a.c.get('/api/items');
    assert.equal(mine.json.items.length, 1);
    assert.equal(mine.json.items[0].offers.length, 3);
    const q = await a.c.post('/api/deals?action=quote', { items: [{ id: pid, qty: 2 }] });
    assert.equal(q.status, 200, q.text);
    assert.equal(q.json.quote.splitTotal, 9500);
    assert.equal(q.json.quote.savings.vsHighest, 9998 - 9500);
    assert.deepEqual(q.json.quote.storeTotals.makro.missing, [pid]);
    const save = await a.c.put('/api/list', { items: [{ id: pid, qty: 2 }, { id: 'domestos', qty: 2 }] });
    assert.equal(save.status, 200, save.text);

    const pub = await new Client(S.base).get('/api/deals');
    assert.ok(!pub.text.includes(ok.json.id), 'private items never appear in public prices');
    assert.ok(!pub.text.includes('White sugar'));

    const b = await newUser();
    assert.deepEqual((await b.c.get('/api/items')).json.items, []);
    assert.equal((await b.c.post('/api/deals?action=quote', { items: [{ id: pid, qty: 1 }] })).status, 400);
    assert.equal((await b.c.put('/api/list', { items: [{ id: pid, qty: 1 }] })).status, 400);
    const steal = await b.c.post('/api/items?action=save', sugar({ id: ok.json.id, name: 'Hacked', offers: [{ store_id: 'sixty60', price: '1' }] }));
    assert.equal(steal.status, 404, 'cannot edit another shopper\'s item');
    assert.equal((await b.c.post('/api/items?action=delete', { id: ok.json.id })).status, 404, 'cannot delete it either');
    assert.equal((await a.c.get('/api/items')).json.items[0].name, 'White sugar 2.5kg');
    assert.equal((await new Client(S.base).post('/api/deals?action=quote', { items: [{ id: pid, qty: 1 }] })).status, 400);

    const del = await a.c.post('/api/items?action=delete', { id: ok.json.id });
    assert.equal(del.status, 200);
    assert.deepEqual((await a.c.get('/api/items')).json.items, []);
  });

  test('signed-out shoppers and cross-site requests cannot add items', async () => {
    assert.equal((await new Client(S.base).post('/api/items?action=save', sugar())).status, 401);
    assert.equal((await new Client(S.base).get('/api/items')).status, 401);
    const { c } = await newUser();
    assert.equal((await c.post('/api/items?action=save', sugar(), { csrf: false })).status, 403);
    assert.equal((await c.post('/api/items?action=save', sugar(), { headers: { origin: 'https://evil.example' } })).status, 403);
  });

  test('item input is validated on the server', async () => {
    const { c } = await newUser();
    const cases = [
      [{ name: '<img src=x onerror=alert(1)>' }, 'name'],
      [{ name: '' }, 'name'],
      [{ unit: 'gallon' }, 'unit'],
      [{ offers: [] }, 'offers'],
      [{ offers: [{ store_id: 'woolworths', price: '10' }] }, 'offers'],
      [{ offers: [{ store_id: 'sixty60', price: '10' }, { store_id: 'sixty60', price: '11' }] }, 'offers'],
      [{ offers: [{ store_id: 'sixty60', price: '-1' }] }, 'sixty60_price'],
      [{ offers: [{ store_id: 'sixty60' }] }, 'sixty60_price'],
      [{ offers: [{ store_id: 'sixty60', in_stock: false }] }, 'offers'],
      [{ unit: 'kg', offers: [{ store_id: 'sixty60', price: '10' }] }, 'sixty60_pack_amount'],
      [{ offers: [{ store_id: 'sixty60', price: '10', deal_qty: 0 }] }, 'sixty60_deal_qty'],
      [{ offers: [{ store_id: 'sixty60', price: '10', brand: '<b>x</b>' }] }, 'sixty60_brand'],
      [{ id: '../../etc' }, 'id'],
    ];
    for (const [extra, field] of cases) {
      const r = await c.post('/api/items?action=save', sugar(extra));
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.json.field, field, JSON.stringify(extra));
    }
  });

  test('per-kg items compare by weight', async () => {
    const { c } = await newUser();
    const r = await c.post('/api/items?action=save', { name: 'Rice', unit: 'kg', offers: [
      { store_id: 'sixty60', price: '89.99', pack_amount: '5' }, { store_id: 'makro', price: '159.95', pack_amount: '10' }] });
    assert.equal(r.status, 201, r.text);
    const q = await c.post('/api/deals?action=quote', { items: [{ id: `u-${r.json.id}`, qty: 10 }] });
    assert.equal(q.json.quote.plan.makro.lines[0].cents, 15995);
    assert.equal(q.json.quote.storeTotals.sixty60.total, 17998);
  });

  test('each shopper can keep at most 50 items', async () => {
    const { c, email } = await newUser();
    S.sql(`insert into dl.user_items (user_id, name) select id, 'Filler ' || g from dl.users, generate_series(1, 50) g where email = :'e';`, { e: email });
    const r = await c.post('/api/items?action=save', sugar({ offers: [{ store_id: 'sixty60', price: '10' }] }));
    assert.equal(r.status, 409);
  });

  test('the admin adds a product for everyone, with all shop prices, in one step', async () => {
    const admin = await newAdmin();
    const r = await admin.c.post('/api/admin?action=product', { name: 'Iwisa maize meal 10kg', unit: 'item', offers: [
      { store_id: 'sixty60', price: '109.99' }, { store_id: 'pnp-asap', price: '104.99' }, { store_id: 'makro', price: '99.95' }] });
    assert.equal(r.status, 201, r.text);
    const pub = await new Client(S.base).get('/api/deals');
    const p = pub.json.products.find((x) => x.name === 'Iwisa maize meal 10kg');
    assert.ok(p, 'visible to everyone');
    assert.equal(pub.json.offers.filter((o) => o.product_id === p.id).length, 3);
    const dup = await admin.c.post('/api/admin?action=product', { name: 'Iwisa maize meal 10kg', unit: 'item', offers: [{ store_id: 'sixty60', price: '1' }] });
    assert.equal(dup.status, 409, 'does not silently overwrite an existing product');
    const { c } = await newUser();
    assert.equal((await c.post('/api/admin?action=product', { name: 'Fake', unit: 'item', offers: [{ store_id: 'sixty60', price: '1' }] })).status, 403);
  });
});

describe('auto-fill switched off', () => {
  test('without a Gemini key the screenshot reader politely says it is off', async () => {
    const { c } = await newUser();
    const r = await c.req('POST', '/api/lookup?action=screenshot', { raw: PNG, headers: { 'content-type': 'image/png' } });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'not_enabled');
    assert.equal((await c.get('/api/items')).json.features.screenshot, false);
  });
});
