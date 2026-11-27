// In-store list: the trolley split by shop, ticked off as you put things in the trolley, with a
// running total. Ticks stay on this device, so the list still works with a weak signal in the shop.
import { UNIT_SHORT, rand } from './pricing.js';
import { clear, h } from './ui.js';

const TICK_KEY = 'ts_ticks_v1';

function readTicks() {
  try {
    const v = JSON.parse(localStorage.getItem(TICK_KEY) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 100) : []);
  } catch {
    return new Set();
  }
}

function saveTicks(ticks) {
  try {
    localStorage.setItem(TICK_KEY, JSON.stringify([...ticks]));
  } catch {
    /* storage blocked: ticks last for this visit */
  }
}

/**
 * Renders the list into `body`.
 * q: a quote from pricing.js. stores: deals.stores. Buttons call onReport and onClose.
 */
export function shoppingList(body, { q, stores, updatedAt, onReport, onClose }) {
  const ticks = readTicks();
  const lines = stores.flatMap((s) => q.plan[s.id].lines.map((l) => ({ ...l, store: s })));
  for (const t of [...ticks]) if (!lines.some((l) => l.id === t)) ticks.delete(t);
  saveTicks(ticks);

  const total = h('b', {});
  const count = h('span', {});
  const bar = h('progress', { max: String(Math.max(1, lines.length)), value: '0', 'aria-label': 'Items in your trolley' });
  const update = () => {
    const got = lines.filter((l) => ticks.has(l.id));
    total.textContent = `${rand(got.reduce((a, l) => a + l.cents, 0))} of ${rand(q.splitTotal)}`;
    count.textContent = `${got.length} of ${lines.length} items in your trolley`;
    bar.value = got.length;
  };

  const report = h('button', { class: 'btn small', type: 'button' }, 'Report a shelf price');
  report.addEventListener('click', onReport);
  const reset = h('button', { class: 'btn small secondary', type: 'button' }, 'Untick all');
  const done = h('button', { class: 'btn small secondary', type: 'button' }, 'Close');
  done.addEventListener('click', onClose);

  const groups = [];
  for (const store of stores) {
    const part = q.plan[store.id];
    if (!part.lines.length) continue;
    const items = part.lines.map((l) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = ticks.has(l.id);
      const unit = UNIT_SHORT[l.unit] || '';
      const li = h('li', { class: cb.checked ? 'got' : '' },
        h('label', {}, cb,
          h('span', { class: 'what' }, `${l.name} ×${l.qty}${unit}`,
            l.deal_qty > 1 ? h('small', {}, `Buy in ${l.deal_qty}s for this price`) : null,
            l.brand && !l.name.toLowerCase().startsWith(l.brand.toLowerCase()) ? h('small', {}, l.brand) : null),
          h('span', { class: 'cost' }, rand(l.cents))));
      cb.addEventListener('change', () => {
        if (cb.checked) ticks.add(l.id);
        else ticks.delete(l.id);
        li.classList.toggle('got', cb.checked);
        saveTicks(ticks);
        update();
      });
      return li;
    });
    groups.push(h('section', { class: 'shop-group', dataset: { store: store.id } },
      h('h3', {}, h('i', { class: `dot-${store.id}` }), store.name, h('span', {}, rand(part.subtotal))),
      h('ul', { class: 'checklist' }, items)));
  }
  reset.addEventListener('click', () => {
    ticks.clear();
    saveTicks(ticks);
    for (const cb of body.querySelectorAll('.checklist input')) cb.checked = false;
    for (const li of body.querySelectorAll('.checklist li')) li.classList.remove('got');
    update();
  });

  const when = updatedAt ? new Date(updatedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }) : '';
  const parts = [
    h('div', { class: 'in-store-sum' }, total, count, bar),
    navigator.onLine === false ? h('p', { class: 'status' }, `You're offline. These are the prices from ${when || 'your last visit'}.`) : null,
    lines.length ? groups : h('p', { class: 'empty' }, 'Your trolley is empty. Tick items on the shelf first.'),
    h('p', { class: 'fine' }, 'Is the shelf price different? Send it, so the next shopper sees the real price.'),
    h('div', { class: 'slip-actions' }, report, reset, done),
  ];
  clear(body).append(...parts.flat().filter(Boolean));
  update();
}
