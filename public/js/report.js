// "Report a shelf price": a shopper in the shop scans a barcode and sends the price on the shelf.
// It stays private until the admin checks it, then everyone sees it, marked with the day it was seen.
import { detectBarcode, field, readImage } from './itemform.js';
import { rand } from './pricing.js';
import { api, clear, h, showFieldError, status } from './ui.js';

const SHOPS = [['sixty60', 'Checkers', 'Checkers (in store or Sixty60)'], ['pnp-asap', 'Pick n Pay', 'Pick n Pay (in store or asap!)'], ['makro', 'Makro', 'Makro']];
const SHORT = { sixty60: 'Checkers', 'pnp-asap': 'Pick n Pay', makro: 'Makro' };
const STATUS = { pending: 'Waiting for a check', approved: 'Live for everyone', rejected: 'Not used' };
const HERE_KEY = 'ts_here_v1';

function recallHere() {
  try {
    const v = JSON.parse(sessionStorage.getItem(HERE_KEY) || 'null');
    return v && typeof v.store_id === 'string' && typeof v.branch === 'string' ? v : null;
  } catch {
    return null;
  }
}

function rememberHere(v) {
  try {
    sessionStorage.setItem(HERE_KEY, JSON.stringify(v));
  } catch {
    /* storage blocked: the shopper picks the shop again next time */
  }
}

function recentList(reports) {
  if (!reports.length) return null;
  return h('div', { class: 'recent' }, h('h3', {}, 'Prices you sent'),
    h('ul', {}, reports.slice(0, 8).map((r) => h('li', {},
      h('span', {}, h('b', {}, r.name), ` ${SHORT[r.store_id] || ''}, ${r.deal_qty > 1 ? `${r.deal_qty} for ` : ''}${rand(r.deal_price_cents)}`),
      h('span', { class: `chip st-${r.status}` }, STATUS[r.status] || r.status)))));
}

