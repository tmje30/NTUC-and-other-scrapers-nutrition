# Grocery Deal Scraper — System Guide

*Last updated: 2026-07-28 · Covers changes through commit f95f3b8*

## What this is

This system watches two Singapore supermarkets — **FairPrice** and **Sheng
Siong** — and tells you when a grocery you actually use is cheaper than what you
normally pay. Every day it looks at your personal ingredient list in Notion,
searches both stores for each item, works out the price per 100 g (or per litre
for liquids), and publishes a simple web page of the best deals. It also sends a
one-line summary to your Telegram. It runs by itself with no daily effort from
you — you only ever maintain your ingredient list in Notion.

## What it does (features)

- **Finds genuine savings on your groceries.** It compares each store's price
  *per 100 g* against the price you already pay (your "baseline", taken from
  Notion), and only flags an item when it's meaningfully cheaper (at least 5%
  off, or explicitly on sale below your baseline). Sub-5% noise is ignored.
- **Covers your whole grocery inventory, split into two lists.** The page has an
  **"In your plan"** section (items in your currently active meal plan, sorted by
  how much you'd save per month) and an **"Other items on offer"** section (the
  rest of your groceries, sorted by biggest percentage off).
- **Shows the numbers that matter on each deal card:** the item and pack size,
  the percentage saved, the price per kg and per 100 g, which store and product
  it is, and roughly how much of it you use per month.
- **Sends a daily Telegram nudge** — a single message with the deal count and a
  link to the page, so you don't have to remember to check.
- **"How do I add a new grocery to watch?"** Just add it in Notion (in your
  Ingredients database, with a category that isn't `Suppliments` or `Filler`, a
  price, and a pack size). You do **not** touch any code or the runner. The
  system rebuilds its own search list from Notion; a new item shows up
  automatically within a day.
- **"How do I stop watching an item, or fix a bad match?"** Remove or rename it
  in Notion. If a search brings back the wrong thing (e.g. "Butter" matching
  "Peanut Butter"), renaming the ingredient to be more specific fixes it.
- **"How do I switch which meal plan is active?"** In Notion, tag the meals you
  want as `Main` in Meal prep's `Current Plan` column. The plan is every
  ingredient on those meals' sub-item lines, and the next scan picks the change
  up — nothing to configure. Tag nothing and the plan is empty: the scan still
  runs and everything appears under "other items on offer".
- **"Which store is cheaper?"** Each deal card names the store and product, so
  the page is also a quick cross-store price check for the things you buy.

## How it fits together

The tricky part is that **Sheng Siong blocks the cloud.** FairPrice can be
scraped from anywhere, but Sheng Siong's bot-protection refuses connections from
data-centre servers (like the free cloud runner) while allowing normal home/mobile
internet connections. So the system is split across two places:

