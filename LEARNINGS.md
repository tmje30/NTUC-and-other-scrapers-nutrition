# Learnings

Running log of decisions, gotchas, and non-obvious facts. Newest on top.

## 2026-07-29 — Ingredient name syntax is the matching spec

`[brand]` / `{ignored}` / `(defining property)` in an ingredient `Name` are load-
bearing, not decoration. Parsed by `parseName()`; enforced in `evaluate()`. Full
table in SYSTEM-GUIDE. The non-obvious decisions:

- **Properties are enforced at scoring time, not in the search query.** Store
  keyword search returns *zero* results for qualifiers like `Bentong`/`Tau Kwa`,
  so the query is always the bare base noun and the property filters the results.
- **"Basic range" is the absence of a property.** Bare `Milk` and `Milk (Normal)`
  are the same thing and both *exclude* adjusted variants (`ADJUSTED_RE`: low fat,
  skimmed, lactose free, sugar free, …). This generalises the old hardcoded
  plain-milk rule. `(Normal|Regular|Plain|Basic|Standard|Original)` is a marker,
  never a required word — requiring it literally would match no real product.
- **Unmet property ⇒ REVIEW, not MISS.** It can never be published as a deal, but
  it surfaces as a "close match" recommendation (only when it also beats the
  item's own baseline — otherwise it's neither right nor cheaper).
- **Wrong brand under `Brand Specific` ⇒ hard MISS**, never recommended.
- **Form-word guards must be checked ONE WORD AT A TIME.** They compare the same
  regex against item and candidate, so a single alternation lets an item whose own
  name contains one word ("Milk", "Peanut Butter") switch the guard off for *all*
  the others. That bug let `Milk (Low Fat)` accept "Low Fat High Protein Milk -
  Green Tea". `GENERIC_FORM_RES` is now a list, tested individually.
- `Brand Specific` already exists as a `Select` option; as of this date **no row
  is tagged with it**, so the brand filter is inert until rows are tagged.

## 2026-07-27 — Platform: Notion Worker over GitHub Actions

The PRD nominated GitHub Actions, but we're building this as a **Notion Worker**
instead. Native Notion DB access (no standalone integration token to manage),
built-in Telegram bot + scheduled-send patterns, hosted/laptop-independent, and
this environment has dedicated build/deploy/operate skills.

- **Cost is a non-issue.** Notion Workers cost 0.002 cents/run from Aug 2026. A
  once-daily job is ~0.06 cents/month — under a cent a year.
- **No Claude calls needed.** All matching is deterministic: strip parentheticals
  → search term, keyword must-match list, price-per-100g arithmetic, and parsing
  the "Used '1' Plan" formula string. No LLM tokens on the hot path.

## 2026-07-27 — Sheng Siong: Meteor DDP works headlessly (Incapsula not a blocker)

`allforyou.sg` is DEAD (NXDOMAIN) — PRD's assumption is stale. Live store =
`shengsiong.com.sg`, a Meteor 3.1.2 SPA behind Incapsula, no public HTTP/JSON API
(data over DDP/SockJS WebSocket). **Key win: a plain Node WebSocket to
`wss://shengsiong.com.sg/websocket` connects and calls methods fine — no auth, no
token, Incapsula does not block it.** Node 22+ global WebSocket, no dependency.

DDP handshake: send `{msg:"connect",version:"1",support:["1"]}`, wait for
`{msg:"connected"}`, then `{msg:"method",method,params,id}` → `{msg:"result",id}`.
Answer `{msg:"ping"}` with pong. See `src/core/stores/ddp.ts`.

Methods (from JS bundle `/<hash>.js`, class `Products`/`Categories`):
- **Search** = `Products.getByAllSlugs(filters, miscFilters, page, pageSize)` —
  FOUR POSITIONAL ARGS, not one object (that was my first wrong guess). Query goes
  in `filters.searchFilter.slug`. Full empty scaffolding in `shengsiong.ts`.
  Results carry `packSize` ("4 x 125 ml","1 kg") + `price` + `prevPrice`
  (on-sale = prevPrice>price) + `slug`, but NOT netWeight.
