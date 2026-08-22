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

## ⛔ BLOCKING prerequisite — the price book has no ratchet

**Found 2026-08-22, raised by the user before it was built. The sweep must not go on
a schedule until this exists.**

### What the code does today

`chooseVendorSlot` (`src/core/vendor-slots.ts:241`):

```ts
const mine = slots.find((s) => norm(s.vendorName) === norm(capture.vendor));
if (mine) return { kind: "update", slot: mine };
```

**If a slot already names that vendor, it is updated unconditionally — there is no
price comparison at all.** The cheaper-than-the-dearest test further down (line 274)
lives in the *eviction* branch, and `recordVendorPrice` calls with
`allowEvict: false`, so a scan never reaches it.

The one comparison that does run, `referencePer100g`, **deliberately excludes the
slot being written** (`excludeSlotN: slot.n`). It compares against the row's *other*
vendors, to catch counterfeits, and only raises a review flag at `OUTLIER_FACTOR`
(**3×**) or more.

### Why that is fine today and not fine daily

Guardian recorded at $8.50/100g. The scan matches a Guardian product at $12.00/100g.
That is 1.4× — under the 3× flag, never compared against Guardian's own recorded
price, and the slot names Guardian. **It is written silently, replacing the cheaper
figure, and nothing says so.**

⚠️ Run by hand that is survivable: you typed the command and you read the output.
**Unattended and daily it is a ratchet turning the wrong way** — every morning is
another chance to overwrite a good price with a worse one, and no one is watching.

### The rule to build

Per row × vendor slot:

| the slot | the find | what happens |
|---|---|---|
| no price (or no size) recorded | cheapest plausible match | **write** — unchanged from today |
| price + size recorded | **cheaper** per kg *at that same vendor* | **write** — unchanged from today |
| price + size recorded | **dearer** per kg | **do not write** · queue to the review page |
| price + size recorded | **nothing matched at all** | **do not write** · queue to the review page |

⚠️⚠️ **The comparison is against THAT VENDOR'S OWN recorded price, not against the
row's cheapest.** Each slot is that shop's price for this item; a Guardian find is
not disqualified by Sheng Siong being cheaper. That is precisely what
`referencePer100g` does *not* do, which is why it cannot be reused here.

⚠️ **Dearer is queued, never discarded.** A strict "never go up" rule would freeze a
stale price forever once a shop genuinely raises it or discontinues the pack. The
review line states both figures — *"Guardian is now $12.00; you have $8.50
recorded"* — and one tap accepts it. **The default price is never overwritten
automatically** (user, 2026-08-22).

⚠️ **"Nothing matched" is queued too, for the same reason**, but only where the slot
already held a price: a row that has simply never matched at that shop must not
generate a line every morning. The existing `findPendingFor` / pending-TTL
de-duplication already suppresses a repeat of a question still awaiting an answer,
and must be relied on here rather than reinvented.

### Where it goes

⚠️ **In `vendor-scan`, not in `chooseVendorSlot`.** That function is shared with the
deals page's Add and Replace buttons, where "the user is looking at this exact
product and pressed the button" is the whole authorisation — a person deliberately
recording a dearer pack must stay able to. The ratchet belongs to the *scan*, which
has no such warrant.

Two natural seams, both already load-bearing:

- the uncertainty gate in `src/scripts/vendor-scan.ts` (~line 383), which already
  computes `reviewReasons` **before** the write; and
- `reviewReasons` in `src/core/vendor-review.ts`, which needs two new kinds —
  something like `dearer-than-recorded` and `price-gone`.

**The accept path needs nothing new.** `review-ok` in `src/scripts/item-action.ts:667`
already records a queued pick through `recordVendorPrice`, so a tap on one of these
writes the dearer price exactly as intended.

### What it also fixes, retrospectively

This is worth having **regardless of whether the sweep is ever scheduled**. Every
by-hand `--write` run to date has had the same hole in it, and no record exists of
whether a recorded price has ever been quietly raised. A one-off report — *"which
slots would today's scan make dearer?"* — would answer that, and is the cheapest way
to find out whether the price book has already drifted.

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
2. ~~**`--write` on a schedule at all?**~~ **Answered 2026-08-22: not until the
   ratchet above exists.** Beyond that: Every automated write so far has been a button
   you pressed. This is the first thing that would write to Notion daily, unattended.
   A first run with `--write` omitted would show exactly what it *would* have done.
3. **How loud should it be?** Recommendation: silent on a clean day, one line in the
   morning digest when something is queued for review.

## Suggested first step

Run the sweep **once, in the cloud, report-only**, with Sheng Siong routed through
the Worker. That answers the runtime question, proves the Worker survives the
pattern, and shows how many of the 106 pairs actually resolve — before anything
writes to Notion or runs on a schedule.

⚠️ **And read that report for the ratchet**: it will show, for the first time, how
many slots today's scan would make **dearer**. That number decides how urgent the
blocking prerequisite above really is — and it costs one run to find out.
