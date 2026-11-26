// Small DOM and API helpers. Text is always inserted with textContent / createTextNode, never as
// HTML, and the page CSP enforces Trusted Types, so an HTML string sink would throw.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('a', { href, class }, 'text', childNode) */
export function h(tag, attrs = {}, ...children) {
  const svg = tag.startsWith('svg:');
  const el = svg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (/^on/i.test(k)) throw new Error('Use addEventListener, not inline handlers');
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'href' && !/^(\/|#|https:\/\/)/.test(String(v))) throw new Error('Unsafe link');
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

let csrf = null;
export const setCsrf = (t) => (csrf = t);

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body || {};
  }
}

/** Same-origin JSON API call with the CSRF headers the server expects. */
export async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-Requested-With': 'TrolleyScout', ...headers },
  };
  if (csrf) opts.headers['X-CSRF-Token'] = csrf;
  if (raw) opts.body = raw;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError("Can't reach TrolleyScout. Check your connection and try again.", 0);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(data.error || `Something went wrong (${res.status}).`, res.status, data);
  return data;
}

export async function loadMe() {
  try {
    const me = await api('/api/auth?action=me');
    setCsrf(me.csrf);
    return me.user;
  } catch {
    return null;
  }
}

export function status(el, text, kind = '') {
  el.textContent = text || '';
  el.className = `status ${kind}`.trim();
}

const EYE = 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10-3.2a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z';
const EYE_OFF = 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.9-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2';

function eyeIcon(off) {
  const path = h('svg:path', { d: off ? EYE_OFF : EYE, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });
  return h('svg:svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, path);
}

/** Password input with a Show / Hide button. */
export function passwordField({ name, label, autocomplete, hint }) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const input = h('input', { type: 'password', id, name, autocomplete, required: true, maxlength: '128', spellcheck: 'false', autocapitalize: 'off' });
  const text = h('span', {}, 'Show');
  const btn = h('button', { type: 'button', 'aria-controls': id, 'aria-pressed': 'false', 'aria-label': `Show ${label.toLowerCase()}` }, eyeIcon(false), text);
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!showing));
    btn.setAttribute('aria-label', `${showing ? 'Show' : 'Hide'} ${label.toLowerCase()}`);
    text.textContent = showing ? 'Show' : 'Hide';
    btn.replaceChild(eyeIcon(!showing), btn.firstChild);
    input.focus();
  });
  return h('label', { class: 'field', for: id },
    h('span', {}, label),
    h('div', { class: 'pw' }, input, btn),
    hint ? h('small', {}, hint) : null,
    h('span', { class: 'err', 'data-err': name, 'aria-live': 'polite' }));
}

export function textField({ name, label, type = 'text', autocomplete, maxlength = 254, hint, value = '' }) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const input = h('input', { type, id, name, autocomplete, required: true, maxlength: String(maxlength), value });
  return h('label', { class: 'field', for: id }, h('span', {}, label), input,
    hint ? h('small', {}, hint) : null, h('span', { class: 'err', 'data-err': name, 'aria-live': 'polite' }));
}

export function showFieldError(form, err) {
  for (const e of form.querySelectorAll('[data-err]')) e.textContent = '';
  const field = err?.body?.field;
  const slot = field && form.querySelector(`[data-err="${CSS.escape(field)}"]`);
  if (slot) slot.textContent = err.message;
  return !!slot;
}
