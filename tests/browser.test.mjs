// Real-browser checks (Chromium via Playwright, when available): the page works under the strict
// CSP + Trusted Types, and script planted in the database is shown as text, never run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { KNOWN_BARCODE, FAKE_GEMINI_KEY, startFakeLookup } from './fake-lookup.mjs';
import { freePort, startStack, strongPassword } from './helpers.mjs';

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  chromium = null;
}
const exe = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const skip = !chromium ? 'Playwright not installed' : false;

let S;
let F;
let browser;
before(async () => {
  if (skip) return;
  F = await startFakeLookup(await freePort());
  S = await startStack('browser', { GEMINI_API_KEY: FAKE_GEMINI_KEY, LOOKUP_GEMINI_BASE: F.base, LOOKUP_OFF_BASE: F.base, LOOKUP_OPF_BASE: `${F.base}/opf` });
  browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
});
after(async () => {
  await browser?.close();
  S?.stop();
  F?.stop();
});

const SAMPLE_STORES = {
  origin: { lat: -26.2, lng: 28.05 },
  attribution: '© OpenStreetMap contributors',
  stores: [
    { chain: 'Checkers', store_id: 'sixty60', name: 'Checkers Hyper Sample', address: 'Main Rd, Rosebank', lat: -26.19, lng: 28.04, km: 1.4, bearing: 320 },
    { chain: 'Pick n Pay', store_id: 'pnp-asap', name: 'Pick n Pay Sample', address: 'Jan Smuts Ave', lat: -26.17, lng: 28.06, km: 3.2, bearing: 20 },
    { chain: 'Checkers', store_id: 'sixty60', name: 'Checkers Sample Mall', address: '', lat: -26.24, lng: 28.1, km: 6.8, bearing: 140 },
    { chain: 'Makro', store_id: 'makro', name: 'Makro Sample', address: 'Woodmead', lat: -26.05, lng: 28.09, km: 17.2, bearing: 15 },
  ],
};

