# Grocery Deal Scraper — System Guide

*Last updated: 2026-08-18 · Covers changes through commit 9ee1841*

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

Since 2026-08-10 there is a third way in, and it's the one used most: **text your
shopping list to a Telegram bot** (`@Grocery69_bot`) and it files the lines onto
your Notion grocery list, asking about anything it isn't sure of. Since 2026-08-12
that runs entirely in the cloud and answers in **under a minute**, awake or not.

The system also **fills in your price book** — what each shop charges for each
ingredient, in Notion's `Vendor 1..4` columns — across up to nine shops rather
than the two it watches daily. It asks before recording anything odd (a 10 kg sack
of carrots is genuinely the cheapest per kilo and is not a pack anyone buys).

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
- **"I don't want to be asked about this again for a while."** Tap **Ignore** under
  Buy and pick **1, 2, 3 or 4 weeks** — the tap that picks the duration is the tap
  that fires. Every option returns the item at the *start* of a week (Mondays, not
  7-day blocks), and it's undone from the list at the foot of the page. The card
  also leaves the page immediately, rather than sitting there until tomorrow's
  rebuild.
- **"How do I get rid of a bad match?"** The `⋯` menu holds three corrections:
  **Ignore for good** (retires that *product* for every ingredient, permanently),
  **Mismatch item** (ban words for that ingredient) and **Almost, but no** (block
  this one product for this one ingredient). All of them teach the matcher rather
  than just hiding today's card.
- **"Where did that price go?"** A second page — **History** — links from the
  footer. It lists what you bought and when, ingredients you've parked, and
  products you've banned outright. It exists because the deals page has to forget
  things to stay readable.
- **"How do I add things to my shopping list without opening Notion?"** Text them
  to the bot, one per line or comma-separated: `2kg chicken breast, bananas x6,
  2 x 500g peanut butter`. Each line is matched against your Ingredients list and
  filed onto the Notion grocery List. You get a reply in **20–60 seconds**.
- **"What happens when it isn't sure what I meant?"** It asks, in the chat, with
  buttons: the ingredient rows that came close, **🆕 New item — create in
  Ingredients**, and **✖️ Cancel — typo**. A parked (`Not in Use ATM`) row is
  offered with a 💤 and picking it wakes the row up — texting something outranks a
  snooze. Nothing is written until you tap.
- **"What if I never answer?"** After **an hour** the line is filed onto the
  grocery list anyway, exactly as you typed it — name only, no price, no
  ingredient link — and the chat tells you what was filed. An unlinked row you can
  shop from beats a question you never answered.
- **"It says it's pricing something — what's that?"** A line matching no
  ingredient at all has no known price, so it is queued and priced across the shops
  within 15 minutes, then published on a **New items** page. The chat says
  `🔎 Pricing 1 new item: …` so the wait is never silent. Since 2026-08-17 this runs
  in the cloud — **no computer of yours needs to be awake.**
- **"How do I just ask what something costs, without adding it?"** Text
  **`/search chicken breast`** (or `/find`, `/price`, `/s`). You get one message
  back: the matching ingredient rows with price, size, price per kg, and which
  vendor is cheapest. ⚠️ **The slash is what makes it a question.** Anything you
  text *without* one is treated as a shopping list — it gets written to your Notion
  List, and anything unrecognised gets priced at the shops. So asking "what does
  chicken cost?" as plain text would add chicken to your list. `/search` reads only;
  it never writes, never scans a shop and never spends money.
  A query that matches nothing well still answers, but labels those rows as merely
  *similar* rather than presenting a weak match in the same voice as a strong one.
- **"Where do the prices for other shops come from?"** `npm run vendor-scan`
  searches the shops each ingredient row actually names and fills its
  `Price [Vendor n]` / `Size[Vendor n]` / `URL [Vendor n]` slots. Anything it isn't
  confident about — a bulk pack, a size range, a wild outlier — is sent to Telegram
  as a review card with **Ok** / **Don't use** instead of being written.
  ⚠️ **"Don't use" is not "ignore forever"**: it declines to *record that pack as
  your price at that shop* and the product still appears on the deals page.
- **"The page says a shop is missing — can I fix it now?"** Tap **Rescan** in the
  warning banner. It fetches fresh Sheng Siong prices from the cloud and rebuilds
  the page *with the data in it*, in about **four minutes**. **No laptop is
  needed** — this changed on 2026-08-13; it used to depend on a machine at home
  being awake, and it no longer does. If the scan fails, Telegram says so rather
  than leaving you waiting for a page that will never change.
- **"Some item needs a size in its name — what does that mean?"** At the foot of
  the deals page, a **"📏 Needs a size in the name"** section lists ingredients
  where the shop only sells the item by weight, but your Notion row records it by
  the piece — so the two prices can't be compared. Adding the pack size to the
  ingredient's name (e.g. `Eggs ( 600g )`) is the fix, and it's a judgement only
  you can make, so there's no button. The Telegram message mentions these too.
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

The tricky part is that **Sheng Siong only answers Singapore.** FairPrice can be
scraped from anywhere, but Sheng Siong's bot-protection challenges connections from
**outside Singapore** — and the free GitHub runner is US-hosted. So the daily work
is split across two clouds:

⚠️ **It is geography, not "residential vs data-centre" — corrected 2026-08-11, and
acted on 2026-08-13.** This was originally designed on the belief that Sheng Siong
needed a *home* internet line. That was wrong: it blocks by **country**. A
Singapore **data-centre** address scans it perfectly well, which is what made the
laptop replaceable. **This is no longer an inference — Cloudflare has been doing
the daily scan since 2026-08-13.**

1. **Cloudflare** (`ss-worker/`, free tier) scans Sheng Siong from **inside
   Singapore**, commits the results to `data/shengsiong-latest.json` in this
   repository, and asks GitHub to rebuild the page. It runs itself every morning
   and also serves the page's Rescan button.

2. **GitHub Actions** (`daily.yml`, once a day) does everything else: it reads your
   Notion ingredient list, scrapes FairPrice live, reads the Sheng Siong file
   Cloudflare left behind, combines the two into the best cross-store deals,
   publishes the web page, and sends the Telegram message.

Data flow, end to end:

```
Notion Ingredients DB ─┐
                       ├─► GitHub Actions: scan FairPrice (live)
Cloudflare ss-worker ──┘                 + read Sheng Siong file
  09:00 SGT, from Singapore                     │
  scan Sheng Siong                              │
  → commit data file ───────────────►  compare per 100 g → best deals
  → dispatch rebuild                            │
                                                ├─► GitHub Pages web page
                                                └─► Telegram summary message
```

⚠️ **Why the clock is Cloudflare's and not GitHub's.** Free public repos queue
`schedule:` workflows by **3–3¾ hours**, so a 09:00 scan asked for on GitHub lands
around noon — useless for planning a shopping day. Cloudflare's cron fires on time.
`daily.yml` still has its own `cron: "0 0 * * *"`, but that is a **floor on when
the shops are scraped**, deliberately, not a delivery time.

⚠️ **The morning scan is a retry window, not a single attempt.** `ss-worker` fires
every 15 minutes from **09:00 to 11:00 SGT** (`*/15 1-2 * * *` plus `0 3 * * *` in
UTC). The first attempt that succeeds commits the file; every later attempt reads
that file, sees today's date, and stops without opening a connection. "Stop once it
works" is that freshness check — a Worker keeps no memory between runs, so the
committed file is the only durable answer to "did the morning scan happen yet?".

If the Sheng Siong file is missing or not from today, the cloud simply skips Sheng
Siong and publishes a **FairPrice-only** page — it never fails and never tries a
blocked connection. A ⚠️ banner on the page (and a line in the Telegram message)
says a shop was missing, so a degraded run is never silent; the banner carries a
**Rescan** button.

⚠️ **Rescan fetches real prices; it does not just redraw the page.** It originally
fired `rescan`, which rebuilt from the same unchanged file — a promise of a rescan
that delivered a redraw, with the warning still there three minutes later. It then
spent two days writing a marker file for the laptop to find. **Since 2026-08-13 it
calls Cloudflare directly**: `scan-request.yml` makes one authenticated HTTP call to
`ss-worker`, which scans, commits and dispatches the rebuild itself. One rebuild
with the data in it, one Telegram message, **about four minutes**. The button says
`✓ requested · ~4 min`.

⚠️ **The marker file is gone.** Nothing writes `data/scan-request.json` any more,
and the laptop's 5-minute poller that watched for it is switched off. If the Worker
cannot reach Sheng Siong, the run **fails loudly in Telegram** rather than quietly
leaving a marker for a job that may be disabled — a fallback that depends on a
switched-off task is worse than no fallback, because it looks like one.

✅ **Nothing scheduled runs on the laptop any more (since 2026-08-17).** All four
Windows Task Scheduler jobs are disabled. New-item pricing — the last one — moved to
GitHub Actions, and no part of the system now launches a browser.

The only thing still run **by hand** on that machine is the price book
(`npm run vendor-scan`), which nothing schedules and never did.

⚠️ **Cloud-priced new items compare FOUR shops, not five — Carousell is missing.**
That is a real gap and not a rounding error: Carousell is the only marketplace, so
its absence removes the second-hand price point. Run `npm run tg-drain` by hand on
the laptop and all five are used.

⚠️ **Why Carousell cannot follow, and the general rule it teaches.** Carousell
refuses a US address, so a GitHub runner is blocked. A Cloudflare Worker in
Singapore *does* reach it — but only when the Worker is called from Singapore.
Measured by asking Carousell's own edge what it sees, through the same Worker, from
both places:

| as Carousell sees it | called from SG | called from a US runner |
|---|---|---|
| IP | a Cloudflare address | **the same** |
| datacenter | Singapore | **the same** |
| **country** | **SG** → answers | **US** → challenge page |

**Cloudflare passes the original caller's country through to the site being
fetched**, and Carousell is itself a Cloudflare customer, so its bot rules are
applied to *your* country rather than the Worker's. **A Worker hop cannot disguise
where a request came from, if the destination is also behind Cloudflare.** Sheng
Siong can be reached this way only because it sits behind a different provider
(Imperva), which receives no such information.

The laptop also keeps a **`ShengSiong Daily Scan` scheduled task, switched off**, as
a one-click emergency scanner if Cloudflare ever cannot reach the shop.

**The inbound leg — Telegram.** Texting the bot is the third way in, and unlike the
other two it is something *arriving* rather than a page being built. Telegram cannot
call GitHub directly: `setWebhook` POSTs Telegram's own JSON to a fixed URL, while
`repository_dispatch` needs an `Authorization` header and an `{event_type}` body, and
Telegram sends neither. So a ~100-line **Cloudflare Worker** (`relay/`) sits between
them — it receives the webhook, checks a shared secret, and fires
`repository_dispatch` at `tg-inbox.yml`.

```
you ──text──▶ Telegram ──webhook──▶ Cloudflare Worker ──dispatch──▶ Actions
                                    (free, always on,               (parse · match ·
                                     ~50 ms, holds no state)         write · ask)
                                            │                            │
                                     every 15 min: tgsweep          a NEW item
                                     (the one-hour rule)            needs a price
                                            │                            │
                                            └──────────▶ price-new-items.yml
                                               same run,  (4 shops, ≤15 min,
                                               sweep first  all in the cloud)
```

⚠️ **The order in that last step is load-bearing.** The sweep files questions nobody
answered, and pricing refuses to touch the queue while any question is still open —
so sweeping *then* pricing in one run means a queued item waits one 15-minute tick
rather than two.

⚠️ **The Worker is also the clock, not just the doorbell.** Its
`crons = ["*/15 * * * *"]` trigger fires a `tgsweep` dispatch that files any question
older than an hour. GitHub's own `schedule:` could not do this — free public repos
queue cron by ~3–3¾ h, so "after an hour" would land past four. **Delete the cron
trigger and the one-hour rule silently stops happening**; nothing else is watching.

