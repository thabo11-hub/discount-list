// Admin tools. This page holds no data of its own: everything comes from /api/admin, which checks
// the admin role on the server for every request.
import { itemForm } from './itemform.js';
import { api, clear, h, loadMe, showFieldError, status, textField } from './ui.js';

const view = document.getElementById('view');
const SHORT = { sixty60: 'Sixty60', 'pnp-asap': 'PnP asap!', makro: 'Makro' };
const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function panel(title, ...children) {
  return h('section', { class: 'panel wide' }, h('h2', {}, title), ...children);
}

function claimView() {
  const msg = h('p', { class: 'status', role: 'status' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Unlock admin tools');
  const f = h('form', { class: 'stack', novalidate: true },
    textField({ name: 'code', label: 'Setup code', autocomplete: 'off', maxlength: 64,
      hint: 'The one-time code from your setup notes. It works once, then expires.' }), btn, msg);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await api('/api/auth?action=claim-admin', { method: 'POST', body: Object.fromEntries(new FormData(f)) });
      location.reload();
    } catch (err) {
      if (!showFieldError(f, err)) status(msg, err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  clear(view).append(h('section', { class: 'panel' },
    h('p', {}, "This account doesn't have admin access yet. If you're the owner, enter your setup code."), f));
}

function offerCell(product, store, offer) {
  const val = (n) => (n === null || n === undefined ? '' : String(n));
  const brand = h('input', { type: 'text', value: val(offer?.brand), maxlength: '60', 'aria-label': `${SHORT[store.id]} brand for ${product.name}`, placeholder: 'Brand' });
  const deal = h('input', { type: 'text', value: val(offer?.deal_text), maxlength: '80', 'aria-label': `${SHORT[store.id]} deal text for ${product.name}`, placeholder: 'Deal text, e.g. 2 for R60' });
  const qty = h('input', { type: 'number', min: '1', max: '100', step: '1', value: val(offer?.deal_qty ?? 1), 'aria-label': `${SHORT[store.id]} items in deal for ${product.name}` });
  const price = h('input', { type: 'text', inputmode: 'decimal', value: offer?.deal_price_cents ? (offer.deal_price_cents / 100).toFixed(2) : '', 'aria-label': `${SHORT[store.id]} deal price in rand for ${product.name}`, placeholder: 'Price (R)' });
  const pack = h('input', { type: 'text', inputmode: 'decimal', value: val(offer?.pack_amount ?? 1), 'aria-label': `${SHORT[store.id]} litres per bottle for ${product.name}` });
  const stock = h('input', { type: 'checkbox' });
  stock.checked = offer ? offer.in_stock : true;
  const save = h('button', { class: 'btn small', type: 'button' }, 'Save');
  const msg = h('span', { class: 'status', role: 'status' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    status(msg, '');
    try {
      await api('/api/admin?action=offer', {
        method: 'POST',
        body: {
          product_id: product.id, store_id: store.id, brand: brand.value, deal_text: deal.value,
          deal_qty: Number(qty.value), price: price.value, pack_amount: product.unit === 'item' ? 1 : pack.value,
          in_stock: stock.checked,
        },
      });
      status(msg, 'Saved', 'good');
    } catch (err) {
      status(msg, err.message, 'error');
    } finally {
      save.disabled = false;
    }
  });
  return h('td', {}, h('div', { class: 'offer-cell' },
    brand, deal,
    h('label', { class: 'inline' }, 'Items in deal', qty),
    price,
    product.unit === 'item' ? null : h('label', { class: 'inline' }, product.unit === 'kg' ? 'Kg each' : 'Litres each', pack),
    h('label', { class: 'inline' }, stock, 'In stock'),
    h('div', { class: 'row-actions' }, save, msg)));
}

function pricesPanel(deals) {
  const idx = new Map(deals.offers.map((o) => [`${o.product_id}|${o.store_id}`, o]));
  const table = h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Product'), deals.stores.map((s) => h('th', {}, s.name)))),
    h('tbody', {}, deals.products.map((p) => h('tr', {},
      h('th', {}, p.name, h('br'), h('small', {}, `${p.id} (${{ litre: 'per litre', kg: 'per kg' }[p.unit] || 'per item'})${p.active ? '' : ', hidden'}`)),
      deals.stores.map((s) => offerCell(p, s, idx.get(`${p.id}|${s.id}`)))))));
  return panel('Prices', h('p', { class: 'fine' }, 'Enter the deal price for the whole deal: for "2 for R60" put 2 items and 60.00. Changes show on the site within a minute.'),
    h('div', { class: 'table-scroll' }, table));
}

function productPanel(deals, features) {
  const done = h('p', { class: 'status', role: 'status' });
  const form = itemForm({
    stores: deals.stores,
    features,
    submitLabel: 'Add product for everyone',
    note: 'Everyone sees this product on the shelf straight away. Shoppers can also add private items for themselves.',
    onSubmit: async (item) => {
      await api('/api/admin?action=product', { method: 'POST', body: { name: item.name, unit: item.unit, offers: item.offers } });
      status(done, `Added ${item.name}. Reloading…`, 'good');
      setTimeout(() => location.reload(), 700);
    },
  });
  return panel('Add a product', form, done);
}

function uploadPanel(uploads) {
  const msg = h('p', { class: 'status', role: 'status' });
  const file = h('input', { type: 'file', accept: TYPES.join(','), required: true, 'aria-label': 'Flyer image' });
  const caption = h('input', { type: 'text', maxlength: '80', placeholder: 'Caption, e.g. Makro Black Friday flyer', 'aria-label': 'Caption' });
  const btn = h('button', { class: 'btn', type: 'button' }, 'Upload flyer');
  btn.addEventListener('click', async () => {
    const f = file.files[0];
    if (!f) return status(msg, 'Choose an image first.', 'error');
    if (!TYPES.includes(f.type)) return status(msg, 'Upload a JPEG, PNG or WebP image.', 'error');
    if (f.size > MAX_BYTES) return status(msg, 'That image is over 2 MB. Make it smaller and try again.', 'error');
    btn.disabled = true;
    try {
      await api(`/api/admin?action=upload&caption=${encodeURIComponent(caption.value)}`, {
        method: 'POST', raw: f, headers: { 'Content-Type': f.type },
      });
      status(msg, 'Flyer uploaded.', 'good');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      status(msg, err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  const list = h('div', { class: 'flyer-grid' }, uploads.map((u) => {
    const del = h('button', { class: 'btn small secondary', type: 'button' }, 'Delete');
    del.addEventListener('click', async () => {
      del.disabled = true;
      try {
        await api('/api/admin?action=upload-delete', { method: 'POST', body: { id: u.id } });
        del.closest('figure').remove();
      } catch (err) {
        status(msg, err.message, 'error');
        del.disabled = false;
      }
    });
    return h('figure', {}, h('img', { src: `/api/uploads?id=${u.id}`, alt: u.caption || 'Flyer', loading: 'lazy' }),
      h('figcaption', {}, u.caption || 'No caption', ` (${Math.round(u.size / 1024)} KB)`), del);
  }));
  return panel('Deal flyers', h('p', { class: 'fine' }, 'JPEG, PNG or WebP, up to 2 MB. Flyers show on the home page.'),
    h('div', { class: 'stack' }, file, caption, btn, msg), list);
}

function securityPanel(o) {
  const alerts = o.alerts.length
    ? h('ul', { class: 'alerts' }, o.alerts.map((a) => h('li', {}, `${a.text} (${a.count} in the last hour)`)))
    : h('ul', { class: 'alerts' }, h('li', { class: 'calm' }, 'No security alerts in the last hour.'));
  const c = o.counts_24h;
  const blocked = (c.csrf_block || 0) + (c.rate_limited || 0) + (c.admin_forbidden || 0);
  const stats = h('div', { class: 'stats' },
    h('div', {}, h('b', {}, String(o.users)), 'accounts'),
    h('div', {}, h('b', {}, String(o.admins)), 'admins'),
    h('div', {}, h('b', {}, String(c.login_failed || 0)), 'failed sign-ins (24h)'),
    h('div', {}, h('b', {}, String(blocked)), 'blocked requests (24h)'));
  const rows = o.events.map((e) => h('tr', {},
    h('td', {}, new Date(e.at).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' })),
    h('td', { class: `sev-${e.severity}` }, e.event),
    h('td', {}, e.ip || ''),
    h('td', {}, JSON.stringify(e.detail).slice(0, 140))));
  const table = h('table', { class: 'grid events' },
    h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Event'), h('th', {}, 'IP (hashed)'), h('th', {}, 'Detail'))),
    h('tbody', {}, rows));
  return panel('Security', alerts, stats, h('div', { class: 'table-scroll' }, table));
}

function reauthButton() {
  const b = h('button', { class: 'btn', type: 'button' }, 'Sign in again');
  b.addEventListener('click', async () => {
    await api('/api/auth?action=logout', { method: 'POST', body: {} }).catch(() => {});
    location.assign('/account?next=admin');
  });
  return b;
}

async function start() {
  const user = await loadMe();
  if (!user) {
    clear(view).append(h('section', { class: 'panel' }, h('p', {}, 'Sign in to use admin tools.'),
      h('a', { class: 'btn', href: '/account?next=admin' }, 'Sign in')));
    return;
  }
  if (user.role !== 'admin') return claimView();
  try {
    const o = await api('/api/admin?action=overview');
    clear(view).append(securityPanel(o), pricesPanel(o.deals), h('div', { class: 'two-col' }, productPanel(o.deals, o.features), uploadPanel(o.uploads)));
  } catch (err) {
    clear(view).append(h('section', { class: 'panel' }, h('p', { class: 'status error' }, err.message),
      err.body?.code === 'reauth' ? reauthButton() : null));
  }
}

start();