- `Products.getOneByIdOrSlug(slug, null, {slug:""})` → full detail incl. numeric
  `netWeight` (grams).
- `Products.getByCategoryId(<oid>)` → 20 products in a category (oid wire form
  `{"$type":"oid","$value":"..."}`).
- `Categories.getByLevels([[1,2]])` → 186 categories w/ ids+slugs.
- `SearchKeywords.getMatched({matchingValues:"tofu"})` → typeahead suggestions.

Sheng Siong's catalog is broader/more processed than FairPrice → many flavoured
variants (Banana Milk/Cake/Essence); needs a fuller FORM_WORDS list in compare.

## 2026-07-27 — Match quality: form-word negative filter kills false deals

First end-to-end run surfaced the PRD's predicted false matches: Ginger→"Ginger
Ade" (soft drink), Banana→"Soymilk - Banana", Butter→"Buttercup ... Spread"
(margarine). Token containment alone can't tell these apart. Fix in
`src/core/compare.ts`: a FORM_WORDS blocklist (drink, ade, juice, soda, soymilk,
flavoured, spread, seasoning, …) — reject a candidate whose name contains a form
word the TARGET doesn't. Dropped false deals; 12→11, all remaining plausible.
Residual imperfections (Oil (Bran)→generic veg oil; Onion (white)→red onion) are
the PRD's "fix by editing the Name" cases — acceptable. Only cheaper-than-baseline
false matches matter (more-expensive ones never alert).

## 2026-07-27 — FairPrice: SSR-scrape, and DisplayUnit is the real pack size

FairPrice search is a server-rendered Next.js page. Fetch `/search?query=<term>`
(plain UA, no auth, 200), extract `__NEXT_DATA__`, products live at
`props.pageProps.data.data.page.layouts[*].value.collection.product` (I recurse
for objects with name+final_price+slug). Direct JSON endpoints exist
(`SEARCH_API_URL=public-api.omni.fairprice.com.sg`) but their params aren't
documented — `/search` 500s on guessed params, `_next/data/<buildId>/search.json`
404s. SSR-scrape (~2.6 MB/term) is the reliable path; optimise later.

Product fields: `final_price` (SGD, whole pack), `brand.name`, `slug`
(→ `/product/<slug>`), `storeSpecificData[0].mrp` (list price; on-sale when
final_price < mrp), no promo end-date in payload.

**Pack size trap:** `metaData.Weight` is unreliable ("2 gm" for 2 L milk).
`metaData.DisplayUnit` is accurate ("1.89L", "830ml", "10 x 100ml") — parse it
first, then `Unit Of Weight`, then `Weight`. ml/l treated as g (density approx).
A mis-parse to a *small* weight is safe (inflates per-100g, never a false deal);
only under-parsing weight *large* could cause a false cheap alert — avoided.
See `src/core/stores/fairprice.ts`, `weight.ts`.

## 2026-07-27 — Active-plan resolution: use `Used 'N' Plan`, NOT `Current Plan`

The user added a `Current Plan` select to the **Meal prep** DS (one option "Main",
set on 5 rows). It looked like the intended active-plan switch, but it is **not
wired into anything**: the `Used '1/2/3' Plan` formulas derive membership from
Meal prep's `Formula '1'/'2'/'3'` columns (="✅" when a line is in that plan),
independent of both `Current Plan` and the 1/2/3 checkboxes. Proof: `Current Plan
= Main` matches exactly the 5 checkbox-"1" rows, yet ~33 ingredients have a
populated `Used '1' Plan` — so neither Main nor the checkboxes drive it.

