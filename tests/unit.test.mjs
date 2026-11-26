import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { sniffImage } from '../lib/images.js';
import { buildQuery, pickStores } from '../lib/overpass.js';
import { hashPassword, verifyPassword } from '../lib/security.js';
import { passwordProblem, priceCents } from '../lib/validate.js';
import { quote, rand } from '../public/js/pricing.js';

// Seed prices, as in sql/002_seed.sql (kept in sync by the test below).
function seedDeals() {
  const sql = fs.readFileSync('sql/002_seed.sql', 'utf8');
  const offers = [...sql.matchAll(/\('([a-z0-9-]+)',\s*'([a-z0-9-]+)',\s*'([^']*)',\s*'([^']*)',\s*(\d+),\s*(\d+|null),\s*(\d+),\s*(true|false)\)/g)]
    .map((m) => ({ product_id: m[1], store_id: m[2], brand: m[3], deal_text: m[4], deal_qty: +m[5],
      deal_price_cents: m[6] === 'null' ? null : +m[6], pack_amount: +m[7], in_stock: m[8] === 'true' }));
  const products = [...sql.matchAll(/\('([a-z0-9-]+)',\s*'([^']+)',\s*'(item|litre)',\s*(\d+),\s*(\d+)\)/g)]
    .map((m) => ({ id: m[1], name: m[2], unit: m[3], default_qty: +m[4] }));
  const stores = [{ id: 'sixty60' }, { id: 'pnp-asap' }, { id: 'makro' }];
  return { stores, products, offers };
}

describe('trolley maths', () => {
  const deals = seedDeals();
  test('seed has 11 products and 33 offers', () => {
    assert.equal(deals.products.length, 11);
    assert.equal(deals.offers.length, 33);
  });

  test('multi-buys and litre pricing work out per unit', () => {
    const q = quote(deals, [{ id: 'stasoft', qty: 3 }, { id: 'laundry-liquid', qty: 6 }]);
    assert.equal(q.plan.sixty60.lines[0].cents, 9499); // 3 for R94.99
    assert.equal(q.plan['pnp-asap'].lines[0].cents, 27998); // Sunlight 3L R139.99, 6 litres
    assert.equal(q.storeTotals.makro.total, Math.round((72995 / 18) * 3) + 28000);
  });

  test('sold-out items are skipped, and the shop is marked as missing them', () => {
    const q = quote(deals, [{ id: 'domestos', qty: 2 }]);
    assert.deepEqual(q.storeTotals.makro.missing, ['domestos']);
    assert.equal(q.splitTotal, 5500);
    assert.equal(q.savings.vsHighest, 500);
    assert.equal(q.savings.bestSingle.store_id, 'pnp-asap');
  });

  test('whole default trolley', () => {
    const items = deals.products.map((p) => ({ id: p.id, qty: p.default_qty }));
    const q = quote(deals, items);
    const sum = Object.values(q.plan).reduce((a, p) => a + p.subtotal, 0);
    assert.equal(sum, q.splitTotal);
    assert.ok(q.savings.vsHighest > 0);
    assert.ok(q.savings.vsBestSingle >= 0);
  });

  test('rand formatting', () => {
    assert.equal(rand(6499), 'R64.99');
    assert.equal(rand(129950), 'R1 299.50');
    assert.equal(rand(5), 'R0.05');
  });
});

describe('validation helpers', () => {
  test('prices parse to whole cents', () => {
    assert.equal(priceCents('64.99'), 6499);
    assert.equal(priceCents('R64.99'), 6499);
    assert.equal(priceCents('R 1 299,50'), 129950);
    assert.equal(priceCents(140), 14000);
    for (const bad of ['', '-1', '1e3', '0', '12.345', 'NaN', '1000000']) assert.throws(() => priceCents(bad));
  });

  test('password policy', () => {
    assert.equal(passwordProblem('Shelf-ticket-yellow-42'), null);
    assert.ok(passwordProblem('Password2026!'));
    assert.ok(passwordProblem('trolleyscout1'));
    assert.ok(passwordProblem('thabo.sodi.1234', 'thabo.sodi@example.com'));
  });

  test('scrypt hashes verify, and tampered hashes fail closed', async () => {
    const h = await hashPassword('Shelf-ticket-yellow-42');
    assert.equal((await verifyPassword('Shelf-ticket-yellow-42', h)).ok, true);
    assert.equal((await verifyPassword('shelf-ticket-yellow-42', h)).ok, false);
    assert.equal((await verifyPassword('x', 'scrypt$40$8$1$aa$bb')).ok, false);
    assert.equal((await verifyPassword('x', 'plain')).ok, false);
  });
});

describe('uploads', () => {
  test('magic bytes decide the type', () => {
    assert.equal(sniffImage(Buffer.from('ffd8ffe000104a46494600010100', 'hex')), 'image/jpeg');
    assert.equal(sniffImage(Buffer.from('89504e470d0a1a0a0000000d', 'hex')), 'image/png');
    assert.equal(sniffImage(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp');
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
    assert.equal(sniffImage(Buffer.from('GIF89a000000')), null);
  });
});

describe('store lookup', () => {
  test('the Overpass query only ever contains numbers from the user', () => {
    const q = buildQuery(-26.2041, 28.0473, 15000);
    assert.match(q, /around:15000,-26\.2041,28\.0473/);
    assert.ok(q.includes('nwr["brand"="Makro"];'));
    assert.doesNotMatch(q.replace(/"[^"]*"/g, ''), /[;]\s*out;\s*\(/);
  });

  test('stores are mapped to chains, filtered and sorted by distance', () => {
    const origin = { lat: -26.2, lng: 28.05 };
    const els = [
      { lat: -26.21, lon: 28.05, tags: { name: 'Checkers Hyper Example', shop: 'supermarket' } },
      { lat: -26.25, lon: 28.05, tags: { name: 'Checkers LiquorShop', shop: 'alcohol' } },
      { center: { lat: -26.3, lon: 28.1 }, tags: { brand: 'Pick n Pay', name: 'Pick n Pay Family', shop: 'supermarket' } },
      { lat: -26.0, lon: 28.1, tags: { name: 'Makro Woodmead <b>', shop: 'wholesale' } },
      { lat: -26.0, lon: 28.1, tags: { name: 'Spar', shop: 'supermarket' } },
    ];
    const s = pickStores(els, origin);
    assert.deepEqual(s.map((x) => x.chain), ['Checkers', 'Pick n Pay', 'Makro']);
    assert.ok(s[0].km < s[1].km);
    assert.ok(!s[2].name.includes('<'));
  });
});

describe('errors in production mode', () => {
  test('unexpected errors return a reference, never a stack trace', () => {
    const script = `
      import { route } from './lib/http.js';
      process.env.NODE_ENV = 'production';
      process.env.APP_DEBUG = '';
      Object.assign(process.env, { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijklmnop',
        SERVER_KEY: 'a'.repeat(43), IP_HASH_SALT: 'b'.repeat(32), CRON_SECRET: 'c'.repeat(32), APP_ORIGIN: 'https://x.vercel.app' });
      const h = route(['GET'], async () => { throw new Error('secret internals at /var/task/lib/db.js'); });
      const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { console.log(JSON.stringify({ status: this.statusCode, body: b })); } };
      await h({ method: 'GET', url: '/api/x', headers: { 'x-forwarded-proto': 'https' }, socket: {} }, res);
      await h({ method: 'GET', url: '/api/x', headers: { 'x-forwarded-proto': 'http' }, socket: {} }, res);
    `;
    const r = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const lines = r.stdout.trim().split('\n').filter((l) => l.startsWith('{"status"')).map((l) => JSON.parse(l));
    assert.equal(lines[0].status, 500);
    assert.doesNotMatch(lines[0].body, /secret internals|\/var\/task|at /);
    assert.match(lines[0].body, /"ref":/);
    assert.equal(lines[1].status, 400, 'plain HTTP is refused in production');
  });

  test('unsafe production config is refused (debug flag on, secrets missing)', () => {
    const script = `
      import { checkEnv } from './lib/env.js';
      process.env.NODE_ENV = 'production';
      Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_PUBLISHABLE_KEY: 'k'.repeat(30), SERVER_KEY: 'short',
        IP_HASH_SALT: 'b'.repeat(32), CRON_SECRET: 'c'.repeat(32), APP_DEBUG: '1' });
      console.log(JSON.stringify(checkEnv()));
    `;
    const r = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.ok, false);
    const all = out.problems.join(' | ');
    assert.match(all, /SUPABASE_URL/);
    assert.match(all, /SERVER_KEY/);
    assert.match(all, /APP_DEBUG/);
    assert.doesNotMatch(all, /short|kkkk/, 'never echoes secret values');
  });
});

describe('store de-duplication', () => {
  test('the same store mapped twice is shown once', async () => {
    const { dedupe } = await import('../api/stores.js');
    const s = dedupe([
      { chain: 'Makro', lat: -26.28047, lng: 28.12946, km: 12 },
      { chain: 'Makro', lat: -26.28059, lng: 28.12945, km: 12 },
      { chain: 'Makro', lat: -26.15241, lng: 28.17168, km: 13.2 },
    ]);
    assert.equal(s.length, 2);
  });
});
