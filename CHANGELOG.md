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
- **Incapsula recovery for the Sheng Siong runner.** From 2026-07-30 the site
  answered every plain-HTTP request — homepage included — with a JS challenge, so
  all 62 searches failed and the scan went FairPrice-only. Measured in order:
  browser-like headers don't clear it, replaying the challenge's own cookies
  doesn't (the JS must run), `--headless=new` doesn't (headless is detected), a
  headed Chrome does. `src/core/stores/incapsula.ts` therefore launches the
  installed Chrome off-screen with a throwaway profile, lets it solve the
  challenge as any visit would, and caches the session cookie to
  `.sessions/shengsiong.json` (gitignored). The cookie is tried first and Chrome
  only appears once it stops working, so an ordinary run launches no browser.
  Uses `ws` + CDP — no Playwright, no new dependency.
- **A missing shop is now visible.** `RunResult.shengsiong` reports freshness;
  the page shows a warning banner and the daily Telegram message says so —
  sending even on a zero-deal day, since silence is exactly what a broken runner
  looks like. `laptop-run.cmd` (and the live wrapper) now return the real exit
  code: Task Scheduler had logged "Last Run Result: 0" on a run where everything
  failed, which is why the outage went unnoticed for a day.
- **Counted items are compared too** (`By Unit` — eggs, slices, tea bags), in
  whichever dimension the shop published. Per piece where it gives a count:
  FairPrice lists eggs as 30s and 10s, and its cheapest carton per egg carries no
  weight at all, so a weight-only comparison could never see it. Per 100g where
  it gives only weight, against a size written into the item's own name
  ("Bread, Wholemeal (600g)") — every bread FairPrice returns is weight-only,
  which is why that convention exists. `Deal`/`ReviewMiss` now carry a
  `dimension` with `baseline`/`productPrice`, replacing the per-100g-only fields,
  and the page/Telegram print "$0.222 each" or "$3.60/kg" accordingly.
  Guardrails, because counting hides size where weight does not: pieces are only
  compared when both stated sizes are within 2.5×, and a plain "egg" item now
  rejects another bird's, preserved or cooked eggs (a quail egg read as 24% off
  against a hen's egg while weighing a sixth as much).
- **Item actions** — two buttons on each row of "Recently bought · not
  searched". *Reset* clears the item's cooldown so the next daily run searches
  it again. *Not in use* tags the Notion ingredient `Not in Use ATM` (appended
  to its existing tags, never assigned over them) and clears the cooldown, so a
  parked item leaves the page too; it asks for confirmation first, since undoing
  it means removing the tag by hand. `src/core/item-actions.ts` (payload),
  `src/core/park.ts` (the Notion write — verifies the tag option exists rather
  than letting Notion invent one), `src/scripts/item-action.ts`
  (`npm run item-action`, takes `--dry-run`) and
  `.github/workflows/item-actions.yml`, deliberately separate from
  `add-to-list.yml`.
- **Correction menu on every card** — a `⋯` button under the percentage (and
  under the *closest* label on a close match), holding three actions that teach
  the matcher instead of just hiding today's card:
  - *Ignore 1× week* — a cooldown until Monday 00:00 SGT (`startOfNextWeek`),
    tagged `reason: "ignored"` so the page lists it under "Ignored this week"
    rather than lying about it being recently bought. Under a day of cover rolls
    to the Monday after, or the item would be back on the next morning's scan.
    Never shortens a longer cooldown already in place.
  - *Mismatch item* — bans words for that item permanently. The page suggests
    the title's words the item never asked for (`suggestExclusionTerms`; "3 in 1"
    and "indocafe" from *Indocafe 3 in 1 Instant Coffee*), and the user edits the
    list before anything is saved, because "extra" honestly includes the brand.
  - *Almost, but no* — blocks one product for one item, for a near-miss whose
    defining property can't be confirmed (the item wants unpasteurized; the shop
    doesn't say). No word to ban, so the product itself is the exclusion.
  New `src/core/exclusions.ts` (pure) + `exclusions-file.ts` →
  `data/exclusions.json`, applied in `findDeal`/`findReview` and keyed by
  `cooldownKey`, so a correction on "Onion (White)" covers "Onion (not red)".
  A single-word term folds through the matcher's own tokenizer ("tissue" catches
  "Tissues"); a phrase uses a separator-tolerant regex, since stemming "3 in 1"
  yields "in" and would exclude the whole shop.
