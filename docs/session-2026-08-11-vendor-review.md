# The daily scan fills the price book — and asks before it guesses

**2026-08-11.** Three changes, in the order they had to happen: the daily scan's
shops were added to the price-book scan, the per-kg fault was closed, and the scan
gained a third answer — *"I found something, but I'm not sure."*

## What prompted it

The user's model of the system was that the daily vendor search also fills the
`Vendor [n]` columns. It did not. Two programs, different shops, and the daily one
wrote nothing to Notion at all.

A read-only census of the live DB settled the "which shops" question:

| shop | slots tagged | searchable | **has a price** |
| --- | ---: | ---: | ---: |
| NTUC | 60 | 51 | 57 |
| **Sheng Siong** | 58 | 49 | **0** |
| Watsons | 5 | 5 | 0 |
| Guardian | 5 | 5 | 4 |
| Iherb | 5 | 5 | 4 |
| Shopee | 3 | 3 | 3 |
| Carousell | 3 | 3 | 2 |
| Google Search | 3 | 3 | 0 |
| My Protein | 1 | 1 | 1 |

**49 rows named Sheng Siong and not one had a price.** The shop the laptop runner
scrapes 1092 products from every morning was the biggest hole in the price book —
the scan had been finding those prices daily and discarding them.

`ROUTES` in `src/core/vendor-scan.ts` now includes `NTUC → fairprice` and
`Sheng Siong → ss`, under the same `SHENGSIONG_LIVE` switch `run.ts` uses.

⚠️ **`option` is the live `Vendor n` select option, not the module's name.**
`matchVendorOption` compares exactly, so the module called `fairprice` is routed as
**"NTUC"**, which is what the database says.

## ⚠️ The file-backed module makes "not stocked" and "never scraped" identical

The first report showed **"no results"** for Peanut butter, Fish Sauce and Thai Red
rice at a supermarket that stocks all three. `shengsiong-file.ts` is
`this.results[term] ?? []` — an **exact, case-sensitive string lookup** into whatever
terms the runner happened to scrape. Today's file holds 66.

Worse, the two term builders disagree by design. `searchTermsFor` prefixes the brand;
the runner scraped the daily scan's `queryTerms` spelling. Measured against the live
file:

| vendor-scan asked for | the file held, under the daily spelling |
| --- | --- |
| `sensodyne Toothpaste - Repair Protect` | **3 hits** as `Toothpaste - Repair Protect` |
| `fairprice Bread` | **48 hits** as `Bread` |
| `knorr Stock cubes` | **4 hits** as `chicken soup cube` |

Forty-eight bread products sat unused. The reported 21/49 hit rate is therefore an
undercount caused by two halves of one system spelling the same question differently
— **not** by Sheng Siong's catalogue.

⚠️ **The fix is to run this on the laptop with `SHENGSIONG_LIVE=1`**, where there is
no term dictionary at all. Patching the exact-key lookup would only move the problem.
Note that `Thai Red rice` and `Szechuan pepper` ARE in the file with zero results —
those are honest zeros, and telling the two apart needs the file, not the report.

## The third answer

`--write` used to mean "write everything it found". On the first NTUC/Sheng Siong
report that would have filed a **10 kg sack of carrots**, a **12 × 1 L case of milk**
and **5 L of soy sauce** as the recorded price for those rows. Each is genuinely the
cheapest per kilo. None is a pack anyone buys.

The user's call:

> leave the large packages and sizes for me to decide. send me a html text in
> telegram with all the items you are not sure about after a scan. and let me pick
> Ok or Don't use

So `src/core/vendor-review.ts` classifies each pick, and an uncertain one is queued
and asked about instead of written. Six reasons, all measured on the live report:

| reason | caught, first run |
| --- | --- |
| `bulk` — pack ≥ 2 kg/2 L, or a multipack | 10 kg carrots, 12 L milk, 5 L soy sauce, 2 L sesame oil, 2 L bran oil |
| `size-range` — a range read at its TOP | cabbage `600-700 g`, banana `1.2-1.5 kg` |
| `outlier` — ≥3× from the row's other shop | white pepper 9.4×, soy sauce 4.8×, cinnamon 6.6× |
| `floor-rescue` — under the floor on reputation alone | (marketplace only) |
| `auto-handle` — seller never personalised | (marketplace only) |
| `undercut` — cheaper listings dropped as implausible | (marketplace only) |

**12 clear picks, 9 queued** out of 21 candidates.

⚠️ **A range is read at its top**, which flatters the per-kilo figure in exactly the
direction that makes a pack look like a bargain — a `600-700 g` cabbage recorded as
700 g prices 14% below a 600 g one.

## ⚠️⚠️ "Don't use" is NOT "ignore forever", and this is the load-bearing rule

The user drew this line explicitly:

> but just because it is 'Don't use' does not mean it should not show up in Discount
> page. (if i don't want it there either, it will be put into the 'ignore forever'
> option.)

| | scope | effect on the deals page |
| --- | --- | --- |
| **Don't use** (`vendor-review.json`) | the PRICE BOOK, one row at one shop | **none — it still appears** |
| **Ignore forever** (`exclusions.json`, `ALL_ITEMS`) | every search, everywhere | gone from the page too |

A refusal here says *"this is not the pack I'd record as my price at this shop"*. It
says nothing about whether the product is a good deal. **Never write these into
`exclusions.ts`** — that would silently answer both questions at once and take away
the user's ability to answer only the first. `vendor-review.test.ts` pins the file
shape for exactly this reason.

⚠️ A refusal is applied **before** the pick, not after, so the next scan offers the
next-best pack rather than going silent on the row. Refusing the 5 L soy sauce should
surface the 640 ml bottle.

## Two things that would have bitten later

- **The queue would have grown every run.** The scan re-finds the same 10 kg sack
  tomorrow; without `findPendingFor` it would mint a fresh token and re-send the same
  card daily until answered. A person asked the same question five times stops
  reading the buttons.
- **A report-only run must write nothing at all** — not Notion, and not
  `data/vendor-review.json` either. `npm run vendor-scan` with no flags is the safe
  thing to reach for, and it stops being that the moment it leaves state behind.

`PENDING_TTL_DAYS = 7`: a fortnight-old question quotes a price the shop has since
changed, so it is dropped rather than answered. The scan re-queues anything still
uncertain, so dropping costs a repeat and nothing else.

## Still open

- **Watsons (5 slots), Iherb (5), Shopee (3)** are tagged with no store module.
- **"Google Search" (3 slots)** is not a shop and cannot be a route.
- **Nothing schedules `vendor-scan`.** Not `daily.yml`, not Task Scheduler. It is
  still a command someone runs.
- The egg rows can never take a Sheng Siong price: the row is `By Unit`, the shop
  publishes `Fresh Eggs (30s)` by weight, and `unitKindAgrees` correctly refuses
  rather than rewriting `Unit type `.
