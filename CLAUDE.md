# TrolleyScout (repo: discount-list) — rules for AI and human contributors

Static site in `public/`, Vercel functions in `api/` (shared code in `lib/`), Supabase Postgres.
No runtime npm packages: keep it that way unless the owner approves a new one.

## Security rules (do not weaken)
- Database: tables live in the private `dl` schema. Add data access only as a `public.dl_*`
  function that is `security definer`, has `set search_path = ''`, starts with
  `perform dl.gate(p_key)`, and uses static SQL with typed parameters. Never build SQL strings.
- Secrets only in Vercel env vars (type Sensitive). Never commit `.env*` (except `.env.example`),
  never print secrets, never send them to the browser.
- Every input is validated on the server with `lib/validate.js`.
- Front end: build DOM with `h()` / `textContent`. No `innerHTML`, inline scripts, inline styles or
  inline event handlers (CSP + Trusted Types will break them anyway).
- State-changing API calls: `assertSameOrigin` (signed out) or `requireCsrf` (signed in).
- Admin actions: `requireAdmin` in the API and `dl.require_admin` in the database.
- Sensitive or expensive endpoints use `limit()` from `lib/ratelimit.js` (database-backed).
- Uploads: magic-byte allowlist (JPEG/PNG/WebP), 2 MB max. Never allow SVG or HTML.
- Errors: never return stack traces; `route()` handles this.
- Run `npm test` before every PR. Fixes go on a branch and a PR; the owner approves merges.
