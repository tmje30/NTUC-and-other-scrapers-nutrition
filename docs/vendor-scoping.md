# Scoping — searching the shops tagged in `Vendor[n]`

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

| vendor | probe result | verdict |
| --- | --- | --- |
| **iHerb** | search page returns **2.6 MB**, **96** `/pr/` product links, `itemprop="price" content="40.31"`, and titles that carry the pack size verbatim — *"…Whey Protein Isolate, Unflavored, 1 lb (454 g)"* | 🟢 **GREEN — the cleanest target here.** Size is in the title, which is exactly what rule 2 needs. `/` 403s but `/search?kw=` and `/deals` both 200 |
| **MyProtein** | `.list` category paths return **635 KB** server-rendered with `ld+json`; `/search/?q=` works | 🟢 **GREEN.** Second-easiest |
| **Guardian** | **every** path — `/`, `/search?q=`, `/catalogsearch/result/?q=`, a bogus `/vitamin.html` — returns the **identical 136,929-byte** shell. React/Vue markers, zero prices, zero products. A `/graphql` endpoint exists (503 to a junk query) | 🟠 **AMBER.** Pure SPA. Needs its GraphQL call reverse-engineered, or a browser |
| **Watsons** | **403** on every URL, including the homepage, even with full browser headers (UA, Accept, Accept-Language, Sec-Fetch-*). 376-byte block page | 🔴 **RED.** Bot-walled like Sheng Siong. Would need the Incapsula-style headed-Chrome pattern |
| **Shopee** | search page 162 KB, no `ld+json`, no products in the HTML | 🔴 **RED.** SPA behind anti-bot |
| **Carousell** | 2.2 MB, but the `ld+json` holds only nav categories ("Men's Fashion", "Books & Magazines") and there is **1** listing link in the whole page | 🔴 **RED.** SPA — *and see below* |
| **Google Search** | n/a — not a scrape | see its own section |

### Why Carousell and Shopee are worse than "RED"

Even with a working scraper, a marketplace breaks rule 2 in a way no code fixes:

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
no anti-bot work. Results land as a **new page section** — not in "🔻 On sale now", because
a general-web price has not passed the same checks a store module's has. Gate it on a
stated pack size or drop the result.

**Phase 2 — iHerb as a real `StoreModule`.** Free, deterministic, forever. Server-rendered
prices and sizes-in-titles make it the cheapest module to write since FairPrice. **Blocked
on the `Suppliments` decision** — without that, it has 1 row to serve.

**Phase 3 — MyProtein.** Same pattern, one branded row (`whey, essential [MyProtein]`), and
it settles that row exactly.

**Phase 4 — Guardian.** Only if wanted. Reverse-engineer the GraphQL call; a browser-driven
scrape is not worth it for what is currently 0 tagged rows.

**Not recommended: Watsons, Shopee, Carousell.** Watsons is a WAF fight for **1** row that
is `Household Supplies` (a category you may be about to exclude anyway). Shopee and Carousell
fail rule 2 by their nature, not by their markup.

**Already free and available today:** the **Chrome extension** works on all of these — it
has no host list, and its generic JSON-LD/DOM reader handles any shop. Browse iHerb or
Watsons, press it, and the price and size land in Ingredients for **$0**. For a 5-row
problem that is not a joke answer; it may be the whole answer.

## Decisions needed before any of this is built

1. **`Suppliments`** — 30 rows, currently never searched. Bring them into the scan (which is
   what makes iHerb worth building), or leave them out and drop iHerb from the plan?
2. **`Household Supplies`** — open item #20, still unanswered. 7 rows. Exclude, or keep and
   accept per-100g comparisons on face cream?
3. **`Sheng Siong` tagged nowhere** — deliberate, or an oversight in the tags?
4. **Where do general-search results appear?** Own section (recommended), or mixed into the
   deals list?
5. **Cadence for the search** — weekly (recommended, ~$0.39/mo) or on-demand button only ($0/mo)?

## Re-running the probes

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"; for u in "https://sg.iherb.com/search?kw=whey%20protein" "https://www.myprotein.com.sg/search/?q=whey" "https://www.guardian.com.sg/catalogsearch/result/?q=vitamin" "https://www.watsons.com.sg/" "https://shopee.sg/search?keyword=peanut%20butter" "https://www.carousell.sg/search/peanut%20butter"; do c=$(curl -s -o /tmp/p -w "%{http_code}" -A "$UA" --max-time 25 -L "$u"); printf "%-62s %s %8sB ld:%s\n" "$u" "$c" "$(wc -c </tmp/p)" "$(grep -c 'ld+json' /tmp/p)"; done
```

A vendor flipping from GREEN to RED looks like a 403, or a page that shrinks to a fixed-size
shell. Both are visible in that one line of output.
