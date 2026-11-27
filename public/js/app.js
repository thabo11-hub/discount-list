import { itemForm } from './itemform.js';
import { UNIT_SHORT, UNIT_SUFFIX, compareProduct, indexOffers, quote, rand, unitCents, withUserItems } from './pricing.js';
import { reportForm } from './report.js';
import { shoppingList } from './shop.js';
import { api, clear, h, loadMe, status } from './ui.js';

const SHORT = { sixty60: 'Sixty60', 'pnp-asap': 'PnP asap!', makro: 'Makro' };
const CHAIN_APP = { Checkers: 'Order on Checkers Sixty60', 'Pick n Pay': 'Order on Pick n Pay asap!', Makro: 'Shop at Makro' };
const CHAIN_CLASS = { Checkers: 'sixty60', 'Pick n Pay': 'pnp-asap', Makro: 'makro' };
const LOCAL_KEY = 'ts_trolley_v1';

const CITIES = [
  ['Johannesburg', -26.2041, 28.0473], ['Soweto', -26.2485, 27.854], ['Sandton', -26.1076, 28.0567],
  ['Midrand', -25.9992, 28.1263], ['Pretoria', -25.7479, 28.2293], ['Centurion', -25.8603, 28.1894],
  ['Polokwane', -23.9045, 29.4689], ['Mbombela', -25.4753, 30.9694], ['Rustenburg', -25.6676, 27.2421],
  ['Mahikeng', -25.856, 25.6403], ['Bloemfontein', -29.0852, 26.1596], ['Kimberley', -28.7282, 24.7499],
  ['Durban', -29.8587, 31.0218], ['Pietermaritzburg', -29.6006, 30.3794], ['Cape Town', -33.9249, 18.4241],
  ['Bellville', -33.9022, 18.6293], ['George', -33.963, 22.4617], ['Gqeberha', -33.9608, 25.6022],
  ['East London', -33.0153, 27.9116],
];

const state = { publicDeals: null, myItems: [], features: {}, deals: null, index: null, user: null, picked: new Map(), qty: new Map() };

/** Public products plus this shopper's private items, as one shelf. */
function rebuild() {
  state.deals = withUserItems(state.publicDeals, state.myItems);
  state.index = indexOffers(state.deals);
  for (const p of state.deals.products) {
    if (!state.qty.has(p.id)) state.qty.set(p.id, p.default_qty);
    if (!state.picked.has(p.id)) state.picked.set(p.id, false);
  }
}
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ trolley state

function trolleyItems() {
  return state.deals.products.filter((p) => state.picked.get(p.id)).map((p) => ({ id: p.id, qty: state.qty.get(p.id) }));
}

function applyItems(items) {
  const known = new Set(state.deals.products.map((p) => p.id));
  for (const p of state.deals.products) {
    state.picked.set(p.id, false);
    state.qty.set(p.id, p.default_qty);
  }
  for (const it of items || []) {
    if (!known.has(it.id) || !Number.isInteger(it.qty) || it.qty < 1 || it.qty > 99) continue;
    state.picked.set(it.id, true);
    state.qty.set(it.id, it.qty);
  }
}

function saveLocal() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(trolleyItems()));
  } catch {
    /* private mode or storage blocked: the trolley still works for this visit */
  }
}

function readLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ shelf

const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });

function tagFor(product, store, best) {
  const offer = state.index.get(product.id)?.get(store.id);
  const storeName = h('span', { class: 'tag-store' }, SHORT[store.id] || store.name);
  if (!offer) return h('div', { class: 'tag out', dataset: { store: store.id } }, storeName, h('span', { class: 'tag-price' }, 'Not listed'));
  if (!offer.in_stock) {
    return h('div', { class: 'tag out', dataset: { store: store.id } }, storeName,
      h('span', { class: 'tag-price' }, 'Sold out'), h('span', { class: 'tag-deal' }, offer.brand && offer.brand !== product.name ? offer.brand : ''));
  }
  const unit = unitCents(offer);
  const isBest = best && Math.abs(unit - best.unit) < 0.5; // ties share the tag
  const seen = offer.seen_on ? `${offer.deal_qty > 1 ? `${offer.deal_qty} for ${rand(offer.deal_price_cents)}, ` : ''}seen ${shortDate(offer.seen_on)}` : '';
  const deal = [offer.brand && !product.name.toLowerCase().startsWith(offer.brand.toLowerCase()) ? offer.brand : '', offer.deal_text, seen, offer.branch]
    .filter(Boolean)
    .join(', ');
  return h('div', { class: `tag${isBest ? ' best' : ''}`, dataset: { store: store.id } },
    storeName,
    h('span', { class: 'tag-price' }, rand(unit), UNIT_SUFFIX[product.unit] ? h('small', {}, UNIT_SUFFIX[product.unit]) : null,
      isBest ? h('span', { class: 'visually-hidden' }, ' (cheapest)') : null),
    h('span', { class: 'tag-deal' }, deal));
}

