# TrolleyScout

Compare Black Friday prices for household basics at **Checkers Sixty60**, **Pick n Pay asap!** and
**Makro**. Tick what you need and TrolleyScout splits your trolley across the shops so you pay the
least, shows how much you save, and finds the nearest stores.

- Shelf view: every product with each shop's price, the cheapest one tagged, multi-buys and
  per-litre prices worked out, sold-out items skipped.
- Till slip: the cheapest split by shop, your total, how much you save, and each single-shop total.
  Totals are re-checked by the server against the latest prices.
- Shops near you: your location or a town, nearest Checkers, Pick n Pay and Makro on a radar plus
  directions (store data from OpenStreetMap).
- Accounts save your trolley across devices. Admins update prices and upload deal flyers.

## Stack

- `public/`: static HTML, CSS and JS (no framework, no build step).
- `api/`: Vercel Node functions. `lib/`: shared server code.
- Supabase Postgres: private `dl` schema, reached only through key-gated `public.dl_*` functions
  (`sql/001_schema.sql`). Seed prices in `sql/002_seed.sql`.
- No runtime npm packages.

## Run locally

Needs Node 22 and PostgreSQL 16 binaries.

```bash
npm test                      # builds a throwaway database and runs the attack tests
npm run dev                   # needs .env values; see .env.example
```

## Deploy

Vercel project with these environment variables (type **Sensitive**): `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SERVER_KEY`, `IP_HASH_SALT`, `CRON_SECRET`, `APP_ORIGIN`, and optionally
`RESEND_API_KEY` + `MAIL_FROM` for password reset emails. The database stores only the SHA-256 hash
of `SERVER_KEY` (table `dl.server_keys`).

Security notes: [SECURITY.md](SECURITY.md).

TrolleyScout is independent and not linked to Checkers, Shoprite, Pick n Pay or Makro.
Fonts: Anton, Fira Sans and Anonymous Pro under the SIL Open Font License (see `licenses/`).
