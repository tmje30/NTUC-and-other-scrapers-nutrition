# Scoping — searching the shops tagged in `Vendor[n]`

> ⚠️ **Superseded for Guardian, MyProtein and Carousell (2026-08-09).** Those three are
> built, and **four per-vendor claims below were measured false**: Guardian needs no
> browser (its `/catalogsearch/` URL is dead and its GraphQL answers a plain fetch),
> Carousell's `itemCondition` is not a usable filter, its rendered text drops every
> lowercase `s`, and MyProtein has no single price per product. The **census is also
> stale** — Guardian is tagged on 5 rows, not 0, and Sheng Siong on 58, not 0. The
> **routing rules and the three writer rules still govern.** See
> [`session-2026-08-09-vendor-scan.md`](session-2026-08-09-vendor-scan.md).

*Written 2026-08-04. Nothing here is built. Every verdict below comes from a live probe
run the same day, and the probe commands are given so they can be re-run when a site
changes — which they will.*

The ask: the daily discount scan currently covers **FairPrice and Sheng Siong only**.
The Ingredients DB tags other shops in `Vendor 1` / `Vendor 2` / `Vendor 3`, and the new
**Website Used** DB now holds a main URL and a discounts URL for each. Should the scan
follow those tags?

## The finding that decides the shape of this

Counted over all **94** Ingredients rows: exactly **five** carry a non-NTUC vendor tag.

| ingredient | `Catagory` | vendors tagged |
| --- | --- | --- |
| `Facial Moisturising Lotion [CereVe]` | Household Supplies | Watsons |
| `Vitamin D` | Suppliments | Iherb |
| `Whey [Titan]` | [1] Meats/Dairy/Proteins | Shopee + Carousell + Google Search |
| `whey [Atlas]` | [1] Meats/Dairy/Proteins | Shopee + Carousell + Google Search |
| `whey, essential [MyProtein]` | [1] Meats/Dairy/Proteins | Shopee + Carousell + My Protein |

**Three of the five are whey protein.** And HANDOVER "Remaining work #9" already says:
*"`Whey` is the last search still returning nothing from both shops."*

So this is not a general multi-vendor scraper request wearing a disguise. As tagged today,
the Vendor[n] feature is **a targeted fix for one unsolved item — whey — plus two
one-offs**. Scope it that way and it is small and worth doing. Scope it as "search every
shop for every ingredient" and it is months of anti-bot work for items FairPrice already
prices fine.

⚠️ **`Sheng Siong` is tagged on ZERO rows**, despite being one of the two shops the whole
residential-runner hybrid exists to scrape. So the tags cannot be read as "the shops that
serve this item" — they are closer to "the shops the *scan does not already cover*". Any
code that treats an empty tag as "don't search" would silently kill the FairPrice scan on
42 rows. **The tags must be a widening, never a narrowing.**

## What the columns MEAN — and therefore what a search should write

*Stated by the user 2026-08-04, after the first draft of this doc got it wrong. This section
governs; anything above or below that disagrees with it is stale.*

> ⚠️ **Superseded in part on 2026-08-09.** The two-prices distinction below was real and is
> exactly what the user has now collapsed: the **baseline columns are being deleted**
> (`Price,SGD` is gone; `Weight /Units of New Product ` and `Vendor, Current ` are renamed
> `… - Delete? `), and `Price,SGD [Cheapest]` / `Cheapest Price/Kg ` / `Cheapest Vendor ` are
> **formulas over the price book**. So the price book is no longer "not what the user pays" —
> it is the only record of any price, and the baseline is derived from it. The counts below
> ("filled on none, ever") are the *before* picture; Add and Replace now fill it on every tap.
> Everything about **routing** — which shop to ask for which category — is unaffected.

There are **two different prices** on every ingredient row, and they answer different questions:

| | column(s) | meaning |
| --- | --- | --- |
| **the baseline** | `Price,SGD` + `Weight /Units of New Product ` + `Vendor, Current ` | **what the user actually, consistently pays**, and where they buy it — their current cheapest/most-used source. This is the number every discovery is measured against |
| **the price book** | `Vendor 1/2/3` + `Price [Vendor n]` + `Size[Vendor n]` + `Vendor n URL` | **where else the item can be found, and what that shop charges.** NOT what the user pays |

So `Vendor, Current ` is not "the last shop we saw this at" — it is a **deliberate statement of
where the base price comes from**. And `Vendor[n]` is a catalogue of alternatives.

