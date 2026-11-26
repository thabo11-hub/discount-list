import { api, clear, h, loadMe, passwordField, setCsrf, showFieldError, status, textField } from './ui.js';

const view = document.getElementById('view');
const title = document.getElementById('title');
const NEXT = { admin: '/admin' };

function nextPath() {
  const n = new URLSearchParams(location.search).get('next');
  return Object.hasOwn(NEXT, n || '') ? NEXT[n] : '/';
}

function form(fields, submitLabel, onSubmit) {
  const msg = h('p', { class: 'status', role: 'status' });
  const btn = h('button', { class: 'btn', type: 'submit' }, submitLabel);
  const f = h('form', { class: 'stack', novalidate: true }, fields, btn, msg);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    status(msg, '');
    btn.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(f)), msg, f);
    } catch (err) {
      if (!showFieldError(f, err)) status(msg, err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  return f;
}

const PW_HINT = 'At least 10 characters. Avoid common words with numbers on the end.';

function signInForm() {
  return form([
    textField({ name: 'email', label: 'Email', type: 'email', autocomplete: 'username' }),
    passwordField({ name: 'password', label: 'Password', autocomplete: 'current-password' }),
  ], 'Sign in', async (data) => {
    const r = await api('/api/auth?action=login', { method: 'POST', body: data });
    setCsrf(r.csrf);
    location.assign(nextPath());
  });
}

function signUpForm() {
  return form([
    textField({ name: 'name', label: 'Your name', autocomplete: 'name', maxlength: 60 }),
    textField({ name: 'email', label: 'Email', type: 'email', autocomplete: 'email' }),
    passwordField({ name: 'password', label: 'Password', autocomplete: 'new-password', hint: PW_HINT }),
  ], 'Create account', async (data) => {
    const r = await api('/api/auth?action=signup', { method: 'POST', body: data });
    setCsrf(r.csrf);
    location.assign(nextPath());
  });
}

function forgotForm() {
  return form([
    textField({ name: 'email', label: 'Email', type: 'email', autocomplete: 'email',
      hint: "We'll email a link to choose a new password. It works once and expires in 30 minutes." }),
  ], 'Email me a reset link', async (data, msg, f) => {
    const r = await api('/api/auth?action=forgot', { method: 'POST', body: data });
    status(msg, r.message, 'good');
    f.reset();
  });
}

function signedOut(tab = 'signin') {
  title.textContent = tab === 'signup' ? 'Create your account' : tab === 'forgot' ? 'Reset your password' : 'Sign in';
  const tabs = [['signin', 'Sign in'], ['signup', 'Create account']];
  const bar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) => {
    const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === id) }, label);
    b.addEventListener('click', () => signedOut(id));
    return b;
  }));
  const body = tab === 'signup' ? signUpForm() : tab === 'forgot' ? forgotForm() : signInForm();
  const extra = h('p', { class: 'fine' });
  if (tab === 'signin') {
    const link = h('button', { type: 'button', class: 'linklike' }, 'Forgot your password?');
    link.addEventListener('click', () => signedOut('forgot'));
    extra.append(link);
  } else if (tab === 'forgot') {
    const back = h('button', { type: 'button', class: 'linklike' }, 'Back to sign in');
    back.addEventListener('click', () => signedOut('signin'));
    extra.append(back);
  } else {
    extra.append('Your account saves your trolley so it follows you between devices.');
  }
  clear(view).append(h('section', { class: 'panel' }, tab === 'forgot' ? null : bar, body, extra));
  view.querySelector('input')?.focus();
}

function signedIn(user) {
  title.textContent = `Hi, ${user.name.split(' ')[0]}`;
  const out = h('button', { class: 'btn secondary', type: 'button' }, 'Sign out');
  out.addEventListener('click', async () => {
    await api('/api/auth?action=logout', { method: 'POST', body: {} }).catch(() => {});
    location.assign('/');
  });
  const change = form([
    passwordField({ name: 'current', label: 'Current password', autocomplete: 'current-password' }),
    passwordField({ name: 'password', label: 'New password', autocomplete: 'new-password', hint: PW_HINT }),
  ], 'Change password', async (data, msg, f) => {
    const r = await api('/api/auth?action=password', { method: 'POST', body: data });
    status(msg, r.message, 'good');
    f.reset();
  });
  clear(view).append(
    h('section', { class: 'panel' },
      h('p', {}, 'Signed in as ', h('b', {}, user.email), '.'),
      h('div', { class: 'slip-actions' }, h('a', { class: 'btn', href: '/' }, 'Back to my trolley'), out),
      user.role === 'admin' ? h('p', { class: 'fine' }, h('a', { href: '/admin' }, 'Open admin tools')) : null),
    h('section', { class: 'panel' }, h('h2', {}, 'Change password'), change));
}

async function resetView(token) {
  title.textContent = 'Choose a new password';
  let valid = false;
  try {
    valid = (await api('/api/auth?action=reset-check', { method: 'POST', body: { token } })).valid;
  } catch {
    valid = false;
  }
  if (!valid) {
    clear(view).append(h('section', { class: 'panel' },
      h('p', { class: 'status error' }, 'This reset link is invalid, used or expired. Ask for a new one below.'), forgotForm()));
    return;
  }
  const f = form([passwordField({ name: 'password', label: 'New password', autocomplete: 'new-password', hint: PW_HINT })],
    'Save new password', async (data, msg) => {
      const r = await api('/api/auth?action=reset', { method: 'POST', body: { token, password: data.password } });
      clear(view).append(h('section', { class: 'panel' }, h('p', { class: 'status good' }, r.message), signInForm()));
      void msg;
    });
  clear(view).append(h('section', { class: 'panel' }, f));
}

async function start() {
  const m = /^#reset=([A-Za-z0-9_-]{40,64})$/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname); // keep the token out of history and screenshots
    return resetView(m[1]);
  }
  const user = await loadMe();
  if (user) signedIn(user);
  else signedOut(new URLSearchParams(location.search).get('tab') === 'signup' ? 'signup' : 'signin');
}

start();
