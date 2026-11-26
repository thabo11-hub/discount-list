// The "product + price at each shop" form, used by shoppers for their own items and by the admin
// for products everyone sees. Leave a shop's price empty to skip that shop.
import { api, h, showFieldError, status } from './ui.js';

const SIZE_LABEL = { litre: 'Litres per pack', kg: 'Kg per pack' };
let seq = 0;

/** Shrink a photo or screenshot on the phone before upload (also drops its camera metadata). */
async function shrink(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error("That file isn't an image this browser can open. Use a screenshot or JPEG photo.");
  }
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  for (const q of [0.85, 0.65, 0.45]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
    if (blob && blob.size <= 1900 * 1024) return blob;
  }
  throw new Error('That image is too large. Crop it to the product and try again.');
}

async function detectBarcode(file) {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
    const found = await detector.detect(await createImageBitmap(file));
    return found[0]?.rawValue || null;
  } catch {
    return null;
  }
}

const readImage = async (file) => (await api('/api/lookup?action=screenshot', {
  method: 'POST', raw: await shrink(file), headers: { 'Content-Type': 'image/jpeg' },
})).reading;

const SHOP_NAME = { sixty60: 'Sixty60', 'pnp-asap': 'PnP asap!', makro: 'Makro' };

function field(label, input, errKey, hint) {
  const id = `if-${++seq}`;
  input.id = id;
  return h('label', { class: 'field', for: id }, h('span', {}, label), input,
    hint ? h('small', {}, hint) : null, h('span', { class: 'err', 'data-err': errKey, 'aria-live': 'polite' }));
}

