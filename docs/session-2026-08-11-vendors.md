# Watsons renders, then gets wiped — and four other things that looked like blocks

**2026-08-11.** A sweep of every vendor from the residential laptop. The headline is
that **a shop can serve you products and then take them away**, and that failure mode
is indistinguishable from a hard block unless you look for it.

## The one-line version

Watsons collected **two independent "dead end" verdicts** — 2026-08-05, and again by a
different session on 2026-08-11 — both saying a real browser renders only the footer and
the product API never yields. Both were honest observations. Both were wrong.

```
settle  4s →     0B    nothing rendered yet
settle  7s →  6285B    52 prices, 96 product links   ✓
settle 11s →  6610B    52 prices, 96 product links   ✓
settle 16s →  6603B    52 prices, 96 product links   ✓
settle 22s →   484B    wiped — footer only
```

An Akamai Bot Manager check tears the results down *after* they render. A fixed
`settleMs` therefore has to thread a window that **fails at both ends**, and too-early
and too-late produce the **identical** empty shell. Two people, two sessions, same wrong
conclusion, because the evidence for "never worked" and "you looked at the wrong moment"
is the same 500 bytes of footer.

⚠️ **The fix is not a tuned delay.** `evaluateInPage` gained `waitFor` (`browser-cdp.ts`):
poll an expression until truthy and read the moment the page is ready, leaving the danger
zone before the wipe arrives. `settleMs` became the give-up deadline rather than the plan.
A timeout still returns whatever is on the page — "we waited and it never came" is a
result the caller must see, not an exception to swallow.

## ⚠️ How I got Watsons wrong in the other direction first

Before the timing test, the probe's generic verdict counted `[class*="price" i]` nodes and
called any non-zero count "works". Watsons scored **54** while rendering nothing but its
footer — skeleton loaders and promo furniture match that selector. I reported it as
working, rewrote the repo's correct note as "wrong", and only caught it because 6603 B of
"rendered" text was within 40 B of the known-empty 6568 B shell.

So the probe now demands **prices containing a NUMBER *and* product links**, and reports
both counts. iHerb re-verified cleanly under the stricter rule (150 priced nodes, 144
product links, real titles); Watsons' footer-only state now correctly reads `no-data`.

**Do not re-open a shop on a node count alone.**

## What each vendor actually is

| shop | access | notes |
| --- | --- | --- |
| NTUC, Sheng Siong | cloud / laptop | working |
| **Watsons** | **laptop, headed** | renders then wipes — needs `waitFor` |
| **Iherb** | **laptop, headed** | plain fetch is 403 |
| Carousell | laptop, headed | headless renders zero cards |
| Shopee | laptop, headed, **signed in** | auth wall, session in `.sessions/chrome-shopee` |
| Guardian | — | **down**: Magento maintenance page on `/graphql`, their side |
| My Protein | cloud | already worked; the "no sizes" complaint was about the SEARCH page, and the module already fetches variants |
| Google Search | — | not a shop, cannot be a route |

⚠️ **Watsons, iHerb, Carousell and Shopee are all laptop-only** — headless is detected by
every one of them, so none can run in GitHub Actions.

⚠️ **Guardian is not blocking us.** `/graphql` returns Magento's own maintenance page
(503, `retry-after: 0`, body leaking an unparsed `<?php` header). The homepage returns 200
and 136 KB, which looks fine — but `x-cache: MISS, HIT` gives it away: the PWA shell is
served from CDN cache while the backend behind it is down. Nothing to fix; it will return.

## ⚠️ The comma that turned 1,500 g into 1.5 g

`marketplaceSize` treated **every** comma as a European decimal point:

```
"Whey Protein 1,500 g"   →  1.5 g      (a thousandfold error)
"…5 lb (2,268 g)"        →  refused    (5 lb vs 2.27 g "disagree")
```

Found because a real iHerb title was being *refused*: the multi-size guard saw 2268 g and
2.27 g disagree and correctly rejected the listing — **a correct refusal covering for a
wrong parse**, which is why it presented as a dropped product rather than a bug.

It matters well beyond one comparison: `vendor-scan` writes this number into
`Size[Vendor n]`, so a misread puts **1.5 where 1500 belongs in the price book**, and
every per-kilo figure derived from it is wrong afterwards.

`looseNumber` now reads a comma followed by exactly three digits as a separator, anything
else as the decimal comma the code was written for. `"1,5 kg"` still works.

⚠️ Known limit, left deliberately: a second comma group (`"1,234,567 g"`) is not handled.
A pack over ~100 kg does not exist in this catalogue, and widening the regex would give
every stray comma another route to becoming a size.

## iHerb: the capsule count IS the size

Two traps, in order:

1. **The dose is not the pack.** "Gold C®, USP Grade Vitamin C, **1,000 mg**, **240
   Veggie Capsules**" — reading the mg as a pack size prices a $22.98 bottle as a 1 g
   purchase. `marketplaceSize` already refuses these, so they are dropped, not guessed.
   ⚠️ **Do not "fix" this by multiplying dose × count.** 240 g of active ingredient is not
   a 240 g pack.

2. **Every Ingredients row tagged Iherb is `By Unit`**, priced per piece
   ($28.72 / 120 pcs). So the capsule count is the size, and `capsuleCount` extracts it —
   the number **adjacent to the piece word**, never the first in the title, or the
   1,000 mg dose becomes a 1,000-capsule count and the bottle looks four times cheaper.

⚠️ Without `unitCount`, `unitKindAgrees` **refuses** every candidate rather than
mismatching it — 0 candidates across all 5 rows, looking exactly like a shop with no
stock. A refusal and an empty catalogue read identically in the report.

## Still open

- **iHerb yields 0 candidates even now**, but for a different reason: the matcher sees the
  products and rejects them (`43 priced results, none matched`). Same for two Watsons
  toothpaste rows (23 and 28 real results, none matched). That is `evaluate()` being
  conservative about supplement and personal-care naming — **a matching problem, not a
  store problem**, and the next piece of work.
- **Shopee has a session but no module.** It is a marketplace, so it needs the full
  Carousell apparatus (`cheapestPlausible`, the price floor, seller reputation) plus
  scroll-and-settle for its lazy-loaded grid. Without the guards it files counterfeits as
  bargains.
- **`vendor-scan` is still not scheduled anywhere.** Not `daily.yml`, not Task Scheduler.
- The user runs a **Singapore VPN**, so the "residential" egress (M1, AS4773) is a rented
  shared exit. Everything above was measured through it. Worth an A/B with it off — that
  would separate the timing window from IP reputation, which is still not cleanly
  separated.
