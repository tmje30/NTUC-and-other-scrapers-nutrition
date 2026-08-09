# Session handover — the price book replaces the baseline, 2026-08-09

What this session changed, what it found already broken, and what is still
unproven. For picking the work up cold. The living project doc is `HANDOVER.md`;
this is the story of one session, kept because most of it is *why*, which a diff
can't tell you.

---

## What was asked for

Four button behaviours, stated by the user:

**Discount (deals) page — `Add`**
- if `Vendor 1` is empty, tag it with the vendor for this site; if full, `Vendor 2`;
  if that's full, move up n
- write price, size and URL into `Price [Vendor n]`, `Size [Vendor n]`, `URL [Vendor n]`
- add 1 to `Amount`

**Discount page — `Replace`**
- a vendor already tagged in `Vendor n` → replace that slot's price/size/URL
- a new vendor with a free slot → tag it and fill it
- all slots taken → replace the vendor with the **highest** `Price / Size * 1000`,
  if this price per kg/L is lower

**Chrome extension — `Add to Ingredients` and `Replacing with this`** — identical rules.

And, twice, emphatically: **don't write prices into `Price, SGD` or weights into
`Weight /Units of New Product `.**

Follow-ups during the session:
- `Size of Cheapest Vendor` was added in Notion mid-session, reviving `Price per 100g `
- counted packs: a 30-egg tray should be `Size[Vendor n] = 30`, `Unit type = By Unit`,
  with the tray's weight in the **Name**, used for discovery so 30 quail eggs can be
  judged against 10 hen's eggs
- confirmed: a size in the name must **not** restrict the search — price per kg/unit
  is what matters, not an exact package match

---

## The thing that made this bigger than four buttons

The instruction "don't write to `Price,SGD`" was not a preference — it was a
consequence. The user had already restructured the Ingredients DB by hand:

| column | state as at 2026-08-09 |
| --- | --- |
| `Price,SGD` | **deleted** |
| `Weight /Units of New Product ` | renamed `… - Delete? `, then replaced by a **formula** `Size of Cheapest Vendor` |
| `Vendor, Current ` | renamed `Vendor, Current - Delete?`, empty on every row |
| `Price,SGD [Cheapest]`, `Cheapest Price/Kg `, `Cheapest Vendor ` | **formulas over the price book** |

So the price book is no longer "where else you can buy it" — it is the **only**
record of any price, and the baseline is derived from it. Everything that still
read the old columns was reading nothing, and `?? 0` was turning that into $0.

**Three silent, total failures were already live before this session started.**
None of them errored, and none was reported by anyone:

1. **The daily scan found ZERO targets.** `readGroceryTargets()` read `Price,SGD`
   and `Weight /Units…`; both returned null, `?? 0` made $0, and the
   `packPriceSgd <= 0` guard then dropped every row in the database. Measured after
   the fix: **0 → 26** plan targets.
2. **`Price per 100g ` read 0 on every row** — it was built on the retired columns.
   It was the weight baseline for every By-Gram ingredient, so every one priced at
   $0 per 100 g, which reads as "every deal is a loss".
3. **The Chrome extension refused every capture.** `REQUIRED_ING_PROPS` listed three
   columns that no longer existed, so `setupCheck()` failed on all three and blocked
   the write before it started. Also `findByUrl` searched `Vendor 1 URL` (renamed to
   `URL [Vendor 1]`), so the duplicate check silently returned null for every page.

⚠️ **The lesson worth carrying:** this project reads a Notion database the user
edits by hand, and a renamed column is indistinguishable from an empty one. Every
one of these failures was a *read* returning null, not an error. Any future reader
of a hand-maintained column should treat "all rows null" as a schema alarm, not as
data.

---

## What shipped

One commit: **`4089953` — price book: Add and Replace write a Vendor n slot.**

### The new core — `src/core/vendor-slots.ts`

