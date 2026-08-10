# Session handover — Buy writes price/kg and links Ingredients directly, 2026-08-09

What this session changed and why. For picking the work up cold. The living
project doc is `HANDOVER.md`; this is the story of one session.

---

## What was asked for

Two changes to the **Buy** button on the deals page (`src/core/site.ts` →
`addButton()` / `addPayload()`, written by `.github/workflows/add-to-list.yml`
→ `src/scripts/add-to-list.ts` → `addToGroceryList()` in
`src/core/grocery-list.ts`):

1. Write the discount listing's own **price per kg/L** into the grocery-List
   row, taken from the discount page — not recomputed elsewhere.
2. Stop relying on the fuzzy "closest item" match alone to say which
   Ingredients row a Buy is for — **link the row directly** to the exact
   Ingredients page, using the relation the Notion schema already has for
   this: `List [Ingredients]`.

⚠️ The user was explicit: **do not create a new Ingredients item.** The
relation must point at the page the deals-page matcher (`match.ts`) already
picked at build time — `AddPayload.ingredientId` — never a fresh page.

A third instruction arrived alongside these: the row's `Name` should read
`Ingredient (size) [Brand]` — e.g. `Fish sauce (200ml) [Knife brand]` —
replacing the old comma-joined `Ingredient, Brand, size`.

## What was already true, and what wasn't

The deals page has **two** buttons that both look like "add": **Buy** (writes
to the **grocery List** DB — the shopping list) and **Add** (writes to the
**Ingredients** DB's price book — see
[`session-2026-08-09-price-book.md`](session-2026-08-09-price-book.md)). This
session only touches Buy / grocery List.

Before this session, `AddPayload` already carried `ingredientId` — the deals
page's build-time match had already decided which Ingredients row a deal
belongs to (`match.ts`'s `evaluate()`), and both buttons already used it. What
was missing was **using that id to set an actual Notion relation** on the
grocery-List row, and **writing the $/kg figure anywhere at all**.

Checked live via `npm run introspect` before writing anything (per this
project's Notion-safety rule — never guess a schema, never invent a column).
The `grocery List` data source already had both fields, unused:

```
- Price per kg/L: rich_text     (blank on every existing row)
- List [Ingredients]: relation  (blank on every existing row)
```

So this was a data-write change, not a schema change.

## What changed

- **`src/core/grocery-list.ts`**
  - `ListProps` gained `pricePerKg` and `ingredientRelation`; `resolveListProps`
    finds them by keyword (`"kg/l"` / `"per kg"`, and `"ingredient"` on a
    `relation`-typed column) the same way every other column here is resolved
    — by type + normalised name, never a hardcoded string, because this DB's
    column names drift.
  - `groceryRowTitle()` rewritten to `Name (size) [Brand]`. The existing rule
    that a brand already stated in the ingredient's own name is not repeated
    still applies — confirmed live (see below): `"AM facial moisturizing
    lotion [cerave]"` + brand `"CeraVe"` does **not** produce a duplicate
    bracket.
  - `AddPayload` gained `pricePerKg?: string` — a pre-formatted label
    (`"$4.45/kg"`), computed once at page-build time so what gets written is
    exactly what the card showed, not a re-derivation with room to disagree.
  - `addToGroceryList()` writes both new fields **only when creating a new
    row** — the same rule price/vendor/amount already follow: a repeat tap
    that bumps `Amount` on an outstanding row does not rewrite data that's
    already there.
- **`src/core/site.ts`** — new `pricePerKgLabel()`, using the exact same
  numbers row 5 of the deal card already displays (`p.pricePer100g * 10`,
  unit from `p.volumetric`). Undefined for a piece-priced product (an egg
  carton has no $/kg to give) — nothing bogus is ever written.
- **`src/tests/grocery-list.test.ts`** — retargeted every title-format
  assertion at the new bracket shape, and added coverage for the two new
  resolved columns (found, distinguished from the `Vendor %` rich-text column,
  and null when absent).

## Verified live, then cleaned up

`npm run check` and `npm test` (338 cases) both pass. Beyond that, this was
tested against the **real** `grocery List` DB directly through
`addToGroceryList()` (bypassing `add-to-list.ts`'s cooldown/purchase-log
writes, which are local files a test run shouldn't touch), linked to a real
Ingredients page (the CereVe lotion row) so the result could be read back and
eyeballed:

| field | written |
| --- | --- |
| `Name` | `TEST — AM facial moisturizing lotion [cerave] (52ml)` |
| `Price per kg/L` | `$478.85/L` |
| `List [Ingredients]` | relation → the real CeraVe Ingredients page (confirmed: no new Ingredients page was created) |
| `Price , To Buy ` | 24.9 |
| `Vendor %` | NTUC |

Notion's own `Price D%/C` formula on that row picked the new figures up
immediately (`$478.85/L / 575 /L - NTUC`), confirming the relation is read by
the formulas that already depend on `List [Ingredients]`.

The test row was archived (`pages.update({archived: true})`) after the user
confirmed the title matched what was created — per the Notion-safety rule,
nothing is deleted without that confirmation.

## What's still unproven

This was tested by calling the write function directly, not by clicking Buy
on a live deployed page end to end (GitHub issue → `add-to-list.yml` →
Notion). The workflow path was unchanged by this session (same payload shape,
two new optional fields), so it should carry through unmodified, but nobody
has pressed the real button since this shipped.