export function itemForm({ stores, initial = {}, submitLabel = 'Save item', onSubmit, onDelete, onCancel, note, features = {} }) {
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
    const shotStatus = h('p', { class: 'status', role: 'status' });
    let shotBtn = null;
    if (features.screenshot) {
      const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
      shotBtn = h('button', { type: 'button', class: 'btn small secondary shot' }, 'Read a screenshot');
      shotBtn.addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files[0];
        file.value = '';
        if (!f) return;
        shotBtn.disabled = true;
        status(shotStatus, 'Reading your screenshot…');
        try {
          fillFromReading(store.id, await readImage(f), shotStatus);
        } catch (err) {
          status(shotStatus, err.message, 'error');
        } finally {
          shotBtn.disabled = false;
        }
      });
      shotBtn.fileInput = file;
    }
    const box = h('fieldset', { class: 'shop-box', dataset: { store: store.id } },
      h('legend', {}, store.name),
      shotBtn ? h('div', { class: 'shot-row' }, shotBtn, shotBtn.fileInput, shotStatus) : null,
      h('div', { class: 'shop-grid' },
        field('Price (R)', price, `${store.id}_price`, 'For the whole deal, e.g. 2 for R60 = 60'),
        field('Items in deal', qty, `${store.id}_deal_qty`),
        packField,
        field('Brand or size', brand, `${store.id}_brand`)),
      h('label', { class: 'inline' }, notSold, 'Not sold here or sold out'));
    return { store, price, qty, pack, packField, brand, notSold, box };
  });
  const byStore = new Map(shops.map((s) => [s.store.id, s]));

  // ---- auto-fill
  const sizes = new Map();
  let productSize = null;
  const setIfEmpty = (input, value) => {
    if (value && !input.value.trim()) input.value = value;
  };
  const sizeNote = h('p', { class: 'fine size-note', hidden: true });
  function applySizes() {
    const known = [...sizes.values()];
    const differ = known.length >= 2 && new Set(known.map((z) => z.dim)).size === 1 && new Set(known.map((z) => z.amount)).size > 1;
    if (!differ) return;
    unit.value = known[0].dim === 'mass' ? 'kg' : 'litre';
    for (const s of shops) {
      const z = sizes.get(s.store.id) || productSize;
      if (z) s.pack.value = String(z.amount);
    }
    syncUnit();
    sizeNote.hidden = false;
    sizeNote.textContent = `Pack sizes differ between shops, so prices are compared ${unit.value === 'kg' ? 'per kg' : 'per litre'}.`;
  }
  function fillFromReading(storeId, r, out) {
    const s = byStore.get(storeId);
    if (!name.value.trim()) name.value = r.name;
    if (r.price) s.price.value = r.price;
    s.qty.value = String(r.deal_qty || 1);
    setIfEmpty(s.brand, r.brand);
    s.notSold.checked = false;
    if (r.size) {
      sizes.set(storeId, r.size);
      s.pack.value = String(r.size.amount);
    }
    applySizes();
    const parts = [r.price ? `Filled in R${r.price}${r.deal_qty > 1 ? ` for ${r.deal_qty}` : ''}. Check it matches.` : "Read the product, but couldn't see a price. Type it in."];
    if (r.shop && r.shop !== storeId) parts.push(`This looks like a ${SHOP_NAME[r.shop]} screenshot.`);
    status(out, parts.join(' '), r.price ? 'good' : 'error');
  }
  function fillFromBarcode(p) {
    name.value = p.name;
    productSize = p.size;
    for (const s of shops) {
      setIfEmpty(s.brand, p.brand);
      if (p.size && !s.pack.value.trim()) s.pack.value = String(p.size.amount);
    }
  }

  // ---- barcode panel
  let barcodeBox = null;
  if (features.barcode) {
    const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '16', autocomplete: 'off', placeholder: 'The numbers under the barcode' });
    const photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    const canPhoto = 'BarcodeDetector' in window || features.screenshot;
    const photoBtn = canPhoto ? h('button', { type: 'button', class: 'btn small secondary' }, 'Take a photo of the barcode') : null;
    const find = h('button', { type: 'button', class: 'btn small' }, 'Look up');
    const out = h('p', { class: 'status', role: 'status' });
    const lookup = async () => {
      const digits = code.value.replace(/\D/g, '');
      if (!digits) return status(out, 'Type the numbers under the barcode first.', 'error');
      find.disabled = true;
      status(out, 'Looking it up…');
      try {
        const { product } = await api(`/api/lookup?action=barcode&code=${encodeURIComponent(digits)}`);
        fillFromBarcode(product);
        status(out, `Found ${product.name}. Now add the price at each shop${features.screenshot ? ', or read a screenshot' : ''}.`, 'good');
      } catch (err) {
        status(out, err.message, 'error');
      } finally {
        find.disabled = false;
      }
    };
    find.addEventListener('click', lookup);
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookup();
      }
    });
    photoBtn?.addEventListener('click', () => photo.click());
    photo.addEventListener('change', async () => {
      const f = photo.files[0];
      photo.value = '';
      if (!f) return;
      status(out, 'Reading the barcode…');
      let digits = await detectBarcode(f);
      if (!digits && features.screenshot) {
        try {
          digits = (await readImage(f)).barcode;
        } catch {
          digits = null;
        }
      }
      if (!digits) return status(out, "Couldn't read that barcode. Type the numbers under it instead.", 'error');
      code.value = digits;
      lookup();
    });
    barcodeBox = h('details', { class: 'barcode-box' },
      h('summary', {}, 'Scan a barcode to fill in the name and size'),
      h('div', { class: 'barcode-row' }, field('Barcode number', code, 'barcode'), find),
      photoBtn ? h('div', { class: 'barcode-row' }, photoBtn, photo) : null,
      out,
      h('p', { class: 'fine' }, 'Product details come from the free Open Food Facts database, which covers most food and some household products.'));
  }

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
    barcodeBox,
    field('Product name', name, 'name'),
    field('Compare prices', unit, 'unit'),
    sizeNote,
    h('p', { class: 'fine' }, features.screenshot
      ? 'For each shop, read a screenshot from its app (or a photo of the shelf ticket), or type the price. Leave a shop empty to skip it. Screenshots go to Google Gemini to be read; TrolleyScout doesn\'t keep them.'
      : 'Fill in the shops you checked. Leave a price empty to skip that shop.'),
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