⚠️ **A bot has a webhook OR serves `getUpdates`, never both.** The relay therefore
*replaced* the laptop's forever-poller rather than joining it — with a webhook
registered, a poller gets `409 Conflict` on every call and the chat just looks dead.
Switch-over order, the four secrets, and the way back are in
[`relay/README.md`](relay/README.md).

⚠️ **State lives in the repo now** (`data/tg-inbox-state.json`), because a webhook
has no process to hold it in — every update is a fresh checkout. Two taps seconds
apart are two runs writing that file, resolved by the three-way merge in
`src/core/merge-data.ts`.

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
  `Category` (⚠️ **and** the old `Catagory` — the typo was fixed in Notion on
  2026-08-11 and this repo didn't follow, so every read returned undefined and every
  category became `""`: `Suppliments` stopped being excluded and the scan started
  asking NTUC for Lion's mane. `CATEGORY_ALIASES` + `categoryOf()` accept both, and
  `Vendor ` → `Vendor %` and `Checkbox` → `Tickbox` have drifted the same way),
  `Unit type `, `Vendor 1..4`, `Price [Vendor n]`, `Size[Vendor n]`,
  `URL [Vendor n]`, `Used '1'/'2'/'3' Plan`. Note `Price [Vendor 2] ` has a
  trailing space and `Price [Vendor 1]` does not, and `Size[Vendor n]` has no
  space after "Size" — which is why the vendor columns are resolved from the live
  schema rather than listed in code.
- **The baseline is the cheapest vendor slot**, since 2026-08-09. It used to be
  `Price,SGD` + `Weight /Units of New Product `; those columns were retired in
  Notion and the scan, still reading them, silently found **zero** targets. It now
  takes the lowest `Price [Vendor n] / Size[Vendor n] * 1000` — the same rule as
  Notion's own `Price,SGD [Cheapest]` and `Cheapest Vendor ` formulas, computed
  locally because the scan needs the price, the size **and** the vendor from the
  same slot, and separate formulas can only agree by luck. Verified identical to
  `Price,SGD [Cheapest]` + `Size of Cheapest Vendor` on **95 of 95 live rows**
  (2026-08-09) — re-run that check if either formula is edited.
  ⚠️ `Price per 100g ` is **not** read. It briefly returned 0 on every row (built
  on the retired columns) and the user repaired it the same day with a new
  `Size of Cheapest Vendor` formula — but it still counts per 100 **units** on a
  By-Unit row, which is the original reason it was never a safe weight baseline.
  The per-100g figure is computed here instead, from the weight in the row's name
  for By-Unit items.
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

#### Counted packs — eggs, slices, rolls, tea bags

An item priced by the piece (`Unit type ` = **By Unit**) is compared **per piece**,
not per 100 g. `Size[Vendor n]` holds the count: a 30-egg tray is `30`, not a weight.
Add and Replace write that automatically from the shop's own count — but ⚠️ **only
when the shop published no weight.** A pack stating both (`10 x 100ml`) is a weight;
taking its count first would file a litre of milk as ten units and price it per bottle.

⚠️ **Counting does not normalise size, and that is the trap.** A quail egg, a hen's
egg and a jumbo egg are all "1", so a per-piece price always flatters the smallest
thing. The defence is **the pack weight written into the row's own `Name`**:

```
Egg tray (350g)      ← the older convention, used by four live rows
Egg tray, 350g       ← also accepted since 2026-08-09
```

⚠️ **The weight never narrows the search.** It is not a demand for a 300 g pack —
a `(300g)` egg row matches a 10-pack and a 30-pack alike, and what decides between
them is price per kg (or per piece). This is worth stating because everything *else*
inside `( )` is a hard requirement: `Onion (White)` really does demand the word
"white" in a candidate's title. A size-only parenthetical is deliberately kept out of
those requirements — no shop writes your pack size in its product name, so treating
it as one would match nothing and the row would simply go quiet.

Both forms work; parentheses win if a name carries both. With that weight present,
`compare.ts` computes grams-per-piece for both sides and refuses a per-piece
comparison when they differ by more than **2.5×** — which passes small-vs-large hen
eggs (53 g vs 68 g) and rejects a quail egg against a hen's (9 g vs 55 g) — then
falls through to comparing **per gram** instead. That is what lets 30 quail eggs be
judged honestly against 10 chicken eggs.

Without a weight in the name there is no such check, and a smaller piece wins on
price every time. As at 2026-08-09, **4 of 9** By-Unit rows state one; see the
handover note for which five do not.

#### The `Select` tags (Notion multi-select)

| Tag | Effect |
| --- | --- |
| `Not in Use ATM` | The ingredient is **skipped entirely** — never searched, never priced. Dropped in `readGroceryTargets()`. |
| `Brand Specific` | Only the `[bracketed]` brand may match; any other brand is a hard miss. |
| `Quality item` | Rejects a cheaper **grade**. A candidate whose **normal (undiscounted)** price per 100 is below `QUALITY_FLOOR` (75%) of what you pay at full price is a budget line, not a bargain. The **sale** price is ignored on purpose — a quality product may be discounted as deeply as it likes. Skipped when there's no baseline or no pack weight, so missing data never rejects. |
| `Organic/animal welfare` | The product must be **store-certified organic** (structured `Dietary Attributes`) or name a welfare rearing method (free range, cage free, grass fed, pasture raised, barn laid, RSPCA). |
| `Weekly Buy` | Not a matching rule — it changes the **cooldown**. After a Buy the item goes quiet for a flat **5 days** regardless of how much was bought, because it's re-bought on a rhythm rather than when the pack runs out. See "Cooldowns" below. |

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

⚠️ **Two shops have a second module that reaches them THROUGH `ss-worker`**, because
where a request comes from decides whether they answer at all. Both report the same
`store` name as their direct twin, since everything downstream keys on that:

- **`shengsiong-worker.ts`** — searches via `/scan?dryRun=1&force=1&terms=…`.
  Used by the cloud (`CLOUD_NEW_ITEM_SHOPS`), because Sheng Siong answers Singapore
  only. ⚠️ **`force=1` is required and omitting it fails silently:** the Worker's
  freshness check runs before the dry-run branch, so with today's scan already
  committed it returns `already-fresh` with **zero products** — a 200 that reads
  exactly like "not stocked". `dryRun` is what keeps `force` safe (it writes
  nothing), and the Worker refuses `terms` without it.
- **`carousell-worker.ts`** — fetches the search page via `/shop` and parses raw
  HTML (`parseSearchHtml`), **no browser**. Used by the **laptop**
  (`NEW_ITEM_SHOPS`), and *not* by the cloud — see the country pass-through note
  under "How it fits together".

- **FairPrice** — `src/core/stores/fairprice.ts`. Server-side-render scrape of
  `GET /search?query=…`, parsing the page's `__NEXT_DATA__` JSON. Weight comes
  from `metaData.DisplayUnit` (the raw `Weight` field is unreliable). Works from
  any IP, including the cloud.
- **Sheng Siong (live)** — `src/core/stores/shengsiong.ts` + `ddp.ts`. Talks the
  site's Meteor **DDP protocol over a WebSocket** (`wss://shengsiong.com.sg/websocket`,
  via the `ws` library), calling `Products.getByAllSlugs(filters, misc, page,
  size)` with the query in `filters.searchFilter.slug`; weight from `packSize`.
  **Only works from a Singapore IP** — an address outside Singapore gets a `200`
  challenge instead of a WebSocket upgrade, whether it is residential or a data
  centre (see the geography note under "How it fits together"). Used by the laptop
  and for local testing.
- **Sheng Siong (file)** — `src/core/stores/shengsiong-file.ts`. Implements the
  same interface but reads `data/shengsiong-latest.json` instead of the network.
  Uses it **only if the file's `date` equals today (Singapore time)**; otherwise
  every search returns empty (→ FairPrice-only). It never makes a live call, so
  the cloud's IP block is irrelevant. Env override: `SHENGSIONG_DATA_PATH`.
- **Guardian** — `src/core/stores/guardian.ts`. Magento PWA Studio; no anti-bot,
  just an SPA, so it needs the browser tier. ⚠️ Its size is stated in the **name**,
  not a field. ⚠️ Its `document.title` is set from the route before the product
  resolves, which is how a slug (`cerave-pm-…-630062.html`) once reached Notion as a
  product name — see `human-name.ts` below.
- **MyProtein** — `src/core/stores/myprotein.ts`. Works from the cloud. The size
  lives in an on-page variant, so the module fetches variants per product; the old
  "28 products priced, 0 with a size" verdict was about the search page only.
- **iHerb** — `src/core/stores/iherb.ts`. Plain `fetch` is 403; needs headed Chrome
  on the laptop. ⚠️ **The capsule count is the size, and the dose is not the pack.**
  "Vitamin C, 1,000 mg, 240 Veggie Capsules" priced as a 1 g purchase is the trap;
  `capsuleCount` takes the number **adjacent to the piece word**, never the first in
  the title. Do **not** "fix" this by multiplying dose × count — 240 g of active
  ingredient is not a 240 g pack.
- **Watsons** — `src/core/stores/watsons.ts`. ⚠️ **It renders prices and then wipes
  them**: an Akamai Bot Manager check tears the results down 16–22 s in, so a fixed
  delay has to thread a window that fails at both ends, and too-early and too-late
  produce the *identical* footer-only shell. That is why it collected two independent
  "dead end" verdicts (2026-08-05 and again 2026-08-11) which were both honest and
  both wrong. The fix is `evaluateInPage`'s `waitFor` — poll an expression until
  truthy and read the page the moment it's ready — with `settleMs` demoted to a
  give-up deadline. **Do not re-open or close a shop on a node count alone**: the
  probe once scored Watsons 54 "prices" while it rendered nothing but its footer,
  because skeleton loaders match `[class*="price"]`. It now demands prices containing
  a **number** *and* product links, and reports both counts.
- **Carousell** — `src/core/stores/carousell.ts`. A marketplace: reduced with
  `cheapestPlausible` and never the minimum, because the cheapest listing is usually
  the scam. **Two transports, one shared pipeline** — the harvest produces
  `RawAnchor[]` either way, and `parseCards` → shortlist → price re-check is the same
  code for both:
  - **`parseSearchHtml`** (default since 2026-08-17) reads the search page's raw
    HTML. No browser. This is what `NEW_ITEM_SHOPS` uses, via `carousell-worker.ts`.
  - **the headed-Chrome path** over CDP still exists and is what
    `vendor-probe --browser` exercises.

  ⚠️ **Carousell refuses by CLIENT, per path** — which is why the parser alone was not
  enough. Measured from one machine, same minute, same URL: Node's `fetch` gets `403`
  on `/search/` but `200` on a `/p/` listing; `curl` and the Worker get `200` on both.
  So listing pages really are "plain-fetchable" on every client, and the search page
  is not — a distinction that made the older note true and misleading at once.

  ⚠️ **Raw HTML is better input than the browser gave**, and both facts bite:
  the rendered DOM dropped lowercase `s` ("U ed"), which made the second-hand badge
  undetectable; and the URL slug drops decimal points, turning a 2.43 kg tub into
  **43 kg**. The markup keeps both. Pinned by `src/tests/carousell-html.test.ts`.
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
[Buy]      Peanut Butter, Smooth                         −31%
[Ignore    [500g] Price $8.20                              ⋯
 1wk]      FairPrice · Skippy Peanut Butter Spread       [Add]
           [500g] $5.65 on sale (−15%)               [Replace]
           $11.30/kg vs $16.40/kg                    [Macros]
           uses ~400g/month                     has macro
