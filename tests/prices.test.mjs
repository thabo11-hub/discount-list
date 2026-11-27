// Attack tests for shopper prices: shelf prices sent from the shop, checked by the admin, then
// shown to everyone. Runs against the real app, a local Postgres and the Data API stand-in.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { validGtin } from '../lib/lookup.js';
import { Client, startStack, strongPassword } from './helpers.mjs';

let S;
before(async () => {
  S = await startStack('prices');
});
after(() => S?.stop());

/** A random valid EAN-13 starting with 600 (South Africa). */
function gtin() {
  const d = `600${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;
  const sum = [...d].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
  const code = d + ((10 - (sum % 10)) % 10);
  assert.ok(validGtin(code));
  return code;
}

async function newUser(prefix = 'shopper') {
  const c = new Client(S.base);
  const email = `${prefix}-${crypto.randomBytes(4).toString('hex')}@example.com`;
  const r = await c.signup('Test Shopper', email, strongPassword());
  assert.equal(r.status, 201, r.text);
  return { c, email };
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

const shelf = (code, extra = {}) => ({
  store_id: 'pnp-asap', branch: 'Pick n Pay Test Mall', gtin: code, name: 'Test rooibos tea 80s', brand: 'Freshpak', price: '42.99', deal_qty: 1, ...extra,
});

describe('reporting a shelf price', () => {
  test('needs a signed-in shopper, the CSRF token and a same-origin request', async () => {
    const anon = new Client(S.base);
    assert.equal((await anon.post('/api/prices?action=report', shelf(gtin()))).status, 401);
    assert.equal((await anon.get('/api/prices?action=mine')).status, 401);
    const u = await newUser();
    const noToken = await u.c.post('/api/prices?action=report', shelf(gtin()), { csrf: false });
    assert.equal(noToken.status, 403, noToken.text);
    const evil = await u.c.post('/api/prices?action=report', shelf(gtin()), { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403, evil.text);
    assert.equal((await u.c.get('/api/prices?action=nope')).status, 404);
    assert.equal(S.sql(`select count(*) from dl.price_reports where user_id = (select id from dl.users where email = :'e');`, { e: u.email }), '0');
  });

  test('every field is checked on the server', async () => {
    const u = await newUser();
    const cases = [
      [{ gtin: '6001087340015' }, 'gtin'], // wrong check digit
      [{ gtin: "1' or '1'='1" }, 'gtin'],
      [{ store_id: 'woolworths' }, 'store_id'],
      [{ store_id: { $ne: 1 } }, 'store_id'],
      [{ name: '' }, 'name'],
      [{ name: 'x'.repeat(61) }, 'name'],
      [{ price: '2 for R50' }, 'price'],
      [{ price: '-5' }, 'price'],
      [{ price: '0' }, 'price'],
      [{ deal_qty: 0 }, 'deal_qty'],
      [{ deal_qty: 101 }, 'deal_qty'],
      [{ branch: 'b'.repeat(81) }, 'branch'],
    ];
    for (const [bad, field] of cases) {
      const r = await u.c.post('/api/prices?action=report', shelf(gtin(), bad));
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`);
      assert.equal(r.json.field, field);
    }
    const big = await u.c.post('/api/prices?action=report', { ...shelf(gtin()), pad: 'x'.repeat(5000) });
    assert.equal(big.status, 413);
  });

  test("a report stays private until the admin approves it, and shoppers can't see each other's", async () => {
    const a = await newUser();
    const b = await newUser();
    const code = gtin();
    const xss = await a.c.post('/api/prices?action=report', shelf(code, { name: '<img src=x onerror=alert(1)> tea' }));
    assert.equal(xss.status, 400, 'markup in names is refused');
    assert.equal(xss.json.field, 'name');
    const r = await a.c.post('/api/prices?action=report', shelf(code));
    assert.equal(r.status, 201, r.text);
    const again = await a.c.post('/api/prices?action=report', shelf(code, { price: '41.50' }));
    assert.equal(again.status, 201);
    assert.equal(again.json.id, r.json.id, 'a second report for the same product, shop and day updates the first');

    const mine = await a.c.get('/api/prices?action=mine');
    assert.equal(mine.json.reports.length, 1);
    assert.equal(mine.json.reports[0].status, 'pending');
    assert.equal(mine.json.reports[0].deal_price_cents, 4150);
    assert.deepEqual((await b.c.get('/api/prices?action=mine')).json.reports, []);
    const pub = await new Client(S.base).get('/api/deals');
    assert.ok(!pub.text.includes(code), 'pending prices never appear in public prices');
    const q = await b.c.post('/api/deals?action=quote', { items: [{ id: `c-${code}`, qty: 1 }] });
    assert.equal(q.status, 400, 'nobody can quote a price that is not approved');
  });

  test('a shopper can have at most 40 prices waiting', async () => {
    const u = await newUser();
    S.sql(`insert into dl.price_reports (user_id, gtin, store_id, name, deal_price_cents, seen_on)
           select (select id from dl.users where email = :'e'), lpad(g::text, 13, '0'), 'makro', 'Filler', 100, current_date
             from generate_series(1, 40) g;`, { e: u.email });
    const r = await u.c.post('/api/prices?action=report', shelf(gtin()));
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'too_many');
  });
});