**This changes the output of the whole feature.** The first draft of this doc assumed a vendor
search would produce *deal cards*. It should not. Its natural output is to **fill the price
book** — `Price [Vendor n]`, `Size[Vendor n]`, `Vendor n URL` — and let the comparison fall out
of it: the row's own `Price per 100g ` formula against each vendor's price per 100 g.

Measured over all 94 rows, 2026-08-04:

| column | rows with a value |
| --- | --: |
| `Price,SGD` (baseline) | **71 / 94** |
| `Vendor, Current ` | **7 / 94** |
| `Vendor 1` | 52 / 94 |
| `Vendor 1 URL` | 6 / 94 |
| `Price [Vendor 1/2/3]` | **0 / 94** |
| `Size[Vendor 1/2/3]` | **0 / 94** |
| `Vendor 2 URL` | 0 / 94 |

**The price book has never been filled — not once, on any row.** That is the gap this feature
exists to close, and it is why writing deal cards would have been solving the wrong problem.

Note also: 71 rows have a base price but only 7 say where it comes from. The baseline is
mostly unsourced.

### Two outputs, not one

*Clarified by the user 2026-08-04.* The vendor search serves **both** purposes:

| vendor kind | primary output | secondary |
| --- | --- | --- |
| **directed** (a named shop — Watsons, iHerb, Sheng Siong…) | **fills the price book** — `Price [Vendor n]`, `Size[Vendor n]`, `Vendor n URL` | a deal card when it beats the baseline |
| **open** (`Vendor 3` — Google, Amazon; not pinned to one shop) | **a deal card**, because that is what carries the URL and the Buy button | `Price [Vendor 3]` as a "best price seen" watermark |

⚠️ `Vendor 3` having **no `Vendor 3 URL` property is deliberate, not an omission** — an open
search has no fixed shop, so there is no stable URL to store. (`Price [Vendor 3]` and
`Size[Vendor 3]` *do* exist and can be written.) Since the found URL has nowhere to live in the
row, the **deal card is the only place it survives** — which is exactly why an open search's
primary output is a card and a directed vendor's is a row.

### Directed search — the routing rule

**Do not search every term at every shop.** Bread and whey have no business being looked up at
Watsons; a specific lotion has no business being looked up at NTUC. Beyond the noise, an
undirected search is what makes results messy and matching hard.

Routing comes from two places, most specific first:

1. **`Vendor[n]` tags on the row** — an explicit statement of where this item can be found. Wins.
2. **`Catagory`, as the default** — for the 89 rows carrying no useful tag.

The category default, from the live census (94 rows, 2026-08-04):

