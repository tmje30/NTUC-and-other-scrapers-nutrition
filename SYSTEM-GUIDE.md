# Grocery Deal Scraper — System Guide

*Last updated: 2026-08-05 · Covers changes through commit a50fc7a*

## What this is

This system watches two Singapore supermarkets — **FairPrice** and **Sheng
Siong** — and tells you when a grocery you actually use is cheaper than what you
normally pay. Every day it looks at your personal ingredient list in Notion,
searches both stores for each item, works out the price per 100 g (or per litre
for liquids), and publishes a simple web page of the best deals. It also sends a
one-line summary to your Telegram. It runs by itself with no daily effort from
you — you only ever maintain your ingredient list in Notion.

It also **writes back to Notion**, always on a button press and never on its own:
a deal can be added to your shopping list, a discovered product can be filed as a
new ingredient or used to re-base an existing one, and nutrition figures
(protein, fat, carbs, fibre per 100 g) are filled in at the same time. A
companion **Chrome extension** does the same capture from a product page you're
browsing.

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
- **"How do I put a deal on my shopping list?"** Tap **Buy** on the card. The row
  lands in your Notion grocery List, and the item then goes quiet for a while (a
  "cooldown") so you aren't offered the same thing again the week after you bought
  it. The page lists what's snoozed under "Recently bought · not searched".
- **"The card found a better product than the one I buy — can I switch to it?"**
  Yes. **Add** files it as a *new* ingredient; **Replace** re-bases the existing
  ingredient onto it (new name, price, pack size, unit and vendor). Replace asks
  first and cannot be undone.
- **"How do I get rid of a bad match?"** Three levels, all on the card. The `⋯`
  menu holds **Ignore 1× week** (quiet until Monday), **Mismatch item** (ban words
  for that ingredient, permanently) and **Almost, but no** (block this one product
  for this one ingredient). The red **Ignore** button retires a *product* outright,
  for every ingredient, forever. All of them teach the matcher rather than just
  hiding today's card.
- **"Where did that price go?"** A second page — **History** — links from the
  footer. It lists what you bought and when, ingredients you've parked, and
  products you've banned outright. It exists because the deals page has to forget
  things to stay readable.
- **"Can I capture a product I'm looking at in the browser?"** Yes — the Chrome
  extension ("Nutrition Plan Extension") reads the product page you're on and
  writes it into your Ingredients database, either as a new row or over an
  existing one.
- **Fills in nutrition automatically.** Whenever a row is written, the four
  per-100 g columns (protein, fat, carbs, fibre) are filled from the shop's own
  nutrition table where one exists, from a photo of the back of the pack where it
  doesn't, and only as a last resort from a paid AI lookup. **Nothing spends money
  unless you press a button that says it will.**

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
never tries the blocked connection. A ⚠️ banner on the page (and a line in the
Telegram message) says a shop was missing, so a degraded run is never silent; the
banner carries a **Rescan** button that re-runs the whole cloud job once the
laptop's data has landed.

**The write-back leg.** Everything above is read-only. Writing to Notion needs a
token, and the deals page is a static file that cannot hold one — so a button on
the page hands the job to a **GitHub Actions workflow**, which holds the token and
does the privileged half. There are two such workflows (`add-to-list.yml` for the
grocery list, `item-actions.yml` for the corrections), kept separate on purpose
because undoing a snooze has a very different blast radius from writing to Notion.
A button takes one of two roads: by default it opens a **pre-filled GitHub issue**
you submit (two taps, no setup); if you've saved a personal access token in the
browser, it fires the workflow directly (one tap).

**The manual leg.** The **Chrome extension** is the third way in and is entirely
separate from the daily job — it only ever acts on a button press, and it writes
to the **Ingredients** database rather than the grocery list. There are now three
doors into Ingredients (the extension, the history page, the deals page) and they
share one writer, `src/core/ingredient-write.ts`, rather than each having their
own.

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
- **Incapsula** — `src/core/stores/incapsula.ts`. Sheng Siong's WAF answers plain
  requests with a JavaScript challenge instead of content, which breaks the
  WebSocket upgrade. This module launches the installed **headed Chrome** with a
  throwaway profile over CDP, lets it solve the challenge the way an ordinary
  visit does, harvests the `incap*` cookies and caches them to
  `.sessions/shengsiong.json` (gitignored — it is a session credential). The
  cached cookie is tried first, so a normal run opens no browser; minting happens
  at most once per process and a failure is remembered, never retried. Headless
  Chrome is detected and does not work; header spoofing and cookie replay do not
  work either. `CHROME_PATH` overrides Chrome's location.

