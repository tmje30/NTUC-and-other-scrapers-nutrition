# Scope — sweeping the tagged vendors daily

*Written 2026-08-18. Scope only: nothing here is built.*

## The question

The `Vendor 1..4` tags on each Ingredients row name the shops that row should be
priced at. Today **nothing sweeps them on a schedule** — `npm run vendor-scan` is a
command someone types. The daily job that reaches Telegram searches **two** shops
(`STORES = [fairprice, ss]`, `src/core/run.ts:28`) and fills the deals page, not the
price book.

This scopes closing that gap: a daily sweep of the tagged shops, feeding the same
morning message.

## What is actually there — measured, not estimated

Read-only count against the live database, 2026-08-18 (no shop contacted):

```
rows the scan would consider:          58
rows skipped (parked / don't-search):  10
total row×vendor pairs:               120
total search terms (incl. fallbacks): 302
```

| vendor tag | rows | reachable from the cloud? |
|---|---:|---|
| NTUC | 50 | yes |
| Sheng Siong | 50 | yes, **via `ss-worker`** |
| Guardian | 5 | yes |
| My Protein | 1 | yes |
| iHerb | 6 | **no — laptop only** |
| Watsons | 5 | **no — laptop only** |
| Carousell | 3 | **no — needs a Singapore caller** |

**106 of 120 pairs (88%) are cloud-reachable.** The laptop-only remainder is 14
pairs across three shops, and two of those three are the same five rows twice
(Watsons and Guardian both cover the CeraVe lotion and four Sensodyne toothpastes).

⚠️ **This reframes the problem.** The earlier framing — "a cloud sweep could only
cover four of seven shops" — is true by shop count and misleading by workload. The
two supermarkets are 100 of the 120 pairs.

## The one design decision that matters

`vendor-scan`'s Sheng Siong route is `SHENGSIONG_LIVE === "1" ? shengsiong :
shengsiongFile` — in Actions it reads the **committed scan file**.

⚠️ **That file only holds the ~60 terms the daily scan searched.** A vendor-scan row
whose term is not one of them finds nothing, and finding nothing is indistinguishable
from "not stocked". This is the most likely explanation for the finding recorded on
2026-08-11 — **49 rows tagged Sheng Siong, not one with a price**.

**So a cloud sweep must route Sheng Siong through `shengsiongViaWorker`**, exactly as
`CLOUD_NEW_ITEM_SHOPS` already does, rather than through the file. Without that, half
the sweep is theatre: it would run daily, report success, and write nothing.

## Shape

A new job in `daily.yml`, `needs: scan`, running **after** the page is deployed and
the digest sent.

```
09:01  ss-worker commits Sheng Siong  →  rescan dispatch
09:01  daily.yml: build-site → Pages → digest      (unchanged, not delayed)
09:1x  daily.yml: vendor sweep → price book → review page
```

⚠️ **After, not before, and this is the trade-off to accept or reject.** Putting the
sweep ahead of `build-site` would fold its results into the same morning message, but
it would also put an estimated 10–25 minutes onto the critical path of the thing you
actually read every day. Running it after means the price book is a day behind on the
deals page. **Recommended: after.** The digest is the product; the price book is
reference data and does not need to be same-minute fresh.

### Flags

`npm run vendor-scan -- --write --no-ask`

- `--write` — record the clear picks. Without it the sweep is a report nobody reads.
- `--no-ask` — queue uncertain picks to `review.html` **without** sending their own
  Telegram message. A daily scan with `--ask` is a daily nag; the count belongs as
  one line in the morning digest instead.

### What it writes

Only `Vendor n` slot properties that already exist, via `recordVendorPrice` — the
same writer the buttons use, under the same three rules (match the vendor by name,
write nothing if no slot names that shop, never touch anything outside the slot).

⚠️ **No schema is created or changed. Nothing is archived or deleted.**

## Estimated cost and runtime

| | estimate | confidence |
|---|---|---|
| FairPrice searches | ~125 terms, 1–2 s each | measured shape, estimated total |
| Sheng Siong via Worker | ~125 terms | **the unknown — see below** |
| Guardian + MyProtein | ~15 terms | small |
| **Wall clock** | **10–25 min** | wide, dominated by the row above |
| Money | **nil** | public repo, free Worker tier, Notion writes are free |

⚠️ **The Sheng Siong leg is the only real technical risk.** 125 sequential round
trips through one Durable Object, each doing a DDP query, is a usage pattern that
has never been tried — the Worker has only ever done one 60-term scan per morning.
**Mitigation available and worth taking:** `/scan?dryRun=1&force=1&terms=` already
accepts a **list** of terms, so the sweep can batch them into a handful of calls
instead of 125. That should be settled before building, not after.

⚠️ **`force=1` is mandatory on those calls.** Without it, a scan file already fresh
for today short-circuits and returns zero products — a 200 that reads as "not
stocked".

## What this does not cover

- **The 14 laptop-only pairs** (iHerb, Watsons, Carousell) stay manual. They should
  be **named in the report** rather than quietly absent, so "no price" never looks
  like "checked and nothing found". Carousell is a country problem with no cloud
  answer; iHerb and Watsons detect headless Chrome.
- **The deals page still compares two shops.** This fills the price book. Widening
  what the daily digest compares is a separate, larger question.

## Open questions for you

1. **After the digest, or in it?** Recommendation: after (see above).
2. **`--write` on a schedule at all?** Every automated write so far has been a button
   you pressed. This is the first thing that would write to Notion daily, unattended.
   A first run with `--write` omitted would show exactly what it *would* have done.
3. **How loud should it be?** Recommendation: silent on a clean day, one line in the
   morning digest when something is queued for review.

## Suggested first step

Run the sweep **once, in the cloud, report-only**, with Sheng Siong routed through
the Worker. That answers the runtime question, proves the Worker survives the
pattern, and shows how many of the 106 pairs actually resolve — before anything
writes to Notion or runs on a schedule.
