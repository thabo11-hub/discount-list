// Real-browser checks (Chromium via Playwright, when available): the page works under the strict
// CSP + Trusted Types, and script planted in the database is shown as text, never run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { startStack, strongPassword } from './helpers.mjs';

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  chromium = null;
}
const exe = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const skip = !chromium ? 'Playwright not installed' : false;

let S;
let browser;
before(async () => {
  if (skip) return;
  S = await startStack('browser');
  browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
});
after(async () => {
  await browser?.close();
  S?.stop();
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