Three fields on `StoreProduct` exist for the nutrition feature rather than for
pricing, and all three must survive the runner's `raw`-stripping before commit:

- **`nutritionHtml`** — the shop's own nutrition table, when it publishes one.
  FairPrice fills it straight from the search payload (34 of 72 products in a
  measured run) at no cost; Sheng Siong never does. This is what decides the
  `has macro` tag on a deal card.
- **`images`** — FairPrice's product photo URLs, used to find a back-of-pack shot.
- **`imageKey`** — Sheng Siong's S3 image key. It says nothing about how many
  images exist, which is why `resolveShengSiongPackShots` has to probe.

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
- `src/core/page-chrome.ts` — the stylesheet and the one-tap dispatch script that
  **both** pages share, so the deals page and the history page cannot drift apart
  visually.

### The deal card and its buttons

Each card carries five controls in two groups — two on the left, three on a right
rail — plus a `⋯` correction menu:

```
[Buy]     Peanut Butter, Smooth                          −31%
[Ignore]  [500g] Price $8.20                               ⋯
          FairPrice · Skippy Peanut Butter Spread        [Add]
          [500g] $5.65 on sale (−15%)                [Replace]
          $11.30/kg vs $16.40/kg                     [Macros]
          uses ~400g/month                      has macro
```

- **Buy** — writes the row to the Notion **grocery List** (Name `[NTUC] Milk`,
  the discounted price, what you currently pay, the vendor; Amount deliberately
  left empty), records a cooldown, and appends to the purchase log. Column names
  are resolved from the live Notion schema at write time, never hardcoded, because
  they drift.
- **Ignore** — retires this **product** for every ingredient, permanently. Scoped
  to the product, not the ingredient: the ingredient stays in the plan and every
  other product still competes for it. There is no button that undoes it.
- **Add** — files today's match into **Ingredients** as a new row.
- **Replace** — re-bases the ingredient that *seeded* the search onto today's
  match: `Name`, `Price,SGD`, `Weight /Units of New Product `, `Unit type ` and
  `Vendor, Current `. Confirmed first, no undo. `Unit type ` travels with the size
  by necessity — re-base a 500 g item onto a 1 L bottle and a stale `By Gram`
  would claim a kilogram of liquid.
- **+ Macros** — a per-card toggle, off by default, that arms a paid nutrition
  lookup for that card only.
- **has macro / no macro** — whether this listing's nutrition is free to file.