/** Builds the report form into `body`. */
export async function reportForm(body, { onDone }) {
  clear(body).append(h('p', { class: 'fine' }, 'Loading…'));
  let mine = { reports: [], features: {} };
  try {
    mine = await api('/api/prices?action=mine');
  } catch (err) {
    clear(body).append(h('p', { class: 'status error' }, err.message));
    return;
  }
  const features = mine.features || {};
  const here = recallHere();

  // ---- which shop
  const shop = h('select', { required: true }, h('option', { value: '' }, 'Choose the shop'),
    SHOPS.map(([id, , label]) => h('option', { value: id }, label)));
  const branch = h('select', {}, h('option', { value: '' }, 'Not sure, or not listed'));
  const branchField = field('Branch (optional)', branch, 'branch');
  const findBranch = h('button', { type: 'button', class: 'btn small secondary' }, 'Find my branch');
  const branchMsg = h('p', { class: 'status', role: 'status' });
  let nearby = [];
  const fillBranches = (keep) => {
    const chain = SHOPS.find(([id]) => id === shop.value)?.[1];
    clear(branch).append(h('option', { value: '' }, 'Not sure, or not listed'));
    for (const s of nearby.filter((x) => x.chain === chain)) branch.append(h('option', { value: s.name }, `${s.name} (${s.km} km)`));
    if (keep && [...branch.options].some((o) => o.value === keep)) branch.value = keep;
    else if (keep) branch.append(h('option', { value: keep, selected: true }, keep));
  };
  shop.addEventListener('change', () => fillBranches(''));
  findBranch.addEventListener('click', () => {
    if (!('geolocation' in navigator)) return status(branchMsg, "This browser can't share your location.", 'error');
    status(branchMsg, 'Finding shops near you…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const la = pos.coords.latitude.toFixed(2);
        const lo = pos.coords.longitude.toFixed(2);
        nearby = (await api(`/api/stores?lat=${la}&lng=${lo}`)).stores;
        if (!shop.value && nearby[0]) shop.value = SHOPS.find(([, chain]) => chain === nearby[0].chain)?.[0] || '';
        fillBranches(branch.value);
        const first = [...branch.options].find((o) => o.value);
        if (first && !branch.value) branch.value = first.value;
        status(branchMsg, nearby.length ? 'Pick your branch from the list.' : 'No branches found on the map near you.');
      } catch (err) {
        status(branchMsg, err.message, 'error');
      }
    }, () => status(branchMsg, "We couldn't get your location. Choose the shop and leave the branch blank.", 'error'),
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60 * 1000 });
  });
  if (here) {
    shop.value = here.store_id;
    if (here.branch) fillBranches(here.branch);
  }

  // ---- which product
  const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '16', autocomplete: 'off', placeholder: 'The numbers under the barcode', required: true });
  const name = h('input', { type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'e.g. Huletts white sugar 2.5kg', required: true });
  const brand = h('input', { type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'Optional' });
  const codeMsg = h('p', { class: 'status', role: 'status' });
  const find = h('button', { type: 'button', class: 'btn small' }, 'Look up');
  const lookup = async () => {
    const digits = code.value.replace(/\D/g, '');
    if (!digits) return status(codeMsg, 'Type the numbers under the barcode first.', 'error');
    find.disabled = true;
    status(codeMsg, 'Looking it up…');
    try {
      const { product } = await api(`/api/lookup?action=barcode&code=${encodeURIComponent(digits)}`);
      name.value = product.name;
      if (product.brand) brand.value = product.brand;
      status(codeMsg, `Found ${product.name}.`, 'good');
    } catch (err) {
      status(codeMsg, err.status === 404 ? "Not in the product database yet. Type the name below." : err.message, err.status === 404 ? '' : 'error');
    } finally {
      find.disabled = false;
    }
  };
  find.addEventListener('click', lookup);
  code.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), lookup()));
  const canScan = 'BarcodeDetector' in window || features.screenshot;
  const scanFile = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const scan = canScan ? h('button', { type: 'button', class: 'btn small secondary' }, 'Photo of the barcode') : null;
  scan?.addEventListener('click', () => scanFile.click());
  scanFile.addEventListener('change', async () => {
    const f = scanFile.files[0];
    scanFile.value = '';
    if (!f) return;
    status(codeMsg, 'Reading the barcode…');
    let digits = await detectBarcode(f);
    if (!digits && features.screenshot) digits = await readImage(f).then((r) => r.barcode).catch(() => null);
    if (!digits) return status(codeMsg, "Couldn't read that barcode. Type the numbers under it instead.", 'error');
    code.value = digits;
    lookup();
  });

  // ---- the price
  const price = h('input', { type: 'text', inputmode: 'decimal', maxlength: '12', autocomplete: 'off', placeholder: 'e.g. 39.99', required: true });
  const qty = h('input', { type: 'number', min: '1', max: '100', step: '1', value: '1' });
  const labelMsg = h('p', { class: 'status', role: 'status' });
  let labelBtn = null;
  const labelFile = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  if (features.screenshot) {
    labelBtn = h('button', { type: 'button', class: 'btn small secondary' }, 'Photo of the shelf label');
    labelBtn.addEventListener('click', () => labelFile.click());
    labelFile.addEventListener('change', async () => {
      const f = labelFile.files[0];
      labelFile.value = '';
      if (!f) return;
      labelBtn.disabled = true;
      status(labelMsg, 'Reading the label…');
      try {
        const r = await readImage(f);
        if (r.price) {
          price.value = r.price;
          qty.value = String(r.deal_qty || 1);
        }
        if (!name.value && r.name) name.value = r.name;
        if (!brand.value && r.brand) brand.value = r.brand;
        if (!code.value && r.barcode) code.value = r.barcode;
        status(labelMsg, r.price ? `Read R${r.price}${r.deal_qty > 1 ? ` for ${r.deal_qty}` : ''}. Check it matches the label.` : "Couldn't read a price. Type it in.", r.price ? 'good' : 'error');
      } catch (err) {
        status(labelMsg, err.message, 'error');
      } finally {
        labelBtn.disabled = false;
      }
    });
  }

  const msg = h('p', { class: 'status', role: 'status' });
  const send = h('button', { class: 'btn', type: 'submit' }, 'Send this price');
  const cancel = h('button', { class: 'btn secondary', type: 'button' }, 'Close');
  cancel.addEventListener('click', onDone);
  const recent = h('div', {}, recentList(mine.reports));

  const form = h('form', { class: 'stack item-form report-form', novalidate: true },
    h('p', { class: 'fine' }, "Send the price on the shelf. We check it, then everyone sees it for 30 days, marked with today's date."),
    h('fieldset', { class: 'shop-box' }, h('legend', {}, 'Where are you?'),
      field('Shop', shop, 'store_id'),
      branchField,
      h('div', { class: 'shot-row' }, findBranch, branchMsg)),
    h('fieldset', { class: 'shop-box' }, h('legend', {}, 'Which product?'),
      h('div', { class: 'barcode-row' }, field('Barcode number', code, 'gtin'), find),
      scan ? h('div', { class: 'barcode-row' }, scan, scanFile) : null, codeMsg,
      field('Product name', name, 'name', 'Include the size, e.g. 2.5kg or 750ml.'),
      field('Brand', brand, 'brand')),
    h('fieldset', { class: 'shop-box' }, h('legend', {}, 'Price on the shelf'),
      labelBtn ? h('div', { class: 'shot-row' }, labelBtn, labelFile, labelMsg) : null,
      h('div', { class: 'shop-grid' },
        field('Price (R)', price, 'price', 'For a deal like 2 for R60, put 60'),
        field('Items for that price', qty, 'deal_qty'))),
    h('div', { class: 'slip-actions' }, send, cancel),
    msg,
    recent);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status(msg, '');
    for (const el of form.querySelectorAll('[data-err]')) el.textContent = '';
    if (!shop.value) return showFieldError(form, { message: 'Choose the shop you are in.', body: { field: 'store_id' } });
    send.disabled = true;
    try {
      await api('/api/prices?action=report', {
        method: 'POST',
        body: { store_id: shop.value, branch: branch.value, gtin: code.value, name: name.value, brand: brand.value, price: price.value, deal_qty: Number(qty.value || 1) },
      });
      rememberHere({ store_id: shop.value, branch: branch.value });
      for (const el of [code, name, brand, price]) el.value = '';
      qty.value = '1';
      for (const el of [codeMsg, labelMsg]) status(el, '');
      status(msg, "Sent, thank you. It shows for everyone once it's checked. Scan the next one.", 'good');
      api('/api/prices?action=mine').then((m) => clear(recent).append(recentList(m.reports) || '')).catch(() => {});
      code.focus();
    } catch (err) {
      if (!showFieldError(form, err)) status(msg, err.message, 'error');
    } finally {
      send.disabled = false;
    }
  });
  clear(body).append(form);
  (shop.value ? code : shop).focus();
}
