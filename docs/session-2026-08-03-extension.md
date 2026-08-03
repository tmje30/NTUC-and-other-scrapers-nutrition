# Session handover — Chrome extension, 2026-08-02 → 03

What this session built, what broke, and what is still unproven. For picking the
work up cold. The living project doc is `HANDOVER.md`; this is the story of one
session, kept because most of it is *why*, which a diff can't tell you.

---

## What was asked for

A Chrome extension modelled on the sibling *Inventory Price Upkeeper* extension
(`C:\Users\newuser\Claude\Inventory Price upkeeper worker [Notion]\extension`),
"functioning identically", with these exceptions:

- no ABV, no SKU / product no.
- Supplier renamed to **Vendor** (same behaviour)
- no Unverified / verified workflow or buttons
- an **Add to Ingredients** button (new row), and a **Replace With This** button
  beside each similar existing item
- `Name` stays generic, the shop's full title + brand goes to `Items Exact Name`
  ("Malaysia Round Cabbage" → Name "Round Cabbage")
- rows land in the **Ingredients** DB with the right Category, Unit type, and
  `Vendor, Current`

Later in the session: renamed to **Nutrition Plan Extension**, and a
`Don't Search` tag was added to Notion for the scraper.

---

## What shipped

| commit | what |
|---|---|
| `6907094` | the extension itself |
| `e14eee1` | rename to Nutrition Plan Extension |
| `27f9cd9` | read the product the page is SHOWING, not the first in the blob |
| `cb83ce5` | survive stale `__NEXT_DATA__` and malformed JSON-LD |
| `bde2007` | round prices to 2 dp |
| `0ad45e6` | repair the SECOND way FairPrice's JSON-LD is invalid |
| `5d28485` | **read the source that works, instead of repairing the one that doesn't** |
| `b0f67ca` | make Sheng Siong work by asking its own app |
| `5ead3c1` | HANDOVER refresh + `.gitignore` hardening |

Plus, earlier the same session and unrelated to the extension: `88f462f`
(`Don't Search` tag honoured permanently).

New shared modules in `src/core/`, imported by the extension rather than copied:
`generic-name.ts`, `categorize.ts`, `ingredients-schema.ts`.
`npm run ext:build` bundles it (esbuild, added as an explicit devDependency).

---

## The four extraction bugs, and what they were really about

This is the part worth reading. Each was reported as a small UI symptom; none of
them was.

**1. "the price is not matching"** — it had captured a *different product*.
`__NEXT_DATA__` on a FairPrice page also carries the recommendations carousel;
the reader took the first product-shaped object it found. Measured on the
Vegeponics lettuce page: **17 product objects, all recommendations, none matching
the page's own URL** — the real product was skipped because only carousel entries
carry `final_price`. Fixed by anchoring on the URL slug and refusing to guess.

**2. "now there is no price"** — two independent faults at once. `__NEXT_DATA__`
**goes stale**: Next.js does not rewrite it on an in-site navigation, so browsing
a category and clicking a product leaves the *category's* blob in the DOM. The
slug guard from (1) correctly refused it — and the JSON-LD fallback then failed
because FairPrice's JSON-LD has **a stray closing brace**.

**3. "why did happen again?"** — same symptom, different malformation: **raw
newlines inside a string**, the importer's postal address pasted into
`description`.

**4. "can you shorten down the decimal placings"** — `7.949999999999999`. Not our
arithmetic: FairPrice's own `final_price` ships binary-float artefacts
(`7.029999999999999`, `5.869999999999999`). Rounded on every path now, and again
in `background.js` as the last gate before Notion.

### Then: "figure out why malformations happen, and an overall fix"

The right question, and the answer changed the design. Measured **40 product
pages across 8 categories**:

| source | valid JSON | slug matches | has a price |
| --- | --- | --- | --- |
| product **JSON-LD** | **0 / 40** | — | — |
| **`__NEXT_DATA__`** (server-rendered) | **40 / 40** | 40 / 40 | 40 / 40 |

The stray brace was on **12 of 12** pages inspected byte-by-byte — always
present, always identical, so it is in the **template**, not the data. Root
cause: **that JSON-LD is built by string concatenation, not `JSON.stringify`.**
Both symptoms follow from that; neither is possible with a serializer. Which is
why patching it never ended.