describe('checking shopper prices (admin)', () => {
  test("shoppers can't list or approve reports", async () => {
    const u = await newUser();
    const own = await u.c.post('/api/prices?action=report', shelf(gtin()));
    assert.equal(own.status, 201);
    assert.equal((await u.c.get('/api/admin?action=reports')).status, 403);
    const self = await u.c.post('/api/admin?action=report-review', { id: own.json.id, decision: 'approve' });
    assert.equal(self.status, 403, 'a shopper cannot approve their own price');
    assert.equal(S.sql(`select status from dl.price_reports where id = :'i';`, { i: own.json.id }), 'pending');
    assert.equal((await new Client(S.base).get('/api/admin?action=reports')).status, 401);
  });

  test('approved prices show for everyone and are priced by the server', async () => {
    const admin = await newAdmin();
    const u = await newUser();
    const code = gtin();
    const pnp = await u.c.post('/api/prices?action=report', shelf(code, { name: 'Rooibos & "honey" 80s', price: '84', deal_qty: 2 }));
    const mak = await u.c.post('/api/prices?action=report', shelf(code, { store_id: 'makro', branch: '', price: '39.99', name: 'Rooibos & "honey" 80s' }));
    assert.equal(pnp.status, 201);
    assert.equal(mak.status, 201);

    const pending = await admin.c.get('/api/admin?action=reports&status=pending');
    assert.equal(pending.status, 200, pending.text);
    const row = pending.json.reports.find((x) => x.id === pnp.json.id);
    assert.ok(row);
    assert.match(row.reporter, /^sh…@example\.com$/, 'the admin sees a masked email only');
    assert.ok(!pending.text.includes(u.email));

    assert.equal((await admin.c.post('/api/admin?action=report-review', { id: pnp.json.id, decision: 'maybe' })).status, 400);
    assert.equal((await admin.c.post('/api/admin?action=report-review', { id: 'nope', decision: 'approve' })).status, 400);
    assert.equal((await admin.c.post('/api/admin?action=report-review', { id: pnp.json.id, decision: 'approve' }, { csrf: false })).status, 403);
    for (const id of [pnp.json.id, mak.json.id]) {
      const ok = await admin.c.post('/api/admin?action=report-review', { id, decision: 'approve' });
      assert.equal(ok.status, 200, ok.text);
    }
    const twice = await admin.c.post('/api/admin?action=report-review', { id: pnp.json.id, decision: 'approve' });
    assert.equal(twice.status, 404);
    assert.ok(Number(S.sql(`select count(*) from dl.audit_log where event = 'price_report_reviewed';`)) >= 2);

    const pub = await new Client(S.base).get('/api/deals');
    const product = pub.json.products.find((p) => p.id === `c-${code}`);
    assert.ok(product, 'the approved product is public');
    assert.equal(product.name, 'Rooibos & "honey" 80s', 'stored as plain text');
    assert.equal(product.shopper, true);
    const offers = pub.json.offers.filter((o) => o.product_id === `c-${code}`);
    assert.equal(offers.length, 2);
    assert.ok(offers.every((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.seen_on)));
    assert.ok(!pub.text.includes(u.email) && !pub.text.includes('user_id'), 'no reporter details are public');

    // The browser sends only the id and quantity; the server prices it (2 for R84 vs R39.99 each).
    const q = await new Client(S.base).post('/api/deals?action=quote', { items: [{ id: `c-${code}`, qty: 2 }], price: 1 });
    assert.equal(q.status, 200, q.text);
    assert.equal(q.json.quote.splitTotal, 7998);
    assert.equal(q.json.quote.plan.makro.lines[0].id, `c-${code}`);
    assert.equal(q.json.quote.savings.vsHighest, 8400 - 7998);

    const live = await admin.c.get('/api/admin?action=reports&status=approved');
    assert.ok(live.json.reports.some((x) => x.id === pnp.json.id));
    const down = await admin.c.post('/api/admin?action=report-review', { id: mak.json.id, decision: 'reject' });
    assert.equal(down.status, 200);
    const after = await new Client(S.base).get('/api/deals');
    assert.equal(after.json.offers.filter((o) => o.product_id === `c-${code}`).length, 1, 'a taken-down price disappears');
    assert.equal((await u.c.get('/api/prices?action=mine')).json.reports.find((x) => x.id === mak.json.id).status, 'rejected');
  });

  test('approved prices drop off after 30 days', async () => {
    const admin = await newAdmin();
    const u = await newUser();
    const code = gtin();
    const r = await u.c.post('/api/prices?action=report', shelf(code));
    await admin.c.post('/api/admin?action=report-review', { id: r.json.id, decision: 'approve' });
    assert.ok((await new Client(S.base).get('/api/deals')).text.includes(code));
    const live = () => S.sql(`select public.dl_shopper_prices(:'k')::text;`, { k: S.env.SERVER_KEY });
    assert.ok(live().includes(code));
    S.sql(`update dl.price_reports set seen_on = seen_on - 30 where id = :'i';`, { i: r.json.id });
    assert.ok(live().includes(code), 'still shown on day 30');
    S.sql(`update dl.price_reports set seen_on = seen_on - 1 where id = :'i';`, { i: r.json.id });
    assert.ok(!live().includes(code), 'gone on day 31');
  });

  test('the database refuses report functions without the server key or admin role', async () => {
    const out = S.sql(`do $$ begin
        begin perform public.dl_shopper_prices('wrong-key-wrong-key-wrong-key-wrong-key'); raise exception 'gate missing';
        exception when insufficient_privilege then null; end;
        begin perform public.dl_reports_admin((select k.key_hash from dl.server_keys k limit 1), gen_random_uuid(), 'pending'); raise exception 'gate missing';
        exception when insufficient_privilege then null; end;
      end $$; select 'ok';`);
    assert.equal(out, 'ok');
  });
});
