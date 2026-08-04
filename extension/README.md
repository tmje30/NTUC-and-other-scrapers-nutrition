# Nutrition Plan Extension — Chrome extension

Capture a grocery product page into the Notion **Ingredients** DB. Internal tool (unpacked install, no Web
Store). Modelled on the sibling *Inventory Price Upkeeper* extension, with its verification workflow removed.

## What it does

Open it on a product page and it reads the name, brand, price and pack size, then offers **two** ways to
commit — and only ever the one you click:

- **Add to Ingredients** — creates a new row, with whatever nutrition is in the four boxes (the shop's own
  panel where it published one, otherwise whatever **Find Macros** or your own typing put there).
- **Replace With This** — appears beside **each** similar ingredient already in Notion. Repoints that row at
  this product.

Every field is editable before either write, so a bad read is a box you fix, never a wrong silent write.

## The naming rule

The shop's full title and the generic name are stored **separately**:

| Notion property | Gets | Example |
|---|---|---|
| `Name` (title) | the stripped-down, generic name | `Round Cabbage` |
| `Items Exact Name` | the shop's full title + brand | `Malaysia Round Cabbage` |

`src/core/generic-name.ts` does the stripping, deterministically (no LLM — the house rule from `parse.ts`).
It removes three classes of word and nothing else: a **known brand** (the page's own brand field, plus SG
house labels like `Pasar`), a **country of origin**, and a **pack size**.

It is deliberately conservative, because keeping a word costs one edit while deleting a meaningful one loses
information the user has to *notice* to fix. Two consequences worth knowing:

- The origin list holds country **nouns only**, which is what makes it safe: `\bchina\b` cannot match
  "Chinese", so `China Chinese Cabbage` → `Chinese Cabbage`, not `Cabbage`.
- Words that name a variety at least as often as an origin are left out on purpose: `Thai` (Thai Red Rice),
  `Holland` (Holland Potatoes), `English`, `Chinese`, `Japanese`, `Korean`.

## What else gets written

| Property | From |
|---|---|
| `Price,SGD` | the page price |
| `Weight /Units of New Product ` | the pack size — grams, ml, or a piece count |
| `Unit type ` | what that size **is**: `By Gram` / `By ml` / `By Unit` |
| `Catagory` | keyword guess (`src/core/categorize.ts`), matched to a **live** option |
| `Vendor, Current ` | the shop (`fairprice.com.sg` → `NTUC`) |
| `Vendor 1 URL` | the product page, so a re-visit is recognised as already added |

**Replace** writes the same fields except the URL, and touches **nothing else** — nutrition figures, plan
formulas, `Select` tags and relations are the user's own work and have nothing to do with which shop a price
came from. It includes `Items Exact Name` on purpose: the row now describes a different physical product, so
leaving the old exact name would label it as something it is not.

## Nutrition

The Ingredients DB carries four per-100g columns — `Protein per 100g`, `Fats per 100 g `, `Carbs per 100g `,
`Fiber per 100g ` — and a stack of formulas on top of them (cost per 100g protein, calories, the plan sums).
A row added without them silently breaks those formulas, so **Add to Ingredients** fills them in.

The form shows the four side by side, per 100g, above the Add button:

```text
Per 100g
  Protein     Carbs      Fats      Fiber
   11.43       68        9.14      10.57
```

**They fill themselves in from the shop's own panel where there is one, and are left blank where there
isn't.** Filled boxes are written as-is and cost nothing. Blank boxes **stay blank** unless you press
**Find Macros**, which is the only thing here that spends money. Every box is editable either way, so a
figure you disagree with is one you overtype — and whatever ends up in them is what Add writes.

### Reading the shop's panel (free, no API key)

FairPrice ships a `Nutritional Data` field — the packaging's own table — in the product payload. When it's
there the boxes fill immediately, marked green with the serving they were scaled from.

⚠️ **It is always *per serving*, never per 100g.** Measured servings: 32 g, 35 g, 236 ml, 100 g. So
`nutrition-panel.ts` scales every figure, and refuses the panel outright when the serving size isn't stated —
a 32 g peanut-butter serving read as 100 g is wrong by a factor of three, in the direction that looks fine.