| `Catagory` | rows | route to | today |
| --- | --: | --- | --- |
| [1] Meats/Dairy/Proteins | 17 | FairPrice + Sheng Siong | same |
| [3] Fruits/Vegetables | 12 | FairPrice + Sheng Siong | same |
| [6] Sauces/Wines/Vinegars | 9 | FairPrice + Sheng Siong | same |
| [2] Wheat/Rice/Carbs | 7 | FairPrice + Sheng Siong | same |
| [4] Fats/Oil | 4 | FairPrice + Sheng Siong | same |
| [7] Teas/Coffees | 3 | FairPrice + Sheng Siong | same |
| [5[ Sugar/Sweetners | 2 | FairPrice + Sheng Siong | same |
| Spice | 1 | FairPrice + Sheng Siong | same |
| **Suppliments** | **30** | **iHerb + MyProtein** | **excluded entirely** |
| **Household Supplies** | **7** | **Watsons + Guardian** | **priced per 100 g against food** |
| Filler | 1 | — excluded | same |
| *(none)* | 1 | — needs a category | searched |

### This retires the deny-list question

Open item #20 asked whether to *exclude* `Household Supplies`, and the first draft of this doc
asked the same about `Suppliments`. **Routing is a better answer than exclusion for both.**

- `Household Supplies` stops being compared per-100 g against peanut butter — not because it
  was banned, but because it is asked at a pharmacy instead of a supermarket.
- `Suppliments` — **30 rows, a third of the DB** — stops being invisible. It is the largest
  category in the database and the scan has never looked at one of them.

It also removes the recurring trap in #20: a **new** `Catagory` option now fails safe by having
no route (searched nowhere, reported) rather than being scanned against food by default.

### Three rules any writer must obey

1. **Find the index by matching the vendor name; never assume a slot.** The mapping is
   per-row — `Vendor 1` is Shopee on `Whey [Titan]` and Watsons on `Facial Moisturising
   Lotion [CereVe]`. A scrape of Guardian must write to whichever index *says* Guardian.
2. **If no index names that shop, write nothing.** Do not add the vendor to a free slot — the
   tags are the user's statement of where an item can be found, exactly like `Don't Search`.
   Report it instead.
3. **Never write `Vendor, Current ` from a price scan.** Changing the baseline is a deliberate
   act ("I'm switching to this"), which is what the extension's *Replace With This* and the
   deals page's *Replace* are for. A background scan must never move it.

### ✅ A live bug this uncovered — FIXED 2026-08-09

[`ingredient-write.ts`](../src/core/ingredient-write.ts) wrote the captured product's URL into
**`Vendor 1 URL`** unconditionally — the slot belonging to whatever shop `Vendor 1` names.
Capture the CereVe lotion from **Guardian** and a Guardian URL landed in the **Watsons** slot.
`Vendor 1` was filled on **52** rows, so it could misfile on any of them. Both writers were
affected (extension *Add* and the deals/history page *Add*).

Fixed by [`vendor-slots.ts`](../src/core/vendor-slots.ts), which does exactly what rule 1 above
demands: the URL goes to `URL [Vendor n]` for the n that names **this** shop, or to a free slot
tagged with it, and nowhere otherwise.

⚠️ **Two schema facts in this section are now out of date.** There are **four** vendor slots,
not three, and `URL [Vendor 3]` and `URL [Vendor 4]` both exist — so the "`Vendor 3` has no URL
column, an open search has nowhere to put a link" reasoning elsewhere in this document no longer
holds as a schema constraint. The columns were also renamed `Vendor n URL` → `URL [Vendor n]`.
Everything about *routing* and *what to search* below still stands; only the column inventory
moved.

## The gate a new vendor has to pass

A store module is [`StoreModule`](../src/core/stores/types.ts) — one method, `search(term)
→ StoreProduct[]`. That is a low bar. The real bar is the three things `StoreProduct`
needs before a result can be *compared*:

1. **A price.** Easy everywhere.
2. **A pack size with a unit** → `packWeightG` / `unitCount`. This is the one that kills
   most candidates. The system compares per 100 g / per L (or per piece), so a result with
   no size is not a cheap price, it is **no data**.
3. **A stable product URL**, for the dedupe, the `Ignore` blocks and the Add/Replace writes.

Nutrition (`nutritionHtml`, `images`) is optional — absent just means a paid lookup, which
is the Sheng Siong situation already.

## Per-vendor verdict — measured 2026-08-04

Probed with `curl` and a desktop Chrome UA. "Server-rendered" means the products and prices
are in the HTML a plain `fetch` gets back — no browser, no WAF session, no Incapsula dance.

**Anti-bot was fingerprinted separately from JS-rendering** — they are different problems with
different fixes, and conflating them is how you build a browser tier for a site that only needed
a header.

| vendor | anti-bot (from response headers) | content | verdict |
| --- | --- | --- | --- |
| **MyProtein** | **none for reads.** 200 to a bare curl. Fastly + Cloudflare in front, but no challenge; sets its own `chumewe_*` session cookies | `.list` paths **635 KB** server-rendered with `ld+json` | 🟢 **GREEN** |
| **iHerb** | **yes, but already solved** — see the sibling project below. `/` 403s; **`/search?kw=` answered a bare curl today**: 2.6 MB, **96** `/pr/` links, `itemprop="price" content="40.31"` | pack size **in the title** — *"…Whey Protein Isolate, Unflavored, 1 lb (454 g)"* | 🟢 **GREEN**, with a known fallback |
| **Guardian** | **NONE.** 200, plain Fastly cache, no WAF, no challenge. (The word "captcha" in the body is their login widget, not a block) | pure SPA — `/`, `/search?q=`, `/catalogsearch/…`, and a bogus `/vitamin.html` all return the **identical 136,929-byte** shell. Zero prices. A `/graphql` endpoint exists | 🟠 **AMBER — and it is *only* a rendering problem**, not a bot problem. Cheaper than first assessed |
| **Watsons** | **Akamai Bot Manager.** `Server: AkamaiGHost`, **403** on every URL including `/`, sets `AKA_A2`. Full browser headers don't help | unknown — never got past the wall | 🟠 **AMBER** (was RED) — same class as Sheng Siong's Incapsula, and **this repo already owns that pattern** |
| **Shopee** | **yes.** Search page 200 from `Server: SGW`, but the API returns **403 `error: 90309999`** (risk control) | SPA; nothing in the HTML | 🔴 **RED** |
| **Carousell** | **Cloudflare** (`Server: cloudflare`, `CF-Ray`); search URL 301s | SPA; the `ld+json` holds only nav categories, **1** listing link in 2.2 MB | 🔴 **RED** — *and see below* |
| **Google Search** | n/a — not a scrape | | see its own section |

**The two corrections that matter:** Guardian has **no anti-bot at all** (it just needs
rendering), and Watsons' wall is **Akamai**, which is the same *kind* of problem as Sheng
Siong's Incapsula — and [`incapsula.ts`](../src/core/stores/incapsula.ts) already solves that
kind here by launching a headed Chrome, harvesting the cookies and caching them to
`.sessions/`. Watsons is not a new capability, it is an existing one pointed at a second host.

## What the sibling project already solved

`C:\Users\newuser\Claude\Inventory Price upkeeper worker [Notion]` has been doing this for many
more shops, for longer. Its `SYSTEM-GUIDE.md` — *"How a price gets found"*, *"Website-fix
playbook"* — is the prior art. **Read it before writing any of this.** What transfers:

### 1. The resolution ladder (stop at the first that works)

1. **Pinned URL or SKU** → read that exact page. Authoritative.
2. **Bespoke adapter** for shops that need one.
3. **Generic**, fastest first: **fetch + parse** → **headless browser** *only if* fetch was
   blocked or the page is JS-rendered → **web-search discovery** if the shop's own search is broken.
4. **Bot-walled / login-walled shops** → driven through the user's **real Chrome over CDP**.

Our sites land on that ladder as: MyProtein and iHerb-search at step 3.1, Guardian at 3.2,
Watsons at step 4, Shopee/Carousell at step 2-as-marketplace.

### 2. ⚠️ The trust rule — import this unchanged

> An exact SKU / pinned URL / user confirmation = **auto-written**. A generic **name** match is
> **always REVIEW** — surfaced with the product URL to verify, never silently written.

That is the discipline this project needs for anything the open search returns, and it already
has the surfaces for it (a card you press, not a row that changes itself).

### 3. The iHerb fix, in full

Recorded there 2026-07-10. Two separate parts:

- **`SEARCH_OVERRIDES`** — iHerb's product URLs are `/pr/<slug>/<id>`, matching **none** of the
  generic product-link patterns, so its search loaded and every result was filtered out (7 items
  sat at "no match on the site"). Fix: force `search?kw=` + `resultHrefRe: /\/pr\//`. ⚠️ **The
  product name is in the link's `title` attribute, not its text.**
- **`CDP_SHOPS`** — iHerb is bot-walled, so it runs over the real ordering Chrome, whose bot
  check is cleared once and persists.

Our probe found `sg.iherb.com/search?kw=` answering a **bare curl** today — so the SG site may
not need CDP at all. Treat that as intermittent (exactly like Sheng Siong's Incapsula, where
"it worked when I tried it" proves nothing) and keep CDP as the fallback rung.

### 4. Marketplaces already have an answer there — and it's expensive

Etsy is their Shopee/Carousell: *bot-walls fetch **and** the headless browser, and it's a
marketplace so a host-wide search pulls every seller's listings.* Their fix was a **bespoke
adapter over the real Chrome**, scoping search to one shop and reading price from listing
JSON-LD. That works because an Etsy *shop* is a fixed seller. **Shopee and Carousell have no
equivalent scoping** — the whole point there is many sellers — so the pattern does not carry
over, which is a second, independent reason to leave them out.

### 5. ⚠️ SearXNG was already tried for open search, and failed

`SEARXNG-REPORT.md` (2026-07-03) is a full write-up. Self-hosted SearXNG doing
`<product> site:<domain>` discovery: fine for one query, **unusable at volume** — `google`
returned 0 silently, `bing` timed out, and brave/duckduckgo/startpage all CAPTCHA within a
handful of queries (**1-hour** suspensions). A 90-query run had its first 16 queries return
nothing. Fallback: a direct no-JS **DuckDuckGo** endpoint, plus **Serper.dev** (2,500 free
queries, Google index, no captcha) under evaluation.

**Do not re-derive this.** If the open search needs a search engine, the shortlist is already
DDG-direct or Serper — not a self-hosted metasearch instance.

## Shopee and Carousell — how to make them work

*The user asked for these specifically, as cheap marketplaces worth mining. Reconnaissance run
2026-08-04 in a real automated browser. **Both are workable.** The access problem turned out to
be smaller than the header probes suggested, and the judgement problem turned out to be
measurable rather than fatal. This section supersedes the "structural no" below, which is kept
for the reasoning that still applies.*

### Access — solved, differently for each

**Carousell needs no login at all.**

| step | route | evidence |
| --- | --- | --- |
| **search** | needs a **browser** (Cloudflare refuses curl) | an automated browser rendered the whey search with **188 cards**, each carrying title, price, condition, seller and age |
| **listing page** | **plain `fetch`** — no browser | HTTP 200, 371 KB, and a valid JSON-LD `Product` |

The listing JSON-LD is exactly what this project wants:

```json
"offers":{"@type":"Offer","availability":"https://schema.org/InStock",
          "itemCondition":"https://schema.org/UsedCondition",
          "price":"40.00","priceCurrency":"SGD","url":"https://www.carousell.sg/p/…"}
```

Price, currency, availability **and machine-readable condition** — so "new only" is a
deterministic filter, not a guess at the title. This is the sibling project's ladder exactly:
browser for discovery, cheap fetch for the read.

**Shopee needs a logged-in session — and it says so.** Every anonymous route is refused
identically: the API returns `error: 90309999`, and the automated browser is redirected to
`/verify/traffic/error?…&is_logged_in=false`, whose page reads:

> "Login Required — Looks like you're not logged in yet."

Both the search page and a product page return the same 162,381-byte shell to curl, so there is
no anonymous read anywhere. That is **not a fingerprint wall, it is an auth wall**, which is the
easier of the two: it is the sibling project's *"Login / captcha wall → route via the real
ordering Chrome (CDP); user logs in once, the profile persists"* case — the one already used for
Sprit & Co, ABcatering and Local Spirits.

⚠️ **The user logs in once, by hand, in that Chrome profile. Nothing in this repo may enter
credentials.** This repo already drives Chrome over CDP in
[`incapsula.ts`](../src/core/stores/incapsula.ts), so the transport exists; what is new is
pointing it at a profile that stays signed in.

Shopee's product URLs carry `…-i.<shopId>.<itemId>`, so once a session exists the item endpoint
is addressable directly — and **web search finds those URLs fine**, so discovery need never
touch Shopee's own walled search.

### Judgement — the real work, and it is measurable

Access was the easy half. Here is what a real Carousell whey search actually contains, measured
over the 47 distinct listings on page 1:

| | count | share |
| --- | --: | --: |
| listings with a **price** | 47 / 47 | **100%** |
| listings stating a **pack size in the title** | 29 / 47 | **62%** |

62% is a workable yield, and the other 38% are simply **dropped** by the rule this project
already has — no size, no result. Four concrete hazards, all visible in that one page of data:

1. **⚠️ `lbs` is the dominant unit** — "5 lbs", "5LBS", "5Lb", "2lb", "1.58LBS", "4.00 LBS".
   The existing weight parser is g/kg/ml/L. **Add lb and oz, or every supplement reads as
   sizeless.** This is the single highest-value line of code in the whole feature.
2. **⚠️ Multi-size titles must be REJECTED, not first-matched.** Real examples:
   `"Applied Nutrition Critical Whey Protein 450g/825g"` and
   `"Optimum Nutrition - Gold Standard 100% Isolate [1.58LBS / 5.2LBS]"`. A first-match regex
   takes 450 g / 1.58 LBS and pairs it with the price of the **big** tub — an error that makes a
   bad deal look spectacular. Same failure family as the 32 g serving read as 100 g.
3. **⚠️ Multipacks** — `"2 X MuscleBlaze … - 2lb"` is 4 lb, not 2. Detect the `N x` prefix and
   multiply, or reject.
4. **⚠️⚠️ The cheapest listing is usually the scam.** This is the important one, and the data
   shows it plainly. In one search, Optimum Nutrition Gold Standard **5 lbs** appeared at
   **S$37**, **S$38** and **S$110** — against a retail of roughly S$120. A "cheapest wins" rule
   surfaces the S$37 every single time, and it is not a 5 lb tub of ON.

**So: never take the minimum. Take the cheapest that survives a plausibility gate.** Cluster the
candidates by product + size, and reject prices far below the cluster median (a floor around
50–60% of median is the obvious starting point, to be tuned against real data). On a marketplace
the minimum is noise; the median is the signal.

Combined with the sibling project's **trust rule** — a generic name match is **always REVIEW** —
the residual risk is a card you look at before pressing anything, which is what every other
surface in this project already is.

### Suggested build order for these two

1. **Carousell first.** No login, no CDP, and the read is a free fetch off JSON-LD. It exercises
   the size parser, the multi-size rejection and the plausibility gate on real data at zero risk.
2. **The `lb`/`oz` units and the multi-size/multipack rejections** — pure functions, offline
   testable, and they belong in `src/tests/` beside the pack-shot and panel suites for exactly
   the same reason: being quietly wrong here is invisible and expensive.
3. **Shopee second**, once you have signed into the CDP Chrome profile yourself. Discovery via
   web search (`site:shopee.sg`) rather than its own search, since the URLs carry the ids.
4. **Both land as REVIEW cards** in their own page section, never auto-written and never into
   the baseline.

### Why Carousell and Shopee looked worse than "RED"

*Kept because the reasoning is still live — it is now the specification for the plausibility
gate above, rather than a reason not to build.* A marketplace strains rule 2:

- **No canonical pack size.** A whey listing is a photo and free text. "2 tubs" is not a size.
- **Resellers, bundles and grey imports.** The same SKU appears at ten prices from ten sellers
  under ten titles.
- **Shipping is not in the price**, and on Carousell often neither is meetup vs postage.
- **Authenticity.** Discount supplements from a marketplace is precisely the category where a
  suspiciously cheap per-kg figure is cheap for a reason.

Every one of those errs in the **flattering** direction — it makes a bad deal look good, which
is the exact failure mode this project's docs keep flagging (the panel read off a rival
product, the 32 g serving read as 100 g, the quail eggs at 24% off). A marketplace price
belongs on the **history/reference** side, not competing in "🔻 On sale now".

### The category collision nobody has hit yet

`NON_GROCERY_CATEGORIES` in [notion.ts:105](../src/core/notion.ts:105) is `{"Suppliments",
"Filler"}` — those rows are dropped by `readGroceryTargets()` before anything is searched.

**30 of the 94 rows are `Suppliments`.** And iHerb and MyProtein — the two GREEN vendors —
are supplement shops. So the two vendors most worth building are, today, pointed at a
category the scan deliberately refuses to look at. `Vitamin D` (Iherb) is in that 30 and is
**never searched at all**.

The three whey rows escape only because they are filed under `[1] Meats/Dairy/Proteins`.

This is the same deny-list trap as open item #20 (`Household Supplies`), from the other end.

## The `Google Search` tag — cost and feasibility

Grounded in this project's **own** measurements, not estimates from elsewhere:

- `web_search` + `web_fetch` (the macro-lookup shape) = **$0.29–0.41 per call**, over 8 real calls.
- Input tokens are ~90% of that, because `web_fetch` drops 340–390 KB pages into context.
- **The searches themselves were 2 cents of a 41-cent call.**
- No tools at all (the commodity path) = **~$0.003**.

So the lever is obvious: **turn `web_fetch` off.** A price + pack size is short, structured
and usually sits in the search snippet; it does not need the whole page.

| design | per item | 3 whey rows, daily | 3 whey rows, **weekly** | all 48 targets daily |
| --- | --: | --: | --: | --: |
| search + fetch (macro shape) | ~$0.35 | ~$31/mo | ~$4.50/mo | **~$500/mo** |
| **search-only** | ~$0.03 † | ~$2.70/mo | **~$0.39/mo** | ~$43/mo |
| on-demand button | ~$0.03/tap † | — | — | — |

† **Estimated, not measured.** Extrapolated from the two ends this project *has* measured
($0.003 no-tools, $0.29–0.41 with fetch). The project's own note applies: identical configs
rerun a day apart varied **±30%**, so anything under ~30% here is noise. **Measure it twice
with `macro-test` before believing this row.**

**Feasible? Yes — in one shape.** Whey does not reprice daily, and 3 rows at weekly cadence
is **under 40 cents a month**. The hard requirement, and the thing that makes it safe:

> **Return nothing unless the answer states a pack size.** A price without a size is not a
> result. The prompt must refuse, the way `parseNutritionPanel` refuses a panel with no
> serving size and `lookupMacros` refuses figures that sum past 105 g.

This also fits the rule already baked into every other surface — *nothing spends money
unasked*. A general search is the most speculative spend in the system, so it should be the
**least** automatic.

## Recommended phasing

**Phase 0 — fix the tags (you, in Notion; no code).** The tags cannot drive anything until
they mean something. Specifically: is `Sheng Siong` meant to be tagged on the rows it
serves, or do the tags only ever mean "*also* look here"? Everything below assumes the
latter, because that is what the data says today.

**Phase 1 — `Google Search` for whey, search-only, weekly, no `web_fetch`.**
Smallest thing that solves the actual open problem (#9). 3 rows, ~$0.39/mo, no new scraper,
no anti-bot work. Gate it on a stated pack size or drop the result.

**Output = the price book, not a deal card.** It fills `Price [Vendor 3]` / `Size[Vendor 3]`
on the two rows tagged `Google Search`, under the three rules above. The two whey baselines
give it something real to beat: `Whey [Titan]` $50 / 2000 g = **$2.50/100 g**, `whey [Atlas]`
$55 / 2100 g = **$2.62/100 g**. Anything the search finds below that is a genuine result;
anything above it is just a filled-in cell, which is still worth having.

If a cheaper price is found, surface it in its **own page section** — not "🔻 On sale now",
because a general-web price has not passed the checks a store module's has.

**Phase 2 — iHerb as a real `StoreModule`.** Free, deterministic, forever. Server-rendered
prices and sizes-in-titles make it the cheapest module to write since FairPrice. **Blocked
on the `Suppliments` decision** — without that, it has 1 row to serve.

**Phase 3 — MyProtein.** Same pattern, one branded row (`whey, essential [MyProtein]`), and
it settles that row exactly.

**Phase 4 — Guardian and Watsons, together.** Both serve `Household Supplies` (7 rows), and the
routing table sends that category to exactly these two. Revised upward from the first draft:
Guardian has **no anti-bot**, only rendering, so it needs the headless-browser rung or its
GraphQL call — no WAF fight. Watsons **is** a WAF fight, but against Akamai using the pattern
[`incapsula.ts`](../src/core/stores/incapsula.ts) already implements for Sheng Siong.

**Phase 5 — Carousell, then Shopee.** Requested explicitly, and reconnaissance says both work —
see "Shopee and Carousell — how to make them work" above. Carousell needs no login (browser for
search, free fetch for the listing's JSON-LD); Shopee needs the CDP Chrome signed in once by
hand. The build cost is not the scraping, it is the **plausibility gate** — 62% of listings
state a size, and the cheapest listing is usually a scam, so both need handling before a single
card is shown.

**Already free and available today:** the **Chrome extension** works on all of these — it
has no host list, and its generic JSON-LD/DOM reader handles any shop. Browse iHerb or
Watsons, press it, and the price and size land in Ingredients for **$0**. For a 5-row
problem that is not a joke answer; it may be the whole answer.

## Is the open search (`Vendor 3`) worth doing? — the honest case

Still being decided. Both sides, as straight as I can put them.

**For:**
- It is aimed at the one item both supermarkets genuinely fail on. `Whey` returning nothing is
  HANDOVER #9, still open, and it is not a scraping bug — the shops don't stock it findably.
- The stake is real: **$50–55 per 2 kg**, bought regularly. A 10% find is $5 a purchase, which
  dwarfs the ~$0.39/month the search costs at weekly cadence.
- It is the only route for an item **no scrapable shop stocks**. Every other phase needs a
  shop with a readable website; this one doesn't.
- Cost is bounded and small, and the bound is enforceable (weekly, 2–3 rows, no `web_fetch`).

**Against:**
- **It is the only part of this system that cannot be verified deterministically.** Every other
  number comes from a parsed payload; this one comes from a model reading a search snippet.
- Supplements are the **worst** category for it: sold in lb, kg, servings and scoops, so pack
  size is frequently ambiguous — and pack size is the whole basis of comparison.
- Whey specifically attracts grey imports and repackers. A cheap per-kg figure is sometimes
  cheap for a reason, and that error is invisible on a deal card.
- It adds a surface where a *plausible wrong number* can enter the DB — the failure mode this
  project has repeatedly had to design against (the rival's nutrition panel, the 32 g serving
  read as 100 g, the quail eggs at 24% off).

### ⚠️ The design correction — don't ask a model for a price

The sibling project's ladder makes the earlier "$0.03 model call returns a price" framing look
wrong, and it is. **Search is used to find the URL; the price is then read off the page
deterministically.** That is why their web-search tier is a *discovery* step, not an answering
step.

Applied here:

```
open search  →  candidate product URLs  →  fetch + parse the page  →  price + pack size
   (DDG / Serper)          (a real URL, storable)         (deterministic, verifiable)
```

Against asking a model for the number, this is better on every axis that matters:

- **The number is verifiable** — it came off a page you can open, not a snippet a model read.
- **The pack size problem largely dissolves.** A product page states its size; a search snippet
  often doesn't. That was the single biggest objection above.
- **It produces a URL**, which the deal card needs anyway for its Buy button.
- **It is nearly free** — DDG-direct costs nothing, Serper gives 2,500 free queries, and the
  fetch is a plain GET. No per-item model spend at all.
- It reuses the parsing this repo already has (JSON-LD, `og:price`, `itemprop`) via the same
  generic readers the Chrome extension uses.

A model is still useful at the **end**, cheaply, to judge *"is this candidate actually the same
product?"* — but that is a text-only classification on a handful of titles, not a $0.29 tool call.

**Verdict: worth doing, and cheaper and more trustworthy than first scoped** — but prove the
discovery step before building on it, because that is exactly the step SearXNG failed at.

**Suggested next step, near-free:** a `price-search` one-shot modelled on `macro-test` — takes a
term, runs DDG-direct (then Serper if that rate-limits), prints the candidate URLs, fetches each
and prints title / price / stated pack size / derived $ per 100 g, and writes nothing anywhere.
Run it on the three whey rows. If the URLs come back and the pages parse, phase 1 is mostly
plumbing. If discovery gets rate-limited at three queries, you have learned that for free — and
`SEARXNG-REPORT.md` says that is the likely failure.

⚠️ Under the trust rule, an open-search result is **REVIEW, never auto-written**. It is a lead
with a URL attached, not a price.

## Decisions needed before any of this is built

1. ~~`Suppliments` / `Household Supplies` — exclude?~~ **Answered by routing.** Neither is
   excluded; both are asked at the right kind of shop instead. Confirm the two default routes
   in the table above are the ones you'd want.
2. **`Sheng Siong` tagged nowhere** — under category routing this no longer breaks anything
   (grocery categories route there by default). Still worth knowing if it was deliberate.
3. **Is the category→vendor table right?** It is my proposal, not your data. The two that
   matter: `Suppliments` → iHerb + MyProtein, `Household Supplies` → Watsons + Guardian. Both
   of those shops are 🔴/🟠 on scrapability, so agreeing the route is not the same as being
   able to serve it — see phasing.
4. **Where do open-search results appear?** Own section (recommended), or mixed into the deals list?
5. **Cadence** — weekly (recommended, ~$0.39/mo) or on-demand button only ($0/mo)?
6. **The `Vendor 1 URL` misfile** — fix now (small, self-contained) or fold into phase 1?
7. ~~`Vendor 3 URL` doesn't exist~~ **Answered: deliberate.** `Vendor 3` is the open slot; an
   undirected search has no fixed shop to link. No schema change wanted.
8. **64 rows have a base price but no `Vendor, Current `.** Worth backfilling by hand? Without
   it, "cheaper than what you pay" can't say *cheaper than where*.

⚠️ **A routing caveat worth seeing before you agree to the table.** Routing `Suppliments` and
`Household Supplies` away from the supermarkets is right, but it points 37 rows at shops that
are **hard or impossible to scrape**: Watsons is 🔴 403-walled, Guardian 🟠 SPA, iHerb 🟢 and
MyProtein 🟢. So the route is correct while the *coverage* arrives in stages — iHerb and
MyProtein can serve `Suppliments` fairly soon; `Household Supplies` has no green vendor at all
and, until one exists, is best served by the Chrome extension by hand.

## Re-running the probes

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"; for u in "https://sg.iherb.com/search?kw=whey%20protein" "https://www.myprotein.com.sg/search/?q=whey" "https://www.guardian.com.sg/catalogsearch/result/?q=vitamin" "https://www.watsons.com.sg/" "https://shopee.sg/search?keyword=peanut%20butter" "https://www.carousell.sg/search/peanut%20butter"; do c=$(curl -s -o /tmp/p -w "%{http_code}" -A "$UA" --max-time 25 -L "$u"); printf "%-62s %s %8sB ld:%s\n" "$u" "$c" "$(wc -c </tmp/p)" "$(grep -c 'ld+json' /tmp/p)"; done
```

A vendor flipping from GREEN to RED looks like a 403, or a page that shrinks to a fixed-size
shell. Both are visible in that one line of output.
