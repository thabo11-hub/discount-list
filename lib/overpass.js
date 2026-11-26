// Nearest Checkers, Pick n Pay and Makro stores from OpenStreetMap (Overpass API).
// The query is built only from validated numbers, so nothing a user types reaches it.

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export const CHAINS = [
  { chain: 'Checkers', store_id: 'sixty60', match: /checkers/i },
  { chain: 'Pick n Pay', store_id: 'pnp-asap', match: /pick\s*n\s*pay|pick'n'pay|picknpay/i },
  { chain: 'Makro', store_id: 'makro', match: /makro/i },
];
const SKIP = /\b(liquor\w*|clothing|pharmacy|pet\w*|home|express|forecourt|kiosk)\b/i;

const cache = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;

export function buildQuery(lat, lng, radiusM) {
  const at = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const r = Math.round(radiusM);
  // Checkers and Pick n Pay: everything nearby. Makro: exact brand/name tag lookups, which the
  // tag index answers fast (a wide radius search was too slow for the public Overpass servers).
  return `[out:json][timeout:15];
(
  nwr["shop"]["brand"~"^(checkers|checkers hyper|pick n pay|pick n pay hyper|pick n pay family)$",i](around:${r},${at});
  nwr["shop"]["name"~"^(checkers|pick n pay)",i](around:${r},${at});
  nwr["brand"="Makro"];
  nwr["name"="Makro"];
);
out center tags 400;`;
}

export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const clip = (s, n) => String(s || '').replace(/[\u0000-\u001f<>`]/g, '').slice(0, n);

export function pickStores(elements, origin, perChain = 4, maxKm = { Checkers: 25, 'Pick n Pay': 25, Makro: 300 }) {
  const seen = new Set();
  const out = [];
  for (const el of elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const tags = el.tags || {};
    const label = `${tags.brand || ''} ${tags.name || ''}`;
    const chain = CHAINS.find((c) => c.match.test(label));
    if (!chain || SKIP.test(label)) continue;
    const key = `${chain.chain}:${lat.toFixed(3)}:${lng.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const point = { lat, lng };
    const km = distanceKm(origin, point);
    if (km > (maxKm[chain.chain] ?? 25)) continue;
    const address = [tags['addr:street'] && `${tags['addr:housenumber'] || ''} ${tags['addr:street']}`.trim(),
      tags['addr:suburb'], tags['addr:city']].filter(Boolean).join(', ');
    out.push({
      chain: chain.chain,
      store_id: chain.store_id,
      name: clip(tags.name || chain.chain, 80),
      address: clip(address, 120),
      lat: Math.round(lat * 1e5) / 1e5,
      lng: Math.round(lng * 1e5) / 1e5,
      km: Math.round(km * 10) / 10,
      bearing: Math.round(bearingDeg(origin, point)),
    });
  }
  out.sort((a, b) => a.km - b.km);
  const counts = {};
  return out.filter((s) => (counts[s.chain] = (counts[s.chain] || 0) + 1) <= perChain);
}

export async function nearbyStores(lat, lng, radiusM = 12000) {
  const key = `${lat},${lng},${radiusM}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const body = `data=${encodeURIComponent(buildQuery(lat, lng, radiusM))}`;
  let lastErr;
  const started = Date.now();
  for (const url of ENDPOINTS) {
    if (Date.now() - started > 12000) break; // stay inside the function time limit
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'TrolleyScout/1.0 (deal comparison; github.com/thabo11-hub/discount-list)',
        },
        body,
        signal: AbortSignal.timeout(11000),
      });
      if (!res.ok) throw new Error(`overpass_http_${res.status}`);
      const json = await res.json();
      const data = pickStores(json.elements, { lat, lng });
      cache.set(key, { at: Date.now(), data });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
