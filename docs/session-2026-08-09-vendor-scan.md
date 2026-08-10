# Session handover — the price book fills itself, 2026-08-09/10

The first writer in this project that goes and looks by itself. Everything else — the
deals page's Add/Replace, the Chrome extension, the history page — is a button pressed by
someone already looking at one matched product. This one searches the shops each
Ingredients row names in `Vendor 1..4` and records what they charge.

## Status: working, live, 7 of 9 slots filled

`npm run vendor-scan` — **report-only by default**, `--write` records. Guardian, MyProtein
and Carousell are built and proven against the live database. The two unfilled slots are
correct refusals, not failures, and are explained below.

**Read these three sections first, whatever else you skip:**

1. *"Four things the docs get wrong about these sites"* — the older `vendor-scoping.md`
   is confidently wrong about Guardian and Carousell, in ways that cost hours.
2. *"The bug that would have been invisible"* — Carousell's slug eats decimal points, so
   2.5 kg reads as 5 kg and halves the apparent price per kg.
3. *"The false diagnosis this nearly shipped with"* — the one worth carrying to other
   work: a parser that maps "absent" and "negative" to the same value makes every
   conclusion about *reliability* unfounded.

Kept because most of this is *why*, which a diff cannot tell you.

---

## What was asked for

> "can the sites in `Vendor [n]` be scrapped and the `price [Vendor n]`, `size [Vendor n]`,
> `url [Vendor n]` and `item Name [Vendor n]` related to `Vendor[n]` be filled out in the
> ingredient DB"

Scoped by the user to **Guardian, MyProtein and Carousell**.

`item Name [Vendor 1..4]` was added to the schema by the user during the session — live
names are `item Name [Vendor 1]`, `item Name [Vendor 2] ` (trailing space), `3`, `4`,
lowercase `item`, type `rich_text`.

---

## Run the census before you plan anything here

`docs/vendor-scoping.md`'s tag census was 5 days old and the DB had been re-tagged
heavily. Measured 2026-08-09 over 95 rows:

| vendor | rows tagged | notes |
| --- | --: | --- |
| NTUC | 60 | 57 priced |
| **Sheng Siong** | **58** | the old doc says **zero**; 0 priced |
| Watsons / Guardian / Iherb | 5 each | |
| Carousell / Google Search | 3 each | |
| My Protein | 1 | |

**Guardian went 0 → 5 tagged rows** (CeraVe lotion + 4 toothpastes), which reversed the
build order: the old doc treats it as a marginal 🟠 needing a browser tier, and it is in
fact the largest of the three *and* the cheapest to read.

### ⚠️ `readGroceryTargets()` is the wrong reader for this feature

It returns **26** targets and **only 1 of the 9 in-scope rows survives it**.
`notion.ts:453` drops any row with no priced vendor slot ("no comparable baseline") and
`:444` drops `Suppliments`/`Filler`. That is circular here — the row has no price, so the
deals scan skips it, so it never gets a price — and breaking that cycle is the whole
point. `vendor-scan.ts` therefore reads the database itself and keeps rows with no price,
honouring only the two suppression tags (`Not in Use ATM`, `Don't Search`).

---

## ⚠️ Four things the docs get wrong about these sites

Each cost real time, and each is invisible — none produces an error.

1. **Guardian needs no browser at all.** `vendor-scoping.md` calls it a pure SPA needing
   the browser tier. In fact `/catalogsearch/result/?q=` now **302s to the homepage**,
   which is why a browser-rendered probe saw an empty shell and concluded "SPA with no
   products" — *the page was never the search page*. The storefront is Magento PWA Studio
   and its **`/graphql` answers an anonymous `fetch`**: name, sku, url_key, stock_status,
   regular/final price and discount, with the pack size in the name. Cheapest adapter in
   the project after FairPrice. `vendor-probe.ts` still probes the dead URL.
2. **Carousell's `itemCondition` is unusable.** The doc calls it "machine-readable, so
   'new only' is a deterministic filter, not a title guess". Over the ten cheapest whey
   listings, **all ten reported `UsedCondition`**, including ones whose card badge plainly
   read "New". Gating on it returned **zero results from the whole shop**. The card badge
   is the trustworthy signal.