Decision: read the already-correct `Used 'N' Plan` string directly (PRD's original
plan), N from `ACTIVE_PLAN_NUMBER` (default "1"). Plan 1 → 27 grocery targets.
If the user later wants `Current Plan` to be the switch, that needs a Notion-side
formula they add (don't create schema for them). `src/core/notion.ts`.

## 2026-07-27 — Live Ingredients data model (verified, not guessed)

Ingredients data source id `34b69a18-4fe7-80e6-904e-000b208cf560`. 88 named rows.
Property names have typos/trailing spaces — **must match exactly**:
`Name` (title), `Price,SGD` (number), `Weight /Units of New Product ` (number),
`Unit type ` (select: "By Gram" | "By ml" | "By Unit"), `Price per 100g ` (formula number),
`Catagory` (select), `Used '1' Plan` / `Used '2' Plan` / `Used '3' Plan` (formula string).

- **`Price,SGD` = whole-pack price**, pairs with Weight. Verified: Bread 3.8/16=0.2375/unit→23.75/100. (PRD open question resolved.)
- **`Price per 100g ` is precomputed** — read it, don't recompute. BUT for `By Unit`
  items it's price-per-100-**units**, not per-100-g → NOT comparable to a store's
  per-100g. Real By-Unit grocery items: eggs, bread(slices), tea bags.
- **`By ml`** (10 rows: milk ×3, soy sauce, oils, fish sauce, rice wine, vinegar, …)
  is a **weight-based** type: the whole system treats ml ≈ g, so By-ml compares on
  `Price per 100g ` exactly like By Gram (only the display unit differs, ml/L vs
  g/kg via each product's `volumetric` flag). `isByWeight()` in `notion.ts` covers
  both. Before 2026-07-29 By-ml rows got a null baseline and were silently dropped.
- **Plan membership** = which `Used 'N' Plan` is non-empty (empty ⇒ not in plan N).
- **`Used 'N' Plan` format** (3 `\n` lines; unit `g` for By Gram, `ml` for By ml, `x` for By Unit):
  `<daily> u | Daily |  <cost> SGD` / `<wk> u / <p>Pk | Weekly[5] | <cost> SGD` /
  `<mo> u / <p>Pk | Monthly[20] |  <cost> SGD`. Monthly = line 3. Parsed by
  `MONTHLY_RE` in `src/core/parse.ts` (verified via `src/scripts/test-parse.ts`).
- Many rows are **supplements/nootropics** (whey, creatine, lions mane, magnesium,
  Noopept, …) not sold at FairPrice/Sheng Siong; several have null price. These
  should be excluded from search (waste + false-match risk).
- Workspace also has duplicate-ish `OverView`, `Meal prep`, and `Meal prep, diet`
  data sources — for v1 the alert only needs the **Ingredients** source.

## 2026-07-27 — Portable core; don't depend on the Worker

Requirement: don't *depend* on the paid Notion Worker (it costs $10/month
minimum whether used or not), but be able to switch to it when already paying.
Design: a runtime-agnostic `src/core/` (Notion read, parsers, store modules,
compare, Telegram) with thin wrappers — GitHub Actions as the free default,
Notion Worker as an optional ~20-line wrapper. Honest caveat logged for the
user: once the core uses the plain Notion API + Telegram Bot API (both free on
GitHub), the Worker's native-access/scheduler/Telegram perks mostly evaporate;
its only real remaining draw is consolidation while already paying.

## 2026-07-27 — Notion SDK v5 = data sources, not `databases.query`

`@notionhq/client` v5 (API 2025-09-03): `client.databases` only has
retrieve/create/update — **no `query`**. Rows + schema live on DATA SOURCES:
`client.databases.retrieve` returns `data_sources: [{id,name}]`, then
`client.dataSources.retrieve(id)` for schema and `client.dataSources.query({data_source_id})`
for rows. `client.search({filter:{value:'database',property:'object'}})` lists
accessible DBs so we don't have to hand-copy IDs. See `src/scripts/introspect.ts`.

## 2026-07-27 — Scaffold

Created via `ntn workers new . --git --install` (ntn 0.16.0) directly into the
project root. `.claude/skills` → `.agents/skills` junction resolved correctly on
Windows out of the box (no manual `mklink /J` needed this time). Entry point is
`src/index.ts` with the example `sayHello` tool — delete once real tools land.