Measured 2026-08-03 over 16 products, **4 had a usable panel**. The split is the useful part: the hits were
packaged goods (oats, yoghurt, instant noodles, canned tuna) and **every fresh item missed** — chicken
breast, salmon, broccoli, bananas, eggs, tofu. Which is exactly where the lookup below earns its keep.

⚠️ **Never search the page for a nutrition table.** The payload carries the recommendations carousel too. On
the Skippy Peanut Butter page the product's own object has *no* panel while four rival peanut butters do, so
a first-match search returns a competitor's label as this product's — plausible, and silently wrong. The
panel is read off the same slug-anchored object as the name and price, and nowhere else.

### Looking it up — press **Find Macros** (needs a Claude API key)

⚠️ **This never happens on its own.** Until 2026-08-04 an empty set of boxes triggered a lookup
automatically once the row was written, and patched the figures in behind you — so an ordinary Add could
quietly spend up to 29 cents on numbers nobody asked for and nobody read. Now there is a **Find Macros**
button under the four boxes, and pressing it is the only way this extension spends anything.

It appears only when it would do something: the page published **no** free panel, and a key is set. Where
the shop did publish one the boxes are already filled and green, and paying for an answer you have would be
daft.

**It fills the BOXES, not the row.** That ordering is the point — the figures land where you can read them,
overtype them or clear them, and only then does Add write them, with the row, for free. The source line is
right there while you decide, which is what makes a `generic` answer easy to reject. Press it again and it
re-asks; the button reads "Find again" afterwards.

Three tiers, tried in order, and the one used is always reported:

| tier | means |
|---|---|
| `product-page` | the nutrition panel on the page you were already looking at — including the one photographed on the back of the pack |
| `search` | the same product's panel, found elsewhere |
| `generic` | representative values for that **food**, when the exact product can't be pinned down |

Generic values are flagged with a ⚠️ in the panel, because they are a category average rather than this
product's own label.

**The state of the food decides the numbers**, and it is written on the label, not in the food name: raw
chicken is not roast chicken, dry pasta is not boiled pasta, and the difference is a factor of two or three
on every column. That rule is the bulk of the prompt, and it is why a wrong-state answer is treated as worse
than no answer — nothing missing is visible, a wrong number is not.

Rejected outright: a reply with no figures, and one whose protein + fat + carbs exceeds ~100 g per 100 g
(which means per-serving figures got reported as per-100g — the single likeliest failure, and the easiest to
catch). Either way the row keeps its price and size and the panel says to fill the columns in by hand.

**How long it takes:** about 5 s when there is a back-of-pack photo to read, 10–30 s when the model has to
go and find the label. The note under the boxes says which wait you are in for *before* you press, using
`packShotsFor` — the same function the worker gates on, imported rather than re-implemented, so the panel
can never promise a path the lookup won't take.

⚠️ Those strings must never say "when you add". Nothing is looked up on Add any more, and a note promising
figures that then don't appear is how a user stops trusting the panel.

The whole feature is off if no key is set: the button doesn't appear, and rows add exactly as they did
before nutrition existed.

⚠️ **Cost, measured 2026-08-04 over four real lookups: US$0.29–0.41 each**, not the 6–7 cents first
estimated. The model rate is not where it goes — input was **123k–280k tokens per call**, about 90% of the
bill, because `web_fetch` drops the entire product page into context (a FairPrice page is 340–390 KB of
HTML). Two web searches came to 2 cents of a 41-cent call.

| product | variant | input tok | searches | secs | tier | cost |
|---|---|--:|--:|--:|---|--:|
| Skippy Peanut Butter | text only | 123,389 | 2 | 54 | search | $0.29 |
| Skippy Peanut Butter | + 2 pack shots | 13,885 | 0 | 8 | **product-page** | **$0.03** |
| Seara Chicken Thigh | text only | 189,271 | 2 | 34 | search | $0.41 |
| Seara Chicken Thigh | + 2 pack shots | 280,409 | 2 | 66 | generic | $0.60 |

**Pack-shot images cut the packaged-goods case 10×** — the model read the label off the back of the jar,
answered in 8 s with no search at all, and landed on the `product-page` tier. Repeated on a second run:
$0.0314, 8 s, same tier, same answer. That is the one robust result here, and it is now how the extension
works — see below.