```

- **Buy** — writes the row to the Notion **grocery List** and records a cooldown,
  then appends to the purchase log. The row is:

  | Name | Price , To Buy | Current Price | Vendor | Amount |
  |---|---|---|---|---|
  | `Fish Sauce, Knife Brand, 750ml` | the discounted price | what you pay today | `Sheng Siong` | `1`, and **+1 on each further tap** |

  The Name is **the ingredient, then the brand and pack size of the listing that's
  actually on offer** — what you need in order to pick the right thing off the
  shelf. The **shop goes in its own `Vendor ` column**, not in the name. Column
  names are resolved from the live Notion schema at write time, never hardcoded,
  because they drift.

  Each segment is dropped when the shop didn't publish it, so a brandless listing
  still reads cleanly. A counted pack says `30 pcs` rather than a weight. The brand
  is used exactly as published and never has the word "brand" appended — `Tiger
  Brand` and `Snow Brand` are real brand names — and a brand the ingredient's own
  name already states isn't repeated.

  ⚠️ Name carried a `[NTUC] ` prefix until 2026-08-06, duplicating the Vendor
  column, so the shop is now recorded in exactly one place. Duplicate detection
  matches the whole title, which means **one row per (ingredient, brand, size)**:
  tapping the same card twice makes one row, while two genuinely different packs
  list separately.

  ⚠️ Since 2026-08-09 that second tap is no longer a no-op — it adds 1 to
  `Amount `. The row still doesn't duplicate; it says you want two. The count is
  read before it is written, so an Amount you set by hand ("get 3") is added to
  rather than overwritten.
- **Ignore 1wk** — snoozes this **ingredient** until Monday 00:00 SGT. Nothing is
  searched for it until then, and it's undone with **Reset** from the list at the
  foot of the page. Red, like the permanent ignore in the menu: red marks the
  controls that take something off the page, and the label and the menu's extra tap
  are what separate the two.
- **Add** — files today's match into **Ingredients** as a new row, with this shop
  in `Vendor 1` and the price, size and URL in `Price [Vendor 1]` /
  `Size[Vendor 1]` / `URL [Vendor 1]`. It is `Vendor 1` because a new row's four
  slots are all empty and the shared rule takes the first free one — not because
  the slot is hardcoded.
- **Replace** — re-bases the ingredient that *seeded* the search onto today's
  match: `Name`, `Unit type `, and the price into **one vendor slot**. Confirmed
  first, no undo. `Unit type ` travels with the size by necessity — re-base a
  500 g item onto a 1 L bottle and a stale `By Gram` would claim a kilogram of
  liquid.

  **Which slot** is decided by the row, in this order:
  1. the slot already tagged with this shop → its price, size and URL are replaced;
  2. otherwise the first slot with *nothing* in it → tagged with this shop and filled;
  3. otherwise the slot with the **highest** `Price [Vendor n] / Size[Vendor n] * 1000`
     gives way — and **only** if this product is cheaper per kg than that. If it
     isn't, nothing is written and the reply says so.

  ⚠️ "Nothing in it" means vendor, price, size and URL all empty. A slot tagged
  `Sheng Siong` with no price is that shop's slot (the commonest shape in the live
  DB), and a price sitting in an *untagged* slot is still a price — neither is
  free real estate.

  ⚠️ A shop with no matching `Vendor n` **option** — Cold Storage, Giant, RedMart,
  Lazada, Amazon SG today — is reported and skipped. Writing it would make Notion
  invent the option, which this tool never does. Add the option in Notion first.
- **+ Macros** — a per-card toggle, off by default, that arms a paid nutrition
  lookup for that card only.
- **has macro / no macro** — whether this listing's nutrition is free to file.

The `⋯` menu holds the three corrections: **Ignore for good** (retires this
**product** for every ingredient, permanently — confirms first, and the one
control on the page with no undo; coming back means editing
`data/exclusions.json`), **Mismatch item** (bans words for that ingredient
permanently — the page proposes the words and you edit the list before anything is
saved), and **Almost, but no** (blocks one product for one ingredient, for a
near-miss whose defining property the shop simply doesn't state).

⚠️ **The two ignores are different scopes, not two durations of one thing.**
`Ignore 1wk` suppresses the *ingredient* for a week; `Ignore for good` retires a
*product* forever. A permanent ingredient-level ignore is a different mechanism
again — the `Don't Search` tag, set by hand in Notion.

They swapped places on 2026-08-05: the button used to hold the permanent block and
the menu the weekly snooze. Neither *action* changed, only which control emits it.
The reversible correction is the reachable one because it is the one reached for
most often; the irreversible one sits behind the menu's two taps.

Corrections live in `src/core/exclusions.ts` (pure) + `exclusions-file.ts` →
`data/exclusions.json`, applied in `findDeal`/`findReview` and keyed by
`cooldownKey`, so a correction on "Onion (White)" also covers "Onion (not red)".

### Cooldowns and the purchase log

- **`src/core/cooldown.ts`** + `data/cooldowns.json`. Three routes, checked in
  this order:

  | # | when | length |
  |---|---|---|
  | 1 | the ingredient is tagged **`Weekly Buy`** | flat **5 days**, whatever was bought |
  | 2 | pack size and monthly usage are both known | `pack ÷ usage × 0.75` |
  | 3 | neither | flat **14 days** |

  Route 2's 25% haircut brings the item back before the cupboard is empty, leaving
  a window to catch a deal. 1 kg of garlic at 500 g/month → 2 months of cover →
  **46 days**.

  ⚠️ **`Weekly Buy` is checked first because it means "ignore the arithmetic", not
  "adjust it".** Some things are bought on a rhythm rather than when they run out —
  bananas are a weekly shop whether you came home with three or a dozen — so a
  bigger pack must not buy more silence. Left to route 2, a 2 kg buy against
  1 kg/month would have gone quiet for 46 days: six weeks of not being shown a
  fruit you buy every week. Five days rather than seven for the same reason route 2
  keeps its haircut — the item is back in the scan a couple of days before the next
  shop, so a deal can actually be caught.

  Entries are keyed on the stemmed base noun (`onion`), so one entry covers
  "Onion (White)" and "Onions" but deliberately not "Garlic Powder" when you bought
  "Garlic".
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
  (a new row, with nutrition), *Replace Current* (the price, size and URL into this
  shop's vendor slot on the existing row, by the same three-step rule the deals
  page's Replace uses — and deliberately **not** a rename, unlike the extension's
  version), and *Never buy again*.
- **Already filed** — the same rows once settled, kept as a record.
- **Never buy again** — the product-wide blocks the red Ignore button writes, read
  from the same `data/exclusions.json` the scan uses, so this list cannot disagree
  with what actually gets skipped. Listed but not undoable from the page.

### New items page — `public/new-items.html`

`src/core/new-items.ts` prices items that **aren't in Ingredients yet** across five
shops (`NEW_ITEM_SHOPS`: FairPrice, Sheng Siong, Guardian, MyProtein, Carousell). The
last three already had modules but were reachable only through `vendor-scan`'s
directed search, which needs a row naming the vendor — and a new item has no row.

- **No baseline exists**, so the card compares *shops against each other* and shows
  the shop's own sale %, never a saving against the user's price.
- Carousell is reduced with `cheapestPlausible` and labelled `[marketplace listing]`.
- The laptop scans and commits `data/new-items-latest.json`,
  `repository_dispatch: newitems` rebuilds Pages, and a stale file is skipped rather
  than published. ⚠️ **This is the hand-off the daily scan used to use** — new-item
  pricing is now the only job still shaped that way, because it searches Carousell,
  which needs a real Chrome.
- ⚠️ It holds **its own shop list and uses the live DDP module**, not `run.ts`'s
  `STORES`. That default is `shengsiong-file`, which only answers terms in that day's
  committed scan — and a new item's term is never among them, so Sheng Siong returned
  zero results with no error on every new-item card.

### The Telegram inbox — texting a list in

The first **inbound** path in the project: everything else here is a page being
built or a button being pressed, while this is a message arriving. Three files do
the thinking and one holds the state.

- **`src/core/list-parse.ts`** — the quantity grammar, no AI. `2kg chicken breast`,
  `bananas x6`, `2 x 500g peanut butter`. ⚠️ **`x` is a multiplier, stripped as a
  whole word and never as a character**: `Carrots x 1kg` reached the matcher as
  `"Carrots x"` and scored 0.65 against a row that `Carrots` scores 1.000 on — while
  a leading character class turns `Xylitol` into `ylitol`.
- **`src/core/list-intake.ts`** — matches each line to an Ingredients row with the
  same scorer the deals page uses, and returns one of **three verdicts**:

  | verdict | what happens |
  |---|---|
  | **link** | the leader clears `ACCEPT` **and is alone** → the row is written silently |
  | **ask** | anything within `CANDIDATE_MARGIN` (0.05) of the leader gets a button |
  | **new** | nothing matched → queued for shop pricing, and offered a home in Ingredients |

  ⚠️ **"Alone" is load-bearing.** Two rows both scoring 1.000 on `1 x milk` used to
  link to whichever Notion returned first. A tie is now a question.
- **`src/core/tg-inbox.ts`** — the handler: chat allow-list, the inline keyboards,
  every button tap, and the state. No paid lookups, ever.
- **`src/core/grocery-list.ts`** `addTextedItem()` — shares schema resolution and
  dedupe with the Buy button, but leaves unknown columns **blank** rather than
  writing zero.

**The question's buttons.** The candidate rows, then **🆕 New item — create in
Ingredients** (creates the row *and* the grocery-list line against it, confirming
first; marked `{New}` in braces — `(New)` would read as a defining property and match
nothing at any shop), then **✖️ Cancel — typo**, always **last** so a thumb aiming at
the final ingredient cannot reach it — the order is pinned by test. A parked
(`Not in Use ATM`) row is offered with a 💤 and never linked silently however well it
scores; picking it un-parks the row, because texting an item outranks a snooze.
⚠️ `Don't Search` rows are still dropped entirely — that tag is the user's and
nothing here may undo it.

**The one-hour rule — `tg-sweep`.** An unanswered ask is filed onto the grocery List
after `ASK_TTL_MS` (60 min) as **name only, exactly as typed**: no Ingredients
relation, no price, no vendor, and nothing created in Ingredients. That is
deliberately weaker than every other path — an unlinked row carries no price and
never appears in the deal scan — because an unlinked row you can shop from beats a
question you never answered, and guessing which candidate was meant is the one thing
this must not do. ⚠️ **A missing `askedAt` starts the clock rather than firing it**:
an ask from a state file written before this shipped is of *unknown* age, and reading
that as "old" would file a question the user had been looking at for ten seconds.
⚠️ The pricing queue is **untouched** by a sweep, and the summary says so.

**The pricing queue — `tg-drain`.** A line matching no ingredient has no known price,
and pricing it means asking Sheng Siong. The cloud sets `deferPricing`, leaves the
item on a queue in `data/tg-inbox-state.json`, **says so in the chat**, and the laptop
drains it every 15 minutes across five shops (`NEW_ITEM_SHOPS`). ⚠️ The cloud
deliberately does **not** scan the shops it *can* reach instead: a card comparing one
shop looks exactly like a card comparing five.

**Two state files, and they are not the same file.**

| | who owns it | when |
|---|---|---|
| `data/tg-inbox-state.json` | the **cloud**, committed to the repo | now |
| `.sessions/tg-inbox.json` | the retired **poller**, local and gitignored | before 2026-08-12 |

`npm run tg-adopt-state` carries the poller's open questions into the committed file.
⚠️ Run it **after** stopping the poller, never before: while the poller is alive it
owns that file and will answer a tap behind your back.

