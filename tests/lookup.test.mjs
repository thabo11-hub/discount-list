// Attack tests for the auto-fill endpoints (screenshot reader and barcode lookup), with Gemini and
// Open Food Facts replaced by local stand-ins.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { FAKE_GEMINI_KEY, KNOWN_BARCODE, OPF_BARCODE, startFakeLookup } from './fake-lookup.mjs';
import { Client, freePort, startStack, strongPassword } from './helpers.mjs';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

let S;
let F;
before(async () => {
  F = await startFakeLookup(await freePort());
  S = await startStack('lookup', {
    GEMINI_API_KEY: FAKE_GEMINI_KEY,
    LOOKUP_GEMINI_BASE: F.base,
    LOOKUP_OFF_BASE: F.base,
    LOOKUP_OPF_BASE: `${F.base}/opf`,
  });
});
after(() => {
  S?.stop();
  F?.stop();
});

async function shopper() {
  const c = new Client(S.base);
  const r = await c.signup('Scanner', `scan-${crypto.randomBytes(4).toString('hex')}@example.com`, strongPassword());
  assert.equal(r.status, 201, r.text);
  return c;
}
const shot = (c, raw = PNG, type = 'image/png', o = {}) =>
  c.req('POST', '/api/lookup?action=screenshot', { raw, headers: { 'content-type': type }, ...o });

describe('screenshot reader', () => {
  test('reads name, pack size and price, and never exposes the API key', async () => {
    const c = await shopper();
    await F.setScenario('sugar');
    const r = await shot(c);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.reading, {
      name: 'Huletts White Sugar 2.5kg', brand: 'Huletts', size: { amount: 2.5, dim: 'mass' },
      deal_qty: 1, price: '49.99', barcode: null, shop: 'sixty60',
    });
    assert.ok(!r.text.includes(FAKE_GEMINI_KEY));
    assert.equal(F.state.calls.at(-1).key, FAKE_GEMINI_KEY, 'key is sent to Gemini only');
    const items = await c.get('/api/items');
    assert.equal(items.json.features.screenshot, true);
  });

  test('multi-buys become a deal, millilitres become litres', async () => {
    const c = await shopper();
    await F.setScenario('deal');
    const r = await shot(c);
    assert.equal(r.json.reading.deal_qty, 2);
    assert.equal(r.json.reading.price, '95.00');
    assert.deepEqual(r.json.reading.size, { amount: 0.75, dim: 'volume' });
    assert.equal(r.json.reading.shop, 'pnp-asap');
  });

  test('hostile text and impossible numbers in an image are cleaned or dropped', async () => {
    const c = await shopper();
    await F.setScenario('evil');
    const r = await shot(c);
    assert.equal(r.status, 200, r.text);
    const x = r.json.reading;
    assert.doesNotMatch(x.name + x.brand, /[<>{}]/);
    assert.ok(x.name.length <= 60);
    assert.equal(x.price, null, 'R999 999 999 is refused');
    assert.equal(x.size, null, '5 tonnes is refused');
    assert.equal(x.deal_qty, 1);
    assert.equal(x.barcode, null);
    assert.equal(x.shop, null);
  });

  test('an overloaded or confused reader fails politely', async () => {
    const c = await shopper();
    await F.setScenario('busy');
    assert.equal((await shot(c)).status, 503);
    await F.setScenario('garbage');
    const g = await shot(c);
    assert.equal(g.status, 422);
    assert.doesNotMatch(g.text, /not json|stack|\bat \//);
  });

  test('only signed-in shoppers, same-site requests and real images', async () => {
    assert.equal((await shot(new Client(S.base))).status, 401);
    const c = await shopper();
    assert.equal((await shot(c, PNG, 'image/png', { csrf: false })).status, 403);
    assert.equal((await shot(c, PNG, 'image/png', { headers: { 'content-type': 'image/png', origin: 'https://evil.example' } })).status, 403);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    assert.equal((await shot(c, svg, 'image/png')).status, 415);
    assert.equal((await shot(c, svg, 'image/svg+xml')).status, 415);
    assert.equal((await shot(c, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).status, 413);
  });

  test('each shopper is limited to 30 screenshots an hour', async () => {
    const c = await shopper();
    await F.setScenario('sugar');
    const codes = [];
    for (let i = 0; i < 31; i++) codes.push((await shot(c)).status);
    assert.equal(codes.filter((s) => s === 200).length, 30);
    assert.equal(codes[30], 429);
  });
});

describe('barcode lookup', () => {
  test('finds name, brand and size; falls back to Open Products Facts for household items', async () => {
    const c = await shopper();
    const r = await c.get(`/api/lookup?action=barcode&code=${KNOWN_BARCODE}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.product, { name: 'Huletts White Sugar 2.5kg', brand: 'Huletts', size: { amount: 2.5, dim: 'mass' } });
    const o = await c.get(`/api/lookup?action=barcode&code=${OPF_BARCODE}`);
    assert.equal(o.status, 200, o.text);
    assert.equal(o.json.product.name, 'Domestos Thick Bleach b 750ml');
    assert.deepEqual(o.json.product.size, { amount: 0.75, dim: 'volume' });
  });

  test('bad and unknown barcodes are refused; signed-out use is refused', async () => {
    const c = await shopper();
    for (const code of ['abc', '123', '6001087340015', '6001087340014;drop', '../../etc/passwd']) {
      assert.equal((await c.get(`/api/lookup?action=barcode&code=${encodeURIComponent(code)}`)).status, 400, code);
    }
    assert.equal((await c.get('/api/lookup?action=barcode&code=5000000000005')).status, 404);
    assert.equal((await new Client(S.base).get(`/api/lookup?action=barcode&code=${KNOWN_BARCODE}`)).status, 401);
  });
});