⚠️ **`max_content_tokens` on web_fetch does not fix the bill — measured, don't retry it.** Capping the
fetch at 8k moved Skippy −25% but Seara **+27%**: starved of page text the model simply searches more, and
search results are large too.

⚠️ **Single measurements here are noisy — treat anything under ~30% as nothing.** Identical configs rerun
a day apart gave 123k then 93k input tokens (Skippy) and 189k then 236k (Seara).

### Fresh commodities skip the search entirely

Every Seara variant above cost $0.38–0.60 and still landed on `generic` — the model searched, found no
label, and answered from its own knowledge anyway. The four runs also disagreed: 16.6, 16.7, 17 and **24.8**
g protein per 100 g for raw chicken thigh, where ~17–18 is right.

So `isCommodityFood()` now sends **no tools at all** for those, and the model answers directly:

| product | before | after | speed | answer |
|---|--:|--:|--:|---|
| Seara Frozen Chicken Thigh | $0.41 | **$0.0030** | 34s → 2.5s | 17.0 g protein — correct |
| Agro Fresh Broccoli | $0.081 | **$0.0027** | 17.7s → 2.2s | unchanged (2.8 / 0.4 / 7.0 / 2.6) |

**137× and 30× cheaper, and the chicken answer got *better*** — it no longer produces the 24.8 g outlier.

The gate is deliberately narrow, because "no label" isn't the same as the category: fresh chicken and a tub
of Greek yoghurt are both `protein`, but the yoghurt is branded and its panel is findable, so it keeps its
tools. Only two cases qualify — the `produce` category, or a meat/fish/egg word **with** an explicit
`fresh|frozen|chilled|raw|live` state. Requiring the state word is what keeps "FairPrice Tuna Flakes - In
Water" on the full lookup. 25 classification cases are covered by tests.

Figures read off the page go in **with** the row instead — one write, no window where the row exists without
its nutrition, and no charge.

`Replace With This` deliberately does **not** do this: that row's nutrition is the user's own work.

### Reading the label off the shop's pack shots (added 2026-08-04)

For everything left on the paid path, the lookup is now handed **the shop's own back-of-pack photograph**
instead of being sent to find the label on the web. It reads the panel off the jar and stops:

| | text only | + back-of-pack shot |
|---|--:|--:|
| Skippy Peanut Butter | $0.2877, 54 s, 2 searches, `search` tier | **$0.0239, 5.2 s, 0 searches, `product-page` tier** |

Same answer, 22.8 g protein — right for Skippy. The saving is not really the searches (2 cents of a
29-cent call); it is that `web_fetch` no longer drops a 340–390 KB page into context. A photo of a label
answers the question directly and costs a fraction.

**Which photos, and why not all of them.** FairPrice publishes the views in `own.images` on the product
object, named by view: `<sku>_XL1_<date>.jpg` is the front, `_BXL1_` the back, `_LXL1_` / `_RXL1_` the
sides (the date suffix is optional). `selectPackShots` takes the **back first, then the sides, at most two**.

⚠️ **The front shot is excluded on purpose, and that exclusion is the whole gate.** Photographs back-fired
once — on frozen chicken, at $0.60 against $0.41 text-only, producing the 24.8 g outlier — because a pack
with no panel leaves only marketing copy to read. So a listing publishing **nothing but a front shot gets no
images at all** and takes the ordinary path. `packShotsFor` also refuses photos to anything
`isCommodityFood` catches, which is the same failure blocked from the other end.

⚠️ **Don't filter the photos by the product's SKU.** The obvious rule, and wrong: FairPrice reuses one photo
across a range, so "[BCRS] Farmhouse Milk - Fresh" (item 13281014) publishes `10966597_LXL1_20230327.jpg` as
its own side view. Read `own.images` off the slug-anchored object — the same anti-carousel rule as the panel,
and simpler than reconstructing which files belong to the product.

**What it does to a real basket.** Surveyed over 32 live FairPrice products across 16 categories:

| path | share | cost each |
|---|--:|--:|
| the shop's own panel | 28% | free |
| fresh commodity, no tools | 31% | ~$0.003 |
| **back-of-pack photo** | **34%** | **~$0.03** |
| text only | 6% | ~$0.29 |