function noteFor(product) {
  const cmp = compareProduct(state.deals, product.id, state.index);
  const parts = [];
  if (product.unit === 'litre') parts.push('Prices are per litre, and quantity is in litres.');
  if (product.unit === 'kg') parts.push('Prices are per kg, and quantity is in kg.');
  if (cmp.best) {
    const offer = state.index.get(product.id).get(cmp.best.store_id);
    const qty = state.qty.get(product.id);
    if (offer.deal_qty > 1 && qty % offer.deal_qty !== 0) {
      parts.push(`Buy in ${offer.deal_qty}s at ${SHORT[cmp.best.store_id]} to get this price.`);
    }
  }
  if (cmp.brandsDiffer) {
    const brands = [...new Set([...state.index.get(product.id).values()].map((o) => o.brand).filter(Boolean))];
    parts.push(`Brands differ (${brands.join(', ')}), so compare like with like.`);
  }
  return parts.join(' ');
}

function renderRow(li, product) {
  const picked = state.picked.get(product.id);
  const qty = state.qty.get(product.id);
  li.classList.toggle('off', !picked);
  li.querySelector('input[type=checkbox]').checked = picked;
  li.querySelector('output').value = String(qty);
  li.querySelector('[data-step="-1"]').disabled = qty <= 1;
  li.querySelector('[data-step="1"]').disabled = qty >= 99;
  li.querySelector('.item-note').textContent = noteFor(product);
}

function renderShelf() {
  const shelf = clear($('shelf'));
  for (const product of state.deals.products) {
    const { best } = compareProduct(state.deals, product.id, state.index);
    const cb = h('input', { type: 'checkbox', 'aria-describedby': `note-${product.id}` });
    const minus = h('button', { type: 'button', 'data-step': '-1', 'aria-label': `One less ${product.name}` }, '−');
    const plus = h('button', { type: 'button', 'data-step': '1', 'aria-label': `One more ${product.name}` }, '+');
    const out = h('output', { 'aria-label': `Quantity of ${product.name}` });
    const unitNote = { litre: ' (litres)', kg: ' (kg)' }[product.unit];
    const edit = product.mine ? h('button', { type: 'button', class: 'linklike small' }, 'Edit') : null;
    edit?.addEventListener('click', () => openItemDialog(product.id.slice(2)));
    const offers = [...(state.index.get(product.id)?.values() || [])];
    const li = h('li', { class: `item${product.mine ? ' mine' : ''}${product.shopper ? ' shopper' : ''}`, dataset: { id: product.id } },
      h('div', { class: 'item-head' },
        h('label', { class: 'pick' }, cb, h('span', {}, product.name, unitNote ? h('small', {}, unitNote) : null)),
        h('div', { class: 'qty' }, minus, out, plus)),
      product.mine ? h('p', { class: 'mine-note' }, h('span', { class: 'chip' }, 'Only you see this'), edit) : null,
      product.shopper ? h('p', { class: 'mine-note' }, h('span', { class: 'chip shopper' }, 'Shopper prices'), 'Seen on the shelf and checked') : null,
      h('div', { class: 'tags' }, state.deals.stores.map((s) => tagFor(product, s, best))),
      h('p', { class: 'item-note', id: `note-${product.id}` }));
    li.dataset.find = [product.name, product.gtin || '', ...offers.map((o) => `${o.brand} ${o.deal_text}`)].join(' ').toLowerCase();
    cb.addEventListener('change', () => {
      state.picked.set(product.id, cb.checked);
      renderRow(li, product);
      changed();
    });
    for (const btn of [minus, plus]) {
      btn.addEventListener('click', () => {
        const next = Math.min(99, Math.max(1, state.qty.get(product.id) + Number(btn.dataset.step)));
        state.qty.set(product.id, next);
        state.picked.set(product.id, true);
        renderRow(li, product);
        changed();
      });
    }
    shelf.append(li);
    renderRow(li, product);
  }
  applySearch();
}

// ------------------------------------------------------------------ till slip

let verifyTimer;
let verifySeq = 0;