1. **A residential runner** (the user's **laptop**, on a daily schedule) does the
   part the cloud can't: it scans Sheng Siong from a normal home internet
   connection and saves the results into a small file (`data/shengsiong-latest.json`)
   that it commits to the project's GitHub repository.

2. **The cloud** (a free GitHub Actions job, once a day) does everything else: it
   reads your Notion ingredient list, scrapes FairPrice live, reads the Sheng
   Siong file the laptop left behind, combines the two into the best cross-store
   deals, publishes the web page, and sends the Telegram message.

Data flow, end to end:

```
Notion Ingredients DB ─┐
                       ├─► cloud job: scan FairPrice (live)
laptop (daily) ────────┘            + read Sheng Siong file
  scan Sheng Siong                        │
  → commit data file  ──────────────►  compare per 100 g → best deals
                                          │
                                          ├─► GitHub Pages web page
                                          └─► Telegram summary message
```

If the laptop's Sheng Siong file is missing or not from today, the cloud simply
skips Sheng Siong and publishes a **FairPrice-only** page — it never fails and
never tries the blocked connection. The whole design needs no browser and no
changes to the cloud's schedule file.

## Technical reference

The system is plain Node/TypeScript run with `tsx`; the portable logic lives in
`src/core/` and the runnable entry points in `src/scripts/` and `src/github/`.
All commands run from the repo root and read secrets from `.env` (see Setup).

### Reading the ingredient list — `readGroceryTargets()`

- **Where:** `src/core/notion.ts`.
- **What it does:** reads the whole grocery inventory from the Notion Ingredients
  data source and returns one `PlanTarget` per item, each flagged `inActivePlan`
  and carrying its monthly usage.
- **Inputs:** `NOTION_TOKEN`. Queries Notion data sources
  `34b69a18-4fe7-80e6-904e-000b208cf560` (Ingredients) and
  `34b69a18-4fe7-8086-83fa-000b24c37d2b` (Meal prep). The plan itself is not
  configurable — it is the `Main` tag.
- **Key detail:** uses the Notion SDK **v5** `dataSources.query` (not
  `databases.query`). Skips the `Suppliments` and `Filler` categories. Notion
  property names contain real typos/trailing spaces and must be matched exactly:
  `Price,SGD`, `Catagory`, `Unit type `, `Weight /Units of New Product `,
  `Price per 100g `, `Used '1'/'2'/'3' Plan`.
- **Output:** array of `PlanTarget` (name, parsed search term, category, pack
  price/size, `baselinePer100g`, monthly amount/packs/cost, `inActivePlan`).

### Parsing — `parseName()`, `parseMonthlyUsage()`

- **Where:** `src/core/parse.ts`. No AI; deterministic.
- `parseName(raw)` → `{ searchTerm, mustMatch, properties, negatedProperties,
  brand, basicRange, ignored, original }`.

#### Ingredient naming convention (how a Name drives the search)

The brackets in an ingredient `Name` are a deliberate, meaningful syntax:

| Syntax | Means | Effect |
| --- | --- | --- |
| `[ ]` | **Brand** — `Chicken Breast [Betagro]` | Never searched. Becomes a hard brand filter **only** when the row is tagged `Brand Specific` in the `Select` property; otherwise any brand may match. |
| `{ }` | **Ignore** — `Egg Whites, {cheap}` | A private note. Excluded from the search term *and* from every matching decision. |
| `( )` | **Defining property** — `Onion (White)`, `egg (Omega 3 Enriched)` | The thing that makes the item the item. A product failing it is **never published as a deal**; a close one is surfaced as a *recommendation*. |

Three special property forms:

- **Category** — `Banana (Fruit)` says what KIND of thing it is, not a word to find
  on the label (no banana is labelled "fruit"; a *freeze-dried fruit snack* is).
  Recognised: `Fruit`, `Vegetable`, `Produce`, `Leaf`, `Root`, `Seed`, `Herb`,
  `Flower`. Declaring one means "the actual fresh item", which rejects a different
  plant part (`Banana Leaves`), a different food borrowing the word (`Banana
  Shallots`, `Banana Prawns`, `Baby Puffs - Banana`) and keeping forms
  (`Freeze Dried Fruit`). Use it on any solo produce item.
- **Negation** — `Onion (not red)` means "any onion *except* red": a hard exclusion.
- **Basic range** — `Milk (Normal)` (also `Regular`/`Plain`/`Basic`) means the
  unadjusted product and is **identical to writing no property at all**. It is not
  a required word; it switches on *variant exclusion*, so both `Milk (Normal)` and
  bare `Milk` reject low-fat, skimmed, lactose-free, flavoured and plant milks.
  Writing a specific property (`Milk (Low Fat)`) instead **requires** it.

#### What actually gets searched — `queryTerms()`

Properties are enforced when **scoring**, never by narrowing the query. But a broad
query can fail to reach the product at all, so `queryTerms()` in `src/core/run.ts`
searches up to **three forms** and unions the hits (de-duped by URL):

1. the raw base noun — the spelling the shop most likely indexes (`Frozen Veg`)
2. its synonym-normalized form (`Frozen vegetables`)
3. base noun + properties (`Frozen vegetables mixed`)

Form 1 always runs, so nothing that used to be found is lost; the extra forms can
only find more. Measured: `Frozen Veg (Mixed)` went from **0 accepted to 5** —
form 1 returns edamame and broccoli, form 3 returns the real mixed-veg products as
top hits. `Szechuan pepper` went from 1 product to 5 (3 accepted).

#### The `Select` tags (Notion multi-select)

| Tag | Effect |
| --- | --- |
| `Not in Use ATM` | The ingredient is **skipped entirely** — never searched, never priced. Dropped in `readGroceryTargets()`. |
| `Brand Specific` | Only the `[bracketed]` brand may match; any other brand is a hard miss. |
| `Quality item` | Rejects a cheaper **grade**. A candidate whose **normal (undiscounted)** price per 100 is below `QUALITY_FLOOR` (75%) of what you pay at full price is a budget line, not a bargain. The **sale** price is ignored on purpose — a quality product may be discounted as deeply as it likes. Skipped when there's no baseline or no pack weight, so missing data never rejects. |
| `Organic/animal welfare` | The product must be **store-certified organic** (structured `Dietary Attributes`) or name a welfare rearing method (free range, cage free, grass fed, pasture raised, barn laid, RSPCA). |
| `Weekly Buy` | Not used by the matcher — user's own bookkeeping. |

**Organic is read from structured data, never from the name.** FairPrice publishes
`metaData["Dietary Attributes"]` (`Organic`, `Halal`, `Vegetarian`, `Healthier
Choice`, `Gluten-Free`, …) on roughly two-thirds of products. Name-matching would
be wrong: *"Chew's Fresh Eggs - Organic Selenium"* is a mineral additive, not an
organic egg. **Sheng Siong's payload exposes no such labels**, so an
`Organic/animal welfare` item can currently only be satisfied from FairPrice.

#### Synonym register — `synonyms.json`

A repo-root register of equivalent names, loaded by `loadUserSynonyms()` in
`src/core/match.ts` and applied to **both** the item name and the product title
before tokenizing. Edit it freely; no code change needed.

```json
{ "from": "tau kwa", "to": "tofu", "note": "why this entry exists" }
```

- `from` is matched as a whole word/phrase, case-insensitively; `to` replaces it.
- `note` is documentation only — the loader ignores unknown keys.
- Synonyms affect **scoring only, never the search query**. The store is still
  asked for the raw spelling it actually indexes (FairPrice lists "Tau Kwa", so
  querying the canonical "tofu" would find fewer of them).

It earns its keep on three kinds of problem:

| Problem | Example |
| --- | --- |
| Store uses a different name for the same thing | `Fortune Tau Kwa` never says "tofu" — coverage was 0 |
| Store mixes spellings in ONE result set | FairPrice returns both `Greek Style Yoghurt` and `Greek Yogurt` |
| Romanisation variants | `szechuan` / `szechwan` / `sichuan` → `sze chuan` |

**Caution:** a synonym makes matching *more* permissive, so it can surface a wrong
product that previously scored too low. Adding `szechuan → sze chuan` lifted a
*white wine* ("Feral No 1 — Beet Hop Szechuan Pepper 0.0 White Wine") from 0.27 to
0.80 for the pepper item; `PREPARED_RE` had to learn alcoholic forms to reject it.
After adding an entry, re-run the affected item and check what else moved.
- `parseMonthlyUsage(usedPlan)` → monthly `{ amount, unit, packs, costSgd }` by
  parsing the `Used 'N' Plan` formula string Notion already computed; returns
  `null` when the item isn't in that plan. **No longer used by the scan** (since
  2026-08-04 usage is summed from the `Main`-tagged meals); kept for
  `npm run test-parse`, which is how that formula gets read when checking Notion.