Adding all 32 would have cost **$3.80 before, $0.94 after**. The only two left on the expensive path were
the silken tofus, which publish a front shot and nothing else — exactly what the gate is for.

Sheng Siong contributes no photos: its Meteor record isn't read for images, so its products take the
text-only path as before.

## Where the data comes from (and why it isn't JSON-LD)

Measured over 40 FairPrice product pages across 8 categories:

| source | valid JSON | matches the URL | has a price |
|---|---|---|---|
| product **JSON-LD** | **0 / 40** | — | — |
| **`__NEXT_DATA__`** (server-rendered) | **40 / 40** | 40 / 40 | 40 / 40 |

FairPrice's JSON-LD is invalid on **every** product — a stray closing brace in the template (identical on
all 12 pages checked byte-by-byte), plus raw newlines pasted into `description` on some. Both are what
hand-concatenated JSON looks like; neither is possible with `JSON.stringify`. Repairing it is endless, so
nothing here depends on it.

`__NEXT_DATA__` is perfect — with one catch: **the inline copy goes stale.** Next.js does not rewrite it on
an in-site navigation, so browsing a category and clicking a product leaves the *category's* blob in the DOM
(no `product` key at all) while the address bar shows the product.

A content script is same-origin with its page, so the reader simply **asks the server again** when the
inline blob doesn't match the URL slug. Measured on the same 40 pages: reached by clicking → 40/40 complete,
one extra request each (~450–1100 ms); opened directly → 40/40 complete, **zero** extra requests.

The order is therefore: inline `__NEXT_DATA__` → same-origin re-fetch → JSON-LD (repair ladder, kept for
other shops) → DOM. `metaData.DisplayUnit` is the accurate pack size; `metaData.Weight` is **not** ("2 gm"
for 2 L of milk). A detail page's selling price is `storeSpecificData[0].mrp` **minus** `discount`, and every
price is rounded to 2 dp because FairPrice's own `final_price` ships float artefacts (`7.949999999999999`).

### Sheng Siong — ask the app, there is nothing else

Sheng Siong publishes **nothing** a scraper can read: no JSON-LD, no product meta tags, no server-rendered
data, not even an `<h1>`, and the same site-wide `<title>` on every page. Everything arrives over its DDP
socket after hydration.

So the extension asks the page's own Meteor app, with the same method the daily scraper uses —
`Products.getOneByIdOrSlug`. The page already holds an open, Incapsula-cleared connection, so this costs no
new network trust and returns the authoritative record: name, brand, price, `packSize` and a **numeric**
`netWeight`. Better data than the DOM could ever give.

This lives in `flow.js`, not `content.js`, because a content script runs in an **isolated world** and cannot
see `window.Meteor`; `chrome.scripting.executeScript({ world: "MAIN" })` is the supported way in. The
injected function closes over nothing (it is serialised into the page), self-guards on a missing Meteor or a
slug that doesn't match the address bar, and times out at 6 s.

`netWeight` is always in **grams**, so the unit is taken from `packSize`: a volume there ("12 x 1 L") emits
`ml`, a weight ("6 x 10 g") emits `g`, and a bare count ("10 s") passes `packSize` straight through so eggs
and tea bags stay `By Unit`. Without that, a 12 × 1 L carton of milk filed itself as 12000 **By Gram**.

⚠️ Sheng Siong records a piece count in the NAME ("Omega 6 Fresh Eggs (10s)") but not in `packSize`, so a
carton reads as `550 g / By Gram`. Change the dropdown to `By Unit` and the count by hand if you want it
planned per egg.

## Safety invariants (don't weaken these)

- **It cannot create Notion schema.** `Catagory` and `Unit type ` values are validated against the live
  options before every write and the write is refused on a mismatch. This is the one rule the whole design
  bends around — a stray select value silently becomes a permanent schema option.
- **It refuses to write at all** if any property it writes is missing from the DB (`setupCheck`), rather than
  letting Notion drop the unknown ones and produce a half-filled row.
- **A blank field is omitted, never written as null** — "I couldn't read a size" must not blank a size the row
  already had.