function row(left, right, cls = 'row') {
  return h('div', { class: cls }, h('span', {}, left), h('span', {}, right));
}

function renderSlip(q, verifiedText = 'Checking totals with the server…', verifiedOk = false) {
  const slip = clear($('slip'));
  const when = new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
  slip.append(h('h3', {}, 'TROLLEYSCOUT'), h('p', { class: 'center' }, 'Black Friday split'), h('p', { class: 'center sub' }, when), h('hr'));
  const items = trolleyItems();
  if (!items.length) {
    slip.append(h('p', { class: 'empty' }, 'Your trolley is empty. Tick items on the shelf to see where to buy each one.'));
    updateBar(q);
    return;
  }
  for (const store of state.deals.stores) {
    const part = q.plan[store.id];
    if (!part.lines.length) continue;
    slip.append(h('p', { class: 'shop' }, h('i', { class: `dot-${store.id}` }), `BUY AT ${store.name.toUpperCase()}`));
    for (const line of part.lines) {
      const unit = UNIT_SHORT[line.unit] || '';
      slip.append(row(`${line.name} ×${line.qty}${unit}`, rand(line.cents)));
    }
    slip.append(row('Subtotal', rand(part.subtotal), 'row sub'), h('hr'));
  }
  slip.append(row('TOTAL', rand(q.splitTotal), 'row total'));
  slip.append(h('span', { class: 'saved' }, 'YOU SAVE', h('b', {}, rand(q.savings.vsHighest))),
    h('p', { class: 'center note' }, 'compared with paying the highest price for each item'));
  const single = q.savings.bestSingle;
  if (single) {
    const name = SHORT[single.store_id];
    slip.append(h('p', { class: 'center note' }, q.savings.vsBestSingle > 0
      ? `${rand(q.savings.vsBestSingle)} less than buying everything at ${name}, the cheapest single shop.`
      : `Buying everything at ${name} costs the same, so one shop does it.`));
  }
  slip.append(h('hr'), h('p', {}, 'One shop only:'));
  for (const store of state.deals.stores) {
    const t = q.storeTotals[store.id];
    const missing = t.missing.length ? ` (${t.missing.length} missing)` : '';
    slip.append(row(`${SHORT[store.id]}${missing}`, rand(t.total), 'row sub'));
  }
  if (q.unavailable.length) slip.append(h('p', { class: 'note' }, `Not available anywhere: ${q.unavailable.length} item(s).`));
  slip.append(h('p', { class: `verified${verifiedOk ? ' ok' : ''}` }, verifiedText));
  updateBar(q);
}

function updateBar(q) {
  $('bar-total').textContent = rand(q.splitTotal);
  $('bar-save').textContent = q.splitTotal ? `You save ${rand(q.savings.vsHighest)}` : 'Tick items to start';
}

function changed() {
  saveLocal();
  const items = trolleyItems();
  const local = quote(state.deals, items);
  renderSlip(local);
  clearTimeout(verifyTimer);
  if (!items.length) return;
  const seq = ++verifySeq;
  verifyTimer = setTimeout(async () => {
    try {
      const { quote: server } = await api('/api/deals?action=quote', { method: 'POST', body: { items } });
      if (seq !== verifySeq) return;
      const same = server.splitTotal === local.splitTotal && server.savings.vsHighest === local.savings.vsHighest;
      if (same) renderSlip(local, '✓ Totals checked by the server against the latest prices.', true);
      else {
        state.publicDeals = await api('/api/deals');
        rebuild();
        renderShelf();
        renderSlip(server, 'Prices changed since you opened the page. These are the latest totals.', true);
      }
    } catch {
      if (seq === verifySeq) renderSlip(local, "Couldn't check totals with the server. These use the prices on screen.");
    }
  }, 450);
}