- **Ignore button** — red, directly under *Add* on every card (deal and close
  match), separated by a real gap so it is never a mis-tap away from the button
  you press on purpose. It retires the **product**, not the ingredient: this
  listing is never offered again for any item, permanently, while the ingredient
  stays in the plan, keeps being searched, and other products still match it.
  New `ignore-product` action → a `BlockedProduct` keyed `ALL_ITEMS` (`"*"`),
  which `exclusionReason` matches alongside the item's own key; a real key is a
  stemmed base noun, so the two can't collide. Adding one supersedes any per-item
  blocks on the same product, and re-tapping is a no-op. Confirmed before it
  fires and it names both sides, because there is no button that undoes it —
  removing the entry from `data/exclusions.json` is the only way back.
- **History page** (`public/history.html`) — a second page linked from the deals
  page footer, holding everything the deals page has to forget to stay readable.
  `src/core/history.ts`; `src/core/page-chrome.ts` now holds the stylesheet and
  one-tap script both pages share. Four sections:
  - *Not in use* — ingredients tagged `Not in Use ATM`, which `readGroceryTargets`
    drops so early they otherwise have no listing anywhere. **Reset** removes that
    one tag (`unparkIngredient`, preserving all others) and refuses on a row that
    also carries the permanent `Don't Search`.
  - *Bought* — the purchase log, with three buttons per row.
  - *Already filed* / *Never buy again* — the record, and the `ALL_ITEMS` blocks
    from `exclusions.json` (the same list the red Ignore button writes; listed but
    deliberately not undoable from the page).
- **Purchase log** — new `src/core/purchases.ts` + `purchases-file.ts` →
  `data/purchases.json`, appended by `add-to-list.ts` once the Notion row lands.
  It exists because `cooldowns.json` **drops expired entries on every write** and
  so was never a history. Append-only and never trimmed: the only place the system
  remembers a price it once saw. Starts empty — earlier adds are not recoverable.
- **Three buttons on a bought row** — *Add to Ingredients* creates a new row
  (name, exact name, price, size, unit type, category, vendor, URL and macros);
  *Replace Current* writes price/size/vendor onto the existing row and nothing
  else, deliberately not renaming it; *Never buy again* writes the `ALL_ITEMS`
  block and settles every open row naming that product.
  `src/core/ingredient-write.ts` copies the extension's two rules verbatim —
  blanks are omitted rather than written as null, and select values are validated
  against the live schema so Notion can never be made to invent an option.
- **Macro lookup** (`src/core/macros.ts`) — Claude Sonnet 5 with web search and
  web fetch, run before the row is written. Product page → search → generic
  values, with the tier recorded and generic values flagged for checking. The
  prompt's load-bearing rule is that state decides the numbers (raw vs cooked,
  dry vs boiled): right food, wrong state is worse than no answer, because
  nothing looks missing. Capped at 4 searches; figures outside 0–100g dropped;
  protein+fat+carbs over 105g rejects the answer as per-serving. Every failure
  returns null and the row is still created — a lookup must never lose an add.
  Needs `ANTHROPIC_API_KEY`; unset is supported and free.
- **Macro lookup in the Chrome extension too** — *Add to Ingredients* in the
  popup / side panel now fills the same four columns, so the two add paths agree.
  `src/core/macro-prompt.ts` is new and holds everything that decides the answer
  (system prompt, tool set, parsing, sanity gate); `macros.ts` and the new
  `extension/macros-client.js` are now only transports — the SDK and raw `fetch`
  respectively, since the Anthropic SDK cannot bundle into a service worker.
  Shared, not copied, like `match.ts` and `ingredients-schema.ts` before it.
  Unlike the Node path the lookup runs **after** the row is written and patches
  it (`writeMacros`): the request takes 10–30s and no one should watch a spinner
  that long for a row that was ready. It runs in the worker, so closing the popup
  doesn't cancel it. Needs `https://api.anthropic.com/*` in `host_permissions`
  plus the `anthropic-dangerous-direct-browser-access` header (a service worker
  sends a browser `Origin`). Key is entered on the Options page beside the Notion
  token; blank disables the whole feature. *Replace With This* still writes no
  nutrition — that row's figures are the user's own work.

- **Rescan button** in the missing-shop warning banner (and only there — it does
  nothing useful otherwise). The two halves of the hybrid heal at different
  times: a laptop shut at 05:30 runs its missed Sheng Siong scan when it next
  wakes (`StartWhenAvailable`), so fresh prices reach the repo by mid-morning,
  but the 10:00 page was already built and nothing looks again — leaving a
  FairPrice-only page all day with the data sitting right there. The button
  fires `repository_dispatch: rescan` at `daily.yml` (new trigger), which
  rescans, redeploys Pages and re-sends the Telegram digest. Without a token it
  falls back to that workflow's own page, where *Run workflow* does the same.

### Changed
- Deal/close-match cards restructured: the percentage column is now a `float`
  inside a `.main` block, a sibling of the product link rather than nested in it
  — a control inside an `<a>` is invalid and untappable. Floating (rather than a
  third flex column) is what keeps the change free: the lines below the float
  reclaim the full card width, so a long product name stays at two lines instead
  of three.
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

