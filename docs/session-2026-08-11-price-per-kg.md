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
By Unit          →  a size in that slot's Item Name [Vendor n] — the shop's wording
                 →  else a size in the row's general Name — "(550g)"
                 →  else null  →  quote per 10 pieces instead
```

⚠️ **The item name is asked FIRST** (order set by the user, 2026-08-11). It comes
from the same slot as the price and the size, so all three describe one pack at
one shop. The row's `Name` is global across all four slots — "Bread, Wholemeal
(600g)" stays 600 g while the cheapest slot moves between shops selling 400 g and
600 g loaves — which makes it the honest fallback rather than the first answer.
The two only ever disagree when both state a size.

⚠️ **Null is a real answer, not a gap.** A razor cartridge, a tissue roll and a
stock cube have no meaningful weight and want none invented. Those quote **per 10
pieces** instead — `$3.99/10 pc` — the figure you use at the shelf between a box
of 10 and a box of 30.

⚠️ **Ten, not one, and that is a deliberate match to Notion.** The
`Cheapest Price/Kg ` formula prints `4.2 /10 pc` on these rows, and the bot briefly
quoted `$0.42/pc` — the same number, scaled. **Two conventions for one figure,
living in two databases, is exactly where someone later assumes a factor of ten.**
`PIECES_PER_QUOTE` in `list-intake.ts` is the constant; change it only alongside
the Notion formula. Verified matching on the live DB: `Bread, Whole grain (Low GI)`
reads `$4.20/10 pc` here and `4.2 /10 pc` there.

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

## ✅ Both closed — the two places in `vendor-scan.ts` (2026-08-11, later same day)

**Done.** The session that owned `vendor-scan.ts` picked these up once it had
finished adding NTUC and Sheng Siong to `ROUTES`. Kept below because the *reasoning*
is what matters if either regresses, and because the second one is a standing trap
for anyone who prints a price in this project.

Verified on the live Sheng Siong report afterwards: `Sesame Oil` now reads
**`$10.08 / 2000ml = $5.04/L`** (was `/kg`), and `Green Tea (50 x 2g)` reads
**`$4.95 / 50 pcs = $49.50/kg`** — the row's own `(50 x 2g)` divided in, exactly as
`packWeightOf` intends — where it previously printed a per-thousand-pieces figure
labelled per kilo.

`pricePer1000(price, size)` in `vendor-slots.ts` is **not** the bug. Its own
header is careful — "per kg, per litre, **or per 1000 pieces**, whichever the
row's `Unit type ` means" — and comparing slots *within one row* is valid, since
every slot on a row shares a unit type. That is what `chooseVendorSlot` and
`cheapestVendorSlot` use it for, correctly. The bug is only ever in **labelling
its output "/kg", or mixing it with a real per-100g figure**. Both happen here:

1. **`referencePer100g()` (`src/core/vendor-scan.ts`) — a real fault, not
   cosmetic.** It did `pricePer1000(...) / 10` and called the result a price per
   100 g. On the eggs row that is `$39.90/100g` against a true `$0.73/100g` —
   **55× too high**. It feeds
   `floor = reference * MIN_FRACTION_OF_KNOWN_PRICE`, and every genuine listing
   then falls *below* that floor and is discarded as counterfeit, with a message
   quoting the nonsense reference back. So a counted row silently yielded **no
   vendor prices at all**, and the reason it printed looked authoritative.
   ⚠️ This mattered more as of that day: the same session added **NTUC and Sheng
   Siong** to `ROUTES`, so `vendor-scan` now runs against far more rows, counted
   ones included.
   **Fixed** — it takes the row (`unitType`, `name`) and divides by
   `packWeightOf(...)`, per slot, using **that slot's own** `Item Name`. A slot
   with no weighable pack contributes nothing rather than a guess, so a row with
   no weighable reference simply has no floor — the safe direction.

2. **`slotLabel()` (`src/scripts/vendor-scan.ts`) — cosmetic but misleading.**
   It printed `(${money(per)}/kg)` unconditionally, so the CLI report showed
   `$399.00/kg` for the eggs row. Report-only, writes nothing, but it is the
   number a human reads while deciding whether the scan is behaving.
   **Fixed** — one `perLabel()` helper now serves the slot label *and* the `✓`
   result line, so the two cannot drift: `packWeightOf` decides whether there is a
   weight to divide by, `By ml` says `/L` rather than `/kg`, and a counted pack
   with no stated weight quotes `$0.400/pc`.
   ⚠️ The `✓` line also stopped quoting the product's own `pricePer100g` and now
   quotes what will actually be **stored** (`Price [Vendor n]` ÷ `Size[Vendor n]`).
   On a By-Unit row those two disagree — the slot holds a count — and the report
   should show the figure Notion will show.

   ⚠️ While in there: `slotLabel` used to call a slot **"empty"** when its four data
   columns were blank, which reads backwards — `Vendor n` still names the shop, and
   that is precisely why the row is being scanned and why a write is an `update`
   rather than a refused `fill`. It now says **"tagged, no price yet"**.

## What was NOT affected

- **The price book itself.** `$3.99 / 10` in Notion is correct and always was.
- **The deals page comparison.** `readGroceryTargets` has always used
  `packWeightG` (the `(600g)`-in-the-name machinery) rather than dividing by a
  count — that is what the whole By-Unit weight rule exists for.
- **Every other grocery-List row.** They are `By Gram`/`By ml`, where `size`
  genuinely is grams or millilitres.

⚠️ **The `$399.00/kg` already written to the list is still there.** The fix stops
new ones; it does not rewrite history.
