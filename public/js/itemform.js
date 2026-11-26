// The "product + price at each shop" form, used by shoppers for their own items and by the admin
// for products everyone sees. Leave a shop's price empty to skip that shop.
import { h, showFieldError, status } from './ui.js';

const SIZE_LABEL = { litre: 'Litres per pack', kg: 'Kg per pack' };
let seq = 0;

function field(label, input, errKey, hint) {
  const id = `if-${++seq}`;
  input.id = id;
  return h('label', { class: 'field', for: id }, h('span', {}, label), input,
    hint ? h('small', {}, hint) : null, h('span', { class: 'err', 'data-err': errKey, 'aria-live': 'polite' }));
}

export function itemForm({ stores, initial = {}, submitLabel = 'Save item', onSubmit, onDelete, onCancel, note }) {
  const name = h('input', { type: 'text', maxlength: '60', required: true, autocomplete: 'off', value: initial.name || '',
    placeholder: 'e.g. White sugar 2.5kg' });
  const unit = h('select', {},
    h('option', { value: 'item' }, 'Each (one pack or bottle)'),
    h('option', { value: 'litre' }, 'Per litre'),
    h('option', { value: 'kg' }, 'Per kg'));
  unit.value = initial.unit || 'item';

  const shops = stores.map((store) => {
    const o = (initial.offers || []).find((x) => x.store_id === store.id);
    const price = h('input', { type: 'text', inputmode: 'decimal', maxlength: '12', autocomplete: 'off', placeholder: 'e.g. 39.99',
      value: o?.deal_price_cents ? (o.deal_price_cents / 100).toFixed(2) : '' });
    const qty = h('input', { type: 'number', min: '1', max: '100', step: '1', value: String(o?.deal_qty ?? 1) });
    const pack = h('input', { type: 'text', inputmode: 'decimal', maxlength: '8', autocomplete: 'off', placeholder: 'e.g. 2.5',
      value: o && Number(o.pack_amount) !== 1 ? String(o.pack_amount) : (o ? '1' : '') });
    const brand = h('input', { type: 'text', maxlength: '60', autocomplete: 'off', value: o?.brand || '', placeholder: 'Optional' });
    const notSold = h('input', { type: 'checkbox' });
    notSold.checked = !!o && !o.in_stock;
    const packField = field(SIZE_LABEL.litre, pack, `${store.id}_pack_amount`);
    const box = h('fieldset', { class: 'shop-box', dataset: { store: store.id } },
      h('legend', {}, store.name),
      h('div', { class: 'shop-grid' },
        field('Price (R)', price, `${store.id}_price`, 'For the whole deal, e.g. 2 for R60 = 60'),
        field('Items in deal', qty, `${store.id}_deal_qty`),
        packField,
        field('Brand or size', brand, `${store.id}_brand`)),
      h('label', { class: 'inline' }, notSold, 'Not sold here or sold out'));
    return { store, price, qty, pack, packField, brand, notSold, box };
  });

  const syncUnit = () => {
    for (const s of shops) {
      s.packField.hidden = unit.value === 'item';
      s.packField.querySelector('span').textContent = SIZE_LABEL[unit.value] || '';
    }
  };
  unit.addEventListener('change', syncUnit);
  syncUnit();

  const msg = h('p', { class: 'status', role: 'status' });
  const save = h('button', { class: 'btn', type: 'submit' }, submitLabel);
  const cancel = onCancel ? h('button', { class: 'btn secondary', type: 'button' }, 'Cancel') : null;
  cancel?.addEventListener('click', onCancel);
  let del = null;
  if (onDelete) {
    del = h('button', { class: 'btn danger', type: 'button' }, 'Delete item');
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Tap again to delete';
        return;
      }
      del.disabled = true;
      try {
        await onDelete();
      } catch (err) {
        status(msg, err.message, 'error');
        del.disabled = false;
      }
    });
  }

  const form = h('form', { class: 'stack item-form', novalidate: true },
    note ? h('p', { class: 'fine' }, note) : null,
    field('Product name', name, 'name'),
    field('Compare prices', unit, 'unit'),
    h('p', { class: 'fine' }, 'Fill in the shops you checked. Leave a price empty to skip that shop.'),
    shops.map((s) => s.box),
    h('span', { class: 'err', 'data-err': 'offers', 'aria-live': 'polite' }),
    h('div', { class: 'slip-actions' }, save, cancel, del),
    msg);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status(msg, '');
    const offers = [];
    for (const s of shops) {
      const hasPrice = s.price.value.trim() !== '';
      if (!hasPrice && !s.notSold.checked) continue;
      offers.push({
        store_id: s.store.id,
        price: hasPrice ? s.price.value.trim() : undefined,
        deal_qty: Number(s.qty.value || 1),
        pack_amount: unit.value === 'item' ? 1 : s.pack.value.trim(),
        brand: s.brand.value,
        in_stock: !s.notSold.checked,
      });
    }
    if (!offers.some((o) => o.in_stock)) {
      showFieldError(form, { message: 'Add a price for at least one shop.', body: { field: 'offers' } });
      return;
    }
    save.disabled = true;
    try {
      await onSubmit({ id: initial.id, name: name.value, unit: unit.value, offers });
    } catch (err) {
      if (!showFieldError(form, err)) status(msg, err.message, 'error');
    } finally {
      save.disabled = false;
    }
  });
  return form;
}