The `⋯` menu holds the three corrections: **Ignore 1× week** (a cooldown until
Monday 00:00 SGT, tagged so the page lists it as ignored rather than bought),
**Mismatch item** (bans words for that ingredient permanently — the page proposes
the words and you edit the list before anything is saved), and **Almost, but no**
(blocks one product for one ingredient, for a near-miss whose defining property
the shop simply doesn't state).

Corrections live in `src/core/exclusions.ts` (pure) + `exclusions-file.ts` →
`data/exclusions.json`, applied in `findDeal`/`findReview` and keyed by
`cooldownKey`, so a correction on "Onion (White)" also covers "Onion (not red)".

### Cooldowns and the purchase log

- **`src/core/cooldowns.ts`** + `data/cooldowns.json`. A cooldown is
  **`pack size ÷ monthly usage × 0.75`** — the 25% haircut brings the item back
  before the cupboard is empty, leaving a window to catch a deal. 1 kg of garlic
  at 500 g/month → 2 months of cover → **46 days**. No monthly usage (anything
  outside the active plan) → a flat **14 days**. Entries are keyed on the stemmed
  base noun (`onion`), so one entry covers "Onion (White)" and "Onions" but
  deliberately not "Garlic Powder" when you bought "Garlic".
- `runOnce()` drops snoozed targets **before** collecting search terms, so neither
  the cloud nor the Sheng Siong runner even looks for them.
- **`data/cooldowns.json` is not a history** — both write paths drop expired
  entries by design, because that file answers "what is suppressed right now". So
  the purchase log is a separate file: `src/core/purchases.ts` (pure) +
  `purchases-file.ts` → `data/purchases.json`, appended after the Notion row
  lands and **never trimmed**. It is the only place this system remembers a price
  it once saw. It started empty on 2026-08-03; adds made before that are not
  recoverable.

### Writing to Notion — `ingredient-write.ts`, `park.ts`

- **`src/core/ingredient-write.ts`** — the single writer behind all three doors
  into Ingredients. Two rules it copies from the extension's client and that must
  stay in step: **a blank field is omitted, never written as null** (so a missing
  size cannot blank a size the row already had), and **select values are validated
  against the live schema** — an unknown option is dropped with a warning, never
  created, because writing one makes Notion invent a permanent schema option.
- **`src/core/park.ts`** — the `Not in Use ATM` tag. Two rules baked in: the tag
  is **appended** to the row's existing tags and never assigned over them (those
  tags are the item's search configuration), and the write **refuses** unless the
  option already exists on the property. This tool never invents Notion schema.

Two suppression tags exist and must not be conflated:

| | who writes it | undone by |
| --- | --- | --- |
| `Not in Use ATM` | this tool (the page's "Not in use" button) | meant to be undone |
| `Don't Search` | the user, by hand in Notion | **nothing here.** Permanent |

Both are dropped in one place — `readGroceryTargets()` — which is why a tagged row
cannot leak into the page by some other path. Nothing in this repo may write,
clear, or offer a button that undoes `Don't Search`. Compare tags through
`normTag()`, never with `===`: the option was first created misspelled
(`Don'r Search`) and renamed by hand, so both spellings are listed and `normTag`
folds case, curly apostrophes and stray spacing.

### Nutrition — four sources, cheapest first

Whenever a row is written, the four per-100 g columns are filled
(`Protein per 100g`, `Fats per 100 g `, `Carbs per 100g `, `Fiber per 100g ` —
note the inconsistent spaces; they are copied verbatim from Notion). A row without
them silently breaks the meal-plan formulas built on top, which is why this
exists. Sources are tried in order, each a fallback for the one above; shares are
from a 32-product survey of live FairPrice pages:

| # | source | cost | share | when |
|---|---|--:|--:|---|
| 1 | the shop's own panel, parsed | **free** | 28% | the page publishes `Nutritional Data` |
| 2 | model, no tools | ~$0.003 | 31% | fresh produce / raw meat — no label exists to find |
| 3 | model + the shop's back-of-pack photo | ~$0.03 | 34% | the shop published a back or side pack shot |
| 4 | model + web search and fetch | $0.29–0.41 | 6% | everything else |

Adding all 32 products costs **$0.94** this way, against **$3.80** if every one
took the last path.

**The rule: no button on any surface may start a paid lookup on its own.** The
deals page needs its per-card **+ Macros** toggle; the extension needs its **Find
Macros** button, which fills the boxes *before* the row is written so you can read
and edit the figures. The one exception is the history page's "Add to Ingredients",
which still looks up automatically because filing a purchase is a deliberate act on
something you already bought.

Where the code lives:

- **`src/core/nutrition-panel.ts`** — source 1, fully deterministic, no model.
  `parseNutritionPanel(html)` → the four figures. Two rules it cannot relax:
  **every published panel is per SERVING, never per 100 g** (measured servings of
  32 g, 35 g, 236 ml, 100 g), so the parser scales and **refuses** any panel whose
  serving size isn't stated — a 32 g peanut-butter serving read as 100 g is wrong
  by 3× in the direction that looks fine. Row labels are matched **exactly**, so a
  `- Saturated Fat` sub-row can't be taken for `Total Fat`.
  The panel must also be read off the **slug-anchored product object**, never
  searched for in the page: the payload also carries a recommendations carousel,
  and on one real page the product itself had no panel while four rival peanut
  butters did.
- **`src/core/macro-prompt.ts`** — everything that *decides* an answer: system
  prompt, tool set, reply parsing, the sanity gate, `isCommodityFood()` and the
  `packShotsFor()` image gate. It has **no Node imports**, because the Chrome
  extension bundles it verbatim.
- **`src/core/macros.ts`** — the Node transport (official Anthropic SDK); the
  extension's `macros-client.js` is the browser one. Both build their request with
  `macroUserContent()` so the two surfaces cannot disagree about what was asked.
- **Model:** `claude-sonnet-5` with `web_search` + `web_fetch`. Three tiers are
  recorded and reported — the product page, then a search, then generic values for
  the food — and generic values are flagged for checking.
- **Guards.** `max_uses: 4` caps the per-tap cost; any figure outside 0–100 g is
  dropped; protein + fat + carbs over 105 g rejects the whole answer (that shape
  means per-serving figures were read as per-100 g); a 180 s timeout with one
  retry, against the SDK's 10-minute default. **Every failure path returns null
  and the row is written without nutrition** — a macro lookup must never lose an
  add.
- **`shengsiong.com.sg` is in `UNFETCHABLE_DOMAINS`.** The same wall that forced
  the scraper onto DDP blocks `web_fetch`, and it doesn't fail fast — it *stalls*.
  One measured lookup took 245 s waiting on a page that was never going to answer,
  then fell back to search anyway; blocking the domain gets the identical answer in
  51 s. FairPrice is deliberately not blocked — its pages are server-rendered and
  often carry a real panel.
- The prompt's load-bearing instruction is that **state decides the numbers** —
  raw vs cooked meat, dry vs boiled pasta. A lookup that gets the food right and
  the state wrong is worse than one returning nothing: nothing looks missing, and
  a wrong number quietly poisons the plan formulas.

### Pack shots — reading the label off the photo

Handing the model the shop's own back-of-pack photograph instead of sending it to
find the panel on the web. Measured on one product: **$0.2877 → $0.0239** and
**54 s → 5.2 s**, same answer. The saving isn't the searches (2 cents of a 29-cent
call) — it's that `web_fetch` stops dropping a 340–390 KB page into context.

- `selectPackShots()` picks the views; **`packShotsFor()` is the gate every caller
  should use**, because it also refuses photos to anything `isCommodityFood()`
  catches.
- **The FRONT shot is deliberately excluded, and that exclusion is the whole
  gate.** A pack with no panel leaves only marketing copy to read, which made one
  measured lookup both dearer and wrong. So a listing publishing nothing but a
  front shot gets no images and takes the ordinary path.
- **Do not filter photos by the product's SKU** — FairPrice reuses one photo
  across a range, and an SKU filter throws away the only label shot some products
  have. Read the images off the slug-anchored object instead. The date suffix in
  the filename is also optional (`13051601_BXL1.jpg` as well as
  `47440_BXL1_20250411.jpg`); a pattern that requires it drops good shots.
- **`src/core/stores/shengsiong-images.ts`** builds Sheng Siong's URLs:
  `https://ssecomm.s3.ap-southeast-1.amazonaws.com/products/{sm|md|lg}/{imgKey}.{n}.jpg`.
  Public S3, **not** behind the WAF — the only Sheng Siong URLs an ordinary
  `fetch` can reach. `lg` is the largest size served. This matters more than
  FairPrice's did, because Sheng Siong publishes no nutrition data at all and its
  pages can't be fetched, so every product there used to take the worst path.
  ⚠️ **`totalImg` is load-bearing and is never guessed** — an index past the end
  returns **403**, and an unreachable image fails the whole API request rather
  than being skipped. The extension gets the count free from the product record;
  the deals page has to HEAD-probe the bucket (`resolveShengSiongPackShots`),
  which happens in `build-site.ts` *after* the deals are chosen — a couple of
  dozen products rather than the 1,100-odd a scan returns, deduped, run in
  parallel, and wrapped so a photograph can never stop the page building.
  Index 0 is always the marketing front shot; `packShotsFor` drops it.
- **`isCommodityFood()`** skips the tools entirely for fresh produce and raw meat,
  where no label exists to find: frozen chicken went **$0.41 → $0.0030** and
  broccoli **$0.081 → $0.0027**, with the same or better figures. The gate is
  narrow on purpose — the `produce` category, **or** a meat/fish/egg word **with**
  a `fresh|frozen|chilled|raw|live` state — which is what keeps branded dairy and
  "Tuna Flakes - In Water" on the full lookup.

### Generic names — `src/core/generic-name.ts`

Turns a shop's title into the user's bracket standard, deterministically, with no
model. Used by the extension and by the deals page's Add/Replace.

- `structuredName()` proposes the `Name`:
  `"Skippy Peanut Butter Spread - Creamy"` → `Peanut Butter Spread [Skippy] {Creamy}`.
  The split point is the shop's own dash, the one separator both shops use
  consistently. Pre-existing brackets in a shop title are stripped first —
  FairPrice really ships `"[BCRS] Farmhouse Milk - Fresh"`, and leaving it would
  have `parse.ts` read "BCRS" as the brand.
- ⚠️ **The variant goes in `{ }`, not `( )`, deliberately.** `(Crunchy)` would
  reject every product whose title omits the word — including the smooth jar on
  offer this week that would have been a fine substitute. Braces keep the words
  visible without letting them silently kill matches. Promoting one to `( )` is a
  judgement only the user can make, so it stays a hand edit.
- `deriveGenericName()` stays plain and is **not** the proposed value — it feeds
  the category guess and the similar-rows search, both of which would match on
  punctuation. `stripStructure()` exists for the same reason.
- The shop's full title goes verbatim into `Items Exact Name`. That column is
  never parsed, only written and displayed; its job is provenance.

### History page — `public/history.html`

A second page on the same site, linked from the deals page footer. The deals page
answers "what should I buy today"; everything it has to forget to stay readable
lives here. Built by `build-site.ts` from `src/core/history.ts`, in a `try` of its
own so a Notion hiccup can never take the deals page down with it. Four sections:

- **Not in use** — every ingredient tagged `Not in Use ATM`. This list exists
  because `readGroceryTargets` drops those rows so early that a parked item
  otherwise has no listing anywhere. **Reset** removes that one tag, preserving
  every other, and refuses outright on a row that also carries `Don't Search`.
- **Bought** — the purchase log, with three buttons per row: *Add to Ingredients*
  (a new row, with nutrition), *Replace Current* (price, size, vendor and URL onto
  the existing row — and deliberately **not** a rename, unlike the extension's
  version), and *Never buy again*.
- **Already filed** — the same rows once settled, kept as a record.
- **Never buy again** — the product-wide blocks the red Ignore button writes, read
  from the same `data/exclusions.json` the scan uses, so this list cannot disagree
  with what actually gets skipped. Listed but not undoable from the page.

### Chrome extension — "Nutrition Plan Extension"

`extension/` — captures a grocery product page straight into the Notion
**Ingredients** DB. Full detail in `extension/README.md`; the essentials:

- **Two writes, never automatic.** *Add to Ingredients* creates a row; *Replace
  With This* appears beside **each** similar existing row and repoints it at this
  product, asking first and showing before → after.
- Writes `Name` (generic, in the bracket standard), `Items Exact Name` (the shop's
  title verbatim), `Price,SGD`, `Weight /Units of New Product `, `Unit type `,
  `Catagory`, `Vendor, Current `, `Vendor 1 URL`, and the four nutrition columns.
- **Four nutrition boxes** sit under "Per 100g" above the Add button, pre-filled
  and green when the shop published a panel, blank otherwise. Blank boxes stay
  blank until you press **Find Macros**, which fills the *boxes* rather than the
  row — so the figures arrive where you can read, edit or clear them. Every box is
  editable.
- `npm run ext:build` regenerates `extension/dist/` and is **required after
  editing `synonyms.json`**, which is baked into the bundle at build time.
  `extension/dist/` is gitignored, so a fresh clone must build before the
  extension will load.

Three things that will bite whoever edits it:

1. **Notion API version 2025-09-03, not 2022-06-28.** This project queries **data
   sources** and creates pages with `parent.data_source_id`. Copying an endpoint
   from an older extension will 404.
2. **Property names are copied verbatim, typos and all.** They live in
   `src/core/ingredients-schema.ts`, which `notion.ts` re-exports from, so the
   scraper and the extension cannot drift. "Correcting" a name silently breaks the
   write.
3. **It must never create Notion schema.** Both selects are validated against the
   live options before every write; a value Notion doesn't already have is
   refused, not sent.

Where it reads prices from is not simplifiable. FairPrice's product JSON-LD is
**invalid on every product** (0 of 40 pages parsed), while `__NEXT_DATA__` is
valid on 40 of 40 — but its inline copy goes stale on an in-site navigation. So
the reader uses the inline blob when its slug matches the URL and otherwise
re-fetches the page same-origin. Sheng Siong works a completely different way: it
publishes nothing readable — no JSON-LD, no meta tags, no server-rendered data, no
`<h1>`, one site-wide `<title>` — so the extension asks the page's own Meteor app
via `Products.getOneByIdOrSlug`, injected with `world: "MAIN"` because a content
script cannot see `window.Meteor`.

The extension imports from `src/core/` — the sharing goes one way only; nothing
under `src/` imports from `extension/`.

### Tests — `npm test`

**167 offline cases in `src/tests/`**, free and fast. Six suites: pack-shot
selection and its commodity gate, nutrition-panel parsing, macro-reply parsing,
name derivation, the deals page's markup, and marketplace size parsing.

There is **no test runner and no new dependency** — each file registers its cases
into `harness.ts`, and `run.ts` imports every suite and sets the exit code.
Nothing here calls Notion, a shop, or Anthropic: a test that costs 29 cents is a
test nobody runs. The live checks that *do* cost something have their own scripts
(`npm run macro-test`, `npm run fp`, `npm run ss`) and are deliberately not wired
in.

The suites cover exactly the functions where being *quietly* wrong is the danger:
a misread serving size is out by 3× and looks plausible, a pack-shot gate that
stops matching a shop's filenames silently costs 10× per lookup, and a drifting
commodity gate spends real money. None of those announce themselves.

### Searching shops beyond FairPrice and Sheng Siong

Scoped but **not built** — only the probe exists. Full detail in
`docs/vendor-scoping.md`, which governs; this is the orientation.

⚠️ **Two different prices live on every Ingredients row and must never be
conflated:**

| | columns | meaning |
| --- | --- | --- |
| **baseline** | `Price,SGD` + `Weight /Units of New Product ` + `Vendor, Current ` | what the user **actually pays**, and where. Every discovery is measured against this |
| **price book** | `Vendor 1/2/3` + `Price [Vendor n]` + `Size[Vendor n]` + `Vendor n URL` | where else it can be found and what **that shop** charges. Not what the user pays |

Measured over 94 rows: `Price,SGD` filled on 71, `Vendor, Current ` on 7,
`Vendor 1` on 52, and `Price [Vendor n]` / `Size[Vendor n]` on **none, ever**.
Filling the price book is the point of the feature. Rules for any writer: match
the vendor **by name** to find the index (the mapping is per-row — `Vendor 1` is
Shopee on one row and Watsons on another); if no index names that shop, write
nothing; and never write `Vendor, Current ` from a scan, because moving the
baseline is a deliberate act and that is what *Replace* is for.

**Searches must be directed** — don't look for bread at a pharmacy or a face
lotion at a supermarket. Routing is `Vendor[n]` tags first, then `Catagory` as the
default: grocery categories → FairPrice + Sheng Siong; `Suppliments` (30 rows) →
iHerb + MyProtein; `Household Supplies` (7 rows) → Watsons + Guardian. ⚠️ The tags
mean "*also* look here", never "only look here" — `Sheng Siong` is tagged on zero
rows, so code treating an empty tag as "don't search" would silently kill the
FairPrice scan on 42 rows.

**`npm run vendor-probe -- "<term>"`** measures whether each shop can yield a
price **and** a pack size. It writes nothing anywhere and prints its own egress IP
first. Status as at 2026-08-05:

| shop | status | note |
| --- | --- | --- |
| **Carousell** | ✅ works end to end | headed browser for search, plain `fetch` for the listing page |
| **Guardian** | ✅ browser tier renders prices | no anti-bot, just an SPA; its `/graphql` is the cheaper long-term route |
| **MyProtein** | 🟠 28 products priced, **0 with a size** | size lives in an on-page variant; needs a second fetch per product |
| **iHerb** | 🔴 403 even from residential | genuinely client-side |
| **Watsons** | 🔴 parked | an SPA behind Akamai Bot Manager; payoff is one row |
| **Shopee** | 🔑 auth wall | needs a hand sign-in once. ⚠️ Nothing in this repo may type a credential |

⚠️ **Never take the minimum on a marketplace — the minimum is usually the scam.**
`cheapestPlausible()` clusters candidates and drops anything below ~55% of the
median. On the one term probed so far, Carousell's cheapest plausible whey was
**36% worse** than what the user already pays; the three listings that beat the
baseline were exactly the ones the plausibility gate rejects. Marketplace adapters
are **not** cleared to build — probe more items first.

- **`src/core/marketplace-size.ts`** — reads a size out of free text a stranger
  typed. Of 47 real listings, 100% carried a price but only **62% a size**; the
  rest are dropped, because no size means no comparable data. It is **separate
  from `weight.ts` on purpose**: that one parses a size a supermarket published as
  a field, this one parses a sentence, where every failure flatters. It knows
  `lb`/`oz`, which supplements are overwhelmingly sold in and `weight.ts` does not.
- **`src/core/browser-cdp.ts`** — drives the installed Chrome over CDP to read a
  page a plain `fetch` can't. Same technique as the Incapsula mint. Three traps,
  all of which have been hit here: never hardcode the debug port (a leftover
  Chrome answers from the stale browser); killing the spawned pid does not kill
  Chrome (it re-parents — close over CDP, then kill the tree, then sweep by the
  launch's own profile path); and a retry that launches a browser needs a circuit
  breaker, or one failing mint retried by 70 searches leaves 42 stray processes.

⚠️ **Your IP decides what you can scrape.** A VPN gives a *datacenter* address and
shops treat it as one — on a VPN, Watsons returned 403 on every URL including
`robots.txt`; on the real residential line, 200. The client matters independently
too: on the *same* residential IP, `curl` gets 403 from Watsons while Node's
`fetch` gets 200. Pin both variables before calling anything "blocked". This is
why `vendor-probe` prints its egress IP and flags datacenter addresses.

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
- **`npm run add -- --payload '<json>'`** — the grocery-list half of the **Buy**
  button, by hand: adds one item and sets its cooldown. `--dry-run` prints the
  plan without writing anything.
- **`npm run item-action -- --payload '<json>'`** — the Reset / Not in use half,
  and the deals page's Add / Replace / Ignore. `--dry-run` reads Notion but writes
  nothing.
- **`npm run macro-test -- "<product>" [--url …] [--store …] [--image <url> …]`** —
  one real nutrition lookup. Writes nothing to Notion; prints tier, basis, timing
  and **cost**. `--image` is repeatable and takes the shop's URLs unfiltered, and
  the output says how many `packShotsFor` actually attached, so "3 image URLs
  given, 1 attached" is the gate working. ⚠️ This one costs money — budget ~$0.30
  for a tools-path call, ~$0.03 with a pack shot, ~$0.003 for a commodity.
- **`npm run vendor-probe -- "<term>"`** — can each shop yield a price *and* a
  pack size? Writes nothing. `--only a,b`, `--browser`, `--headed`,
  `--login shopee`. ⚠️ Prints its egress IP first — a 403 from a datacenter
  address means nothing.
- **`npm run ext:build`** — rebuild the Chrome extension's `dist/`. Required after
  editing `synonyms.json`.
- **`npm test`** — the 167 offline cases. Free, fast, no network.
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

### The cloud jobs

Three GitHub Actions workflows:

- **`.github/workflows/daily.yml`** — the main job. `cron: "0 2 * * *"` (02:00
  UTC), plus a manual "Run workflow" button and a `repository_dispatch: rescan`
  trigger the page's Rescan button fires. Steps: `npm ci` → `npm run build-site` →
  deploy `public/` to GitHub Pages → `npm run notify`.
  ⚠️ **It nominally means 10:00 SGT and actually delivers around 13:20–13:50
  SGT.** GitHub queues scheduled runs on free public repos by roughly 3.5 hours —
  measured at +3h18 to +3h46 on four consecutive days. This is ordinary queueing,
  not a fault, but it means **"it didn't run" is almost always "it hasn't run
  yet"**. To land near 10:00 SGT the cron would have to be about `30 22 * * *`
  (the previous day). Not changed — the user's call.
- **`.github/workflows/add-to-list.yml`** — the privileged half of the **Buy**
  button: writes the grocery-list row, records the cooldown, appends to the
  purchase log, comments the result on the issue and closes it. No Telegram ping —
  the user gets one daily digest and doesn't want adds narrating themselves. It
  deliberately has **no `concurrency` group**: that would cancel pending runs and
  lose adds when two people add at once. The cooldown push rebases and retries
  instead.
- **`.github/workflows/item-actions.yml`** — Reset, Not in use, Add, Replace and
  Ignore. Kept separate from the above because undoing a snooze has a different
  blast radius from writing to Notion. Issue titles use a fixed `Item: ` prefix,
  which is what the workflow's allowlist matches, so renaming a button on the page
  cannot break the two-tap path.

**One-tap.** Tapping "⚡ enable one-tap" at the foot of the page and pasting a
fine-grained PAT (this repo, Contents: read/write) lets the page fire
`repository_dispatch` at the same workflows straight from the browser —
`api.github.com` allows cross-origin calls, so nothing sits in between. The token
lives only in that browser's localStorage. Any failure falls back to the two-tap
issue flow. Two people share this setup; a second person needs no GitHub account
(send them a `#add-token=…` link, and use a separate PAT per phone so one can be
revoked alone).

- **Repo (public):** https://github.com/tmje30/NTUC-and-other-scrapers-nutrition
- **Live page:** https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/
- Workflow files push normally; if a push is ever rejected for the `workflow`
  scope, `gh auth refresh -s workflow` settles it.

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
- **`ANTHROPIC_API_KEY`** — the nutrition lookup. **Optional**: unset is fully
  supported and costs nothing — rows are created without nutrition and the reply
  says to fill it in. Needed as a repo secret *and* in `.env`; the Chrome
  extension takes its own copy on its Options page.
- **`CHROME_PATH`** — where to find Chrome, if it isn't on `PATH` or at a standard
  location.
- **`ADD_EXTRA_LOGINS`** (repo variable, not a secret) — extra GitHub logins
  allowed to use the two-tap issue flow. Without it, a non-owner's issue is
  ignored silently.

Access the Notion integration needs:

- **Read** on the **Ingredients** and **Meal prep** databases — the daily scan.
- **Write** ("Insert content") on the **grocery List** database — the Buy button.
  Reading alone is no longer enough.
- **Write** on **Ingredients** — the Add / Replace / park buttons and the
  extension.

Other requirements:

- **Node 22+**, npm ≥ 10.9.2.
- The repo must be **public** for free GitHub Pages, and Pages must be enabled.
- The laptop runner needs a working `git push` credential (Windows Credential
  Manager), the scheduled task above, and — since the WAF change — **Google Chrome
  installed**, which it launches briefly to earn a session cookie when it gets
  challenged.
- The Chrome extension needs `https://api.anthropic.com/*` in `host_permissions`
  plus the `anthropic-dangerous-direct-browser-access` header, because a service
  worker sends a browser `Origin`.

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
- **Price book** — the `Vendor n` / `Price [Vendor n]` / `Size[Vendor n]` columns:
  where else an item can be found and what *that* shop charges. Not the baseline,
  which is what the user actually pays.
- **Cooldown** — a temporary suppression of one item after you buy it, so the same
  deal isn't offered the week after. Length is derived from pack size and monthly
  usage.
- **Exclusion** — a permanent correction: banned words for an ingredient, one
  blocked product for one ingredient, or a product retired for every ingredient.
- **Pack shot** — a photograph of the product the shop publishes. The **back** one
  carries the nutrition label; the front carries only marketing copy, which is why
  it's excluded.
- **Commodity food** — fresh produce and raw meat, where no printed label exists
  to find. These skip the search tools entirely and cost about a tenth of a cent.
- **Nutrition panel** — the nutrition table a shop publishes on a product. Always
  stated *per serving*, never per 100 g, so it must be scaled — and refused if the
  serving size isn't stated.
- **Incapsula** — the bot-protection in front of Sheng Siong. It answers with a
  JavaScript challenge instead of content, which is why a real headed Chrome has
  to earn a cookie first.
- **CDP** — Chrome DevTools Protocol, the interface used to drive an installed
  Chrome. No Playwright, no extra dependency.
- **Plausibility gate** — on a marketplace, the rule that drops anything priced far
  below the cluster median. The minimum on a marketplace is usually the scam.
- **One-tap** — firing a workflow straight from the page using a personal access
  token saved in the browser, instead of the default two-tap GitHub-issue flow.

## What changed in this update

- **2026-08-05 — Everything the guide had not caught up with.** The guide had
  drifted: it described the daily scan accurately but knew nothing about the
  write-back half of the system, which is now most of it. Added in this pass:
  - **The deal card's five buttons and the `⋯` correction menu** — Buy, Ignore,
    Add, Replace, + Macros, and the three corrections — plus the cooldowns,
    exclusions and purchase log behind them, and the two GitHub Actions workflows
    that hold the Notion token on the static page's behalf.
  - **The history page**, the second page on the site, and the three doors into
    the Ingredients database that now share one writer.
  - **The Chrome extension**, and the two very different ways it has to read
    FairPrice and Sheng Siong product pages.
  - **Nutrition, end to end** — the four sources cheapest-first, the rule that
    nothing spends money unasked, reading the label off the shop's own
    back-of-pack photo, the per-serving trap in published panels, and what each
    path actually costs.
  - **Vendor scoping** — the probe, what each of six shops can and can't give, the
    baseline-versus-price-book distinction, and the marketplace size parser.
  - **The test suite** — 167 offline cases, no runner, no dependency.
  - **Corrections to facts that were wrong here.** The cloud job is `cron:
    "0 2 * * *"`, not `"0 22 * * *"`, and it lands around 13:20–13:50 SGT rather
    than the stated 06:00 — GitHub queues free-tier scheduled runs by about 3.5
    hours. Workflow files push normally now; the note saying they need the web
    editor was stale.
- **2026-07-28 — Initial version.** First `SYSTEM-GUIDE.md`, written after the
  residential hybrid went live: the laptop scans Sheng Siong on a daily Task
  Scheduler job and commits `data/shengsiong-latest.json`; the cloud reads that
  file (via `shengsiong-file.ts`) and now shows Sheng Siong deals alongside
  FairPrice, falling back to FairPrice-only when the file is missing or stale.
