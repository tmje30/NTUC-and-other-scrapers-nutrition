# `$399.00/kg` for a box of eggs — a piece count read as grams

**2026-08-11.** Written as a hand-off because a second session hit the same thing
independently. Read this before touching anything that turns
`Price [Vendor n] / Size[Vendor n]` into a price per kilo.

## The one-line version

`Size[Vendor n]` holds **whatever `Unit type ` says it holds** — grams,
millilitres, *or a count of eggs*. Divide by it as though it were always grams
and a `By Unit` row produces a number that is off by a factor of a hundred-odd
and still looks like a price.

## What was seen

`egg (Omega 3 Enriched) (550g)` reached the grocery List on 2026-08-10 with

```
Price per kg/L = $399.00/kg
```

It is a **$3.99 box of ten**. The sum was `3.99 ÷ 10 × 1000 = 399` — which is the
honest price of **a thousand eggs**, wearing a "/kg" label.

## ⚠️ Notion's own formula was never wrong

This is the trap the second session fell into too. There are two columns, in two
databases, and only one of them is this project's:

| where | column | showed | owner |
| --- | --- | --- | --- |
| **Ingredients** | `Cheapest Price/Kg ` | `3.99 /10 pc` | **Notion formula — correct.** It knows the row is counted and says so in the unit |
| **grocery List** | `Price per kg/L` | `$399.00/kg` | **this repo — wrong** |

If you are looking at `3.99 /10 pc` in Notion, nothing is broken. That is the
database telling you it is a counted row. **Check which column you are looking at
before diagnosing anything.**

## Why the guard did not fire

`pricePerKgLabelFor` in `list-intake.ts` carried this header:

> A `By Unit` row has no per-kg figure to give and correctly returns undefined
> rather than a fabricated one.

Its actual guard was `if (!row.price?.per1000) return undefined` — a falsy check,
which a count of `10` sails straight through. **The comment described the intent
and the code did the opposite**, and the comment is what everyone reads. Worth
remembering wherever a doc comment is the only thing asserting a rule; that is
what a test is for, and there is one now.

## The fix

Three answers were tried, in this order:

| | eggs, $3.99 for 10, `(550g)` in the row's name |
| --- | --- |
| divide by the count | ❌ `$399.00/kg` |
| refuse outright | ⚠️ blank, when the row plainly states 550 g |
| **divide by the weight** | ✅ **`$7.25/kg`** ← the user's call |

**`packWeightOf()` in `src/core/notion.ts` is now the single rule** for what a
pack weighs:

```
By Gram / By ml  →  Size[Vendor n] itself
By Unit          →  a size in the row's Name — "(550g)"
                 →  else a size in the CHEAPEST slot's Item Name [Vendor n]
                 →  else null
```

⚠️ **Null is a real answer, not a gap.** A razor cartridge, a tissue roll and a
stock cube have no meaningful weight and want none invented. Those quote **per
piece** instead — `$0.40/pc` — which is the figure you use at the shelf between a
box of 10 and a box of 30, and is the same conclusion Notion reaches with
`3.99 /10 pc`.

⚠️ **Only the cheapest slot's item name is read, never another slot's.** This
weight divides *that* slot's price, and the slots describe different packs at
different shops. Borrowing Guardian's 550 g to divide FairPrice's price invents a
figure that is no shop's.

Both readers now call it — `readGroceryTargets` for the deal comparison and
`readIngredientRows` for the texted list — because a rule this quiet, implemented
twice, drifts. `parseWeightInText()` in `stores/weight.ts` does the reading, with
the word boundary `parseWeight` lacks: that one's unit list ends in a bare `l`, so
on free text **"2 large" parses as two litres**.

Verified against the live DB, all 13 `By Unit` rows:

```
$7.25/kg    egg  (Omega 3 Enriched) (550g)      ← was $399.00/kg
$31.25/kg   Pu Erh (Tea bags) (100 x 2g)
$62.50/kg   Green Tea (50 x 2g)
$4.00/kg    Bread, Wholemeal, [FairPrice] (600g)
$4.28/pc    Razor Cartridge Refill - Hydro 5 [Schick]
$0.70/pc    Bathroom Tissue Roll - 4 Ply
$0.38/pc    Stock cubes [Knorr]
$0.21/pc    Eggs, Whole, small, {cheap}
```

Commits `9389db0` (stop the wrong number) and `3c5b295` (quote the right one).
`src/tests/intake-candidates.test.ts` → "a piece count is not a weight".

## ⚠️ Still open — two more places, both in `vendor-scan.ts`

**Left alone deliberately: another session is editing that file.** Whoever owns
it should take these.

`pricePer1000(price, size)` in `vendor-slots.ts` is **not** the bug. Its own
header is careful — "per kg, per litre, **or per 1000 pieces**, whichever the
row's `Unit type ` means" — and comparing slots *within one row* is valid, since
every slot on a row shares a unit type. That is what `chooseVendorSlot` and
`cheapestVendorSlot` use it for, correctly. The bug is only ever in **labelling
its output "/kg", or mixing it with a real per-100g figure**. Both happen here:

1. **`referencePer100g()` (`src/core/vendor-scan.ts:398`) — a real fault, not
   cosmetic.** It does `pricePer1000(...) / 10` and calls the result a price per
   100 g. On the eggs row that is `$39.90/100g` against a true `$0.73/100g` —
   **55× too high**. It feeds
   `floor = reference * MIN_FRACTION_OF_KNOWN_PRICE`, and every genuine listing
   then falls *below* that floor and is discarded as counterfeit, with a message
   quoting the nonsense reference back. So a counted row silently yields **no
   vendor prices at all**, and the reason it prints looks authoritative.
   ⚠️ This matters more as of today: the same session added **NTUC and Sheng
   Siong** to `ROUTES`, so `vendor-scan` is about to run against far more rows,
   counted ones included.
   The fix is `packWeightOf(...)` — the row's `Name` and `Unit type ` are both to
   hand where the slots are read.

2. **`slotLabel()` (`src/scripts/vendor-scan.ts:59`) — cosmetic but misleading.**
   It prints `(${money(per)}/kg)` unconditionally, so the CLI report will show
   `$399.00/kg` for the eggs row. Report-only, writes nothing, but it is the
   number a human reads while deciding whether the scan is behaving.

## What was NOT affected

- **The price book itself.** `$3.99 / 10` in Notion is correct and always was.
- **The deals page comparison.** `readGroceryTargets` has always used
  `packWeightG` (the `(600g)`-in-the-name machinery) rather than dividing by a
  count — that is what the whole By-Unit weight rule exists for.
- **Every other grocery-List row.** They are `By Gram`/`By ml`, where `size`
  genuinely is grams or millilitres.

⚠️ **The `$399.00/kg` already written to the list is still there.** The fix stops
new ones; it does not rewrite history.