- **Replace asks first**, naming the row and showing each before → after value. It overwrites work the user
  maintains by hand and there is no undo.
- **Nothing under `src/` imports from `extension/`.** The sharing goes one way only.

## Install (per machine)

1. `npm run ext:build` in the repo root (regenerates `extension/dist/`). Needed after any edit to the
   extension, to `src/core/match.ts` / `generic-name.ts` / `categorize.ts` / `ingredients-schema.ts`,
   **or to `synonyms.json`** — synonyms are baked into the bundle at build time.
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → pick this `extension/` folder.
3. Extension **Options** → paste the Notion integration token (same value as `NOTION_TOKEN` in `.env`) →
   *Save & test* must come back green.
4. *Optional, same page:* paste a Claude API key (same value as `ANTHROPIC_API_KEY` in `.env`) to turn on
   the nutrition lookup. Blank = rows are added without nutrition, exactly as before.

⚠️ The integration needs **Insert content** *and* **Update content** on the Ingredients DB — replacing a row
is an update, which adding alone doesn't cover. The nutrition lookup is also an update, for the same reason.

## Popup vs side panel

The flow lives in one shared module (`flow.js`, `render(tab, alive)`); `popup.html` and `sidepanel.html`
carry the same body ids, so there is no duplicated flow to keep in sync.

- **Popup** — runs the flow once for the current tab.
- **Side panel** — stays open and re-runs on every tab switch / navigation, so walking a shop's catalogue
  keeps showing "already added / similar rows / add it" hands-free.
  - **First use:** click **"Enable page reading"** in the panel's banner. The panel, unlike the popup, has no
    per-open `activeTab` grant for pages you navigate to yourself. The vendor name and duplicate check work
    from the URL without it (that comes from `tabs` — metadata only); only auto-filling the fields needs it.

## How it works (files)

| File | Role |
|---|---|
| `manifest.json` | MV3. `activeTab`+`scripting` inject the reader on demand (works on any shop, no host list) + `sidePanel` + `tabs`. Notion via `host_permissions`; `optional_host_permissions` is what the side panel opts into for page CONTENT. No `content_scripts`. |
| `flow.js` | The **shared** flow used by both surfaces. Re-entrant (honours `alive()`) so the side panel can re-run it on navigation without stacking listeners or clobbering the new tab's fields. |
| `content.js` | Extraction only; never calls Notion (content scripts are CORS-blocked from `api.notion.com`). Reads `__NEXT_DATA__`, re-fetching the page when the inline copy is stale — see "Where the data comes from" below. |
| `background.js` | Service worker; the only Notion caller. Imports the naming/category logic from `src/core/` — shared, not copied. |
| `notion-client.js` | The single Notion module. **API 2025-09-03**, which queries *data sources*, not databases — do not copy endpoints from the reference extension, which speaks 2022-06-28. |
| `macros-client.js` | The single Claude caller — raw `fetch`, because the Anthropic SDK is a Node client. The prompt, tool set and parsing come from `src/core/macro-prompt.ts`, shared with the Node path, not copied. Reached only from the `find-macros` handler, i.e. only from a button press. |
| `vendors.js` | Host → vendor label. A convenience, not a gate: an unknown shop still captures, with the host as the vendor. |
| `popup.*` / `sidepanel.*` | Thin callers of `flow.js`. |
| `shared.css` | One stylesheet for both surfaces — they render the same ids, so they must look the same. |
| `options.*` | Token entry (Notion + optional Claude key) and a live setup check. |
| `build.mjs` | esbuild. Resolves NodeNext `.js` specifiers to their `.ts` files and stubs `node:fs` so `match.ts` runs in the worker with `synonyms.json` baked in. |

## Not built (deliberately)

The reference extension's **selection / PDF list mode** and its four **Haiku** helpers (type guess, name
restructuring, translation, list parsing) are absent. They exist there for a Danish, multi-vendor drinks
catalogue; here the **naming rule stays deterministic** (`generic-name.ts`, the house rule from `parse.ts`) —
the Claude key is used for nutrition lookup only, where the answer lives on a label this code cannot reach,
and never for deciding what a product is called. Say the word if the bulk list mode turns out to be wanted.