### Added
- **Chrome extension — "Add to Ingredients"** (`extension/`). Captures a grocery
  product page into the Notion Ingredients DB. Modelled on the sibling Inventory
  Price Upkeeper extension, minus ABV, SKU and the Unverified/verified review
  workflow, with Supplier renamed to Vendor. Two writes, neither automatic:
  **Add to Ingredients** creates a row, and **Replace With This** appears beside
  each similar existing row and repoints it at this product (confirms first,
  showing before → after). Writes `Name` (generic) and `Items Exact Name` (the
  shop's full title + brand) separately — "Malaysia Round Cabbage" → `Name`
  "Round Cabbage" — plus `Price,SGD`, `Weight /Units of New Product `,
  `Unit type `, `Catagory`, `Vendor, Current ` and `Vendor 1 URL`.
- `src/core/generic-name.ts` — deterministic full-name → generic-name stripper
  (a known brand, a country of origin, a pack size; nothing else). Origin words
  are country NOUNS only, so `China Chinese Cabbage` → `Chinese Cabbage`.
- `src/core/categorize.ts` — keyword → `Catagory`, and pack size → `Unit type `.
- `src/core/ingredients-schema.ts` — the data-source id and the exact (typo'd,
  trailing-spaced) Ingredients property names, re-exported by `notion.ts` so the
  scraper and the extension share one source of truth.
- `npm run ext:build` (esbuild) — bundles the extension, resolving NodeNext
  `.js` specifiers to `.ts` and baking `synonyms.json` in.
- **`Don't Search` tag.** A `Select` option the user sets by hand in Notion to
  take an ingredient out of the scan permanently. Same exclusion point as
  `Not in Use ATM` (`readGroceryTargets`), so a tagged row is never searched,
  never compared and reaches no section of the page — but unlike the parked tag
  it is never written or cleared by this tool. Tag comparison now goes through
  `normTag()` (folds case, curly apostrophes, stray spacing) and accepts the
  original `Don'r Search` spelling too, so a hand-edit in Notion cannot silently
  switch the suppression off. 53 → 48 targets; no deals lost.

### Fixed
- **Sheng Siong only ever returned promoted products.**
  `Products.getByAllSlugs` was called with `ecommPromotionFilter.active: true`,
  which restricts results to items in a current promotion — so 28 of the 70
  daily search terms came back empty (`cinnamon`, `lotus root`, `apple cider
  vinegar`, `old garlic`) and the rest saw only their promoted subset.
  `search()` now runs both passes and merges on `slug`, and `PAGE_SIZE` goes
  20 → 50. 437 → 1166 products, 28 → 22 empty terms, 19 → 25 deals.
- Lentils returned nothing from either shop. `synonyms.json` folds `lentil` /
  `lentils` → `dhall` (the spelling Sheng Siong indexes: 0 hits for "lentil",
  10 for "dhall"), and `channa` → `chickpea` so "Channa Dhall" satisfies a
  "(Chana Dahl)" item. The Notion rows were renamed `Lentil (…)` → `Dahl (…)`
  to match. Sheng Siong now offers Masoor Dhall Split at 0.382/100g.
- Pu Erh now matches FairPrice's own spellings (`Pu'Er`, `Puer`, `Pu Er`);
  Sheng Siong does not stock it under any spelling.
- **Omega-3 and omega-6 were indistinguishable.** `tokens()` drops tokens
  starting with a digit, so both collapsed to `["omega"]`. They now fold to the
  single tokens `omega3` / `omega6`. Also, `parseName()` runs its must-match
  keyword hay through `normSynonyms()`, letting `omega 3 enriched` → `omega3`
  retire "enriched" — a word FairPrice prints on bread, never on omega-3 eggs,
  so the three egg items previously matched nothing at all. `skim` added to
  `MUST_MATCH_KEYWORDS` to keep parity under normalisation.
- `muscovado` → `brown muscovado`, so `Muscovado Sugar (Brown)` stops failing
  its own requirement against titles that all say "Dark Muscovado Sugar".
- `tofu` / `bean curd` added to `GENERIC_FORM_PATTERNS` — egg tofu undercuts
  real eggs per 100 g and would have published as an omega-3 egg deal.
- Matcher gaps that the wider candidate pool exposed: added bakery
  (`loaf`, `bread`, `cookies`, `buns`, …), household paper / scented non-food
  (`tissue`, `bathroom`, `scent`, …) and `\d in \d` premix patterns to
  `GENERIC_FORM_PATTERNS`, and `light` to the plain-milk variant guard. Stops
  bathroom tissue matching "Green Tea", a butter loaf matching "Butter", and a
  3in1 mix matching "Instant Coffee (plain)".

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
