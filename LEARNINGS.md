# Learnings

Running log of decisions, gotchas, and non-obvious facts. Newest on top.

## 2026-07-30 — A `concurrency` group silently DELETES queued work

`add-to-list.yml` originally had `concurrency: { group: add-to-list,
cancel-in-progress: false }` to stop two runs racing on `cooldowns.json`. That
setting does not queue indefinitely: when a new run enters the group, GitHub
**cancels whatever was already pending**. With one person adding, invisible.
With two people sharing the page, a third tap during a run deletes the second
person's add — no error, no comment, nothing.

Removed the group. The race it guarded is handled where it belongs, in the
commit step: push, and on rejection `git pull --rebase --autostash` and retry,
up to 5 times. Two single-entry appends to a JSON file rebase cleanly.

General rule: `concurrency` is right for *deploys*, where only the newest state
matters and superseding is the point. It is wrong for *queues of independent
events*, where every item must be processed.

## 2026-07-29 — A static page CAN reach GitHub: api.github.com allows CORS

Spent a while assuming one-tap Add required a relay service (Notion Worker or
Cloudflare) purely to hold a credential. It doesn't. `api.github.com` answers
cross-origin requests, so a GitHub Pages page can fire `repository_dispatch`
itself with a token the user pastes into `localStorage`.

Verified from the live page rather than assumed — a preflighted POST with an
`Authorization` header from `https://tmje30.github.io`:

```
status 401, body {"message":"Bad credentials"}   ← reached GitHub, CORS fine
```

A CORS block would have thrown `TypeError` before any status existed. Note
`headers.get("access-control-allow-origin")` returns `null` even so — that
header isn't exposed to script; being able to *read the body at all* is the
proof.

This beats a relay on every axis: free, nothing to deploy, and the response is
readable so the button can report the real outcome (a Notion webhook returns no
CORS headers, forcing `mode: "no-cors"` and an opaque "sent"). Design rule that
follows: the button stays an `<a href>` to the pre-filled issue and JS only
upgrades the click — no token, revoked token or JS off degrades to two taps
instead of breaking.

## 2026-07-29 — `Used 'N' Plan` omits the unit for By-ml rows

`Soy Sauce (light)` is in Plan 1, yet the page filed it under "Other items on
offer" with no monthly usage. Its formula reads:

```
300 / 0.5Pk | Monthly[20] |  1.85 SGD     ← By ml: no unit
40 x / 0.4Pk | Monthly[20] |  2.5 SGD     ← By Unit: unit present
```

`MONTHLY_RE` required `(ml|g|x)`, so **every liquid silently failed to parse** —
7 of the 27 grocery ingredients in Plan 1: soy sauce, fish sauce, sesame oil,
bran oil, cider vinegar, cooking rice wine, low-fat milk. Consequences were
quiet rather than loud: no `uses ~X/month` line, wrong page section, no
monthly-saving sort, and cooldowns falling back to the flat no-usage default
(the first real add, Rice Wine, got 14 days instead of 73).

The unit is now optional, with the row's `Unit type ` supplying it. Lesson: a
formula's rendering varies by unit type — never assume one shape from one
sample. Worth re-running a "parses / fails" count over the whole DB after any
change to that regex.

## 2026-07-29 — `repository_dispatch` allows only 10 client_payload properties

```
422: No more than 10 properties are allowed; 12 were supplied.
```

An `AddPayload` has 12 fields, so the one-tap relay in `src/index.ts` would have
failed on its first real tap — the limit is on **top-level** keys only, so
senders nest it: `client_payload: { payload: {...} }`. `add-to-list.ts` accepts
both shapes (`dispatched.payload ?? dispatched`).

Also: **`gh run rerun` replays the original commit**, not current `main`. Fixing
a bug and re-running a failed run therefore re-runs the bug. To retry against
the fix, fire a fresh event (`gh api repos/OWNER/REPO/dispatches`) — that one
does run at the default branch's HEAD.

## 2026-07-29 — Never hardcode a grocery-list column name