async function openPage(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.route('**/api/stores?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_STORES) }));
  return { ctx, page, problems };
}

test('stored script in deal data is displayed as text and never runs', { skip }, async () => {
  S.sql(`update dl.offers set brand = '<img src=x onerror="window.__xss=1">', deal_text = '"><script>window.__xss=2</script>'
         where product_id = 'olive-oil' and store_id = 'sixty60';`);
  const { ctx, page, problems } = await openPage({ width: 390, height: 844 });
  await page.goto(S.base + '/');
  await page.waitForSelector('.item[data-id="olive-oil"] .tag');
  const tag = await page.textContent('.item[data-id="olive-oil"] .tag[data-store="sixty60"]');
  assert.match(tag, /<img src=x onerror/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('.item[data-id="olive-oil"] img').count(), 0);
  assert.deepEqual(problems.filter((p) => /Content Security Policy|Trusted Type/i.test(p)), [], 'no CSP violations');
  await ctx.close();
  S.sql(`update dl.offers set brand = 'Olive Pride', deal_text = '' where product_id = 'olive-oil' and store_id = 'sixty60';`);
});

test('home page works under the CSP, and totals are checked by the server', { skip }, async () => {
  const { ctx, page, problems } = await openPage({ width: 390, height: 844 });
  await page.goto(S.base + '/');
  await page.waitForSelector('.slip .verified.ok');
  assert.match(await page.textContent('.slip'), /YOU SAVE/);
  await page.selectOption('#city', { label: 'Johannesburg' });
  await page.waitForSelector('.store');
  assert.equal(await page.locator('.radar .pin').count(), 4);
  await page.screenshot({ path: '/tmp/ts-mobile-top.png' });
  await page.screenshot({ path: '/tmp/ts-mobile-full.png', fullPage: true });
  assert.deepEqual(problems, []);
  await ctx.close();
  const d = await openPage({ width: 1280, height: 900 });
  await d.page.goto(S.base + '/');
  await d.page.waitForSelector('.slip .verified.ok');
  await d.page.screenshot({ path: '/tmp/ts-desktop.png' });
  await d.page.screenshot({ path: '/tmp/ts-desktop-full.png', fullPage: true });
  assert.deepEqual(d.problems, []);
  await d.ctx.close();
});

test('sign-up form has a working show/hide password button', { skip }, async () => {
  const { ctx, page, problems } = await openPage({ width: 390, height: 844 });
  await page.goto(S.base + '/account?tab=signup');
  await page.fill('input[name=name]', 'Browser Tester');
  await page.fill('input[name=email]', `browser-${Date.now()}@example.com`);
  const pw = page.locator('input[name=password]');
  await pw.fill(strongPassword());
  const toggle = page.locator('.pw button');
  assert.equal(await pw.getAttribute('type'), 'password');
  await toggle.click();
  assert.equal(await pw.getAttribute('type'), 'text');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: '/tmp/ts-signup.png' });
  await toggle.click();
  assert.equal(await pw.getAttribute('type'), 'password');
  await page.click('button[type=submit]');
  await page.waitForURL(S.base + '/');
  await page.waitForSelector('.slip .verified.ok');
  assert.equal(await page.textContent('#account-link'), 'Your account');
  await page.click('#save-list');
  await page.waitForSelector('#save-status.good');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('search filters the shelf and links to the same search at each shop', { skip }, async () => {
  const { ctx, page, problems } = await openPage({ width: 390, height: 844 });
  await page.goto(S.base + '/');
  await page.waitForSelector('.slip .verified.ok');
  await page.fill('#search', 'domes');
  assert.equal(await page.locator('#shelf .item[data-id]:visible').count(), 1);
  const links = page.locator('#shop-links a');
  assert.equal(await links.count(), 4);
  assert.equal(await links.nth(0).getAttribute('href'), 'https://www.checkers.co.za/search/all?q=domes');
  assert.equal(await links.nth(1).getAttribute('href'), 'https://www.pnp.co.za/search/domes');
  assert.equal(await links.nth(2).getAttribute('href'), 'https://www.makro.co.za/search?q=domes');
  assert.match(await links.nth(0).getAttribute('rel'), /noopener/);
  await page.fill('#search', 'brown sugar');
  assert.equal(await page.locator('#shelf .item[data-id]:visible').count(), 0);
  assert.ok(await page.isVisible('#search-empty'));
  await page.screenshot({ path: '/tmp/ts-search.png' });
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('a signed-in shopper adds a private item and it lands on the till slip', { skip }, async () => {
  const { ctx, page, problems } = await openPage({ width: 390, height: 844 });
  await page.goto(S.base + '/account?tab=signup');
  await page.fill('input[name=name]', 'Item Tester');
  await page.fill('input[name=email]', `items-${Date.now()}@example.com`);
  await page.fill('input[name=password]', strongPassword());
  await page.click('button[type=submit]');
  await page.waitForURL(S.base + '/');
  await page.waitForSelector('.slip .verified.ok');
  await page.fill('#search', 'brown sugar');
  await page.click('#add-searched');
  await page.waitForSelector('#item-dialog[open]');
  assert.equal(await page.inputValue('#item-dialog .item-form > label input[type=text]'), 'brown sugar');
  await page.fill('#item-dialog .item-form > label input[type=text]', 'Brown sugar 2kg');
  const price = (store) => page.locator(`.shop-box[data-store="${store}"] input[inputmode="decimal"]`).first();
  await price('sixty60').fill('42.99');
  await price('pnp-asap').fill('39.99');
  await page.check('.shop-box[data-store="makro"] input[type=checkbox]');
  await page.screenshot({ path: '/tmp/ts-dialog.png', fullPage: false });
  await page.click('#item-dialog button[type=submit]');
  await page.waitForSelector('#item-dialog', { state: 'hidden' });
  await page.waitForSelector('.item.mine');
  assert.match(await page.textContent('.item.mine'), /Only you see this/);
  await page.waitForSelector('.slip .verified.ok');
  assert.match(await page.textContent('.slip'), /Brown sugar 2kg ×1/);
  await page.locator('.item.mine').screenshot({ path: '/tmp/ts-mine-row.png' });
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('barcode and screenshots fill in the item; different pack sizes switch to per kg', { skip }, async () => {
  const { ctx, page, problems } = await openPage({ width: 390, height: 844 });
  await page.goto(S.base + '/account?tab=signup');
  await page.fill('input[name=name]', 'Auto Filler');
  await page.fill('input[name=email]', `auto-${Date.now()}@example.com`);
  await page.fill('input[name=password]', strongPassword());
  await page.click('button[type=submit]');
  await page.waitForURL(S.base + '/');
  await page.waitForSelector('.slip .verified.ok');
  await page.click('#add-item');
  await page.waitForSelector('#item-dialog[open]');
  await page.click('.barcode-box summary');
  await page.fill('.barcode-box input[inputmode=numeric]', KNOWN_BARCODE);
  await page.click('.barcode-box button:has-text("Look up")');
  await page.waitForSelector('.barcode-box .status.good');
  assert.equal(await page.inputValue('#item-dialog .item-form > label input[type=text]'), 'Huletts White Sugar 2.5kg');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAALElEQVR4XmP8f8megRqAiRqGgMCoQYTBaBgRBqNhRBiMhhFhMBpGhMHgCyMAxgoCQNmsDpkAAAAASUVORK5CYII=', 'base64'); // a real 24x24 PNG
  await F.setScenario('sugar');
  await page.setInputFiles('.shop-box[data-store="sixty60"] input[type=file]', { name: 'sixty60.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.shop-box[data-store="sixty60"] .status.good');
  await F.setScenario('sugar_pnp');
  await page.setInputFiles('.shop-box[data-store="pnp-asap"] input[type=file]', { name: 'pnp.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.shop-box[data-store="pnp-asap"] .status.good');
  assert.equal(await page.inputValue('.shop-box[data-store="sixty60"] input[inputmode=decimal]'), '49.99');
  assert.equal(await page.inputValue('.shop-box[data-store="pnp-asap"] input[inputmode=decimal]'), '41.99');
  assert.equal(await page.inputValue('#item-dialog select'), 'kg');
  assert.ok(await page.isVisible('.size-note'));
  await page.screenshot({ path: '/tmp/ts-autofill.png' });
  await page.click('#item-dialog button[type=submit]');
  await page.waitForSelector('#item-dialog', { state: 'hidden' });
  const row = page.locator('.item.mine');
  await row.waitFor();
  assert.match(await row.textContent(), /R20\.00\/kg/);
  assert.match(await row.locator('.tag.best').textContent(), /Sixty60/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('in the shop: report a shelf price, then shop with a tick-off list (installable, offline-ready)', { skip }, async () => {
  const { ctx, page, problems } = await openPage({ width: 390, height: 844 });
  await page.goto(S.base + '/account?tab=signup');
  const email = `shelf-${Date.now()}@example.com`;
  await page.fill('input[name=name]', 'Shelf Reporter');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', strongPassword());
  await page.click('button[type=submit]');
  await page.waitForURL(S.base + '/');
  await page.waitForSelector('.slip .verified.ok');
  assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active), true, 'service worker registered under Trusted Types');
  assert.equal(await page.evaluate(() => document.querySelector('link[rel=manifest]').href.endsWith('/manifest.webmanifest')), true);

  await page.click('#report-price');
  await page.waitForSelector('#item-dialog[open] .report-form');
  await page.selectOption('.report-form select >> nth=0', 'pnp-asap');
  await page.fill('.report-form input[inputmode=numeric]', KNOWN_BARCODE);
  await page.click('.report-form button:has-text("Look up")');
  await page.waitForSelector('.report-form .status.good');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAALElEQVR4XmP8f8megRqAiRqGgMCoQYTBaBgRBqNhRBiMhhFhMBpGhMHgCyMAxgoCQNmsDpkAAAAASUVORK5CYII=', 'base64');
  await F.setScenario('deal');
  await page.setInputFiles('.report-form .shot-row input[type=file]', { name: 'label.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.report-form .shot-row .status.good');
  assert.equal(await page.inputValue('.report-form input[inputmode=decimal]'), '95.00');
  assert.equal(await page.inputValue('.report-form input[type=number]'), '2');
  await page.screenshot({ path: '/tmp/ts-report.png' });
  await page.click('.report-form button[type=submit]');
  await page.waitForSelector('.report-form > .status.good');
  await page.waitForSelector('.recent .st-pending');
  await page.click('.report-form button:has-text("Close")');

  // Approve it through the real admin API (this shopper is made admin for the test).
  S.sql(`update dl.users set role = 'admin' where email = :'e';`, { e: email });
  const approved = await page.evaluate(async (g) => {
    const me = await (await fetch('/api/auth?action=me')).json();
    const { reports } = await (await fetch('/api/admin?action=reports&status=pending')).json();
    const res = await fetch('/api/admin?action=report-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TrolleyScout', 'X-CSRF-Token': me.csrf },
      body: JSON.stringify({ id: reports.find((r) => r.gtin === g).id, decision: 'approve' }),
    });
    return res.status;
  }, KNOWN_BARCODE);
  assert.equal(approved, 200);
  await page.reload();
  const row = page.locator(`.item.shopper[data-id="c-${KNOWN_BARCODE}"]`);
  await row.waitFor();
  assert.match(await row.textContent(), /Shopper prices/);
  assert.match(await row.textContent(), /2 for R95\.00, seen/);
  await row.locator('input[type=checkbox]').check();
  await page.waitForSelector('.slip .verified.ok');

  await page.click('#shop-mode');
  await page.waitForSelector('#shop-dialog[open] .checklist');
  const first = page.locator('#shop-dialog .checklist input').first();
  await page.screenshot({ path: '/tmp/ts-instore-before.png' });
  await first.check({ timeout: 5000 });
  assert.match(await page.textContent('#shop-dialog .in-store-sum span'), /^1 of \d+ items in your trolley$/);
  await page.screenshot({ path: '/tmp/ts-instore.png' });
  await page.reload();
  await page.waitForSelector('.slip .verified.ok');
  await page.click('#shop-mode');
  await page.waitForSelector('#shop-dialog[open] .checklist');
  assert.equal(await page.locator('#shop-dialog .checklist input:checked').count(), 1, 'ticks survive a reload');
  assert.deepEqual(problems, []);
  await ctx.close();
});