3. **Carousell's rendered text is missing every lowercase `s`.** "Used" renders as
   "U ed", "MuscleTech" as "Mu cleTech", "Post Workout" as "Po t Workout". Any condition
   filter written the obvious way can never fire, and titles read from the DOM are
   corrupted.
4. **MyProtein has no single price per product.** One product page is a `ProductGroup`
   with **42 variants priced $36.91 → $611**, of which only **20 state a weight**. Pairing
   the search page's one price with a size read off the page would be wrong by up to 16×,
   in the flattering direction.

---

## ⚠️ The bug that would have been invisible: Carousell's slug eats decimal points

The title has to come from the **URL slug**, because of (3) above. But the slug replaces
`.` with `-`, so **`2.5kg` arrives as `2 5kg` and parses as 5 kg** — double the real pack,
half the real price per kg, a bargain that does not exist. Same family as the 32 g serving
read as 100 g.

Two listings in the very first run hit it (`myprotein … 2 5kg` = 2.5 kg,
`titan whey protein 2 1kg` = 2.1 kg).

The fix reads the size from the **rendered text**, which keeps the decimal (its missing
`s` does not matter to a size — "5LBS" renders "5LB" and both parse), and **refuses the
slug entirely** when the ambiguous `\d+ \d+ <unit>` shape appears, because "2 5kg" cannot
be told from a genuine "2 × 5kg". `restoreDecimal()` then puts the point back into the
stored `item Name` only when the dotted reading agrees with the size already parsed —
never inventing a number.

---

## The rules the scan writes under

From `vendor-scoping.md`, unchanged and now enforced in code:

1. Match the vendor by **name** to find the index; never assume a slot.
2. **If no index names that shop, write nothing.** Never claim a free slot.
3. Never write `Vendor, Current ` from a scan.

Rule 2 has a consequence worth stating plainly: **a scan may only ever `update` a slot
that already names the shop.** So it cannot reuse `replaceIngredientPrice()`, which fills
free slots and evicts the dearest — correct for a button, wrong for a robot.
`recordVendorPrice()` in `ingredient-write.ts` is the scan's writer and refuses anything
but `update`.

⚠️ **And it writes nothing outside the four slot columns — in particular not
`Unit type `.** That column is row-level and says what every `Size[Vendor n]` on the row
counts. A scan setting it would let one shop's gram-size silently re-interpret every other
slot. A candidate whose unit kind disagrees with the row is refused instead
(`unitKindAgrees`).

**Report-only by default.** `--write` is a separate act, because this is the one write
path with no human looking at the specific match.

---

## Two gates decide what is worth recording

1. **`evaluate()`, ACCEPT band only.** A search hit is not a match — searching one shop
   for one product returns its whole aisle. This is what stops the aisle being written.
2. **The price rule, which differs by shop kind.** A retailer's own catalogue is
   trustworthy, so the cheapest relevant wins outright. On a **marketplace it does not**:
   `cheapestPlausible` drops anything under ~55% of the median first, because the minimum
   is usually the scam (ON Gold Standard 5 lbs at S$37/S$38 against ~S$120 retail — all
   still listed today).

### ⚠️ Guard 3 — a price already known, which the median cannot see

`cheapestPlausible` compares a listing against the **other listings**, so a search whose
results are mostly counterfeit sets a counterfeit standard of normal and the whole set
passes. Measured: a bare "whey protein" search rejected nothing, while a focused "gold
standard" search put the same 5 lb tub at **$35–$47 against an $85–$99 cluster** — 2.3× on
an identical SKU, every listing badged New.

So a marketplace candidate that falls under `MIN_FRACTION_OF_KNOWN_PRICE` (**50%**) of the
cheapest price **already recorded on that row** does not go straight in. That reference
comes from outside the search and cannot be gamed by it. The slot being written is excluded
from it, or one bad write becomes the justification for the next.

### The reputation rescue (user's design, 2026-08-09)

An under-floor price is treated as a **question, not a verdict**: the listing gets one way
back in, via the seller's own record. Both bars must be cleared — **4.5★ and 50 reviews**
(`REPUTATION_BAR`). Under-floor candidates are offered the check cheapest-first, at most
`MAX_REPUTATION_CHECKS` (3) of them, and only until one passes.

