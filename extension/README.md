# Add to Ingredients — Chrome extension

Capture a grocery product page into the Notion **Ingredients** DB. Internal tool (unpacked install, no Web
Store). Modelled on the sibling *Inventory Price Upkeeper* extension, with its verification workflow removed.

## What it does

Open it on a product page and it reads the name, brand, price and pack size, then offers **two** ways to
commit — and only ever the one you click:

- **Add to Ingredients** — creates a new row.
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

⚠️ The integration needs **Insert content** *and* **Update content** on the Ingredients DB — replacing a row
is an update, which adding alone doesn't cover.

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
| `content.js` | Extraction only; never calls Notion (content scripts are CORS-blocked from `api.notion.com`). FairPrice gets a dedicated `__NEXT_DATA__` reader — the scraper already learned that `metaData.DisplayUnit` is the accurate size and `Weight` is not. |
| `background.js` | Service worker; the only Notion caller. Imports the naming/category logic from `src/core/` — shared, not copied. |
| `notion-client.js` | The single Notion module. **API 2025-09-03**, which queries *data sources*, not databases — do not copy endpoints from the reference extension, which speaks 2022-06-28. |
| `vendors.js` | Host → vendor label. A convenience, not a gate: an unknown shop still captures, with the host as the vendor. |
| `popup.*` / `sidepanel.*` | Thin callers of `flow.js`. |
| `shared.css` | One stylesheet for both surfaces — they render the same ids, so they must look the same. |
| `options.*` | Token entry + live setup check. |
| `build.mjs` | esbuild. Resolves NodeNext `.js` specifiers to their `.ts` files and stubs `node:fs` so `match.ts` runs in the worker with `synonyms.json` baked in. |

## Not built (deliberately)

The reference extension's **selection / PDF list mode** and its four **Haiku** helpers (type guess, name
restructuring, translation, list parsing) are absent. They exist there for a Danish, multi-vendor drinks
catalogue; here the naming rule is deterministic and needs no API key, and nothing in this project has ever
required one. Say the word if the bulk list mode turns out to be wanted.
