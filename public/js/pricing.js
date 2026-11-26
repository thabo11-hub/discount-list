// Trolley maths, shared by the browser (instant totals) and the server (the totals that count).
// All money is in integer cents.

/** Cents per compare unit (one item, or one litre for products sold by the litre). */
export function unitCents(offer) {
  if (!offer || !offer.in_stock || !offer.deal_price_cents) return null;
  return offer.deal_price_cents / (offer.deal_qty * Number(offer.pack_amount || 1));
}

export function lineCents(offer, qty) {
  const unit = unitCents(offer);
  return unit === null ? null : Math.round(unit * qty);
}

/** Index offers by product, then store. */
export function indexOffers(deals) {
  const byProduct = new Map();
  for (const o of deals.offers) {
    if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, new Map());
    byProduct.get(o.product_id).set(o.store_id, o);
  }
  return byProduct;
}

/** For one product: cheapest and dearest available offer, and whether brands differ. */
export function compareProduct(deals, productId, index = indexOffers(deals)) {
  const offers = index.get(productId) || new Map();
  let best = null;
  let worst = null;
  const brands = new Set();
  for (const store of deals.stores) {
    const o = offers.get(store.id);
    if (o?.brand) brands.add(o.brand.split(' ')[0].toLowerCase());
    const unit = unitCents(o);
    if (unit === null) continue;
    if (!best || unit < best.unit) best = { store_id: store.id, unit };
    if (!worst || unit > worst.unit) worst = { store_id: store.id, unit };
  }
  return { best, worst, brandsDiffer: brands.size > 1 };
}

/**
 * Quote a trolley.
 * items: [{ id, qty }]
 * Returns the cheapest split across shops, each single-shop total, and the savings.
 */
export function quote(deals, items) {
  const index = indexOffers(deals);
  const products = new Map(deals.products.map((p) => [p.id, p]));
  const storeTotals = Object.fromEntries(deals.stores.map((s) => [s.id, { total: 0, missing: [] }]));
  const plan = Object.fromEntries(deals.stores.map((s) => [s.id, { subtotal: 0, lines: [] }]));
  let splitTotal = 0;
  let highestTotal = 0;
  const unavailable = [];

  for (const { id, qty } of items) {
    const product = products.get(id);
    if (!product) continue;
    const offers = index.get(id) || new Map();
    let best = null;
    let worst = null;
    for (const store of deals.stores) {
      const cents = lineCents(offers.get(store.id), qty);
      if (cents === null) {
        storeTotals[store.id].missing.push(id);
        continue;
      }
      storeTotals[store.id].total += cents;
      if (!best || cents < best.cents) best = { store_id: store.id, cents };
      if (!worst || cents > worst.cents) worst = { store_id: store.id, cents };
    }
    if (!best) {
      unavailable.push(id);
      continue;
    }
    const offer = offers.get(best.store_id);
    plan[best.store_id].lines.push({
      id,
      name: product.name,
      qty,
      unit: product.unit,
      cents: best.cents,
      deal_qty: offer.deal_qty,
      deal_text: offer.deal_text,
      brand: offer.brand,
    });
    plan[best.store_id].subtotal += best.cents;
    splitTotal += best.cents;
    highestTotal += worst.cents;
  }

  // Best single shop = cheapest shop that has everything in the trolley.
  let bestSingle = null;
  for (const store of deals.stores) {
    const t = storeTotals[store.id];
    if (t.missing.length) continue;
    if (!bestSingle || t.total < bestSingle.total) bestSingle = { store_id: store.id, total: t.total };
  }

  return {
    splitTotal,
    plan,
    storeTotals,
    unavailable,
    savings: {
      vsHighest: highestTotal - splitTotal,
      vsBestSingle: bestSingle ? bestSingle.total - splitTotal : null,
      bestSingle,
    },
  };
}

export function rand(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const r = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}R${r}.${String(abs % 100).padStart(2, '0')}`;
}

/** A shopper's private items become extra products ("u-<uuid>") visible only to them. */
export function withUserItems(deals, items) {
  if (!items?.length) return deals;
  return {
    ...deals,
    products: [...deals.products, ...items.map((i) => ({ id: `u-${i.id}`, name: i.name, unit: i.unit, default_qty: 1, mine: true }))],
    offers: [...deals.offers, ...items.flatMap((i) => i.offers.map((o) => ({ ...o, product_id: `u-${i.id}` })))],
  };
}

export const UNIT_SUFFIX = { item: '', litre: '/L', kg: '/kg' };
export const UNIT_SHORT = { item: '', litre: 'L', kg: 'kg' };
