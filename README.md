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
- Accounts save your trolley across devices, and shoppers add their own private items: scan a
  barcode to fill in the name and size (Open Food Facts), and read a screenshot from the Sixty60,
  PnP asap! or Makro app to fill in the price (Google Gemini).
- Shopper prices: in the shop, a signed-in shopper scans a barcode and sends the shelf price (or
  snaps the shelf label). The admin checks each one; approved prices show for everyone for 30 days,
  marked with the day they were seen.
- In-store mode: "Shop with this list" turns the trolley into a tick-off list per shop with a running
  total. The app installs to the home screen, and a small service worker keeps the page and the latest
  prices for a weak signal.
- Admins update prices, add products for everyone, check shopper prices and upload deal flyers.

## Stack

- `public/`: static HTML, CSS and JS (no framework, no build step).
- `api/`: Vercel Node functions. `lib/`: shared server code.
- Supabase Postgres: private `dl` schema, reached only through key-gated `public.dl_*` functions
  (`sql/001_schema.sql` to `sql/005_shopper_prices.sql`, applied in order). Seed prices in `sql/002_seed.sql`.
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
`RESEND_API_KEY` + `MAIL_FROM` for password reset emails and `GEMINI_API_KEY` for the screenshot reader. The database stores only the SHA-256 hash
of `SERVER_KEY` (table `dl.server_keys`).

Security notes: [SECURITY.md](SECURITY.md).

TrolleyScout is independent and not linked to Checkers, Shoprite, Pick n Pay or Makro.
Fonts: Anton, Fira Sans and Anonymous Pro under the SIL Open Font License (see `licenses/`).