Pure functions, no Notion client, **bundled into the Chrome extension by esbuild**
so the Node writers and the browser share one implementation of the rules rather
than two copies that drift.

⚠️ **Column names are resolved from the LIVE schema, never hardcoded.** The real
names are irregular in ways that are invisible in a diff:

```
Price [Vendor 1]      Price [Vendor 2]      ← trailing space on 2, not on 1
Size[Vendor 1]        Size[Vendor 2]        ← no space after "Size"
URL [Vendor 1] … URL [Vendor 4]             ← renamed from "Vendor n URL"
```

Sixteen names, four irregular. A mistyped property is not an error in Notion — it
is a value that never arrives.

### The rules, as implemented

```
Add     → first slot with nothing in it, tagged with the shop. NEVER evicts.
Replace → 1. the slot already tagged with this shop  → replace its price/size/URL
          2. else the first slot with nothing in it  → tag it and fill it
          3. else the slot with the highest Price/Size*1000 gives way,
             and ONLY if this product is cheaper per kg.
             Otherwise nothing is written and the reply says why.
```

⚠️ **"Nothing in it" means vendor, price, size AND url all empty.** Two live shapes
depend on this: a slot tagged `Sheng Siong` with no price is *that shop's slot* (the
commonest shape in the DB — the user's "also look here" intent), and a price sitting
in an *untagged* slot is still a real price. Neither is free space.

⚠️ **`Vendor n` is a SELECT.** A shop with no existing option is reported and
dropped — writing it would make Notion invent an option, a schema edit to a live
personal workspace. Live options: NTUC, Sheng Siong, Watsons, Guardian, Carousell,
Shopee, Iherb, Google Search, My Protein. **Cold Storage, Giant, RedMart, Lazada and
Amazon SG have none** — capture still writes the row, names the shop, skips the price.

### Everything else