So the fix was architectural: **stop using it.** A content script is same-origin
with its page, so when the inline blob is stale it simply **re-fetches
`location.href`** and reads that HTML's `__NEXT_DATA__`. Result over the same 40
pages: reached by clicking → 40/40 complete, one request each (~450–1100 ms);
opened directly → 40/40 complete, **zero** extra requests.

**Lesson: count before patching.** A source failing 5 % of the time is worth
repairing; one failing 100 % of the time is worth replacing — and you cannot tell
which you have without measuring.

---

## Sheng Siong — a completely different problem

Never tested until asked directly, and it publishes **nothing** readable: no
JSON-LD, no product meta tags, no server-rendered data, not even an `<h1>`, and
the same site-wide `<title>` on every page. The old code would have filled the
Name box with the shop's slogan and left price and size blank.

Fix: ask the page's **own Meteor app** via `Products.getOneByIdOrSlug` — the same
method the daily scraper uses. The page already holds an open, Incapsula-cleared
connection, so this costs no new network trust and returns a numeric `netWeight`.

Lives in `flow.js`, not `content.js`, because a content script runs in an
**isolated world** and cannot see `window.Meteor`; `world: "MAIN"` is the way in.
`netWeight` is always grams, so the **unit** comes from `packSize` — otherwise a
`12 x 1 L` carton of milk files itself as 12000 By Gram.

---

## What is verified, and what is not

**Verified**

- FairPrice: 40/40 pages complete, stale and direct, running the *built* bundle.
- Sheng Siong: 6 products complete; the unit rule checked across a 12×1 L carton,
  a 4×300 ml drink, 6×10 g cubes, a 26 ml colouring and a 1 kg flour.
- Both writes against the **live** Ingredients DB: create, the URL duplicate
  check, and replace (tested by replacing the row the add had just created, so no
  curated row was touched — that row has since been moved to Notion's trash).
- Schema safety: an invented `Catagory` value is **refused**, not written.
- Round trip: `7.949999999999999` / `1499.9999999999998` stored as `7.95` / `1500`.

**NOT verified — the real open item**

**Nobody has used the extension for a genuine capture.** Every check above ran
through Node harnesses and browser probes. That proves the logic, not the
experience. First real use is the outstanding test.

**Known quirks, neither a bug**

- A Sheng Siong egg carton reads `550 g / By Gram`: they record the piece count in
  the NAME ("Fresh Eggs (10s)"), not in `packSize`. Change the dropdown by hand.
- When a shop's brand field doesn't appear in its own title (`T.Valley` vs
  "Tamar Valley Dairy"), the generic-name stripper can't match them, so the Name
  box keeps the full title.

---

## Decisions taken, worth knowing

- **Replace also updates `Items Exact Name`**, which wasn't in the spec. The row
  describes a different physical product afterwards; leaving the old exact name
  would mislabel it. Flagged at the time, easy to reverse.
- **It writes `Vendor 1 URL`**, also not in the spec — that is what makes the
  duplicate check possible.
- **No AI, no PDF/list mode.** The reference extension's four Haiku helpers exist
  for a Danish drinks catalogue; this naming rule is deterministic and needs no
  API key, matching `parse.ts`'s "no LLM" house rule.
- **The generic-name stripper is deliberately conservative** — it removes only a
  known brand, a country of origin, and a pack size. Origin words are country
  NOUNS only, which is what keeps "China Chinese Cabbage" → "Chinese Cabbage".

---

## Working notes

- A **parallel session** was editing this repo throughout (the correction menu /
  exclusions feature). Commits were kept strictly separate; at one point
  `CHANGELOG.md` had to be dropped from a commit because it had picked up the
  other session's prose. If two sessions run again, check `git status` before
  staging and stage by path, never `-A`.
- The `Don't Search` option was first created in Notion as **`Don'r Search`** (an
  `r`) and renamed the same day. Both spellings are kept in `DONT_SEARCH_TAGS`
  and comparison goes through `normTag()`, because a suppression tag that
  silently stops matching fails in the direction the user notices last.
- Verified afterwards across every Ingredients row: **only** tagged rows are
  skipped. Everything untagged with a usable price is searched; the other
  exclusions are supplements/filler (category) and rows with no price at all.
