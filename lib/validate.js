// Server-side validation for every input. The browser checks are only for convenience;
// these are the ones that count.
import { HttpError } from './http.js';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export function fail(field, message) {
  throw new HttpError(400, message, { code: 'invalid_input', field });
}

export function email(value) {
  if (typeof value !== 'string') fail('email', 'Enter your email address.');
  const v = value.trim().toLowerCase();
  if (v.length < 3 || v.length > 254 || CONTROL.test(v) || !/^[^\s@<>()"',;:\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) {
    fail('email', 'Enter a valid email address, like name@example.com.');
  }
  return v;
}

export function name(value) {
  if (typeof value !== 'string') fail('name', 'Enter your name.');
  const v = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (v.length < 1 || v.length > 60) fail('name', 'Use a name between 1 and 60 characters.');
  if (CONTROL.test(v) || /[<>{}[\]\\`$]/.test(v)) fail('name', 'Use letters, numbers, spaces and simple punctuation only.');
  return v;
}

const BASE_WORDS = [
  'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'administrator', 'iloveyou',
  'monkey', 'dragon', 'football', 'soccer', 'baseball', 'sunshine', 'princess', 'shadow', 'master', 'superman',
  'batman', 'trustno1', 'abc123', 'abcdef', 'abcdefgh', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'starwars', 'whatever',
  'trolley', 'trolleyscout', 'discount', 'blackfriday', 'southafrica', 'mzansi', 'johannesburg', 'capetown',
  'durban', 'pretoria', 'soweto', 'kaizerchiefs', 'orlandopirates', 'bafana', 'springbok', 'springboks',
  'checkers', 'picknpay', 'makro', 'sixty60', 'shoprite', 'login', 'changeme', 'secret', 'default', 'test',
];
const COMMON = new Set([
  '1234567890', '12345678910', '123456789a', '0987654321', '1111111111', '0000000000', '1234512345',
  '1q2w3e4r5t', '1qaz2wsx3edc', 'q1w2e3r4t5', 'qwerty123456', 'qwertyuiop', 'password12', 'password123',
  'password1!', 'password!1', 'iloveyou12', 'iloveyou123', 'letmein123', 'welcome123', 'admin12345',
  'abcd123456', 'abc1234567', 'aa12345678', 'zaq12wsxcde', 'football123', 'sunshine123', 'princess123',
  'monkey12345', 'dragon12345', 'baseball123', 'superman123', 'starwars123', 'whatever123', 'trustno1234',
]);

/** Returns an error message, or null if the password is acceptable. */
export function passwordProblem(pw, userEmail = '') {
  if (typeof pw !== 'string' || pw.length === 0) return 'Enter a password.';
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 128) return 'Use 128 characters or fewer.';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common. Pick something harder to guess.';
  const core = lower.replace(/[^a-z]/g, '');
  if (BASE_WORDS.includes(core) || BASE_WORDS.includes(lower.replace(/[\d\W_]+$/, ''))) {
    return 'That password is too easy to guess. Avoid common words with numbers on the end.';
  }
  if (/^(.)\1+$/.test(pw) || new Set(pw).size < 5) return 'Use a more varied mix of characters.';
  if (/^(0123456789|1234567890|9876543210)+/.test(pw)) return 'Avoid number sequences.';
  const local = String(userEmail).split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return "Don't use your email address in your password.";
  return null;
}

export function password(value, userEmail) {
  const problem = passwordProblem(value, userEmail);
  if (problem) fail('password', problem);
  return value;
}

export function loginPassword(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) fail('password', 'Enter your password.');
  return value;
}

export function token(value, field = 'token') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(value)) {
    fail(field, 'This link is invalid or has expired. Ask for a new one.');
  }
  return value;
}

export function slug(value, field, max = 40) {
  if (typeof value !== 'string' || !new RegExp(`^[a-z0-9-]{2,${max}}$`).test(value)) {
    fail(field, 'Use 2 or more lowercase letters, numbers or dashes.');
  }
  return value;
}

export function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail(field, 'Enter text.');
  const v = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (required && !v) fail(field, 'This field is required.');
  if (v.length > max) fail(field, `Use ${max} characters or fewer.`);
  if (CONTROL.test(v) || /[<>`]/.test(v)) fail(field, 'Remove special characters like < > or `.');
  return v;
}

export function int(value, field, min, max) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) fail(field, `Enter a whole number from ${min} to ${max}.`);
  return n;
}

export function bool(value, field) {
  if (typeof value !== 'boolean') fail(field, 'Choose yes or no.');
  return value;
}

/** Rand amount -> integer cents. Accepts 64.99, "64.99", "R64.99", "R 1 299,50". */
export function priceCents(value, field = 'price') {
  let s = typeof value === 'number' ? value.toFixed(2) : String(value ?? '');
  s = s.trim().replace(/^R\s*/i, '').replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) fail(field, 'Enter a price like 64.99 (up to R999 999.99).');
  const [rand, cents = ''] = s.split('.');
  const total = Number(rand) * 100 + Number((cents + '00').slice(0, 2));
  if (total < 1 || total > 10_000_000) fail(field, 'Enter a price between R0.01 and R100 000.');
  return total;
}

export function packAmount(value, field = 'pack_amount') {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 1000 || Math.round(n * 1000) !== n * 1000) {
    fail(field, 'Enter a size from 0.001 to 1000 (up to 3 decimals).');
  }
  return n;
}

export function uuid(value, field = 'id') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    fail(field, 'Invalid id.');
  }
  return value;
}

/** Trolley items: [{ id, qty }], at most 60 lines. */
export function trolleyItems(value, productIds) {
  if (!Array.isArray(value)) fail('items', 'Send a list of items.');
  if (value.length > 60) fail('items', 'A trolley can hold up to 60 lines.');
  const seen = new Set();
  return value.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('items', `Item ${i + 1} is not valid.`);
    const id = slug(item.id, `items[${i}].id`);
    if (productIds && !productIds.has(id)) fail('items', `Unknown product: ${id}.`);
    if (seen.has(id)) fail('items', `Product listed twice: ${id}.`);
    seen.add(id);
    return { id, qty: int(item.qty, `items[${i}].qty`, 1, 99) };
  });
}

/** South African coordinates only (also limits abuse of the store lookup). */
export function coords(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -35.5 || la > -21.5 || lo < 16 || lo > 33.5) {
    fail('location', 'Pick a location inside South Africa.');
  }
  return { lat: Math.round(la * 100) / 100, lng: Math.round(lo * 100) / 100 };
}