### Store modules (the `StoreModule` interface)

Each store exposes `search(term) → StoreProduct[]`. A `StoreProduct` carries
store, name, brand, pack price, pack weight (grams), a `volumetric` flag (litres
vs grams), price-per-100 g, sale info, and URL. Defined in
`src/core/stores/types.ts`.

- **FairPrice** — `src/core/stores/fairprice.ts`. Server-side-render scrape of
  `GET /search?query=…`, parsing the page's `__NEXT_DATA__` JSON. Weight comes
  from `metaData.DisplayUnit` (the raw `Weight` field is unreliable). Works from
  any IP, including the cloud.
- **Sheng Siong (live)** — `src/core/stores/shengsiong.ts` + `ddp.ts`. Talks the
  site's Meteor **DDP protocol over a WebSocket** (`wss://shengsiong.com.sg/websocket`,
  via the `ws` library), calling `Products.getByAllSlugs(filters, misc, page,
  size)` with the query in `filters.searchFilter.slug`; weight from `packSize`.
  **Only works from a residential IP** — data-centre IPs get a `200` challenge
  instead of a WebSocket upgrade. Used by the runner and for local testing.
- **Sheng Siong (file)** — `src/core/stores/shengsiong-file.ts`. Implements the
  same interface but reads `data/shengsiong-latest.json` instead of the network.
  Uses it **only if the file's `date` equals today (Singapore time)**; otherwise
  every search returns empty (→ FairPrice-only). It never makes a live call, so
  the cloud's IP block is irrelevant. Env override: `SHENGSIONG_DATA_PATH`.