The first real Add failed with `Price  is not a property that exists.` — a
column verified against the live schema **the same morning**. Between the check
and the tap, `Price ` had been renamed `Price , To Buy ` and a `Current Price `
column added. This DB is edited by hand and its names drift constantly
(trailing spaces, commas, renames); the Ingredients DB is the same story.

`grocery-list.ts` now resolves columns from the live schema at write time
(`resolveListProps`): the title is whatever has type `title`, prices are the
`number` columns matching "current" / "buy" / "price", vendor is the `rich_text`
matching "vendor". Unresolved columns are **skipped, not sent** — Notion rejects
the entire `pages.create` for one unknown property name, so a missing column
must never become a failed add. Verified against the old schema, the current
one, and a hypothetical future rename.

Reading Ingredients still matches names exactly; that's a read, and a wrong name
there surfaces as a missing value rather than a hard failure. Worth revisiting
if it ever bites.

## 2026-07-29 — Two ways "the same word" failed to match

**1. The must-match check bypassed normalisation.** Properties went through
`tokensPresent()` (synonyms + stemming) but must-match keywords used a raw
`hay.includes(kw)`. So `Milk (Skimmed)` rejected "FairPrice UHT Milk - **Skim**"
even though the property test folded both to `skim`. Both now use the same test;
that item became a −38% deal.

**2. The stemmer left 23 of 32 equivalent word pairs unmatched.** Both sides are
stemmed identically, so a mismatch only bites when the item uses one form and the
title another — which is exactly the skim/skimmed case. Fixed:

| Rule | Fixes |
| --- | --- |
| collapse doubled consonant after `-ed` (f/l/s/z excluded, so `stuffed`→`stuff` survives) | skim/skimmed, chop, can, trim |
| require a ≥4-char stem before stripping `-ed` | shred/shredded (was becoming `shr`), breed, speed |
| strip silent `-e` | slice, grate, smoke, pickle, glaze, mince |
| `-ies`/`-y` → `-i` | berry/berries, cookie/cookies |
| `-ise`→`-ize`, `-our`→`-or` (length floors keep `anise`, `cruise`, `flour` intact) | pasteurised/pasteurized, flavoured/flavored, colour/color |

**8 pairs are deliberately left unmatched**: dice/diced and bake/baked (too short
for the `-ed` floor), dry/dried, fry/fried, freeze/frozen, grind/ground,
leaf/leaves, fibre/fiber. None matter here — the ones that do any work
(`dried`, `frozen`, `ground`, `leaves`) are matched by **raw-text regexes**
(`PRODUCE_PROCESSED_RE`, `ATTRIBUTE_GROUPS`, `PART_GROUPS`), not by tokens, so
stemming never sees them. Don't chase the remainder: each extra rule risks
mangling a real word, and `grind → ground` in particular must NOT be folded
globally (see the context-dependence note above).

## 2026-07-29 — Synonyms are GLOBAL; context-dependent equivalences don't belong there

A `synonyms.json` entry rewrites every item name and every product title, so it may
only hold equivalences that are true **everywhere**. Two worked examples:

- ❌ `minced → ground` looks obviously right, but "ground" means *minced* for meat
  and *powdered* for spice ("White Pepper - Ground"). It was removed from the
  register and expressed instead as one member of the meat-cut variety group
  (`"mince|minced|ground"`), which only fires when the ITEM itself names a cut — so
  a spice item is untouched. **Context-dependent equivalence ⇒ scope it to the
  guard that owns the context, not the global register.**
- ✅ `sotong → squid`, `yoghurt → yogurt`, `veg → vegetables` are true everywhere.

Also fixed while in there: variety-group members were listed singular AND plural as
SEPARATE entries, so "Chicken thigh" read "Chicken Thighs" as a different cut and
penalised it. Members are now alternations (`"thighs?"`, `"fillets?|filets?"`).

## 2026-07-29 — "un-" in a property is a NEGATION, not a word to find

`Squid Ring (unbreaded)` found 18 products and accepted **0**; `Apple Cider vinegar
(Unpasteurized)` accepted 0 of 21. Both were requiring a word no store ever prints.
`parseName` now reads `un<root>` (root ≥5 chars) as "must NOT contain root", the
same treatment as `(not red)`.