### Asking a price without buying — `src/core/item-search.ts`

`/search chicken breast` (also `/find`, `/price`, `/s`) answers from the price book:
the matching Ingredients rows with price, size, price per kg, and which vendor is
cheapest. **It reads only** — no shop scan, no model call, no Notion write.

⚠️ **The slash is what separates a question from an instruction**, and that is the
whole reason this is a command. Plain text to this bot is a *shopping list*: it gets
matched, written to the Notion List, and anything unrecognised gets priced at the
shops. So "what does chicken cost?" typed without a slash would add chicken to the
list. There was no way to ask a question until `/search` existed.

- **`searchQuery(text)`** returns the query, `""` for a bare command, or `null` when
  the message is not a search at all. ⚠️ `""` and `null` are different answers and
  callers must keep them apart: `""` earns the usage hint, `null` must fall through
  to the shopping-list path.
- **`searchAll` / `formatSearch`** — **one message, always.** Several queries in one
  text share a single reply, and the length cap drops results with a note rather than
  sending a second message.
- ⚠️ **Weak matches are labelled as such.** A query that lands on nothing good still
  answers, but says the rows are merely *similar* — presenting a 0.35 match in the
  same voice as a 0.95 one is how someone ends up believing they stock something they
  do not.

Tested offline in `src/tests/item-search.test.ts`.

### The relay Worker — `relay/`

A single dependency-free ESM file (`relay/worker.mjs`, ~200 lines) deployed to
Cloudflare's free tier; `wrangler deploy` uploads it as-is, there is no build step.
Full setup, verification and rollback in [`relay/README.md`](relay/README.md).

- **It holds no state** and does two things: turn a Telegram webhook delivery into a
  `repository_dispatch`, and fire a `tgsweep` dispatch every 15 minutes on its cron
  trigger. It also sends the typing indicator, so the chat acknowledges you in about
  a second while Actions takes 20–60 s.
- **It is fail-closed.** A request without the exact
  `X-Telegram-Bot-Api-Secret-Token` gets `401`, and a missing `WEBHOOK_SECRET` in the
  environment fails the same way rather than opening up — the URL is public the moment
  it is guessed, and an unauthenticated webhook is a stranger writing to the grocery
  list. `ALLOWED_CHAT_ID` is a second gate: exactly one chat is answered.
- **Four secrets** (`wrangler secret put`), documented in `relay/wrangler.toml`:
  `WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN` (fine-grained PAT, this repo
  only, **Contents: read and write** — that and only that is what
  `repository_dispatch` needs; Administration does not grant it), `ALLOWED_CHAT_ID`.
  `REPO` is a plain var in `wrangler.toml`.
- ⚠️ **A cron-tick failure is deliberately not reported into the chat.** 96 ticks a
  day would train the user to mute the bot. The consequence is that nothing tells you
  if the PAT is revoked, which is why it was created with **no expiry** — a decision,
  not an oversight.
- **Live:** `https://grocery-telegram-relay.tmje30.workers.dev`. `npx wrangler tail`
  from `relay/` is the live log; `relay/worker.test.mjs` has 33 offline cases and runs
  as part of `npm test`.

### The Sheng Siong scanner — `ss-worker/` (added 2026-08-13)

The Worker that replaced the laptop for the daily scan. TypeScript, deployed with
`npx wrangler deploy` from `ss-worker/`. Live at
`https://ss-worker.tmje30.workers.dev`.

**The problem it solves.** Sheng Siong answers Singapore and challenges everywhere
else. A Cloudflare Worker on its own is no help — it runs wherever the *caller* is,
and the caller is a US GitHub runner. The fix is a **Durable Object**.

- **`worker.ts`** — the entry point. Exports `fetch` (the `/scan` endpoint),
  `scheduled` (the morning cron), and the `ScanRunner` Durable Object class.
  - ⚠️⚠️ **Both paths go through the Durable Object, and that is not obvious.** The
    first design let the on-demand path skip it, reasoning that a request from
    Singapore is placed in Singapore. True of a tap from your phone — but the tap
    never reaches this Worker. The deals page is public and cannot hold a secret, so
    the button fires `repository_dispatch` and **GitHub Actions** calls the Worker,
    from a US runner. `SCAN.get(id, { locationHint: "apac" })` is what puts the scan
    in Singapore on *every* path.
  - `CANDIDATES` — eight named objects, `sheng-siong-sg-0..7`. `pickStub()` probes
    them in turn and uses the first that can actually reach the shop. `apac` is
    region-coarse, so some objects land in HKG or KIX rather than SIN; placement per
    name is sticky, so a working one keeps working.
  - ⚠️⚠️ **Read `colo`, never `loc`.** `cdn-cgi/trace` fetched inside a Worker
    reports `loc` as the *original caller's* country, not the object's. A probe that
    keyed on `loc` produced a confidently wrong result on 2026-08-12. Even `colo` is
    only a hint — `reachable()` is the real gate, and it tests the one thing that
    matters: whether the shop returns a `101` WebSocket upgrade rather than the `200`
    that means a challenge page.
  - **It refuses rather than scan-and-fail.** An object outside Singapore returns
    `503 unreachable-from-here` with its datacenter, so the caller can try another.
- **`ddp.ts`** — `WorkerDdpClient`. Sheng Siong's catalogue is served over **Meteor
  DDP on a WebSocket**, not the HTML site. The bot-protection guards the front door;
  the DDP protocol answers directly. **No browser and no Incapsula cookie are
  involved** — which is exactly why this fits in a Worker at all.
- **`scan.ts`** — `runScan()`, `fetchTerms()`, `mapProduct()`, `sgtDate()`. Reads the
  published `targets.json` for its search terms, so it stays in step with Notion
  without holding any Notion credential.
- **`github.ts`** — `commitScanFile()`, `readScanFile()`, `dispatchRebuild()`. Commits
  via the Contents API (GET blob sha → PUT base64 + sha) and then fires the rebuild.
  - ⚠️ **The Worker must dispatch the rebuild itself, with its own PAT.** GitHub
    blocks a `repository_dispatch` sent with a workflow's own `GITHUB_TOKEN` from
    starting another workflow run (anti-recursion), so `scan-request.yml` could not
    do it even if it wanted to.

**The endpoint.** `GET /scan`, authenticated with an `X-Scan-Secret` header:

| Parameter | Effect |
|---|---|
| `force=1` | scan even if today's file is already committed (what Rescan sends) |
| `source=…` | recorded in the committed file, e.g. `cloudflare-cron`, `rescan-button` |
| `dryRun=1` | return the scan without writing it — how the port was diffed against the laptop |
| `probe=1` | cheap yes/no on whether this object can reach the shop |
| `terms=a\|b` | override the search terms; ⚠️ **only honoured with `dryRun`**, so a two-term "scan" can never overwrite the real file |

**A second endpoint — `GET /shop?url=…`** (added 2026-08-17), same `X-Scan-Secret`.
It fetches one page **from Singapore** and returns it unchanged. This is how Carousell
is reached without a browser: its search page is server-rendered, so plain HTML is
enough once the request comes from the right country.

⚠️ **It is deliberately NOT a general proxy and must not become one.** An
authenticated open proxy is a stranger fetching anything they like from this
Cloudflare account. The **host allowlist is the entire security model** — only
`carousell.sg` — it is checked in both the Worker and the Durable Object, and the
host is never taken from the caller. Verified: `403` for any other host, `401`
without the secret, `400` for a non-`https` URL.

⚠️ It goes through the Durable Object for the same reason the scan does: a plain
Worker runs beside the *caller*, and the caller is usually a US runner.

⚠️⚠️ **A VPN on your laptop breaks Carousell, and this is why.** The route forwards
the *caller's* country, and Carousell refuses every country except Singapore — so
with a VPN on a Danish exit, every Carousell page including the homepage came back
refused (measured 2026-08-18). Turning the VPN off fixed it in the same minute. The
error now names the VPN rather than printing the refusal page.

⚠️ **The last idea for reaching Carousell from the cloud was tested on 2026-08-18
and does not work.** A Durable Object alarm has no incoming request, so it should
carry no country — and it genuinely sheds the caller's, but presents as **US**,
which is exactly what Carousell refuses. A scheduled handler works the same way, so
both are closed. The experiment was removed again rather than left in the code.

⚠️ **It cannot help a US-initiated call reach Carousell** — see the country
pass-through note under "How it fits together". It works when called from Singapore,
which is what the laptop does.