⚠️ **An unknown reputation never rescues.** If "could not read it" counted as a pass, the
least reliable outcome would become the most permissive one, on exactly the listings already
flagged as too cheap. `reputationPasses` fails closed, and `sellerReputation` returns nulls
rather than throwing.

#### ⚠️⚠️ The false diagnosis this nearly shipped with — read this one

An earlier version of this note claimed the seller block was "client-rendered and lazy,
appearing on roughly one attempt in six". **That was wrong, and the error was mine, not the
site's.** A seller with no history renders `N/A — No review yet`, which matched none of the
numeric patterns and fell through to `null` — and `null` meant *"could not check"*. So the
single least trustworthy seller on the site produced the identical result to a network
failure, and an entire flakiness theory got built on top of it, complete with scrolling and
20-second waits that "fixed" nothing.

`parseReputation` now reads a stated zero AS zero, keeps it distinct from unreadable, and
captures account age. Re-run against the same four listings afterwards, **4 of 4 read
correctly on the first attempt**:

| listing | seller | rating | reviews | age | rescue |
| --- | --- | --: | --: | --: | --- |
| $35 | `liveriver_96a30c` | — | **0** | **4 mo** | refused |
| $38 | `silentstorm_4bb81d` | — | **0** | **4 mo** | refused |
| $85 | `sarah.toys.store` | 5★ | 755 | 13 y | passes |
| $88 | `gheord` | 5★ | 173 | 12 y | passes |

**The lesson generalises past this feature**: when a parser's "absent" and a source's
"negative" collapse to the same value, every downstream conclusion about *reliability* is
unfounded. Distinguish them at the point of parsing, not by reasoning about the transport.

⚠️ It also means the earlier `sellerReputation` implementation — an async expression that
scrolled and polled — was solving a problem that did not exist, and it kept returning
`undefined` from `Runtime.evaluate` while doing so. It is now a plain synchronous read of
`innerText` at a 15 s settle, with all parsing in TypeScript.

⚠️ **Reputation is not authenticity, and this is worth re-reading before trusting a
rescue.** Carousell reviews are not product-specific: the 5.0/755 seller inspected while
building this had their visible review on a **Polly Pocket toy**. The rating says a
transaction completes smoothly, not that the goods are genuine — and a high-volume
counterfeit seller accumulates precisely this profile, while a one-off genuine seller
clearing a cupboard may have three reviews.

⚠️ **The rescue has never fired inside a scan.** No under-floor candidate has arisen in any
run to date — every match sat above the floor — so the *wiring* is covered by unit tests
only. The **lookup itself is proven** against four real listings (table above); what is
unproven is the branch in `vendor-scan.ts` that calls it.

### The free signal: an auto-generated handle

⚠️ **The cleanest discriminator of the three, and it costs nothing.** The seller's username
is in the listing's **plain HTML** (`"username": "..."`), so `looksAutoGeneratedHandle`
runs without the browser the reputation check needs — and runs FIRST in the rescue, ruling
a listing out before that render is spent.

On the six Gold Standard sellers, all three signals agree perfectly: every cheap listing is
a 4-month-old account, zero reviews, default `word`+separator+hex handle
(`liveriver_96a30c`, `nobleowl.3c9a58`, `silentstorm_4bb81d` — the last selling two of
them); both plausible ones are 12–13-year accounts with hundreds of reviews and chosen
names (`sarah.toys.store`, `gheord`).

⚠️ The hex tail must carry **at least two digits**. Hex is mostly letters, so a chosen name
can be accidentally hex-legible — "john.beaded" is six valid hex characters — and flagging a
real person's handle as a throwaway is the failure mode to avoid here.

⚠️ It is a **contributing** signal, never a verdict alone: a default handle is ordinary for
a genuine one-off seller too. It only withdraws the benefit of the doubt from a price
already under the floor.

⚠️ It costs a **full browser render per candidate**, against a plain `fetch` for everything
else, which is why only under-floor listings are ever checked.

⚠️ It only helps where the row already has a price. The three whey rows do (Shopee), which
is what made it implementable at all — and is a second reason filling the price book pays
for itself.