- **Weight parsing** — `src/core/stores/weight.ts`: turns pack-size strings
  ("4 x 125 ml", "1 kg") into grams and a volumetric flag.

### Matching and deals — `matchesTarget()`, `findDeal()`

- **Where:** `src/core/compare.ts`.
- `matchesTarget(product, target)` accepts a product only if its name/brand
  contains every significant token of the search term and every must-match
  keyword, and **rejects "right word, wrong form"** via the `FORM_WORDS` list
  (blocks e.g. Butter→"Peanut Butter", Banana→"Banana Milk", Ginger→"Ginger Ade").
- `findDeal(target, products)` → `Deal | null`: takes the cheapest qualifying
  product per 100 g and returns a deal only if it beats the baseline by
  `MIN_SAVING_PCT` (5%) or is on sale below baseline. A `Deal` includes the
  saving per 100 g, saving %, and estimated **monthly** SGD saving.

### Orchestration — `runOnce()`

- **Where:** `src/core/run.ts`. One full daily pass: read targets, search every
  comparable target across `[FairPrice, ShengSiong]`, find the best deal each,
  and split results into `planDeals` (by monthly saving) and `otherDeals` (by %).
- **Store selection:** Sheng Siong is the **file source by default**; set
  `SHENGSIONG_LIVE=1` to use the live DDP module instead (local use only). The
  runner script always uses live.
- **Output:** `RunResult` — `planDeals`, `otherDeals`, `targetsConsidered`,
  `searchTerms` (unique terms, published for runners), and `errors`.

### Page and message

- `renderDealsPage(planDeals, otherDeals, generatedAt?, recommendations?)` —
  `src/core/site.ts`: builds the styled HTML deals page. `recommendations` render
  last, in a dashed-border "Close matches · not exactly what you asked for"
  section that names the property each one failed.
- `sendSummary(count, url)` — `src/core/telegram.ts`: sends the single Telegram
  message via the bot.

### Runnable commands (npm scripts)

- **`npm run build-site`** — the cloud's main job. Runs `runOnce()`, writes
  `public/index.html`, `public/summary.json` (deal counts), and
  `public/targets.json` (the search-term list runners fetch). Needs `.env`.
- **`npm run notify`** — reads `public/summary.json` and sends the Telegram
  message. Run by the cloud *after* the page is deployed, so the link is live.
- **`npm run push-ss`** — the residential runner. Fetches search terms from the
  public `targets.json`, scans Sheng Siong live, writes `data/shengsiong-latest.json`
  (with the bulky debug payload stripped), and `git commit`s + `push`es it. Skips
  if today's file already exists (`--force` to rescan, `--no-push` to skip git).
  Labels the data with `RUNNER_SOURCE` (`phone`/`laptop`).
- **`npm start`** / **`npm run dry-run`** — `src/github/main.ts`: local all-in-one
  (scan → write page → send Telegram; dry-run writes the page but sends nothing).
- **`npm run ss -- tofu milk`** / **`npm run fp -- tofu`** — test a store module
  directly (both hit the live site).
- **`npm run deals`** — print the cross-store deal list to the console.
- **`npm run targets`** — print the resolved active-plan grocery targets.
- **`npm run check`** — TypeScript type-check (no emit). **`npm run build`** emits
  `dist/`.

### The laptop runner (scheduled)

- **Dedicated clone:** `C:\Users\newuser\shengsiong-runner\repo`, separate from
  the development copy so the daily job never collides with in-progress work.
- **Wrapper:** `C:\Users\newuser\shengsiong-runner\run.cmd` — sets
  `RUNNER_SOURCE=laptop`, adds Node + git to `PATH`, runs `git pull` then
  `npm run push-ss`, and appends output to `..\push-ss.log`.