Word-boundary matching makes this safe in both directions: "Unsalted Butter" does
**not** contain `\bsalted\b`, so it passes, while "Salted Butter" is rejected.
Results: Squid Ring 0 → 5 (plain rings only; tempura and battered rejected via
`battered|tempura|panko → breaded` in the register), vinegar 0 → 20.

## 2026-07-29 — The unit-type dimension guard is ASYMMETRIC (measured)

A "By Gram" item is a solid sold by weight, so a candidate packed in ml/L is a
different product. Measured over the whole inventory against live FairPrice:

- **By Gram → reject volumetric: SAFE.** Of **260** candidates accepted for the 37
  By-Gram targets, only **2** were volumetric — and both were wrong ("Aoren Drop of
  Hope - Red Apple", an apple *drink*, matching the Red Apple fruit). Implemented.
- **By ml → reject grams: NOT safe.** Of 61 accepted for By-ml targets, **5** were
  gram-packed and several were genuine — FairPrice labels "Double A 100% Sesame
  Oil" and "Zarotti Colatura Anchovies Fish Sauce" by weight. **Not implemented.**

Physically sensible: a solid is never sold in ml, but a liquid is sometimes sold by
weight. Don't "tidy this up" into a symmetric rule — it would drop real products.

This is the guard the original port dropped with an "ml ≈ g, acceptable for v1"
note; the sibling project has it as its `mlOnly` test. Note it only fires when the
unit type is right, so it depends on rows being tagged correctly in Notion.

## 2026-07-29 — Precision cannot separate brand noise from extra ingredients

Tempting rule: "a single-ingredient item should reject titles with lots of extra
words." It does not work, and here is the counter-example that kills it:

| Title | precision | verdict |
| --- | --- | --- |
| `Sumifru Sweet Mountain Bananas` (correct) | **0.25** | must accept |
| `…Szechuan Pepper 0.0 White Wine` (wrong) | **0.33** | must reject |

The correct match has *lower* precision than the wrong one, because brand and
marketing words ("Sumifru Sweet Mountain") are indistinguishable from ingredient
words ("Beet Hop White Wine") by counting alone. Any precision floor high enough to
catch the wine also rejects real produce. Extra words are therefore filtered by
**vocabulary** (form words, other-fruit/veg names, drink forms) and by the
**dimension guard**, never by a raw precision threshold.

## 2026-07-29 — The sibling project is the reference; check it before inventing

`C:\Users\newuser\Claude\Inventory Price upkeeper worker [Notion]\src\match.js` is
where this matcher came from and it already solves most filtering problems. Three
things were re-ported after being wrongly dropped or reinvented here:

- **The precision term is back.** `score()` is now `0.7 × coverage + 0.3 ×
  precision` as in the sibling. The old comment claimed precision "wrongly sank
  long-title matches like Laobanniang Dried Sze Chuan Peppercorn" — **that was
  false**: it scores **0.81**, well above ACCEPT (0.7). Without precision, a bare
  "Banana" matched anything with the word in it.
- **`( )` is the CATEGORY bracket** (sibling `CATEGORY_TOKENS` / `parenTokens`),
  not a literal to find in the title. `Banana (Fruit)` matched *nothing* real and
  accepted "Freeze Dried **Fruit** — Strawberry & Banana" when treated literally,
  because no banana is ever labelled "fruit".
- **`PART_GROUPS`** (fruit/leaf/root/seed/flower/stem): item names one part, title
  names only another ⇒ wrong product. This is what rejects "Banana Leaves".

Net effect on `Banana (Fruit)`: 5 real bananas accepted; leaves, shallots, prawns,
baby puffs, cereal, banana milk and freeze-dried fruit all rejected.

Also ported: the sibling's `bestScore` idea — score the bare noun *and* the
noun+properties, take the max. Needed because some products are sold only under
the qualifier ("Fortune Tau Kwa" never says "tofu", so bare coverage was 0).

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