⚠️ **It is not sufficient alone**, and the Atlas incident below shows why: the real
defence against a counterfeit *Optimum Nutrition* landing on an *Atlas* row is the matcher
refusing the brand, not the price floor.

### ⚠️ The search term can throw a word away — and widening it nearly wrote a fake

`parseName("whey, essential  [MyProtein]")` returns `searchTerm: "whey"`. The clause after
the comma survives in **neither `mustMatch` nor `properties` nor `ignored`** — it is simply
gone. So MyProtein was asked for "myprotein whey", ranked *Impact Diet Whey* first, and
never returned **Essential Whey Protein** at all, which is a product they sell. Searching
"whey essential" returns it as the top three hits.

The row's own words are therefore tried as an extra term, with two constraints that both
came from live failures:

1. **The bracketed brand is REMOVED from that term** (the opposite of term 1, which adds
   it). A shop's own site search chokes on its own name: "whey essential MyProtein"
   returns nothing from MyProtein; "whey essential" returns the product.
2. ⚠️⚠️ **It is used only when it adds a word `searchTerm` lacks.** `whey [Atlas]` strips
   to the bare **"whey"**, which matched *"optimum nutrition gold standard 100 whey protein
   5 lbs" at $35* — a listing this project believes is counterfeit — and would have filed
   it as the Atlas price. Caught in a dry run, before any write. A term that drops the only
   distinguishing word does not widen the search, it erases the question.

⚠️ **The search term includes the `[brand]`, unlike the daily scan**, and deliberately:
one named shop, one named product, and Guardian sells fifty toothpastes. Widening the
*query* cannot widen what is accepted, since `evaluate` is still the gate. There is also a
bounded fallback — retry without the trailing `- variant` clause — after Guardian returned
**nothing** for "Sensitivity Gum Toothpaste - Original" and 23 products, including the
exact item, without "- Original".

---

## A matching bug this surfaced, fixed in shared code

`GENERIC_FORM_PATTERNS` in `match.ts` gained **`gainers?`**. The scan's accepted match for
`whey, essential [MyProtein]` was *"Myprotein Impact Whey **Gainer** 2.5kg"* at $2.00/100 g
— cheaper per 100 g than real whey precisely because most of it is maltodextrin. Wrong
product, wrong macros, wins on price. Same shape as the butter-loaf and egg-tofu entries
already there, and the guard is skipped when the item itself names the word, so a genuine
gainer row still matches. This protects the daily FairPrice/Sheng Siong scan too.

---

## What was written, live

`npm run vendor-scan -- --write`. **7 of 9 tagged slots filled, 0 failures**, every one read
back from Notion afterwards:

| row | shop | price / size | $/100g |
| --- | --- | --- | --: |
| AM facial moisturizing lotion (SPF30) [cerave] | Guardian | $23.90 / 52 ml | 45.96 |
| Toothpaste - Multi Care [Sensodyne] | Guardian | $7.55 / 100 g | 7.55 |
| Clinical White - Enamel Strengthening | Guardian | $13.00 / 100 g | 13.00 |
| Toothpaste - Repair & Protect [Sensodyne] | Guardian | $8.65 / 100 g | 8.65 |
| Whey [Titan] | Carousell | $60.00 / 2100 g | 2.86 |
| whey, essential [MyProtein] | Carousell | $85.00 / 2500 g | 3.40 |
| whey, essential [MyProtein] | My Protein | $190.02 / 2500 g | 7.60 |

Each write sets four columns for that slot: `Price`, `Size`, `URL` and `item Name`.

**The user renamed one row through this tool**: `AM facial moisturizing lotion [cerave]` →
`… (SPF30) [cerave]`, to pin SPF30 as a defining property. ⚠️ It must be written
**`(SPF30)`, no space** — `(SPF 30)` matches neither SPF30 nor SPF50, since the property
folds to the token "spf 30" which no title contains.

### The two that correctly wrote nothing

- **`Sensitivity & Gum Toothpaste - Original`** — Guardian *does* stock it at $8.65
  ("Sensodyne Sensitivity & Gum, 100g"), but no listing says **"Original"**, so `evaluate`
  holds every candidate at REVIEW. This is the trust rule working; forcing it would be a
  guess. **Still a user decision**: accept the listing by hand, or drop "- Original" from
  the row name if it is not actually a requirement.