async function saveTrolley() {
  const st = $('save-status');
  const items = trolleyItems();
  saveLocal();
  if (!state.user) {
    clear(st).className = 'status';
    st.append('Saved on this device. ', h('a', { href: '/account' }, 'Sign in'), ' to keep it on your account.');
    return;
  }
  const btn = $('save-list');
  btn.disabled = true;
  try {
    await api('/api/list', { method: 'PUT', body: { items } });
    status(st, 'Saved to your account.', 'good');
  } catch (err) {
    status(st, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ nearby stores

function radar(origin, stores) {
  const svg = clear($('radar'));
  const C = 170;
  const R = 150;
  const max = Math.max(5, ...stores.map((s) => s.km));
  const scale = (km) => Math.sqrt(km / max) * R;
  for (const f of [0.25, 0.5, 0.75, 1]) {
    const km = max * f * f;
    svg.append(h('svg:circle', { class: 'ring', cx: C, cy: C, r: (R * f).toFixed(1) }),
      h('svg:text', { class: 'ring-label', x: C + 4, y: (C - R * f + 12).toFixed(1) }, `${km < 10 ? km.toFixed(1) : Math.round(km)} km`));
  }
  svg.append(h('svg:path', { class: 'sweep', d: `M${C},${C} L${C},${C - R} A${R},${R} 0 0,1 ${C + R * Math.sin(0.6)},${C - R * Math.cos(0.6)} Z` }));
  stores.forEach((s, i) => {
    const r = scale(s.km);
    const a = (s.bearing * Math.PI) / 180;
    const pin = h('svg:circle', {
      class: `pin pin-${s.store_id}`, cx: (C + r * Math.sin(a)).toFixed(1), cy: (C - r * Math.cos(a)).toFixed(1), r: '8',
      tabindex: '0', role: 'button', 'aria-label': `${s.name}, ${s.km} km`, dataset: { i: String(i) },
    }, h('svg:title', {}, `${s.name} (${s.km} km)`));
    const pick = () => focusStore(i);
    pin.addEventListener('click', pick);
    pin.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
    svg.append(pin);
  });
  svg.append(h('svg:circle', { class: 'you', cx: C, cy: C, r: '6' }), h('svg:text', { class: 'ring-label', x: C + 9, y: C + 4 }, 'You'));
}

function focusStore(i) {
  for (const el of document.querySelectorAll('.store, .pin')) el.classList.toggle('active', el.dataset.i === String(i));
  const card = document.querySelector(`.store[data-i="${i}"]`);
  card?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function storeList(stores) {
  const list = clear($('stores'));
  stores.forEach((s, i) => {
    const dir = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
    const osm = `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=17/${s.lat}/${s.lng}`;
    list.append(h('li', { class: 'store', dataset: { i: String(i) } },
      h('i', { class: `dot-${CHAIN_CLASS[s.chain]}` }),
      h('b', {}, s.name),
      h('span', { class: 'km' }, `${s.km} km`),
      h('span', { class: 'meta' }, [s.address, CHAIN_APP[s.chain]].filter(Boolean).join('. ')),
      h('span', { class: 'links' },
        h('a', { href: dir, target: '_blank', rel: 'noopener noreferrer' }, 'Directions'),
        h('a', { href: osm, target: '_blank', rel: 'noopener noreferrer' }, 'Map'))));
  });
}

function fallbackLinks(st) {
  clear(st).className = 'status error';
  st.append("We couldn't load nearby stores. Search instead: ",
    h('a', { href: 'https://www.google.com/maps/search/Checkers+near+me', target: '_blank', rel: 'noopener noreferrer' }, 'Checkers'), ', ',
    h('a', { href: 'https://www.google.com/maps/search/Pick+n+Pay+near+me', target: '_blank', rel: 'noopener noreferrer' }, 'Pick n Pay'), ', ',
    h('a', { href: 'https://www.google.com/maps/search/Makro+near+me', target: '_blank', rel: 'noopener noreferrer' }, 'Makro'), '.');
}

async function lookup(lat, lng) {
  const st = $('near-status');
  status(st, 'Looking for shops near you…');
  const la = (Math.round(lat * 100) / 100).toFixed(2);
  const lo = (Math.round(lng * 100) / 100).toFixed(2);
  try {
    const data = await api(`/api/stores?lat=${la}&lng=${lo}`);
    if (!data.stores.length) {
      status(st, 'No Checkers, Pick n Pay or Makro found on the map near there. Try a nearby town.', 'error');
      $('near-results').hidden = true;
      return;
    }
    status(st, `Found ${data.stores.length} shops. Tap a dot to see which one it is.`);
    $('near-results').hidden = false;
    radar(data.origin, data.stores);
    storeList(data.stores);
  } catch (err) {
    if (err.status === 400) status(st, err.message, 'error');
    else fallbackLinks(st);
  }
}

function setupNearby() {
  const select = $('city');
  for (const [name, lat, lng] of CITIES) select.append(h('option', { value: `${lat},${lng}` }, name));
  select.addEventListener('change', () => {
    if (!select.value) return;
    const [lat, lng] = select.value.split(',').map(Number);
    lookup(lat, lng);
  });
  $('locate').addEventListener('click', () => {
    const st = $('near-status');
    if (!('geolocation' in navigator)) return status(st, "This browser can't share your location. Pick a town instead.", 'error');
    status(st, 'Asking for your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => lookup(pos.coords.latitude, pos.coords.longitude),
      () => status(st, "We couldn't get your location. Allow location access, or pick a town instead.", 'error'),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// ------------------------------------------------------------------ flyers

async function loadFlyers() {
  try {
    const { items } = await api('/api/uploads');
    if (!items.length) return;
    const grid = clear($('flyer-grid'));
    for (const f of items) {
      grid.append(h('figure', {}, h('img', { src: `/api/uploads?id=${f.id}`, alt: f.caption || 'Deal flyer', loading: 'lazy', decoding: 'async' }),
        f.caption ? h('figcaption', {}, f.caption) : null));
    }
    $('flyers').hidden = false;
  } catch {
    /* flyers are optional */
  }
}

// ------------------------------------------------------------------ start

// ------------------------------------------------------------------ search

const SHOP_SEARCH = [
  ['Checkers', (q) => `https://www.checkers.co.za/search/all?q=${encodeURIComponent(q)}`],
  ['Pick n Pay', (q) => `https://www.pnp.co.za/search/${encodeURIComponent(q)}`],
  ['Makro', (q) => `https://www.makro.co.za/search?q=${encodeURIComponent(q)}`],
];

function searchTerm() {
  return $('search').value.trim().replace(/\s+/g, ' ').slice(0, 60);
}

function applySearch() {
  const term = searchTerm();
  const words = term.toLowerCase().split(' ').filter(Boolean);
  let shown = 0;
  for (const li of document.querySelectorAll('#shelf .item[data-id]')) {
    const hit = words.every((w) => li.dataset.find.includes(w));
    li.hidden = !hit;
    if (hit) shown++;
  }
  const empty = $('search-empty');
  const shops = $('shop-search');
  empty.hidden = !term || shown > 0;
  shops.hidden = !term;
  if (!term) return;
  clear($('search-empty-text')).append(`Nothing on the shelf matches “${term}”.`);
  const links = clear($('shop-links'));
  for (const [name, url] of SHOP_SEARCH) {
    links.append(h('a', { class: 'shop-link', href: url(term), target: '_blank', rel: 'noopener noreferrer' }, name));
  }
  const google = `https://www.google.com/search?q=${encodeURIComponent(`${term} site:checkers.co.za OR site:pnp.co.za OR site:makro.co.za`)}`;
  links.append(h('a', { class: 'shop-link quiet', href: google, target: '_blank', rel: 'noopener noreferrer' }, 'All three on Google'));
  $('shop-search-term').textContent = term;
}

// ------------------------------------------------------------------ your own items

async function reloadMyItems() {
  const r = state.user ? await api('/api/items') : { items: [], features: {} };
  state.myItems = r.items;
  state.features = r.features || {};
  rebuild();
}

async function syncTrolley() {
  saveLocal();
  if (state.user) await api('/api/list', { method: 'PUT', body: { items: trolleyItems() } }).catch(() => {});
}

function closeDialog() {
  const d = $('item-dialog');
  if (d.open) d.close();
}

function openItemDialog(editId, prefillName = '') {
  const d = $('item-dialog');
  const body = clear($('item-dialog-body'));
  const existing = editId ? state.myItems.find((i) => i.id === editId) : null;
  $('item-dialog-title').textContent = existing ? 'Edit your item' : 'Add your own item';
  if (!state.user) {
    body.append(h('p', {}, 'Sign in to add your own items. Only you will see them, and they stay in your trolley on every device.'),
      h('div', { class: 'slip-actions' }, h('a', { class: 'btn', href: '/account' }, 'Sign in'),
        h('a', { class: 'btn secondary', href: '/account?tab=signup' }, 'Create an account')));
  } else {
    body.append(itemForm({
      stores: state.deals.stores,
      features: state.features,
      initial: existing || { name: prefillName },
      submitLabel: existing ? 'Save changes' : 'Add to my trolley',
      note: 'Only you see your items. Use the prices you saw in the app, flyer or shop.',
      onCancel: closeDialog,
      onSubmit: async (item) => {
        const r = await api('/api/items?action=save', { method: 'POST', body: { ...item, id: existing?.id } });
        await reloadMyItems();
        const pid = `u-${r.id}`;
        if (!existing) {
          state.picked.set(pid, true);
          state.qty.set(pid, 1);
        }
        closeDialog();
        $('search').value = '';
        renderShelf();
        changed();
        await syncTrolley();
        document.querySelector(`.item[data-id="${CSS.escape(pid)}"]`)?.scrollIntoView({ block: 'center' });
      },
      onDelete: existing ? async () => {
        await api('/api/items?action=delete', { method: 'POST', body: { id: existing.id } });
        state.picked.delete(`u-${existing.id}`);
        await reloadMyItems();
        closeDialog();
        renderShelf();
        changed();
        await syncTrolley();
      } : null,
    }));
  }
  if (!d.open) d.showModal();
  body.querySelector('input')?.focus();
}

// ------------------------------------------------------------------ at the shop

function signInPrompt(body, why) {
  body.append(h('p', {}, why),
    h('div', { class: 'slip-actions' }, h('a', { class: 'btn', href: '/account' }, 'Sign in'),
      h('a', { class: 'btn secondary', href: '/account?tab=signup' }, 'Create an account')));
}

function openReportDialog() {
  const d = $('item-dialog');
  const body = clear($('item-dialog-body'));
  $('item-dialog-title').textContent = 'Report a shelf price';
  if (!state.user) signInPrompt(body, 'Sign in to send shelf prices. We check each one before everyone sees it.');
  else reportForm(body, { onDone: closeDialog });
  if (!d.open) d.showModal();
}

function openShopDialog() {
  const d = $('shop-dialog');
  shoppingList(clear($('shop-dialog-body')), {
    q: quote(state.deals, trolleyItems()),
    stores: state.deals.stores,
    updatedAt: state.publicDeals.updated_at,
    onReport: openReportDialog,
    onClose: () => d.close(),
  });
  if (!d.open) d.showModal();
}

// Installable app: a small service worker keeps the page and the latest prices for a weak signal.
function setupApp() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try {
      const policy = window.trustedTypes?.createPolicy('ts-sw', {
        createScriptURL: (u) => {
          if (u !== '/sw.js') throw new TypeError('Blocked script URL');
          return u;
        },
      });
      navigator.serviceWorker.register(policy ? policy.createScriptURL('/sw.js') : '/sw.js', { scope: '/' }).catch(() => {});
    } catch {
      /* the site works without it */
    }
  }
  const btn = $('install-app');
  let prompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    prompt = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!prompt) return;
    btn.hidden = true;
    prompt.prompt();
    prompt = null;
  });
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) $('ios-tip').hidden = false;
}

// ------------------------------------------------------------------ start

async function start() {
  setupApp();
  $('report-price').addEventListener('click', openReportDialog);
  $('shop-mode').addEventListener('click', openShopDialog);
  $('shop-dialog-close').addEventListener('click', () => $('shop-dialog').close());
  setupNearby();
  $('save-list').addEventListener('click', saveTrolley);
  $('select-all').addEventListener('click', () => {
    for (const p of state.deals.products) state.picked.set(p.id, true);
    renderShelf();
    changed();
  });
  $('select-none').addEventListener('click', () => {
    for (const p of state.deals.products) state.picked.set(p.id, false);
    renderShelf();
    changed();
  });
  $('search').addEventListener('input', applySearch);
  $('add-item').addEventListener('click', () => openItemDialog(null, searchTerm()));
  $('add-searched').addEventListener('click', () => openItemDialog(null, searchTerm()));
  $('item-dialog-close').addEventListener('click', closeDialog);
  try {
    const [deals, user] = await Promise.all([api('/api/deals'), loadMe()]);
    state.publicDeals = deals;
    state.user = user;
    if (user) await reloadMyItems().catch(() => {});
    rebuild();
  } catch (err) {
    const shelf = clear($('shelf'));
    shelf.append(h('li', { class: 'item' }, h('p', { class: 'status error' }, `${err.message} Reload the page to try again.`)));
    return;
  }
  if (state.user) $('account-link').textContent = 'Your account';
  if (state.publicDeals.updated_at) {
    const d = new Date(state.publicDeals.updated_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
    $('updated').textContent = `Prices last updated ${d}.`;
  }
  let items = null;
  if (state.user) {
    try {
      const saved = await api('/api/list');
      if (saved.items.length) items = saved.items;
    } catch {
      /* fall back to this device */
    }
  }
  items ||= readLocal() || state.publicDeals.products.filter((p) => !p.shopper).map((p) => ({ id: p.id, qty: p.default_qty }));
  applyItems(items);
  renderShelf();
  changed();
  loadFlyers();
}

start();