- **Task:** Windows Task Scheduler **"ShengSiong Daily Scan"**, daily **05:30
  SGT**. Runs if the scheduled time was missed (laptop off/asleep), runs on
  battery, and runs as the logged-in user so Windows Credential Manager provides
  git push auth — **no access token is stored anywhere.**
- **Inspect it:** `type C:\Users\newuser\shengsiong-runner\push-ss.log`;
  `schtasks /Query|/Run|/Change|/Delete /TN "ShengSiong Daily Scan"`.
- A **phone (Termux/Android)** runner (`phone-run.sh`) exists as optional extra
  redundancy; its push is proven but its scheduling is unfinished (see HANDOVER).

### The cloud job

- **Where:** `.github/workflows/daily.yml`. Daily at **06:00 SGT**
  (`cron: "0 22 * * *"`) plus a manual "Run workflow" button. Steps: `npm ci` →
  `npm run build-site` → deploy `public/` to GitHub Pages → `npm run notify`.
- **Repo (public):** https://github.com/tmje30/NTUC-and-other-scrapers-nutrition
- **Live page:** https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/
- Note: editing the workflow file requires the GitHub **web editor** (the local
  token lacks the `workflow` scope). Everyday code pushes and `gh secret set` work.

## Setup and requirements

Environment variables (values live in `.env` locally, and as GitHub Actions
secrets in the cloud — names only here, never values):

- **`NOTION_TOKEN`** — Notion integration token; required to read the ingredient
  list. Must have access to the Ingredients database.
- **`TELEGRAM_BOT_TOKEN`**, **`TELEGRAM_CHAT_ID`** — the bot (reuses the user's
  `@Big_Notion_Bot`) and destination chat for the daily message.
- **`SITE_URL`** — public URL of the Pages page (defaults to the live URL);
  used in the Telegram message.
- **`SHENGSIONG_LIVE`** — set to `1` to force the live Sheng Siong scan instead
  of the file (local testing only).
- **`SHENGSIONG_DATA_PATH`** — override the Sheng Siong data file location
  (default `data/shengsiong-latest.json`).
- **`RUNNER_SOURCE`** — label written into the data file/commit (`phone` default;
  the laptop wrapper sets `laptop`).
- **`TARGETS_URL`** — where the runner fetches search terms (defaults to the live
  `targets.json` on Pages).

Other requirements: **Node 22+**; the repo must be **public** for free GitHub
Pages; the laptop needs a working `git push` credential (Credential Manager) and
the scheduled task above; GitHub Pages must be enabled for the repo.

## Glossary

- **Baseline (price per 100 g)** — what you currently pay for an item, computed in
  Notion; the number a store must beat to count as a deal.
- **By-Gram / By-Unit** — whether an ingredient is measured by weight or by count
  (eggs). Only By-Gram items are compared in this version.
- **Active plan** — the meals tagged `Main` in Meal prep's `Current Plan`
  column; the ingredients on their sub-item lines form the "In your plan"
  section.
- **DDP** — the WebSocket-based protocol (from the Meteor framework) that Sheng
  Siong's website uses; the live Sheng Siong module speaks it directly.
- **Residential vs data-centre IP** — a home/mobile internet address vs a cloud
  server's. Sheng Siong allows the former and blocks the latter, which is why a
  laptop runner exists.
- **Runner** — the residential machine (laptop, optionally phone) that scans Sheng
  Siong and commits the data file the cloud reads.
- **`targets.json`** — the list of search terms, rebuilt from Notion each cloud
  run and published on the web page so runners can read it without any token.
- **FORM_WORDS** — a reject-list that stops "right word, wrong form" matches (e.g.
  a plain "Butter" search matching "Peanut Butter").
- **GitHub Actions / Pages** — the free cloud service that runs the daily job, and
  the free web host that serves the deals page.

## What changed in this update

- **2026-07-28 — Initial version.** First `SYSTEM-GUIDE.md`, written after the
  residential hybrid went live: the laptop scans Sheng Siong on a daily Task
  Scheduler job and commits `data/shengsiong-latest.json`; the cloud reads that
  file (via `shengsiong-file.ts`) and now shows Sheng Siong deals alongside
  FairPrice, falling back to FairPrice-only when the file is missing or stale.