**Two secrets, both fail closed** (`npx wrangler secret put`): `SCAN_SECRET` (a
missing one rejects every request rather than accepting all of them) and
`GITHUB_TOKEN` (a fine-grained PAT, this repo, **Contents: read and write** — kept
separate from the relay's).

⚠️ **Cron triggers are registered at deploy time, from `[triggers]` in
`wrangler.toml`.** Adding that block without redeploying does nothing, and secret
changes do not re-read it. **The check:** a successful `wrangler deploy` prints the
schedules back —

```
Deployed ss-worker triggers (6.93 sec)
  schedule: */15 1-2 * * *
  schedule: 0 3 * * *
```

If those lines are absent, the crons are not registered. Config changes take up to
**15 minutes** to propagate.

⚠️ **`* * * * *` is not honoured — never use it to test a cron here.** One sat
deployed for 20 hours across a stale file and never fired once, while the 15-minute
schedule worked on its first opportunity. It produces a convincing false negative.
Test with a `*/15`-style expression, or read the history instead (below).

**How to check whether the morning scan ran:**
1. **Cloudflare dashboard** → Workers & Pages → `ss-worker` → Settings → **Trigger
   Events** → View events. Keeps the **100 most recent cron invocations** with
   outcomes. Historical, so it answers the question days later. **Try this first.**
2. `npx wrangler tail ss-worker --format pretty` from `ss-worker/` — live only, and
   ⚠️ it can lose its connection while its output still reads `Connected …`, so a
   silence proves nothing unless the session is confirmed alive.
3. The repo itself: `data/shengsiong-latest.json` carries `date` and `source`, and
   the commit is titled `data: Sheng Siong scan <date> (<source>)`.

`[observability] enabled = true` is set so logs persist — the scan runs unattended
at 09:00, which is precisely when live tailing is not an option.

**Verified against the laptop before it was given write access:** on four real
target terms, **151 of 152 products byte-identical on every field**, zero differing.
⚠️ Re-run that diff (with `dryRun=1`) if the port is ever touched, and **key the
comparison on `url`, never `name`** — Sheng Siong sells several products under one
name, so a name key compares an item against an arbitrary same-named sibling.

`ss-worker/scan.test.ts` runs offline as part of `npm test`.

### Chrome extension — "Nutrition Plan Extension"

`extension/` — captures a grocery product page straight into the Notion
**Ingredients** DB. Full detail in `extension/README.md`; the essentials:

- **Two writes, never automatic.** *Add to Ingredients* creates a row; *Replace
  With This* appears beside **each** similar existing row and repoints it at this
  product, asking first and showing before → after.
- Writes `Name` (generic, in the bracket standard), `Items Exact Name` (the shop's
  title verbatim), `Unit type `, `Catagory`, the four nutrition columns — and the
  price, size and URL into **one `Vendor n` slot**, chosen by the same rule as the
  deals page (this shop's slot → first free slot → the dearest, if beaten per kg).
  ⚠️ A shop with no `Vendor n` option is named in the panel and its price skipped;
  the row is still written.
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

### Shared plumbing — the small modules everything leans on

- **`src/core/sgt.ts`** — `sgtDate()` (the `YYYY-MM-DD` **data** value, compared for
  equality to decide whether a scan is today's) and `sgtLongDate()` (the **display**
  string a person reads). ⚠️ These existed as **four verbatim copies plus a fifth
  inlined**, and `item-action.ts` had independently grown a *different* function with
  the same name and a docstring warning against exactly what the other five did. Two
  implementations of "what day is it in Singapore", sharing a name and disagreeing
  about method, is how the wrong one eventually gets copied.
  ⚠️ **The `+8h`-then-`toISOString` form is correct and must not be "simplified"** —
  Singapore has been UTC+8 with no DST since 1982 — but only because the offset
  *precedes* the `toISOString`, and that leading line is precisely what a future reader
  deletes on recognising the anti-pattern. 13 cases pin it, all inside the 00:00–08:00
  SGT window, because that is the only window this system runs in; three of them assert
  that the naive form gives the **wrong** answer. Getting it wrong is silent: the page
  simply goes FairPrice-only and nothing says why.
- **`src/core/human-name.ts`** — repairs a product name that is really a URL slug:
  `cerave-pm-facial-moisturizing-lotion-52ml-630062.html` → `Cerave PM Facial
  Moisturizing Lotion 52ml`. Runs at the two points a name is captured.
  ⚠️ **The strict half is the point.** A repair that fires on a title a shop really
  published rewrites a field nobody re-reads, so it only touches a string with **no
  whitespace at all** that also has a page extension, a path, or **three or more**
  hyphenated parts — three, not two, because `Coca-Cola`, `7-Eleven` and `Vitamin-C`
  are real names. A trailing catalogue id is dropped only at **five** digits or more,
  so `vitamin-c-1000` keeps its dose. ⚠️ Rows written before 2026-08-12 are untouched.
- **`src/core/git-data-push.ts`** — a data file re-applied onto the fetched remote and
  retried (5 attempts), used by every writer on the laptop. It exists because on
  2026-08-05 a perfect scan (58 terms, 0 errors) was rejected for being 12 commits
  behind and **sat stranded locally while the cloud built FairPrice-only**. It is a
  whole-file re-apply, deliberately *not* `merge-data.ts`'s three-way merge: these
  files are regenerated in full each run. ⚠️ A clone holding any *other* uncommitted
  change refuses the working-tree reset and says so — so a session's edits are never
  sacrificed to publish a page. `DataPushOptions.reapply` is the exception for
  `tg-inbox-state.json`, which the cloud edits on every tap: a runner writing its whole
  copy over the remote would resurrect questions the user had just answered, on screen,
  with live buttons.
- **`src/core/gh-dispatch.ts`** — fires `repository_dispatch`. Falls back to the `gh`
  CLI when `GITHUB_TOKEN` is unset, which is how the laptop's rebuild request worked at
  all. ⚠️ `gh` reads its token from the OS keyring, which a scheduled job can reach
  while the user is logged in and may not when they are logged out — a job that must
  work regardless still wants a real PAT in `GITHUB_TOKEN`. It also does not pass the
  token as a `curl` argument, where anything able to list processes could read it.
- **`src/core/workflow-report.ts`** — the one `report()` both write workflows use.
  ⚠️ Its heredoc delimiter is **randomised per call**: the text either side of it is
  not ours (a shop listing's title, and on Carousell the seller writes it), and a title
  carrying a line that is exactly `EOF` closes the block early — benign case truncates
  the comment, crafted case sets outputs the script never wrote.

### Tests — `npm test`

**1,046 offline cases, free and fast** — 978 across 29 suites in `src/tests/`, plus
33 in `relay/worker.test.mjs` and 35 in `ss-worker/scan.test.ts`, which `npm test`
runs after them.

⚠️ **`npm test` also typechecks the Worker now (2026-08-18), and until that day
nothing ever had.** `ss-worker` asked for Cloudflare's type definitions but the
package had never been installed, so the check failed on the missing library and
nobody ran it twice — leaving the one part of the system nobody can watch run as
also the least checked. There are deliberately **two** configs: the main one types
`ss-worker` as a Worker and nothing else, while a second adds Node's types for the
test file alone. Merging them would let a Node-only API pass the check and then fail
at the edge, which is precisely the mistake worth catching. They cover pack-shot
selection and its commodity gate, nutrition-panel parsing, macro-reply parsing, name
derivation and URL-slug repair, the deals page's markup, marketplace and in-text size
parsing, cooldown length, the concurrent-write merge, the whole-file re-apply against
a real temp git repo, the grocery-list row, vendor slots / scan / review, the texted
list's parsing and candidate ranking, the inbox state and its one-hour sweep, SGT
dates, the scan-request marker, and the relay's dispatch and auth behaviour.

There is **no test runner and no new dependency** — each file registers its cases
into `harness.ts`, and `run.ts` imports every suite and sets the exit code. The relay
suite is plain Node with no imports from `src/`, because the Worker is deployed as-is.
Nothing here calls Notion, a shop, or Anthropic: a test that costs 29 cents is a
test nobody runs. The live checks that *do* cost something have their own scripts
(`npm run macro-test`, `npm run fp`, `npm run ss`) and are deliberately not wired
in.

The suites cover exactly the functions where being *quietly* wrong is the danger:
a misread serving size is out by 3× and looks plausible, a pack-shot gate that
stops matching a shop's filenames silently costs 10× per lookup, and a drifting
commodity gate spends real money. None of those announce themselves.

### Searching shops beyond FairPrice and Sheng Siong

**Built as of 2026-08-11**, as `npm run vendor-scan` — no longer just a probe. Full
detail in `docs/vendor-scoping.md`, which governs; this is the orientation.

⚠️ **Nothing schedules `vendor-scan`.** Not `daily.yml`, not Task Scheduler. It is
still a command someone runs, deliberately — it drives a headed browser for four of
the shops and can only run on the laptop.

⚠️ **The baseline and the price book used to be separate sets of columns, and that
distinction is gone as of 2026-08-09.** The price book is now the *only* record of
what anything costs, and the baseline is derived from it:

| | columns | meaning |
| --- | --- | --- |
| **price book** | `Vendor 1..4` + `Price [Vendor n]` + `Size[Vendor n]` + `URL [Vendor n]` | what **each shop** charges. Every write in this project lands here |
| **baseline** | `Price,SGD [Cheapest]`, `Cheapest Price/Kg `, `Cheapest Vendor ` — **formulas** | the cheapest of the above. Nothing writes these; they fall out |

The old baseline columns (`Price,SGD`, `Weight /Units of New Product `,
`Vendor, Current `) are deleted or renamed `… - Delete? `. Any code or note
telling you to write them is stale — and reading them returns nothing, which is
how the daily scan silently found zero targets until this was fixed.

Rules for any writer, unchanged in spirit and now enforced in
`src/core/vendor-slots.ts`: match the vendor **by name** to find the index (the
mapping is per-row — `Vendor 1` is Shopee on one row and Watsons on another); a
shop with no `Vendor n` **option** is reported, never created; and a slot holding
anything at all is never silently overwritten.

⚠️ One rule *did* change. "If no index names that shop, write nothing" was the
right call for a background **scan**, and still is — but the Add and Replace
buttons are a deliberate human act, so they may claim a free slot, and Replace may
displace the dearest slot when it beats it per kg. A scan must still not.

**Searches must be directed** — don't look for bread at a pharmacy or a face
lotion at a supermarket. Routing is `Vendor[n]` tags first, then `Catagory` as the
default: grocery categories → FairPrice + Sheng Siong; `Suppliments` (30 rows) →
iHerb + MyProtein; `Household Supplies` (7 rows) → Watsons + Guardian. ⚠️ The tags
mean "*also* look here", never "only look here" — `Sheng Siong` is tagged on zero
rows, so code treating an empty tag as "don't search" would silently kill the
FairPrice scan on 42 rows.

**`npm run vendor-probe -- "<term>"`** measures whether each shop can yield a
price **and** a pack size. It writes nothing anywhere and prints its own egress IP
first. Status as at **2026-08-11**, re-measured from the laptop:

| shop | where it can run | note |
| --- | --- | --- |
| **NTUC (FairPrice), Sheng Siong** | cloud / laptop | working. `NTUC` is the live `Vendor n` option name; the module is called `fairprice` |
| **Watsons** | laptop, **headed** | renders, then wipes — needs `waitFor`, not a tuned delay |
| **iHerb** | laptop, **headed** | plain `fetch` is 403 |
| **Carousell** | laptop, **headed** | headless renders zero cards |
| **Shopee** | laptop, headed, **signed in** | session in `.sessions/chrome-shopee`. ⚠️ Nothing in this repo may type a credential — and it has a session but **no module yet** |
| **MyProtein** | cloud | already worked; the "no sizes" complaint was about the search page |
| **Guardian** | — | was **down** on 2026-08-11: Magento's own maintenance page on `/graphql` (503, and the homepage still 200s from CDN cache — `x-cache: MISS, HIT` gives it away). Not blocking us; nothing to fix |
| **"Google Search"** | — | tagged on 3 rows, but it is not a shop and cannot be a route |

⚠️ **Watsons, iHerb, Carousell and Shopee are laptop-only** — headless is detected by
every one of them, so none can run in GitHub Actions.

⚠️ **Still open: iHerb yields 0 candidates even now**, and so do two Watsons
toothpaste rows — but for a *different* reason. The shops serve real results (43, 23
and 28 priced products) and `evaluate()` rejects them all. That is a **matching**
problem with supplement and personal-care naming, not a store problem, and a refusal
reads identically to an empty catalogue in the report.

#### Filling the price book — `vendor-scan.ts`, `vendor-review.ts`

`npm run vendor-scan` searches the shops each row names and, with `--write`, fills
that shop's `Price [Vendor n]` / `Size[Vendor n]` / `URL [Vendor n]`. A read-only
census on 2026-08-11 found the hole it was built for: **49 rows named Sheng Siong and
not one had a price** — the shop the laptop scrapes 1,092 products from every morning
was the biggest gap in the price book, and the scan had been finding those prices
daily and discarding them.

⚠️ **Run it on the laptop with `SHENGSIONG_LIVE=1`.** Against the committed file the
lookup is an *exact, case-sensitive* string match into whichever terms that morning's
run happened to scrape, so **"not stocked" and "never scraped" become identical**. The
two term builders also disagree by design — `vendor-scan` prefixes the brand, the
runner scraped the daily scan's spelling — so `fairprice Bread` found nothing while 48
bread products sat in the file under `Bread`. Patching the exact-key lookup would only
move the problem.

**The third answer: "I found something, but I'm not sure."** `--write` used to mean
"write everything it found", which on the first run would have recorded a **10 kg sack
of carrots**, a **12 × 1 L case of milk** and **5 L of soy sauce** as the user's price.
Each is genuinely the cheapest per kilo; none is a pack anyone buys. So
`vendor-review.ts` classifies each pick and an uncertain one is **queued and asked
about** — a Telegram review card with **Ok** / **Don't use**. Six reasons: `bulk`
(≥ 2 kg/2 L or a multipack), `size-range` (a range read at its **top**, which flatters
the per-kilo figure by 14% on a 600–700 g cabbage), `outlier` (≥ 3× from the row's
other shop), and three marketplace-only ones (`floor-rescue`, `auto-handle`,
`undercut`). First run: **12 clear picks, 9 queued** of 21 candidates.

⚠️⚠️ **"Don't use" is NOT "ignore forever", and this is the load-bearing rule.**

| | scope | effect on the deals page |
| --- | --- | --- |
| **Don't use** (`data/vendor-review.json`) | the price book: one row, one shop | **none — the product still appears** |
| **Ignore forever** (`data/exclusions.json`, `ALL_ITEMS`) | every search, everywhere | gone from the page too |

A refusal says *"this is not the pack I'd record as my price at this shop"* and says
nothing about whether it's a good deal. **Never write these into `exclusions.ts`** —
that answers both questions at once and takes away the user's ability to answer only
the first. `vendor-review.test.ts` pins the file shape for exactly this reason.

⚠️ A refusal is applied **before** the pick, not after, so the next scan offers the
next-best pack rather than going silent on the row — refusing the 5 L soy sauce
surfaces the 640 ml bottle. `findPendingFor` stops the same 10 kg sack being re-asked
every day, and `PENDING_TTL_DAYS = 7` drops a stale question rather than answering it
with a price the shop has since changed.

⚠️ **A report-only run must write nothing at all** — not Notion, and not
`data/vendor-review.json` either. `npm run vendor-scan` with no flags is the safe
thing to reach for, and it stops being that the moment it leaves state behind.

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

*`npm test` runs everything below the line automatically; `npm run check:worker`
typechecks the Cloudflare Worker on its own.*

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
- **`npm run vendor-scan`** — fill the price book. No flags = report only, writing
  **nothing** anywhere; `--write` fills the vendor slots and queues the uncertain
  picks for review. Laptop only, and wants `SHENGSIONG_LIVE=1`.
- **`npm run ss-on-request`** — ⚠️ **ORPHANED since 2026-08-13; nothing writes the
  marker it reads.** Rescan now calls Cloudflare directly. Kept deliberately as a
  by-hand emergency path: pair it with `npm run scan-request` to file a marker
  yourself, and it will scan and push. **Its silence is correct — do not "fix" it.**
- **The Telegram commands** — all read `TELEGRAM_BOT_TOKEN` from `.env`:

  | command | what it does |
  |---|---|
  | `npm run tg-handle` | handle **one** update from `TG_UPDATE`. What the cloud runs |
  | `npm run tg-drain` | price the queued new items. **Runs in Actions since 2026-08-17**; by hand on the laptop it uses all five shops instead of four |
  | `npm run tg-sweep` | file any ask older than an hour. What the Worker's cron triggers |
  | `npm run tg-webhook` | `show` (default) / `set <url> [secret]` / `delete` |
  | `npm run tg-adopt-state` | carry the poller's open questions into the committed file |
  | `npm run tg-diag` | "which bot is this and what is queued" |
  | `npm run tg-poll` | the **retired** forever-poller. `409 Conflict`s while a webhook is registered |

  ⚠️ `tg-webhook` **refuses to touch `@Big_Notion_Bot`**, checked against the live
  bot's own name — its webhook is another project's only delivery path, and
  `TELEGRAM_INBOX_BOT_TOKEN` falling back to `TELEGRAM_BOT_TOKEN` means a mis-set
  `.env` could genuinely point this at it. It also **refuses to register without a
  secret**, reading `WEBHOOK_SECRET` from `.env` rather than taking it on the command
  line where it would land in shell history.
- **`npm run ext:build`** — rebuild the Chrome extension's `dist/`. Required after
  editing `synonyms.json`.
- **`npm test`** — the 854 offline cases (`src/tests/` then the relay suite). Free,
  fast, no network.
- **`npm run check`** — TypeScript type-check (no emit). **`npm run build`** emits
  `dist/`.

### The laptop runner (scheduled)

- **Dedicated clone:** `C:\Users\newuser\shengsiong-runner\repo`, separate from
  the development copy so the daily job never collides with in-progress work.
- **Wrapper:** `C:\Users\newuser\shengsiong-runner\run.cmd` — sets
  `RUNNER_SOURCE=laptop`, adds Node + git to `PATH`, runs `git pull` then
  `npm run push-ss`, and appends output to `..\push-ss.log`.
- **Four Windows Task Scheduler tasks**, as at **2026-08-14** — ⚠️ **three of the
  four are now off**; Cloudflare does this work:

  | task | script | when | state |
  |---|---|---|---|
  | **Grocery New-Item Pricing** | `tg-drain-run.cmd` | every **15 min** | **Ready** — the one still doing a job |
  | **ShengSiong Daily Scan** | `run.cmd` (runner clone) | 05:30 SGT, then every 30 min until 11:00 | **Disabled** 2026-08-14 — kept as the one-click emergency scanner |
  | **ShengSiong Scan Request** | `ss-request-run.cmd` | every 5 min | **Disabled** 2026-08-14 — Rescan calls Cloudflare now |
  | **Grocery Telegram Inbox** | `tg-poll-run.cmd` | at logon, every 15 min | **Disabled** — retired by the relay |

  All run as the logged-in user (`/IT`), so Windows Credential Manager provides git
  push auth and **no access token is stored anywhere**. The two `tg-*` jobs and the
  scan-request job run in the **dev clone**, because they need the `.env` holding
  `NOTION_TOKEN` and `TELEGRAM_BOT_TOKEN`; the daily scan runs in its own clone so it
  never collides with in-progress work.

- ⚠️ **A non-zero exit code does not buy you a retry, and this cost three days.**
  10–12 August all failed identically: the task fired on time, `git pull` hit
  `Could not resolve host: github.com` while the network came up after wake, and the
  runner correctly refused to scan into a dead network. The page was FairPrice-only
  three days running — on the 12th that was **half the deals**, 3 becoming 6 once the
  scan landed. The task carried `RestartCount: 3` and the wrapper returned 1 on the
  stated reasoning that a non-zero exit buys the second attempt. It does not: Windows
  restarts a task that **failed to run**, and a program that runs and returns 1 is a
  *completed* run. `RunOnlyIfNetworkAvailable` doesn't help either — it asks whether an
  adapter has a link, not whether DNS resolves. The fix is a **trigger repetition**,
  which Task Scheduler does honour, and it costs nothing on a normal morning because
  `push-ss` self-gates on today's file and the extra runs print "Already fresh".
- **Inspect them:** `type C:\Users\newuser\shengsiong-runner\push-ss.log` (and
  `tg-drain.log`, `tg-poll.log` beside it);
  `schtasks /Query|/Run|/Change|/Delete /TN "<task name>"`.
  ⚠️ Run `schtasks` through **PowerShell, not Git Bash** — MSYS rewrites `/Query` into
  a path (`C:/Users/newuser/scoop/apps/git/…/Query`) and the command fails obscurely.
- ⚠️ **A long-running poller degrades invisibly.** On 2026-08-12 `tg-poll.log` held
  **2,547** `poll failed: fetch failed` lines across 13 hours while the chat looked
  normal, because a *successful* poll logs nothing at all and the failure path backs
  off 5 s and retries forever. So "every line is a failure" does **not** mean nothing
  succeeded, and the ratio cannot be recovered from the log — corroborate with the
  state file's `updatedAt`. This is the same silent-degradation shape as the 2 h 45 m
  Modern Standby delay, and it is an argument for the relay rather than a bug to fix.
- A **phone (Termux/Android)** runner (`phone-run.sh`) exists but is **shelved** by
  the user (2026-08-11); its push was proven, its scheduling never finished. Do not
  pick it up as pending work. ⚠️ **The Singapore VPS it was shelved in favour of was
  never needed either** — `ss-worker` took that job on Cloudflare's free tier on
  2026-08-13, at no cost.

### The cloud jobs

Seven GitHub Actions workflows:

- **`.github/workflows/daily.yml`** — the main job: `npm ci` → `npm run build-site`
  → deploy `public/` to GitHub Pages → `npm run notify`.
  ⚠️⚠️ **What actually starts it every morning is the Worker, not this cron.**
  `ss-worker` scans Sheng Siong from 09:00 SGT and fires a `rescan`
  `repository_dispatch` the moment it commits, which runs this whole workflow at
  about 09:01. The `schedule:` here is a **backstop** for the morning that never
  happens.
  ⚠️ **Until 2026-08-18 it was not a backstop, and it cost you a second digest every
  day.** Both clocks ran the full job — 09:01 from the Worker, ~09:15 from the cron —
  and the notify step has no condition on it, so two identical digests arrived every
  morning for five days without anyone noticing. The cron now fires at **11:30 SGT**
  (`30 3 * * *`), *after* the Worker's last retry at 11:00 so it never races what it
  covers for, and a **`guard` job** stands the run down when the page has already
  been built today.
  ⚠️ The guard counts today's successful runs in **Singapore** time — a UTC
  comparison would read an evening rebuild as belonging to the next day — and it
  **fails toward publishing**: only a definite "already built today" stands the run
  down. If the check errors, times out, or cannot answer, the page is built anyway.
  A spurious duplicate digest is the safe direction; a silently missing page is not.
  ⚠️ **That was not true when first shipped, and it cost four mornings** (2026-08-19
  to 08-22). The check could not work out which repository to ask about, failed, and
  because the build was gated on it *succeeding and saying yes*, the build was
  skipped — taking the "something broke" alarm down with it, since that alarm lives
  in the build. Four failures, no message. Nothing was lost, because the Worker's
  09:01 trigger published normally every one of those mornings, but the safety net
  was not there. Fixed 2026-08-22.
  ⚠️ **There is now a way to test it without waiting for morning.** The "Run
  workflow" button offers **`test_backstop`**, which makes the check decide exactly
  as it would at 11:30. On a day the page is already built it sends nothing — so the
  branch that failed can be exercised on demand, which is how it should have been
  proven in the first place. Only the *scheduled* run is second-guessed. The
  rescan dispatch, the page's Rescan button, new-item pricing and a manual run all
  build on request as before.
  ⚠️ **The old floor still holds.** The reason the cron was 00:00 UTC was that a
  discount read at 5am may not be the one on the shelf; 11:30 SGT respects that
  comfortably. An earlier cron aimed at an 08:00 *arrival* (`30 20 * * *`) was tried
  and reverted the same day — the queue delay is a queue, not a promise.
  ⚠️ **It says so in Telegram when it fails outright** (added 2026-08-13). A partial
  failure already spoke for itself — a missing shop becomes a warning in the same
  message as the deals — but a run that died *before* the notify step sent nothing at
  all, so a broken morning looked exactly like a morning with no discounts. The
  notifier uses **raw `curl`, not `npm run notify`**, on purpose: two of the likeliest
  breakages are `setup-node` and `npm ci`, which leave no `node_modules` for a script
  to run in. A notifier that depends on the thing that just failed goes quiet exactly
  when it is needed.
  ⚠️ **It had never once fired, and now it can be fired on purpose.** Written on
  2026-08-13, it sat unused because nothing failed — a safety net nobody had pulled.
  The "Run workflow" button now offers a **`drill`** tick-box: the run fails
  deliberately, straight after checkout, so the notifier has something to report and
  the drill costs seconds instead of a full scan and deploy. **The message says it is
  a drill**, because a test that arrives looking like a real outage teaches you to
  distrust the alarm. First fired 2026-08-18; Telegram accepted it and it arrived.
  ⚠️ **The drill immediately found a weakness worth knowing about:** `curl` exits
  successfully even when Telegram *refuses* a message, so a green step was not proof
  of delivery — a wrong chat id or a revoked token would have looked like a working
  alarm indefinitely. The step now checks the reply and fails if the message was not
  accepted.
- **`.github/workflows/add-to-list.yml`** — the privileged half of the **Buy**
  button: writes the grocery-list row, records the cooldown, appends to the
  purchase log, comments the result on the issue and closes it. No Telegram ping —
  the user gets one daily digest and doesn't want adds narrating themselves. It
  deliberately has **no `concurrency` group**: GitHub keeps only one run pending
  per group and cancels the rest, so a burst of taps would lose the middle ones.
  Colliding pushes are handled by re-merging instead (below).
- **`.github/workflows/item-actions.yml`** — Reset, Not in use, Add, Replace and
  Ignore. Kept separate from the above because undoing a snooze has a different
  blast radius from writing to Notion. Issue titles use a fixed `Item: ` prefix,
  which is what the workflow's allowlist matches, so renaming a button on the page
  cannot break the two-tap path.
- **`.github/workflows/tg-inbox.yml`** — one Telegram update, handled. Triggered by
  `repository_dispatch: tgupdate` from the relay Worker; runs `npm run tg-handle` with
  the update in `TG_UPDATE`, then commits `data/tg-inbox-state.json`. ⚠️ **No
  `concurrency` group, deliberately** — GitHub keeps one run pending per group and
  cancels the rest, so a burst of taps would lose the middle ones.
- **`.github/workflows/tg-sweep.yml`** — the one-hour rule. Triggered by
  `repository_dispatch: tgsweep`, which the Worker's cron fires every 15 minutes, so
  the real deadline is **60–75 minutes**. ⚠️ This one **does** have a `concurrency`
  group, where `tg-inbox.yml` has none: cancelling a duplicate *tap* loses data,
  cancelling a duplicate *sweep* costs nothing, and two concurrent sweeps would file
  the same ask twice. Most runs exit in seconds having found nothing.
  ⚠️ **It also carries the 15-minute clock for new-item pricing**, as a second job
  calling `price-new-items.yml`. Sweep first, then price — the sweep files unanswered
  questions, which is exactly what unblocks a queue pricing refuses to touch.
- **`.github/workflows/price-new-items.yml`** (added 2026-08-17) — prices the queued
  items in the cloud, replacing the laptop's `Grocery New-Item Pricing` task.
  `workflow_call` + `workflow_dispatch` only: **no `schedule:`**, because free public
  repos queue those by 3–3¾ h, which would turn a 15-minute promise into a four-hour
  one. Rebuilds the site via `daily.yml` **only when something was actually priced** —
  it runs 96 times a day and finds an empty queue almost every time.
  ⚠️ It cannot fire `repository_dispatch` to trigger that rebuild: GitHub refuses to
  start a workflow from a dispatch sent with a workflow's own token, **silently**
  (204, nothing runs). Hence a dependent job, and `daily.yml` gained `workflow_call`.
  ⚠️ The rebuild job declares `pages:`/`id-token:` permissions itself — a called
  workflow is capped by its caller, so inheriting `contents: write` alone would fail
  the deploy *after* the expensive scan had already run.
- **`.github/workflows/scan-request.yml`** — triggered by `repository_dispatch: sscan`
  from the page's Rescan button. **Rewritten 2026-08-13:** it makes one authenticated
  HTTP call to `ss-worker` and nothing else — no checkout, no `npm ci`, `permissions:
  {}`. The Worker scans, commits and dispatches the rebuild itself. It needs the
  `SCAN_SECRET` repository secret, and fails with a named error if that is missing
  rather than sending an unauthenticated request (the Worker answers those with a bare
  `401`, which reads like a *wrong* secret rather than an absent one).
  ⚠️ It no longer writes `data/scan-request.json`. If the Worker cannot be reached the
  run **fails loudly in Telegram**, naming the disabled `ShengSiong Daily Scan` task as
  the emergency runner.

**When two taps land together** — `src/core/merge-data.ts` + `src/scripts/merge-data.ts`.
Each tap is its own workflow run, and each commits a JSON data file and pushes, so
two presses a few seconds apart race: the second push is rejected. The loser then
takes the winner's version of the repo wholesale and **re-applies its own change on
top**, up to five times.

⚠️ It is a proper three-way merge (what the run started from, what it produced,
what landed upstream), not a union — these files are not append-only, since
**Reset** removes a cooldown and **Never buy again** settles a purchase row, and a
union would put back exactly what someone had just removed. Where the two sides
disagree, a removal beats an edit.

⚠️ The previous approach — replaying the commit with `git pull --rebase` — could
not do this: two entries appended to the same JSON array is a content conflict, so
the run died *after* the page had already reported success. It silently lost three
real corrections on 2026-08-05, which is what prompted the change.

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
- **`TELEGRAM_BOT_TOKEN`**, **`TELEGRAM_CHAT_ID`** — the bot and destination chat.
  ⚠️ Since 2026-08-10 this project has **its own bot, `@Grocery69_bot`**, which both
  sends the daily digest and serves the inbox; `@Big_Notion_Bot` went back to being
  only the Notion Worker's, so no shared bot and no chance of one project's webhook
  breaking the other's polling. The chat id is unchanged — a private chat's id is the
  user's own user id, the same for every bot.
- **`TELEGRAM_INBOX_BOT_TOKEN`** — optional override for the inbox bot. Stays blank;
  `config.telegramInboxBotToken()`'s fallback to `TELEGRAM_BOT_TOKEN` is the normal
  path, not a degraded one. ⚠️ Which is exactly why `tg-webhook` checks the *live
  bot's own name* before touching a webhook.
- **`WEBHOOK_SECRET`** — shared three ways and all three must match exactly: `.env`
  (where `tg-webhook` reads it), the Worker's `wrangler secret put WEBHOOK_SECRET`,
  and Telegram's `setWebhook` `secret_token`. Generate it straight into `.env` so it
  never appears on screen or in shell history:
  ```bash
  node -e "console.log('WEBHOOK_SECRET='+require('crypto').randomBytes(24).toString('hex'))" >> .env
  ```
- **`GITHUB_TOKEN`** — a fine-grained PAT, this repo only, **Contents: read and
  write**. Needed by the Worker (as a `wrangler secret`) and wanted in `.env` so the
  laptop's `repository_dispatch` doesn't depend on the `gh` CLI's keyring. ⚠️ Not the
  same thing as the automatic `GITHUB_TOKEN` inside an Actions run.
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
  Manager), the scheduled tasks above, and — since the WAF change — **Google Chrome
  installed**, which it launches briefly to earn a session cookie when it gets
  challenged. Four of the nine shops need that headed browser for every search.
- **A Cloudflare account** (free tier) for the two Workers — the relay (`relay/`)
  and the Sheng Siong scanner (`ss-worker/`) — with `npx wrangler` to deploy them;
  no global install, no build step. ⚠️ `wrangler login` opens a browser and cannot
  be scripted. The **workers.dev subdomain is global across Cloudflare** and separate
  from the Worker's name.
  - **Secrets are write-only.** `wrangler secret put` sets them; nothing can read a
    value back. `wrangler secret list` shows only the names. Losing one means
    generating a new one on both sides, not recovering it.
  - ⚠️ The Worker name is a **positional** argument to `wrangler tail`
    (`wrangler tail ss-worker`), not `--name`.
  - **Free-plan cron limit is 5 per account**, and this project uses **3** (one on
    the relay, two on `ss-worker`).
  - `ss-worker` needs `SCAN_SECRET` and `GITHUB_TOKEN`; the same `SCAN_SECRET` value
    must also be a **repository secret** on GitHub, so `scan-request.yml` and
    `price-new-items.yml` can present it.
  - ⚠️ **`SCAN_SECRET` is now needed in the LOCAL `.env` too** (since 2026-08-17).
    New-item pricing reaches Carousell through the Worker on every path, including
    by-hand runs on the laptop. Without it, Carousell throws with that message and is
    recorded as an error against the shop — it does **not** fall back to Chrome,
    because a silent fallback would hide a broken configuration behind a slower path
    that happens to work.
- ⚠️ **On a brand-new `workers.dev` subdomain, `setWebhook` will fail first** with
  `bad webhook: Failed to resolve host: Temporary failure in name resolution`.
  Telegram's own resolvers lag a new subdomain by up to about an hour while every
  public resolver already answers it, so nothing is misconfigured and nothing local
  will reproduce it. Wait and re-run; don't debug it. (Failed twice at ~25 min and
  succeeded untouched at ~70 min on 2026-08-12.)
- This machine's shell is **Windows PowerShell 5.1**, where `&&` is a parser error
  ("not a valid statement separator in this version"). Commands go one per line.
- The Chrome extension needs `https://api.anthropic.com/*` in `host_permissions`
  plus the `anthropic-dangerous-direct-browser-access` header, because a service
  worker sends a browser `Origin`.

## Glossary

- **Baseline (price per 100 g)** — what you currently pay for an item, computed in
  Notion; the number a store must beat to count as a deal.
- **By-Gram / By-Unit** — whether an ingredient is measured by weight or by count
  (eggs). Both are compared: By-Unit rows per piece, or per kilo when a weight is
  stated in the row's `Name` or the cheapest slot's item name.
- **Active plan** — the meals tagged `Main` in Meal prep's `Current Plan`
  column; the ingredients on their sub-item lines form the "In your plan"
  section.
- **DDP** — the WebSocket-based protocol (from the Meteor framework) that Sheng
  Siong's website uses; the live Sheng Siong module speaks it directly.
- **Residential vs data-centre IP** — a home/mobile internet address vs a cloud
  server's. ⚠️ **This distinction is *not* what Sheng Siong cares about** — it
  challenges addresses outside **Singapore**, residential or not (corrected
  2026-08-11). It still matters at other shops: on the same line, `curl` gets 403
  from Watsons while Node's `fetch` gets 200, so the client is an independent
  variable. Pin both before calling anything "blocked".
- **Runner** — whatever scans Sheng Siong from Singapore and commits the data file
  the cloud reads. ⚠️ **Since 2026-08-13 this is `ss-worker`, not the laptop.** The
  laptop keeps a switched-off scheduled task as an emergency stand-in.
- **Relay** — the Cloudflare Worker in `relay/`. Turns a Telegram webhook into a
  GitHub `repository_dispatch`, and carries the 15-minute cron behind the chat's
  one-hour rule. Holds no state.
- **`ss-worker`** — the second Cloudflare Worker (`ss-worker/`). Scans Sheng Siong
  from Singapore, commits the prices and asks GitHub to rebuild the page. Runs on a
  morning cron and on demand from the Rescan button.
- **Durable Object** — a Cloudflare primitive that pins a piece of code to one
  place, addressed by a name you choose. Here it is used purely for **geography**:
  `locationHint: "apac"` is what puts the scan inside Singapore no matter where the
  request came from. Placement per name is sticky, and region-coarse — `apac` can
  mean Hong Kong or Osaka as well as Singapore, which is why eight candidates are
  probed and the reachable one is used.
- **`colo`** — the Cloudflare datacenter serving a request (`SIN`, `HKG`, `NRT`…).
  ⚠️ Not to be confused with `loc` in `cdn-cgi/trace`, which reports the *caller's*
  country and produced a confidently wrong measurement on 2026-08-12.
- **Webhook** — Telegram pushing each message to a URL you registered, instead of
  your program asking repeatedly. A bot can have a webhook **or** serve `getUpdates`,
  never both.
- **`repository_dispatch`** — the GitHub API call that starts a workflow **promptly**,
  unlike `schedule:`, which free public repos queue by ~3–3¾ h. Everything in this
  system that has to happen soon goes through it.
- **DNS** — the lookup turning a hostname into an address. There is no single copy:
  Telegram runs its own, which is why a brand-new subdomain can resolve everywhere
  except at Telegram for about an hour.
- **Sweep** — the 15-minute job that files any chat question older than an hour onto
  the grocery list as name only. The "one-hour rule".
- **Pricing queue** — texted items matching no Ingredients row. The cloud can't price
  them (Sheng Siong), so they wait in `data/tg-inbox-state.json` for the laptop.
- **Price-book review** — the **Ok** / **Don't use** cards the vendor scan sends when
  a pick is odd (bulk pack, size range, wild outlier). ⚠️ **"Don't use" affects only
  the price book** — the product still appears on the deals page. "Ignore forever" is
  the other thing.
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

- **2026-08-22 — a price check can no longer quietly make one of your prices worse.**
  When the scanner looked up a shop you had already recorded a price for, it wrote
  whatever it found — including a *higher* price — over the one you had. Nothing
  compared the two. It now only writes a price that is **cheaper than what that same
  shop already has**; anything dearer goes to the review page with both figures side
  by side, and **your recorded price is never replaced unless you tap to accept it**.
  Checking the 50 NTUC rows the day this was built, **six of them would have been
  made more expensive that morning** — one from $24.50/kg to $40.20/kg.
  ⚠️ Worth knowing: this hole existed for every run before the 22nd, so a recorded
  price may already have drifted upward. Running the check in report-only mode now
  lists exactly which ones, and writes nothing.
- **2026-08-22 — the safety net added on the 18th was itself broken, and is now
  fixed.** The check that decides whether the late-morning backup run is needed
  could not work out which repository to look at, so it failed every morning from
  the 19th — and because the backup run was only allowed to proceed if that check
  succeeded, the backup never ran. Worse, the "something broke" Telegram alarm sits
  inside that same run, so four failures passed without a word. **Nothing was
  actually missed** — your page and digest went out at 09:01 every one of those
  mornings from the Worker, as designed. What was missing was the fallback. It now
  errs the other way: if the check cannot answer, the page gets built regardless.
- **2026-08-18 — you were getting two identical digests every morning, and now you
  get one.** The daily job had two clocks: the Worker started it at 09:01, and
  GitHub's own timer started the whole thing again at about 09:15. Nobody had
  noticed in five days. GitHub's timer is now a genuine backstop — it waits until
  11:30, checks whether the page has already been built today, and stands down if it
  has. On a morning the Worker fails, it still publishes.
- **2026-08-18 — the "nothing is working" alarm has now actually been tested.** It
  was written on 2026-08-13 and had never sent a single message, because nothing had
  failed. There is now a tick-box that fires it deliberately, and the message says
  it is a drill so a test can't be mistaken for a real outage. Testing it found that
  the alarm could have been broken without anyone knowing — it now checks that
  Telegram really accepted the message.
- **2026-08-18 — if your VPN is on, Carousell will not work.** This was always true
  and nothing said so. Carousell refuses every country except Singapore, and it is
  your own machine's country that counts, even though the request goes through the
  Singapore Worker. The error now tells you to turn the VPN off instead of showing a
  page of technical noise. Everything else — the two supermarkets, Guardian,
  MyProtein — is unaffected.
- **2026-08-18 — the last idea for reaching Carousell from the cloud was tried, and
  it failed.** Worth recording so nobody spends the day on it again: the four-shop
  gap below is permanent unless the request comes from a machine actually in
  Singapore.
- **2026-08-17 — nothing scheduled runs on your laptop any more.** New-item pricing
  was the last job on it; it now runs in the cloud, within 15 minutes of you texting
  something the system has no price for. All four Windows scheduled tasks are off.
  The daily Sheng Siong scan stays disabled-but-present as a one-click emergency
  scanner. Nothing in the system launches a web browser any longer either — the last
  thing that did was the Carousell search, now read from plain HTML.
- **2026-08-17 — you can ask what something costs without adding it.** Text
  `/search chicken breast` (or `/find`, `/price`, `/s`). Until now every message to
  the bot was a shopping list, so asking about an item was the same as adding it.
- **2026-08-17 — cloud-priced new items compare four shops, not five.** Carousell
  cannot be reached from the cloud at all: it refuses non-Singapore addresses, and —
  the part that took a day to establish — routing through the Singapore Worker does
  **not** disguise that, because Cloudflare passes the original caller's country
  through to the site being fetched. Running `npm run tg-drain` by hand on the laptop
  still uses all five. This is a real gap, since Carousell is the only marketplace.
- **2026-08-16 — two shops turned out to have been working for a week.** Guardian and
  MyProtein were both recorded as needing more work; both had been finished since
  2026-08-09. The diagnostic tool had drifted from the code it was describing, and
  its stale verdict was believed. The probes now test the real modules.

- **2026-08-15 — The daily Sheng Siong scan no longer needs the laptop.** This is
  the biggest change since the system was built, and it makes several older
  paragraphs in this guide obsolete — they have been rewritten. Sheng Siong is now
  scanned by a Cloudflare Worker (`ss-worker/`) from inside Singapore, on a Durable
  Object pinned there. It runs itself every morning from 09:00 to 11:00 SGT, retrying
  every 15 minutes until one attempt succeeds, then commits the prices and asks
  GitHub to rebuild the page. Proven unattended on 2026-08-15: cron at 09:00:00,
  prices committed at 09:01:09, page and Telegram from it five seconds later.
  Before it was reliable, Sheng Siong prices depended on a laptop being awake in
  Singapore — which is why the page was FairPrice-only for three days running in
  mid-August.
- **2026-08-13 — Rescan got four times faster and stopped needing a machine at
  home.** The button used to commit a marker file for the laptop's five-minute job to
  notice, taking about ten minutes and only working if something was awake. It now
  calls Cloudflare directly and takes about four. The marker file is gone entirely.
- **2026-08-13 — A failed morning now says so.** If the daily run dies before it can
  send the digest, Telegram gets a plain "nothing is working" message with a link to
  the failure. Previously a broken morning and a morning with no discounts looked
  identical — both were silence.
- **2026-08-13 — The deals page tells you when an item needs a size in its name.** A
  new section at the foot of the page lists ingredients the shop sells only by weight
  while your Notion row counts them by the piece, so the two can't be compared. There
  is no button, because the fix is a judgement about which pack you actually buy.
- **2026-08-13 — A By-Unit row can record a pack the shop only weighs.** The price
  book no longer refuses a vendor slot just because the shop states grams where the
  ingredient counts pieces.
- **2026-08-12 — Texting the bot now works from the cloud, in under a minute.** A
  list texted at ~18:20 on 08-11 was answered at **21:11**: the laptop had entered
  Modern Standby at 18:26 and Telegram held the message for 2 h 45 m. Nothing was
  broken; nothing was awake. A Cloudflare Worker now receives the webhook and starts a
  GitHub Actions run — measured **2 seconds** from message to run, ~15 s to the row
  being written. The laptop's forever-poller is retired, and only one Telegram job
  remains on this machine: pricing an item nobody has bought before.
- **2026-08-12 — "After an hour, file it anyway."** A near-miss the user never got
  round to tapping used to leave the line nowhere at all. It now lands on the grocery
  list as typed — name only, no price, no ingredient link — because an unlinked row you
  can shop from beats a question you never answered. ⚠️ The clock is **Cloudflare's**,
  not GitHub's: Actions `schedule:` is queued by ~3–3¾ h on a free public repo, which
  would turn one hour into four. Delete the Worker's cron trigger and the rule silently
  stops happening.
- **2026-08-12 — Rescan actually rescans.** The button fired a rebuild from the same
  unchanged file, so it promised a rescan and delivered a redraw — the warning banner
  was still there three minutes later. It now asks the laptop for fresh prices; about
  ten minutes, one rebuild with the data in it, one Telegram message, and a label that
  says `✓ requested · ~10 min` instead of claiming to be rescanning.
- **2026-08-12 — ⚠️ It was never the residential line, it was the country.** This
  system was designed around "Sheng Siong needs a home internet connection", and that
  was **wrong**. A Singapore data-centre address scans all 60 terms cleanly; US
  data-centre addresses are challenged, VPN cookie or not. The laptop qualifies by
  being in Singapore. The practical upshot: a **~US$5/month Singapore VPS could take
  the last job off this laptop** — indicated, not proven, so probe the box first.
  ✅ **Resolved 2026-08-13, and better than proposed:** no VPS was needed. A
  Cloudflare Durable Object pinned to `apac` scans from Singapore on the free tier.
- **2026-08-12 — Two silent-failure lessons worth more than the fixes.** The 05:30
  scan failed three days running because a non-zero exit code does **not** buy a Task
  Scheduler retry (Windows retries a task that failed to *launch*), and the page was
  FairPrice-only — half the deals — with nothing saying why. And the poller logged
  **2,547** consecutive failures in 13 hours while looking healthy, because a
  successful poll logs nothing at all.
- **2026-08-11 — The daily scan fills the price book, and asks before it guesses.**
  49 rows named Sheng Siong and **not one had a price**: the scan had been finding
  those prices every morning and discarding them. `vendor-scan` now writes them. But
  "cheapest per kilo" would have recorded a 10 kg sack of carrots and a 12 × 1 L case
  of milk as the user's price, so an uncertain pick is sent to Telegram as an **Ok /
  Don't use** card instead of written. ⚠️ **"Don't use" is not "ignore forever"** — it
  declines to record that *pack* as the price at that *shop*, and the product still
  appears on the deals page.
- **2026-08-11 — Five more shops, and what each of them actually is.** Guardian,
  MyProtein, iHerb, Watsons and Carousell have modules now. The find worth keeping:
  **Watsons renders its prices and then wipes them** 16–22 s in, so a fixed delay has
  to thread a window that fails at both ends — and too-early looks exactly like
  too-late. It collected two independent "dead end" verdicts, both honest, both wrong.
  Never re-open or close a shop on a node count alone.
- **2026-08-10 — Text your shopping list to the bot.** The first *inbound* path in the
  project: a quantity grammar, the existing matcher, three verdicts (link silently /
  ask with buttons / price it as new), and a **New items** page for things not in
  Ingredients yet. The project also got **its own bot**, `@Grocery69_bot`, so
  `@Big_Notion_Bot` is the Notion Worker's alone again.
- **2026-08-12 — The guide had drifted six days and about 17,800 lines.** Everything
  above was missing from it, plus: the 854-case test suite (was 241), the six
  workflows (was three), the four scheduled tasks (was one), the shared plumbing
  (`sgt.ts`, `human-name.ts`, `git-data-push.ts`, `gh-dispatch.ts`,
  `workflow-report.ts`), the `Category` spelling fix, and the Ignore dropdown.
- **2026-08-06 — The grocery-list Name says which pack to look for.**
  `Fish Sauce` is now `Fish Sauce, Knife Brand, 750ml` — the ingredient, then the
  brand and pack size of the listing actually on offer, which is what you need
  standing in the aisle. Each segment is dropped when the shop published none, a
  counted pack reads `30 pcs`, and the brand is used exactly as published.
- **2026-08-06 — The grocery-list Name no longer carries the shop.**
  `[Sheng Siong] Banana (Fruit)` is now just `Banana (Fruit)`, with the shop in
  the list's own `Vendor ` column — which every add already wrote to, so the
  prefix was only a duplicate of it. Two consequences: the shop is now recorded in
  exactly one place, and adding the same ingredient from a second shop finds the
  existing row rather than making a second line.
- **2026-08-05 — Two taps at once no longer lose one of them.** Each button press
  is its own workflow run, and two a few seconds apart raced to commit the same
  data file; the loser's recovery replayed its commit, hit a conflict, and failed
  *after* the page had reported success. Three real corrections were lost that way
  before it was found. The loser now takes the winner's version and re-applies its
  own change on top.
- **2026-08-05 — `Weekly Buy` now sets the cooldown.** The tag was read from
  Notion and used by nothing. An ingredient carrying it goes quiet for a flat
  **5 days** after a Buy, regardless of how much was bought — bananas are a weekly
  shop whether you came home with three or a dozen, and the pack ÷ usage sum would
  have silenced a 2 kg buy for six weeks. Checked before that sum, not after.
- **2026-08-05 — The two ignores swapped places.** The button under Buy used to
  retire a product permanently and the `⋯` menu used to hold the weekly snooze;
  they traded. The button is now **Ignore 1wk** (snoozes the ingredient until
  Monday, undoable) and the menu holds **Ignore for good** (retires the product
  for every ingredient, no undo, confirms first). Neither behaviour changed — only
  which control triggers it. The reversible correction is the reachable one
  because it is the one used most; the irreversible one now takes two taps. Both
  are red: red marks what takes something off the page, and the label and the
  extra tap are what separate them.
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