- **The scan's baseline** is now the cheapest slot: lowest `Price [Vendor n] /
  Size[Vendor n] * 1000`. Computed locally rather than read from
  `Price,SGD [Cheapest]` because the scan needs price + size + **vendor** from the
  *same* slot, and three separate formulas can only agree by luck.
  Verified equal to Notion's own formulas on **95 of 95 live rows**.
- **`Buy` counts.** Grocery-list `Amount ` = 1 on a new row, **+1** on each further
  tap of a row still outstanding. Read-then-add, so an Amount set by hand is added
  to, never overwritten. The one-row-per-listing dedupe is unchanged.
- **Counted packs** write their piece count (30-egg tray → `Size[Vendor n] = 30`,
  `By Unit`). ⚠️ A published **weight still wins** — `10 x 100ml` carries a count of
  10 *and* 1000 ml, and taking the count first files a litre of milk as ten units.
- **`parseName` accepts a comma-stated pack weight** — `Egg tray, 350g` — as well as
  `(350g)`. The comma form was silently dropped before. Parentheses win if both.
- **Deals-page Replace now writes the URL**, which it deliberately didn't before.
  The old reason (`Vendor 1 URL` belonging to whatever shop `Vendor 1` named) is
  gone: it now goes to `URL [Vendor n]` for the slot naming *this* shop. That also
  fixes the misfile logged in `docs/vendor-scoping.md`.
- **A capture with no readable size no longer asserts `Unit type = By Gram`.** It
  defaulted to that, so a Replace on a By-Unit egg row would silently flip it and
  leave piece counts read as grams. Now that `Unit type ` is what says whether
  `Size[Vendor n]` is grams or pieces, that default was actively dangerous.

---

## ⚠️ The bug the unit tests did not catch

334 offline tests passed. A live write then produced this:

```
Replaced: ZZ TEST DELETE ME now records $1.00 for 500g from Cold Storage.
```

…while correctly writing **nothing** to the price book. The caller asked *"were any
properties written?"* — and a refused replace still writes `Unit type `, so the
answer was yes.

**A button that reports a write it did not make is worse than one that fails
loudly**, because nothing prompts anyone to check. Fixed at the source: every
refusal now returns a `none` **decision** rather than a null one, so the caller
tests one field — *did the price book take it?* — instead of counting properties.
`null` now means exactly one thing: no shop was supplied, nothing was attempted.

The regression test lives at the layer where the bug was reachable
(`vendorSlotProps`, exported for this), **not** on `chooseVendorSlot` — an
unrecognised shop never reaches the chooser, because `matchVendorOption` refuses it
first. My first attempt tested the wrong layer and passed vacuously.

**Carry this forward: the offline suite cannot see the reporting path.** Anything
that changes what a button *says* needs a live write to verify.

---

## What was verified, and how

| | how |
| --- | --- |
| slot rules | 334 offline tests, incl. the real column spellings |
| baseline reader | **95/95** live rows agree with Notion's own formulas |
| the scan | 0 → **26** plan targets |
| Add | live write — `Vendor 1` free → tagged and filled |
| Replace, same shop | live — updated its own slot in place |
| Replace, new shop ×3 | live — filled slots 2, 3, 4 |
| Replace, dearer | live — **refused**, $20/kg vs the worst at $18/kg |
| Replace, cheaper | live — **evicted** Sheng Siong, the dearest |
| Replace, unknown shop | live — refused, and (after the fix) says so honestly |
| Notion formulas | picked up every write: `Cheapest Vendor`, `Price per 100g ` etc. |
| a size in the name never filters | a `(300g)` row matched a 10-pack **and** a 30-pack; winner chosen per kg |

The test row (`ZZ TEST DELETE ME Rolled Oats`) was created for this and **trashed at
the end of the session** — it is in Notion's 30-day trash, not in the database.

---

## Still unproven / outstanding

1. **No scan has run end-to-end since the fix.** `plan-targets` reads 26 targets, but
   the full `npm start` → scrape → page → Telegram path has not been exercised. The
   06:00 SGT job is the next thing to run it. **This is the highest-value next check.**
2. **The extension's writes were never live-tested.** Its Node twin was, and they
   share `vendor-slots.ts`, but `extension/notion-client.js` has its own `slotProps`
   wrapper and its own `findByUrl`. ⚠️ **Reload the unpacked extension at
   `chrome://extensions`** — the bundle changed and Chrome will keep serving the old one.
3. **Five By-Unit rows state no pack weight in their `Name`**, so they can only be
   compared per piece — and a smaller piece always wins on price. See `HANDOVER.md`
   item 0 for the table. `Eggs, Whole, small, {cheap}` is the one that matters (it is
   the quail-egg exposure); the razor/tissue/soup-cube rows matter much less.
   **This is a Notion edit, not code.**
4. **The eviction path has never fired on a real row** — no live ingredient has four
   priced slots yet. It is covered by unit tests and by the throwaway row only.
5. **The `Amount ` +1 was never live-tested.** It is unit-tested at the
   schema-resolution level (`Amount ` is found, is not confused with either price
   column), but no Buy has been pressed since the change.
6. `CLAUDE.md` has a large uncommitted deletion that predates this session, and
   `.claude/skills/notion-workers-sdk/` is untracked. **Both were deliberately left
   alone** — they are not this session's work.

---

## Files worth reading first

| file | why |
| --- | --- |
| `src/core/vendor-slots.ts` | the rules, and every ⚠️ that motivates them |
| `src/tests/vendor-slots.test.ts` | the failure modes, each one named after the bug it prevents |
| `src/core/notion.ts` → `readBaseline()` | why the scan computes rather than reads |
| `src/core/ingredient-write.ts` → `vendorSlotProps()` | the write path, and the reporting bug |
| `SYSTEM-GUIDE.md` → "Counted packs" | the egg-tray rule and the 2.5× piece-ratio guard |
| `docs/vendor-scoping.md` | ⚠️ partly superseded — its routing advice stands, its column inventory does not |
