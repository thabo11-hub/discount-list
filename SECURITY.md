# Security

TrolleyScout went through a pre-launch security review before its first deployment. Every item
below is covered by an automated test in `tests/` that attacks the running app over HTTP or in a
real browser (`npm test`; CI runs it on every pull request and weekly).

| Area | Protection |
| --- | --- |
| Authentication | Email + password accounts, server-side sessions, lockout after 8 wrong passwords, same reply for unknown accounts |
| Passwords | scrypt (N=2^15, r=8) with a per-password salt; 10+ characters; common passwords refused; old hashes upgraded at sign-in |
| Sessions | Random token in an HttpOnly, Secure, SameSite=Lax `__Host-` cookie; only its hash is stored; 7-day expiry, 2-day idle timeout, rotated at sign-in, revoked at sign-out and password change |
| CSRF | Origin check + custom request header on every write, plus a per-session token for signed-in writes |
| Database | Private schema, RLS on, no grants to API roles; access only through key-gated functions with static, parameterized SQL; admin role re-checked inside the database |
| API keys | All secrets in Vercel env vars; none in the repo or the browser; config validated at start-up and unsafe production config refused |
| HTTPS | Enforced by Vercel, HSTS with preload, plain HTTP refused by the API |
| XSS | All text rendered with `textContent`; strict CSP (no inline script or style) with Trusted Types; markup refused in user input |
| Headers | CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP |
| CORS | Same-origin only; preflights refused; no `Access-Control-Allow-*` headers |
| Rate limits | Shared database counters on sign-in, sign-up, reset, admin, uploads and store lookups |
| Admin | Role checked on the server for every request; needs a sign-in from the last 12 hours; first admin unlocked with a one-time setup code |
| Password reset | 256-bit single-use links, stored hashed, expire in 30 minutes, newest link only, sign out everywhere after reset |
| Uploads | Admin only; JPEG, PNG or WebP by magic bytes; 2 MB max; served with nosniff and a sandbox CSP |
| Auto-fill | Screenshot reading and barcode lookup need sign-in, CSRF and rate limits (30 screenshots an hour each, 400 a day overall); images are checked by bytes, shrunk on the phone and never stored; everything returned by Gemini or Open Food Facts is cleaned and range-checked; the Gemini key never reaches the browser |
| Shopper prices | Sign-in, CSRF and a rate limit (40 an hour, 40 waiting at most) to send one; every field checked on the server; private until the admin approves it (role checked in the API and the database); public data never includes who sent it; approved prices expire after 30 days |
| Service worker | Registered through one Trusted Types policy that allows only `/sw.js`; caches only the home page, its files and the public prices; never touches sign-in, account or admin requests |
| Prices | Totals computed on the server from database prices; the browser sends only product ids and quantities. There are no payments in the app |
| Errors | No stack traces or debug output in production; errors carry a reference id |
| Logging | Security events (failed sign-ins, lockouts, CSRF blocks, rate limits, refused admin access, rejected uploads, price changes) logged without secrets; alerts on the admin page |
| Hygiene | No runtime packages; Dependabot; weekly `npm audit`; full-history secret scan in CI; only `public/` is served |

## Reporting a problem

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a
public issue.
