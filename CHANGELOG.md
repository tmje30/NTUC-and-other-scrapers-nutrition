# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/). Everything stays under
`## [Unreleased]` until the first deploy.

## [Unreleased]

### Added
- Scaffolded Notion Worker project via `ntn workers new` (template
  makenotion/workers-template).
- Portable-core architecture: `src/core/` runtime-agnostic; GitHub Actions is
  the default free runtime, Notion Worker an optional wrapper.
- `src/core/config.ts` — env-based config (dotenv locally, Actions secrets in CI).
- `src/scripts/introspect.ts` + `npm run introspect` — discovers accessible
  Notion DBs, dumps data-source schema and sample rows (incl. `Used '1' Plan`).
- `.env.example` and local `.env` for read-only Notion access via a token.
- `src/core/parse.ts` — name → search term + must-match keywords, and
  `Used 'N' Plan` → monthly usage parsers (verified against live data).
- `src/core/notion.ts` `readPlanTargets()` — resolves active-plan grocery
  targets (baseline price + monthly usage), filtered to groceries. Plan 1 → 27
  targets. `npm run targets` prints them.

- `src/core/stores/` — pluggable store modules. `types.ts` (StoreProduct /
  StoreModule), `weight.ts` (pack-size → grams), and `fairprice.ts` (FairPrice
  via SSR-scrape). `npm run fp -- <terms>` live-tests it.
- `src/core/compare.ts` — matches store products to targets (search-token +
  must-match + form-word negative filter) and finds per-100g deals.
- `src/core/stores/ddp.ts` + `shengsiong.ts` — Sheng Siong store module over
  Meteor DDP/WebSocket (headless, no auth, past Incapsula). `npm run ss -- <t>`.
- `src/core/run.ts` `runOnce()` — full cross-store pass (FairPrice + Sheng Siong),
  best per-100g deal per ingredient. `npm run deals` (Plan 1 → ~14 cross-store deals).
- `src/core/telegram.ts` — formats + sends one Telegram message per deal
  (item, store, per-100g saving, sale note, monthly usage, link).
- `src/github/main.ts` — GitHub Actions entry (`npm start`), with `npm run
  dry-run` to preview messages without a Telegram token.
- `.github/workflows/daily.yml` — daily scheduled run (06:00 SGT) + manual
  dispatch; scans, deploys the deals page to GitHub Pages, then notifies.
- `src/core/site.ts` — renders the daily deals as a styled, mobile/dark-aware
  HTML page (each card links to the store product). `build-site` + `notify`
  scripts; one Telegram summary message ("N deals today → link") replaces the
  per-deal messages.

- Whole-inventory scan: `readGroceryTargets()` reads every grocery ingredient
  (not just the active plan). The page now has two sections — "In your plan"
  (with monthly usage) and "Other items on offer" (rest of the inventory).
  Deal cards also show price per 100g/100ml beside the per-kg/L price.

- **Add button** on every deal card (left of the item row) — pushes the item to
  the Notion **grocery List** DB as `[NTUC] Milk`, at the discounted price, with
  `Vendor` filled and `Amount` left empty. The page is static, so the button
  opens a pre-filled GitHub issue and `.github/workflows/add-to-list.yml` does
  the privileged half. `src/core/grocery-list.ts` writes the row (skipping a
  duplicate un-ticked one); `src/scripts/add-to-list.ts` (`npm run add`) is the
  entry point and takes `--dry-run`.
- **Cooldowns** — an added item stops being searched for
  `pack size ÷ monthly usage × 0.75` (1 kg garlic at 500 g/month → 46 days), or
  a flat 14 days when there's no monthly usage. State lives in
  `data/cooldowns.json`, committed by the same workflow and read by the scan.
  Keyed on the stemmed base noun, so close relatives ("Onion (White)",
  "Onions") are covered by one entry. The page lists what's snoozed and when it
  returns. `src/core/cooldown.ts` (pure) + `cooldown-file.ts` (persistence).
- Optional one-tap path, built but **not deployed**: `addToGroceryList` webhook
  in `src/index.ts` relays a tap to the same workflow via `repository_dispatch`.
  See `docs/one-tap-add.md` for the CORS trade-off and the setup.

### Changed
- Telegram message cleaned up: item name is the link, shows pack size `[700g]`
  / `[640ml]`, price per kg (per L for volumetric), monthly usage; dropped the
  per-month savings figure; "month" spelled out.

### Changed
- Added `@notionhq/client` (v5) + `dotenv`. Portable Notion access no longer
  depends on the Workers runtime.
- Telegram messages now lead with price per **kg** (or per **L** for volumetric
  items — ml/L pack sizes), with per-100g as a secondary line. Weight parser
  tracks `volumetric`; `StoreProduct` gains a `volumetric` flag.
- Daily schedule moved to **06:00 SGT** (`cron: "0 22 * * *"`).

### Fixed

### Pending
- Read Ingredients DB + active meal plan (default: Plan 1.8k) via Notion.
- Name parser: strip parentheticals/trailing qualifiers → search term;
  keyword list (organic, fresh, frozen, enriched, wholegrain, skinless, …)
  → must-match constraints.
- FairPrice store module (search → standard product shape).
- Sheng Siong (AllForYou.sg) store module.
- Price-per-100g normalisation + must-match filtering.
- Parse the "Used '1' Plan" formula string for monthly usage.
- Telegram alert: store, per-100g saving (amount + %), deal duration,
  link, monthly usage — one message per qualifying deal.
- Daily scheduled run.