- **`whey [Atlas]`** — Carousell has no Atlas whey. Honest miss, and the row is left alone.

---

### ⚠️ Two Notion-side naming traps, both hit in this session

Both cost a wrong answer before they were understood, and both are edits to the row's
`Name`, not code:

1. **A defining property must be written `(SPF30)` — no space.** The CeraVe row was renamed
   to `AM facial moisturizing lotion (SPF30) [cerave]` to pin SPF30, and it works: SPF30
   accepts, SPF50 drops to review. ⚠️ **`(SPF 30)` matches NEITHER**, because the property
   folds to the token "spf 30" and no shop title contains that.
2. **A clause after a comma is silently discarded.** `parseName("whey, essential
   [MyProtein]")` yields `searchTerm: "whey"` — "essential" survives in neither `mustMatch`
   nor `properties` nor `ignored`. That is why MyProtein was asked for "myprotein whey" and
   returned *Impact Diet Whey*. Handled in code now (the row's own words are a fallback
   search term), but a row wanting a hard requirement should say `Whey (Essential)
   [MyProtein]` rather than relying on the comma.

## Still outstanding

**Unproven, in the order it would bite:**

1. ⚠️ **The reputation rescue has never fired inside a scan.** No under-floor candidate has
   arisen in any run — every match sat above the floor — so the *branch in
   `vendor-scan.ts` that calls it* is covered by unit tests only. The **lookup itself is
   proven** (4/4 live, table above); it is the wiring that is untested.
2. **Nothing is scheduled.** `vendor-scan` is manual, and deliberately so far: these prices
   move far more slowly than supermarket promotions, and every Carousell run opens a real
   Chrome window on the user's desktop.
3. **Carousell cannot run in the cloud.** It needs a **headed** browser — headless renders
   zero cards and is detected. Guardian and MyProtein are plain `fetch` and could run
   anywhere, so a cloud schedule would have to be split by vendor.

**Known-stale, will mislead the next person:**

4. **`vendor-probe.ts` is out of date for two of the three shops.** It still probes
   Guardian's dead `/catalogsearch/` URL and still describes Carousell's `itemCondition` as
   a reliable filter. It is a diagnostic, not part of the scan, but it reads authoritative.
5. **`docs/vendor-scoping.md`** keeps its routing advice; its per-vendor verdicts and its
   census are superseded by this file (it now carries a banner saying so).

**Not attempted:**

6. **The other tagged shops**: Watsons (5 rows), Iherb (5), Shopee (3), Google Search (3),
   and **Sheng Siong — 58 rows tagged, 0 priced**. The last is the biggest single gap in
   the price book and is *not* a scraping problem: the daily scan already reads Sheng Siong,
   it simply never writes what it finds into the slots.
7. **`Catagory`-based routing** (`Suppliments`→iHerb/MyProtein, `Household Supplies`→
   Watsons/Guardian) from `vendor-scoping.md` is NOT implemented. This build is
   **tag-directed only** — a shop is asked only for a row that names it. That table was
   explicitly the doc author's proposal rather than the user's data, and adopting it would
   multiply both the row count and the traffic.

## Files

| file | why |
| --- | --- |
| `src/core/vendor-scan.ts` | the reader, the routing, the gates, the reputation bar |
| `src/scripts/vendor-scan.ts` | the CLI, the report, the rescue, the `--write` path |
| `src/core/stores/guardian.ts` | GraphQL; read the header before touching the URL |
| `src/core/stores/myprotein.ts` | why a variant without a weight is dropped |
| `src/core/stores/carousell.ts` | the missing `s`, the slug decimal, the badge, the handle |
| `src/core/ingredient-write.ts` → `recordVendorPrice` | update-only, slot-columns-only |
| `src/tests/carousell.test.ts`, `src/tests/vendor-scan.test.ts` | ~60 cases over exactly the silent failures above |

## Commands

```bash
npm run vendor-scan                          # report only — writes NOTHING
npm run vendor-scan -- --only guardian       # one shop
npm run vendor-scan -- --write               # record the prices
npm test                                     # 496 offline cases, free, no network
```
