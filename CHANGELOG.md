# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/). Everything stays under
`## [Unreleased]` until the first deploy.

## [Unreleased]

### Added
- **Telegram grocery-list intake (2026-08-10)** — text a list into the bot and it
  files into the Notion **grocery List**. `src/core/list-parse.ts` reads the
  quantity grammar (`2kg chicken breast`, `bananas x6`, `2 x 500g peanut butter`);
  `src/core/list-intake.ts` matches each line to an Ingredients row using the
  existing scorer and returns one of three verdicts (link / ask / new);
  `src/core/grocery-list.ts` gains `addTextedItem()`, which shares schema
  resolution and dedupe with the Buy button but leaves unknown columns blank
  instead of writing zero. Near-misses ask in-chat with inline buttons.
  `src/core/tg-inbox.ts` is the first **inbound** path in the project — chat
  allow-list, offset persisted after handling, no paid lookups.
  `npm run tg-poll` runs it on the residential-IP laptop.
- **New-items discount page** — `src/core/new-items.ts` prices items that aren't
  in Ingredients yet across **five shops** (FairPrice, Sheng Siong, Guardian,
  MyProtein, Carousell — `NEW_ITEM_SHOPS`). The last three already had store
  modules but were reachable only via `vendor-scan.ts`'s directed search, which
  needs an Ingredients row naming the vendor; a new item has none. Carousell is
  reduced with `cheapestPlausible` rather than the minimum and labelled
  `[marketplace listing]` on the card. No baseline exists for a new item, so the
  card compares shops and shows the shop's own sale %, not a saving against the
  user's price; it renders
  `public/new-items.html` through the shared `page-chrome.ts`. Same hybrid
  hand-off as Sheng Siong: the laptop scans and commits
  `data/new-items-latest.json`, `repository_dispatch: newitems` rebuilds Pages,
  and a stale file is skipped rather than published.

### Fixed
- **New-item pricing was silently missing Sheng Siong.** `scanNewItems` reused
  `run.ts`'s `STORES`, which defaults to `shengsiong-file` — a reader that answers
  only the terms in that day's committed scan. A new item's term is never among
  them, so Sheng Siong returned zero results with no error on every new-item card.
  `new-items.ts` now holds its own shop list and uses the live DDP module, which is
  correct because the scan only ever runs on the residential runner.
- Scaffolded Notion Worker project via `ntn workers new` (template
  makenotion/workers-template).
- Portable-core architecture: `src/core/` runtime-agnostic; GitHub Actions is
  the default free runtime, Notion Worker an optional wrapper.
- `src/core/config.ts` — env-based config (dotenv locally, Actions secrets in CI).
- `src/scripts/introspect.ts` + `npm run introspect` — discovers accessible
  Notion DBs, dumps data-source schema and sample rows (incl. `Used '1' Plan`).
- `.env.example` and local `.env` for read-only Notion access via a token.
- `src/core/parse.ts` — name → search term + must-match keywords, and
  `Used 'N' Plan` → monthly usage parsers (verified against live data).
- `src/core/notion.ts` `readPlanTargets()` — resolves active-plan grocery
  targets (baseline price + monthly usage), filtered to groceries. Plan 1 → 27
  targets. `npm run targets` prints them.

- `src/core/stores/` — pluggable store modules. `types.ts` (StoreProduct /
  StoreModule), `weight.ts` (pack-size → grams), and `fairprice.ts` (FairPrice
  via SSR-scrape). `npm run fp -- <terms>` live-tests it.
- `src/core/compare.ts` — matches store products to targets (search-token +
  must-match + form-word negative filter) and finds per-100g deals.
- `src/core/stores/ddp.ts` + `shengsiong.ts` — Sheng Siong store module over
  Meteor DDP/WebSocket (headless, no auth, past Incapsula). `npm run ss -- <t>`.
- `src/core/run.ts` `runOnce()` — full cross-store pass (FairPrice + Sheng Siong),
  best per-100g deal per ingredient. `npm run deals` (Plan 1 → ~14 cross-store deals).
- `src/core/telegram.ts` — formats + sends one Telegram message per deal
  (item, store, per-100g saving, sale note, monthly usage, link).
- `src/github/main.ts` — GitHub Actions entry (`npm start`), with `npm run
  dry-run` to preview messages without a Telegram token.
- `.github/workflows/daily.yml` — daily scheduled run (06:00 SGT) + manual
  dispatch; scans, deploys the deals page to GitHub Pages, then notifies.
- `src/core/site.ts` — renders the daily deals as a styled, mobile/dark-aware
  HTML page (each card links to the store product). `build-site` + `notify`
  scripts; one Telegram summary message ("N deals today → link") replaces the
  per-deal messages.

- Whole-inventory scan: `readGroceryTargets()` reads every grocery ingredient
  (not just the active plan). The page now has two sections — "In your plan"
  (with monthly usage) and "Other items on offer" (rest of the inventory).
  Deal cards also show price per 100g/100ml beside the per-kg/L price.

- **Add button** on every deal card (left of the item row) — pushes the item to
  the Notion **grocery List** DB as `[NTUC] Milk`, at the discounted price, with
  `Vendor` filled and `Amount` left empty. The page is static, so the button
  opens a pre-filled GitHub issue and `.github/workflows/add-to-list.yml` does
  the privileged half. `src/core/grocery-list.ts` writes the row (skipping a
  duplicate un-ticked one); `src/scripts/add-to-list.ts` (`npm run add`) is the
  entry point and takes `--dry-run`.
- **Cooldowns** — an added item stops being searched for
  `pack size ÷ monthly usage × 0.75` (1 kg garlic at 500 g/month → 46 days), or
  a flat 14 days when there's no monthly usage. State lives in
  `data/cooldowns.json`, committed by the same workflow and read by the scan.
  Keyed on the stemmed base noun, so close relatives ("Onion (White)",
  "Onions") are covered by one entry. The page lists what's snoozed and when it
  returns. `src/core/cooldown.ts` (pure) + `cooldown-file.ts` (persistence).
- Optional one-tap path, built but **not deployed**: `addToGroceryList` webhook
  in `src/index.ts` relays a tap to the same workflow via `repository_dispatch`.
  See `docs/one-tap-add.md` for the CORS trade-off and the setup.
- **Incapsula recovery for the Sheng Siong runner.** From 2026-07-30 the site
  answered every plain-HTTP request — homepage included — with a JS challenge, so
  all 62 searches failed and the scan went FairPrice-only. Measured in order:
  browser-like headers don't clear it, replaying the challenge's own cookies
  doesn't (the JS must run), `--headless=new` doesn't (headless is detected), a
  headed Chrome does. `src/core/stores/incapsula.ts` therefore launches the
  installed Chrome off-screen with a throwaway profile, lets it solve the
  challenge as any visit would, and caches the session cookie to
  `.sessions/shengsiong.json` (gitignored). The cookie is tried first and Chrome
  only appears once it stops working, so an ordinary run launches no browser.
  Uses `ws` + CDP — no Playwright, no new dependency.
- **A missing shop is now visible.** `RunResult.shengsiong` reports freshness;
  the page shows a warning banner and the daily Telegram message says so —
  sending even on a zero-deal day, since silence is exactly what a broken runner
  looks like. `laptop-run.cmd` (and the live wrapper) now return the real exit
  code: Task Scheduler had logged "Last Run Result: 0" on a run where everything
  failed, which is why the outage went unnoticed for a day.
- **Counted items are compared too** (`By Unit` — eggs, slices, tea bags), in
  whichever dimension the shop published. Per piece where it gives a count:
  FairPrice lists eggs as 30s and 10s, and its cheapest carton per egg carries no
  weight at all, so a weight-only comparison could never see it. Per 100g where
  it gives only weight, against a size written into the item's own name
  ("Bread, Wholemeal (600g)") — every bread FairPrice returns is weight-only,
  which is why that convention exists. `Deal`/`ReviewMiss` now carry a
  `dimension` with `baseline`/`productPrice`, replacing the per-100g-only fields,
  and the page/Telegram print "$0.222 each" or "$3.60/kg" accordingly.
  Guardrails, because counting hides size where weight does not: pieces are only
  compared when both stated sizes are within 2.5×, and a plain "egg" item now
  rejects another bird's, preserved or cooked eggs (a quail egg read as 24% off
  against a hen's egg while weighing a sixth as much).
- **Item actions** — two buttons on each row of "Recently bought · not
  searched". *Reset* clears the item's cooldown so the next daily run searches
  it again. *Not in use* tags the Notion ingredient `Not in Use ATM` (appended
  to its existing tags, never assigned over them) and clears the cooldown, so a
  parked item leaves the page too; it asks for confirmation first, since undoing
  it means removing the tag by hand. `src/core/item-actions.ts` (payload),
  `src/core/park.ts` (the Notion write — verifies the tag option exists rather
  than letting Notion invent one), `src/scripts/item-action.ts`
  (`npm run item-action`, takes `--dry-run`) and
  `.github/workflows/item-actions.yml`, deliberately separate from
  `add-to-list.yml`.
- **Correction menu on every card** — a `⋯` button under the percentage (and
  under the *closest* label on a close match), holding three actions that teach
  the matcher instead of just hiding today's card:
  - *Ignore 1× week* — a cooldown until Monday 00:00 SGT (`startOfNextWeek`),
    tagged `reason: "ignored"` so the page lists it under "Ignored this week"
    rather than lying about it being recently bought. Under a day of cover rolls
    to the Monday after, or the item would be back on the next morning's scan.
    Never shortens a longer cooldown already in place.
  - *Mismatch item* — bans words for that item permanently. The page suggests
    the title's words the item never asked for (`suggestExclusionTerms`; "3 in 1"
    and "indocafe" from *Indocafe 3 in 1 Instant Coffee*), and the user edits the
    list before anything is saved, because "extra" honestly includes the brand.
  - *Almost, but no* — blocks one product for one item, for a near-miss whose
    defining property can't be confirmed (the item wants unpasteurized; the shop
    doesn't say). No word to ban, so the product itself is the exclusion.
  New `src/core/exclusions.ts` (pure) + `exclusions-file.ts` →
  `data/exclusions.json`, applied in `findDeal`/`findReview` and keyed by
  `cooldownKey`, so a correction on "Onion (White)" covers "Onion (not red)".
  A single-word term folds through the matcher's own tokenizer ("tissue" catches
  "Tissues"); a phrase uses a separator-tolerant regex, since stemming "3 in 1"
  yields "in" and would exclude the whole shop.
- **Ignore button** — red, directly under *Add* on every card (deal and close
  match), separated by a real gap so it is never a mis-tap away from the button
  you press on purpose. It retires the **product**, not the ingredient: this
  listing is never offered again for any item, permanently, while the ingredient
  stays in the plan, keeps being searched, and other products still match it.
  New `ignore-product` action → a `BlockedProduct` keyed `ALL_ITEMS` (`"*"`),
  which `exclusionReason` matches alongside the item's own key; a real key is a
  stemmed base noun, so the two can't collide. Adding one supersedes any per-item
  blocks on the same product, and re-tapping is a no-op. Confirmed before it
  fires and it names both sides, because there is no button that undoes it —
  removing the entry from `data/exclusions.json` is the only way back.
- **History page** (`public/history.html`) — a second page linked from the deals
  page footer, holding everything the deals page has to forget to stay readable.
  `src/core/history.ts`; `src/core/page-chrome.ts` now holds the stylesheet and
  one-tap script both pages share. Four sections:
  - *Not in use* — ingredients tagged `Not in Use ATM`, which `readGroceryTargets`
    drops so early they otherwise have no listing anywhere. **Reset** removes that
    one tag (`unparkIngredient`, preserving all others) and refuses on a row that
    also carries the permanent `Don't Search`.
  - *Bought* — the purchase log, with three buttons per row.
  - *Already filed* / *Never buy again* — the record, and the `ALL_ITEMS` blocks
    from `exclusions.json` (the same list the red Ignore button writes; listed but
    deliberately not undoable from the page).
- **Purchase log** — new `src/core/purchases.ts` + `purchases-file.ts` →
  `data/purchases.json`, appended by `add-to-list.ts` once the Notion row lands.
  It exists because `cooldowns.json` **drops expired entries on every write** and
  so was never a history. Append-only and never trimmed: the only place the system
  remembers a price it once saw. Starts empty — earlier adds are not recoverable.
- **Three buttons on a bought row** — *Add to Ingredients* creates a new row
  (name, exact name, price, size, unit type, category, vendor, URL and macros);
  *Replace Current* writes price/size/vendor onto the existing row and nothing
  else, deliberately not renaming it; *Never buy again* writes the `ALL_ITEMS`
  block and settles every open row naming that product.
  `src/core/ingredient-write.ts` copies the extension's two rules verbatim —
  blanks are omitted rather than written as null, and select values are validated
  against the live schema so Notion can never be made to invent an option.
- **Macro lookup** (`src/core/macros.ts`) — Claude Sonnet 5 with web search and
  web fetch, run before the row is written. Product page → search → generic
  values, with the tier recorded and generic values flagged for checking. The
  prompt's load-bearing rule is that state decides the numbers (raw vs cooked,
  dry vs boiled): right food, wrong state is worse than no answer, because
  nothing looks missing. Capped at 4 searches; figures outside 0–100g dropped;
  protein+fat+carbs over 105g rejects the answer as per-serving. Every failure
  returns null and the row is still created — a lookup must never lose an add.
  Needs `ANTHROPIC_API_KEY`; unset is supported and free.
- **Macro lookup in the Chrome extension too** — *Add to Ingredients* in the
  popup / side panel now fills the same four columns, so the two add paths agree.
  `src/core/macro-prompt.ts` is new and holds everything that decides the answer
  (system prompt, tool set, parsing, sanity gate); `macros.ts` and the new
  `extension/macros-client.js` are now only transports — the SDK and raw `fetch`
  respectively, since the Anthropic SDK cannot bundle into a service worker.
  Shared, not copied, like `match.ts` and `ingredients-schema.ts` before it.
  Unlike the Node path the lookup runs **after** the row is written and patches
  it (`writeMacros`): the request takes 10–30s and no one should watch a spinner
  that long for a row that was ready. It runs in the worker, so closing the popup
  doesn't cancel it. Needs `https://api.anthropic.com/*` in `host_permissions`
  plus the `anthropic-dangerous-direct-browser-access` header (a service worker
  sends a browser `Origin`). Key is entered on the Options page beside the Notion
  token; blank disables the whole feature. *Replace With This* still writes no
  nutrition — that row's figures are the user's own work.
- **Four macro boxes on the capture form**, side by side per 100g (Protein /
  Carbs / Fats / Fiber), above the Add button. They pre-fill from the shop's own
  nutrition panel where the page publishes one, stay blank where it doesn't, and
  are editable either way. Filled boxes are written **with** the row and cost
  nothing; empty ones trigger the paid lookup at Add, as before.
- **`src/core/nutrition-panel.ts`** — deterministic reader for a shop's own
  `Nutritional Data` table (no model; the `generic-name.ts` house rule).
  ⚠️ Every panel measured is **per serving, never per 100g** — 32 g, 35 g, 236 ml,
  100 g — so it scales, and refuses a panel whose serving size isn't stated
  rather than emitting figures 3× out. Prefers a real per-100g column when a
  panel offers both. Matches row labels exactly, so Skippy's `- Saturated Fat`
  sub-row can't be mistaken for `Total Fat`, nor `Added Sugars` for carbohydrate.
  Same per-100g plausibility gate as the model path.
  ⚠️ **The panel is read off the slug-anchored product object only, never
  searched for in the page.** On the Skippy Peanut Butter page the product's own
  object carries no panel while the recommendations carousel carries four rival
  peanut butters' — a first-match search returns a competitor's label as this
  product's, which is both wrong and entirely plausible-looking. An early
  measurement made exactly that mistake and reported 4-of-5 availability; the
  real slug-anchored rate is **4 of 16** (packaged goods hit, fresh produce and
  meat always miss — which is precisely where the paid lookup is needed anyway).
- **Fresh commodities skip the web search** (`isCommodityFood` in
  `macro-prompt.ts`). Measured 2026-08-04: a lookup costs **US$0.29–0.41**, not
  the 6-7 cents claimed everywhere in this repo — out by ~5x, now corrected in
  the code, Options page, `macro-test.ts` and the README. Input tokens are ~90%
  of it (123k-280k per call: `web_fetch` drops whole 340-390 KB pages into
  context); two searches were 2 cents of a 41-cent call.
  Fresh items were the worst of it — every frozen-chicken variant cost $0.38-0.60
  and landed on `generic` regardless, with answers spread 16.6-24.8 g protein.
  Sending no tools for those gives **$0.0030 in 2.5s (was $0.41 in 34s)** for the
  chicken and **$0.0027 (was $0.081)** for broccoli, with the same or better
  figures — the chicken no longer produces the 24.8 g outlier. Gate is narrow on
  purpose: `produce`, or a meat/fish/egg word WITH a fresh/frozen/chilled/raw
  state, so branded dairy and canned fish keep their tools. 25 cases tested.
  ⚠️ `max_content_tokens` on web_fetch was tried and **rejected** — capping the
  fetch made one product 25% cheaper and another **27% dearer** (starved of page
  text it just searches more). Reruns of identical configs also varied ±30%, so
  anything under ~30% here is noise, not a result.
- **`lookupMacros` now logs tokens, searches and estimated cost** on every call.
  The 5x cost error above survived as long as it did because nothing printed it.
- **The lookup reads the label off the shop's own pack shots**
  (`selectPackShots` / `packShotsFor` in `macro-prompt.ts`, `images` on
  `MacroQuery`). Instead of sending the model to find a nutrition panel on the
  web, it is handed the back-of-pack photograph FairPrice already publishes.
  Skippy Peanut Butter: **$0.0239 in 5.2s with 0 searches on the `product-page`
  tier**, against $0.2877 in 54s with 2 searches text-only — same answer (22.8 g
  protein, right for Skippy). The saving isn't the searches (2 cents of a 29-cent
  call); it's that `web_fetch` no longer drops a 340-390 KB page into context.
  FairPrice names the views in `own.images` — `<sku>_XL1_<date>.jpg` front,
  `_BXL1_` back, `_LXL1_`/`_RXL1_` sides, date suffix optional. Back first, then
  sides, **at most two**.
  ⚠️ **The FRONT shot is excluded, and that exclusion is the gate.** Photographs
  back-fired once, on frozen chicken — $0.60 against $0.41 and the 24.8 g outlier
  — because a pack with no panel leaves only marketing copy to read. So a listing
  with nothing but a front shot gets no images and takes the ordinary path, and
  `packShotsFor` additionally refuses photos to anything `isCommodityFood`
  catches. The two gates cover "no label exists" from both ends.
  ⚠️ **Do not filter the photos by the product's SKU** — FairPrice reuses one
  across a range ("[BCRS] Farmhouse Milk - Fresh", item 13281014, publishes
  `10966597_LXL1_20230327.jpg` as its own side view). They are read off the
  slug-anchored product object, same anti-carousel rule as the panel.
  Surveyed over 32 live FairPrice products: 28% shop panel (free), 31% commodity
  (~$0.003), **34% pack shot (~$0.03)**, 6% text-only (~$0.29) — **$3.80 → $0.94**
  to add all 32. The two left on the expensive path publish a front shot only.
  30 offline cases cover the selector, the commodity interaction and the content
  array. `macro-test.ts` takes a repeatable `--image <url>` and reports how many
  of the URLs given were actually attached.

- **Rescan button** in the missing-shop warning banner (and only there — it does
  nothing useful otherwise). The two halves of the hybrid heal at different
  times: a laptop shut at 05:30 runs its missed Sheng Siong scan when it next
  wakes (`StartWhenAvailable`), so fresh prices reach the repo by mid-morning,
  but the 10:00 page was already built and nothing looks again — leaving a
  FairPrice-only page all day with the data sitting right there. The button
  fires `repository_dispatch: rescan` at `daily.yml` (new trigger), which
  rescans, redeploys Pages and re-sends the Telegram digest. Without a token it
  falls back to that workflow's own page, where *Run workflow* does the same.

- **Add and Replace on every deal card** — the deals page can now write to the
  **Ingredients** DB, not just the grocery List. *Add* files the discovered
  product as a new row; *Replace* re-bases the ingredient that **seeded** the
  search on it, writing `Name` (a generic name derived from the product),
  `Price,SGD`, `Weight /Units of New Product `, `Unit type ` and
  `Vendor, Current `. Both take the same road as every other card button — a
  pre-filled GitHub issue, one tap when a token is saved — routed to
  `item-actions.yml`, which needed no change (it gates on the `Item: ` title
  prefix, not on the action).
  New action `rebase-ingredient` + `rebaseIngredient()` in `ingredient-write.ts`.
  ⚠️ **Not the same as the history page's `replace-ingredient`, and they must not
  be merged**: that one does not rename and does write the URL; this one renames
  and does not. The rename is load-bearing — a row's name IS the search term the
  daily scan uses, so re-basing without it leaves the scan hunting for the thing
  you just replaced. Confirmed before it fires; there is no undo.
  ⚠️ `Unit type ` is written even though it isn't one of the four columns the
  button advertises, and it has to be: re-base a 500 g item onto a 1 L bottle and
  the size becomes 1000, but a stale `By Gram` then claims a kilogram of liquid
  and every per-100g figure built on it is wrong.
- **`has macro` / `no macro` tag** on each deal card, and it costs nothing.
  Measured 2026-08-04: FairPrice's **search** payload carries `Nutritional Data`
  on **34 of 72** products — the scraper already had it in `raw` and nobody had
  looked. New `StoreProduct.nutritionHtml` carries it through, `site.ts` parses it
  at build time, and the four figures ride in the Add/Replace payloads, so a card
  marked `has macro` files its nutrition with **no page fetch, no model and no API
  call**. Sheng Siong publishes nothing readable and always leaves it unset.
- **`Find Macros` button in the Chrome extension** (`find-macros` worker handler),
  which looks the figures up and hands them **back** rather than writing them. It
  fills the four boxes *before* the row exists, so they arrive where you can read,
  edit or clear them — and only then does Add write them, free. Shown only when a
  lookup is possible: no free panel on the page, and a key set.

- **`npm test` — 109 offline cases in `src/tests/`**, and no test runner. Four
  suites: pack-shot selection with its commodity gate, nutrition-panel parsing,
  macro-reply parsing, and the deals page's markup. Each file registers cases into
  a 40-line `harness.ts`; `run.ts` sets the exit code. Nothing calls Notion, a shop
  or Anthropic — a test that costs 29 cents is a test nobody runs, so the paid
  checks keep their own scripts (`macro-test`, `fp`, `ss`).
  They cover the functions where being *quietly* wrong is the whole danger: a
  misread serving size is out by 3× and looks plausible; a pack-shot gate that
  stops matching FairPrice's filenames silently costs 10× a lookup; a drifting
  commodity gate spends real money. Equivalent suites had been written and thrown
  away with the session four times before this.

### Changed
- **The grocery-list row title names the pack you have to find** (2026-08-06, by
  request): `Fish Sauce, Knife Brand, 750ml`. The ingredient, then the brand and
  pack size of the listing actually on offer, both carried in the Buy payload
  (`brand`, `size`) since nothing downstream can recover them — `add-to-list`
  never sees the product.
  ⚠️ The brand is **verbatim, never suffixed with "brand"**: `Tiger Brand`,
  `Snow Brand` and `House Brand` are real brand names (5 of 264 in one scan), and
  a naive template reads "Snow Brand brand".
  ⚠️ A brand the ingredient's own name already states is not repeated, so
  `Fish Sauce [Knife]` does not become "Fish Sauce [Knife], Knife, 750ml".
  ⚠️ A counted pack reads `30 pcs`, not the grams `packSizeG` carries for the
  cooldown's sake — no egg carton prints "1650g".
  Segments are individually optional, so a brandless listing (~4% of Sheng Siong)
  still reads cleanly and an issue raised before the fields existed produces the
  shorter title rather than throwing.
- **The grocery-list row title lost its vendor prefix** (2026-08-06, by request).
  `[Sheng Siong] Banana (Fruit)` is now `Banana (Fruit)`, with the shop
  in the list's own `Vendor ` column — which it was always written to as well, so
  the prefix only duplicated it. Nothing else about the row moved.
  ⚠️ The shop is now recorded in **exactly one place**. `resolveListProps` finds
  the vendor column by type + keyword (live schema has `"Vendor "`, rich_text,
  trailing space — verified against Notion on 2026-08-06); if that ever stopped
  resolving, the writer skips it by design and the shop would be lost with only a
  console warning. It used to survive in the title.
  ⚠️ `findOpenRow` matches the whole title, so what it dedupes on moved twice in
  one day: dropping the prefix briefly made it one row per ingredient across
  shops, and adding brand and size (above) settled it at **one row per
  (ingredient, brand, pack size)**. The same listing tapped twice still collapses
  to one row — the double-tap this guard exists for — while two genuinely
  different packs list separately.
  `groceryRowTitle` lost its `store` parameter rather than keeping one that no
  longer affects the result. New suite covering the title, the vendor labels and
  column resolution against the real schema.

### Fixed
- **Two taps at once no longer lose one of them** (2026-08-05). Both write
  workflows commit a JSON data file and push, so presses a few seconds apart race
  and the second push is rejected. The recovery was `git pull --rebase`, which
  **replays the commit** — and two entries appended to the same JSON array seconds
  apart is a content conflict it cannot resolve, so the run died *after* the page
  had already shown "✓ ignored".
  ⚠️ Measured damage: on 2026-08-05, **3 of 9 item-action runs failed and three
  real corrections were silently lost** (two `Ignore for good`, one `Mismatch`).
  Nothing surfaced it — the entries simply were not in `data/exclusions.json`.
  The retry now resets to the new remote and re-applies this run's own change on
  top, via `src/core/merge-data.ts` (pure) + `src/scripts/merge-data.ts`.
  ⚠️ **Three-way merge, not a union.** These files are not append-only — `reset`
  removes a cooldown, `never-buy` settles a purchase — so a union would resurrect
  exactly what someone just removed. Start from theirs, drop what I removed, upsert
  what I added or changed. Where they removed what I merely edited, removal wins.
  ⚠️ A blocked product's identity is `(key, url)`, not `key`: every
  `Ignore for good` writes `key: "*"`, and keying on that alone collapses two
  different products into one. That was one of the three losses.
  ⚠️ A `concurrency` group is still not the fix — GitHub keeps one run pending per
  group and cancels the rest, losing the middle of a burst (LEARNINGS 2026-07-30).
  21-case suite replaying the real collision; its first run caught a genuine bug in
  the merge (the append pass resurrected entries the other run had removed).

### Added
- **`Weekly Buy` now sets the cooldown** (2026-08-05). The tag was read off the
  Notion row and used by nothing. A tagged ingredient now goes quiet for a flat
  **5 days** after a Buy, whatever the pack size — bananas are a weekly shop
  whether you came home with three or a dozen.
  ⚠️ Checked **before** the `pack ÷ usage × 0.75` sum, not after: the tag means
  "ignore the arithmetic", not "adjust it". Left to the formula, a 2 kg buy against
  1 kg/month goes quiet for 46 days — six weeks of not being shown a weekly fruit.
  Five and not seven for the same reason the sum keeps its 25% haircut: the item is
  back in the scan a couple of days before the next shop.
  ⚠️ It is a **cooldown** rule, not a matching rule — a weekly item is searched,
  scored and priced exactly like any other.
  The flag rides in `AddPayload.weeklyBuy` (optional, so an issue still open from
  an older page parses and takes the old route), set at page-build time from
  `PlanTarget.weeklyBuy`. `planCooldown` moved its trailing booleans into a
  `CooldownOptions` object — `planCooldown(a, b, now, true, true)` is a call nobody
  can read. New `src/tests/cooldown.test.ts` (13 cases) pins both failure
  directions, since dropping the flag hides a staple for six weeks and applying it
  too widely collapses every cooldown to 5 days, and neither announces itself.

### Changed
- **`Ignore 1wk` is red** (2026-08-05, by request), sharing `.act.ignore` with the
  permanent one rather than the neutral grey it briefly shipped with. Red now marks
  "this takes something off the page"; the label, the action and the menu's extra
  tap are what distinguish the two. ⚠️ The weekly button must not inherit the
  confirm dialog along with the class — there is a test for that.
- **The two ignores traded places** (2026-08-05, by request). The button under Buy
  was the permanent product block and the `⋯` menu held the weekly snooze; now the
  button is **`Ignore 1wk`** and the menu holds **`Ignore for good`**. Both actions
  (`ignore-week`, `ignore-product`) are unchanged — only which control emits which.
  The reversible correction is the reachable one because it is the one reached for
  most often; the irreversible one now takes two taps behind the `<details>`.
  ⚠️ They are different **scopes**, not two durations of one thing: the button
  snoozes the *ingredient* until Monday, the menu entry retires a *product* for
  every ingredient, permanently.
  ⚠️ Red now means "no undo" and nothing else — the weekly button is the neutral
  `.act` grey, and `.act.ignore` became colour-only (`.panel .act` sizes it).
  ⚠️ `.cta { max-width: 78px }` is load-bearing: the column is stretch-sized by its
  widest child, so "Ignore 1wk" on one line widened it ~45px and took that out of
  the product name on a phone. Capped, the label wraps to two lines.
  New `deals page — the two ignores` suite (11 cases) pins the pairing, the confirm
  dialog staying with the permanent action, and the issue titles naming the product
  and the ingredient respectively — getting it backwards is otherwise invisible.
- **Nothing spends money unasked.** No button on any surface starts a paid
  nutrition lookup on its own any more. Adding a row used to look macros up
  automatically whenever the four boxes were empty, so an ordinary tap could
  quietly spend up to 29 cents on figures nobody asked for and nobody read. Now
  the deals page has a per-card **+ Macros** toggle (red when off, green and
  reading `+ Macros` when on) and the extension has **Find Macros**; both default
  to off. `macrosFor()` in `item-action.ts` is the one place that decides, and its
  order is the whole cost story: the shop's free panel first, a paid lookup only
  if the toggle was on, otherwise nothing.
  ⚠️ The free panel is checked **before** the toggle, so a product whose shop
  published a table costs nothing even with + Macros armed — the shop's own label
  beats a model's answer.
  ⚠️ The history page's "Add to Ingredients" still looks up automatically, by
  passing `findMacros: true` explicitly. Deliberate: the default is now off
  everywhere, and that one button opts back in because filing a purchase is a
  one-off deliberate act on something already bought.
  The flag travels on both roads out of the static page — `"findMacros":false` in
  the one-tap JSON and the URL-encoded `"findMacros": false` in the two-tap issue
  body — which is why `ingredientPayload` always serialises it even though it is
  always false: a string replace can only rewrite a value that is actually there.
- **Deal card restructured** to fit five controls on a phone. The text is now five
  short rows rather than four long ones, and the right rail holds `−%`, `⋯`, a
  one-line gap, then Add / Replace / Macros. That pairing is the trick: a floated
  rail only costs text width while it is *taller* than the text beside it, so
  splitting "item [size] price" across two lines makes the rail free. The usage
  line `clear: both`s below it and gets the full card width back, which is where
  the has/no-macro tag sits. ⚠️ Undo that split and every product name loses
  ~80px on a 390px screen.
- **The grocery-list button is labelled `Buy`, not `Add`** — because a second
  button called Add now sits on the same card and writes to a different database.
  ⚠️ **Only the label changed.** The CSS class, `AddPayload`, the `grocery-add`
  label, the `Add: ` title prefix the workflow's allowlist matches and
  `add-to-list.yml` are all still `add`; renaming those would have broken every
  in-flight issue for nothing.
- **The plan is now whatever you tag `Main`.** `readGroceryTargets()` builds it
  from Meal prep's `Current Plan` = "Main" meals — their sub-item lines'
  ingredients, `Amount Used ` summed per ingredient, monthly = daily × 20 —
  instead of the Ingredients `Used 'N' Plan` formula chosen by
  `ACTIVE_PLAN_NUMBER`. Re-tagging meals in Notion now changes what gets scanned;
  the env var didn't. Same ingredients either way (verified: 33/33 monthly
  amounts identical), plus 2 items whose `Amount Used ` is blank and which used
  to land in "other items". No fallback: nothing tagged `Main` means an empty
  plan section, logged.

### Removed
- `ACTIVE_PLAN_NUMBER` — the plan is the `Main` tag, so the env var no longer
  selects anything. Dropped from `config.ts`, `.github/workflows/daily.yml` and
  `.env.example`, along with the never-read `ACTIVE_PLAN` entry beside it.
- Deal/close-match cards restructured: the percentage column is now a `float`
  inside a `.main` block, a sibling of the product link rather than nested in it
  — a control inside an `<a>` is invalid and untappable. Floating (rather than a
  third flex column) is what keeps the change free: the lines below the float
  reclaim the full card width, so a long product name stays at two lines instead
  of three.
- Telegram message cleaned up: item name is the link, shows pack size `[700g]`
  / `[640ml]`, price per kg (per L for volumetric), monthly usage; dropped the
  per-month savings figure; "month" spelled out.

### Changed
- Added `@notionhq/client` (v5) + `dotenv`. Portable Notion access no longer
  depends on the Workers runtime.
- Telegram messages now lead with price per **kg** (or per **L** for volumetric
  items — ml/L pack sizes), with per-100g as a secondary line. Weight parser
  tracks `volumetric`; `StoreProduct` gains a `volumetric` flag.
- Daily schedule moved to **06:00 SGT** (`cron: "0 22 * * *"`).

### Added
- **Chrome extension — "Add to Ingredients"** (`extension/`). Captures a grocery
  product page into the Notion Ingredients DB. Modelled on the sibling Inventory
  Price Upkeeper extension, minus ABV, SKU and the Unverified/verified review
  workflow, with Supplier renamed to Vendor. Two writes, neither automatic:
  **Add to Ingredients** creates a row, and **Replace With This** appears beside
  each similar existing row and repoints it at this product (confirms first,
  showing before → after). Writes `Name` (generic) and `Items Exact Name` (the
  shop's full title + brand) separately — "Malaysia Round Cabbage" → `Name`
  "Round Cabbage" — plus `Price,SGD`, `Weight /Units of New Product `,
  `Unit type `, `Catagory`, `Vendor, Current ` and `Vendor 1 URL`.
- `src/core/generic-name.ts` — deterministic full-name → generic-name stripper
  (a known brand, a country of origin, a pack size; nothing else). Origin words
  are country NOUNS only, so `China Chinese Cabbage` → `Chinese Cabbage`.
- `src/core/categorize.ts` — keyword → `Catagory`, and pack size → `Unit type `.
- `src/core/ingredients-schema.ts` — the data-source id and the exact (typo'd,
  trailing-spaced) Ingredients property names, re-exported by `notion.ts` so the
  scraper and the extension share one source of truth.
- `npm run ext:build` (esbuild) — bundles the extension, resolving NodeNext
  `.js` specifiers to `.ts` and baking `synonyms.json` in.
- **`Don't Search` tag.** A `Select` option the user sets by hand in Notion to
  take an ingredient out of the scan permanently. Same exclusion point as
  `Not in Use ATM` (`readGroceryTargets`), so a tagged row is never searched,
  never compared and reaches no section of the page — but unlike the parked tag
  it is never written or cleared by this tool. Tag comparison now goes through
  `normTag()` (folds case, curly apostrophes, stray spacing) and accepts the
  original `Don'r Search` spelling too, so a hand-edit in Notion cannot silently
  switch the suppression off. 53 → 48 targets; no deals lost.

### Fixed
- **Sheng Siong only ever returned promoted products.**
  `Products.getByAllSlugs` was called with `ecommPromotionFilter.active: true`,
  which restricts results to items in a current promotion — so 28 of the 70
  daily search terms came back empty (`cinnamon`, `lotus root`, `apple cider
  vinegar`, `old garlic`) and the rest saw only their promoted subset.
  `search()` now runs both passes and merges on `slug`, and `PAGE_SIZE` goes
  20 → 50. 437 → 1166 products, 28 → 22 empty terms, 19 → 25 deals.
- Lentils returned nothing from either shop. `synonyms.json` folds `lentil` /
  `lentils` → `dhall` (the spelling Sheng Siong indexes: 0 hits for "lentil",
  10 for "dhall"), and `channa` → `chickpea` so "Channa Dhall" satisfies a
  "(Chana Dahl)" item. The Notion rows were renamed `Lentil (…)` → `Dahl (…)`
  to match. Sheng Siong now offers Masoor Dhall Split at 0.382/100g.
- Pu Erh now matches FairPrice's own spellings (`Pu'Er`, `Puer`, `Pu Er`);
  Sheng Siong does not stock it under any spelling.
- **Omega-3 and omega-6 were indistinguishable.** `tokens()` drops tokens
  starting with a digit, so both collapsed to `["omega"]`. They now fold to the
  single tokens `omega3` / `omega6`. Also, `parseName()` runs its must-match
  keyword hay through `normSynonyms()`, letting `omega 3 enriched` → `omega3`
  retire "enriched" — a word FairPrice prints on bread, never on omega-3 eggs,
  so the three egg items previously matched nothing at all. `skim` added to
  `MUST_MATCH_KEYWORDS` to keep parity under normalisation.
- `muscovado` → `brown muscovado`, so `Muscovado Sugar (Brown)` stops failing
  its own requirement against titles that all say "Dark Muscovado Sugar".
- `tofu` / `bean curd` added to `GENERIC_FORM_PATTERNS` — egg tofu undercuts
  real eggs per 100 g and would have published as an omega-3 egg deal.
- Matcher gaps that the wider candidate pool exposed: added bakery
  (`loaf`, `bread`, `cookies`, `buns`, …), household paper / scented non-food
  (`tissue`, `bathroom`, `scent`, …) and `\d in \d` premix patterns to
  `GENERIC_FORM_PATTERNS`, and `light` to the plain-milk variant guard. Stops
  bathroom tissue matching "Green Tea", a butter loaf matching "Butter", and a
  3in1 mix matching "Instant Coffee (plain)".

### Changed — the price book replaces the baseline columns (2026-08-09)
- **Every captured price now goes into a `Vendor n` slot, not a flat column.**
  Requested by the user, and forced by their own Notion restructure: `Price,SGD`
  is gone, `Weight /Units of New Product ` and `Vendor, Current ` are renamed
  `… - Delete? `, and `Price,SGD [Cheapest]` / `Cheapest Price/Kg ` /
  `Cheapest Vendor ` are now formulas derived from `Vendor 1..4` +
  `Price [Vendor n]` + `Size[Vendor n]`. Filling a slot is what gives a row a
  price at all. `Unit type ` now describes `Size[Vendor n]`.
- `src/core/vendor-slots.ts` — new, pure, and shared by the Node writers and the
  Chrome extension (esbuild bundles it), so the two surfaces cannot drift on
  which shop owns which slot. Column names are resolved off the LIVE schema
  rather than hardcoded: `Price [Vendor 2] ` has a trailing space and
  `Price [Vendor 1]` does not, and `Size[Vendor n]` has no space after "Size".
- **Add** (deals page, history page, extension) writes the capture into the first
  free slot — always `Vendor 1` on a new row, via the shared rule rather than a
  hardcoded 1. It never evicts.
- **Replace / Replacing With This** (all three surfaces) picks the slot in the
  user's stated order: this shop's own slot if it has one → the first free slot →
  otherwise the slot with the highest `Price / Size * 1000`, and **only** if this
  product is cheaper per kg than that. Otherwise nothing is written and the reply
  says why. A slot is "free" only when its vendor, price, size and URL are all
  empty, so a price sitting in an untagged slot is never silently overwritten.
- A shop with no matching `Vendor n` **select option** (Cold Storage, Giant,
  RedMart, Lazada, Amazon SG today) is reported and dropped — writing it would
  make Notion invent the option, a schema edit to a live personal workspace.
  `extension/vendors.js` gained iHerb, MyProtein, Carousell and Shopee mappings
  spelled the DB's way (`Iherb`, `My Protein`).
- **Buy now counts.** The grocery-list row gets `Amount ` = 1, and a second tap
  on a row still outstanding makes it 2 instead of doing nothing. The
  one-row-per-listing dedupe is unchanged.
- The deals page's **Replace** now writes the product URL, which it deliberately
  did not before. The reason it didn't — `Vendor 1 URL` belonging to whatever shop
  `Vendor 1` named — is gone: the URL lands in `URL [Vendor n]` for the slot that
  names *this* shop. (The `Vendor 1 URL` misfile logged in `docs/vendor-scoping.md`
  is fixed by the same change.)
- Extension form labels: "Price, SGD" → "Price at this shop, SGD",
  "Weight / Units" → "Pack size", "Vendor, Current" → "Vendor".

### Fixed — three silent, total failures caused by that restructure
- **The daily scan had stopped finding any target at all.** `readGroceryTargets()`
  read `Price,SGD` and `Weight /Units of New Product `; both now return null, `?? 0`
  turned that into $0, and the `packPriceSgd <= 0` guard then dropped every row.
  The baseline is now the cheapest vendor slot — the same rule the Notion formulas
  use, computed locally because the scan needs the pack SIZE too and no formula
  publishes it. Live check: 0 → **26** plan targets.
- **`Price per 100g ` read 0 on every row** (it was built on the retired columns).
  It was the weight baseline for every By-Gram ingredient, so every such item
  priced at $0 per 100 g. Computed locally instead, from the cheapest slot; the old
  By-Unit branch folds into the same expression.
  *(The user repaired the formula the same day with a new `Size of Cheapest Vendor`
  formula for `price per g/unit [SGD]` to divide by. The scan still computes its own,
  because it needs price + size + vendor from the same slot and `Price per 100g `
  counts per 100 **units** on By-Unit rows. Verified identical on 95 of 95 rows.)*
- **The Chrome extension refused to write anything.** `REQUIRED_ING_PROPS` listed
  three columns that no longer exist, so `setupCheck()` failed on all three and
  every capture was blocked. The list now covers only Name, Items Exact Name,
  Catagory and Unit type; the price-book columns are checked separately and report
  themselves rather than blocking the write.
- `findByUrl` (the extension's "already added?" check) searched `Vendor 1 URL`, a
  column that no longer exists, so it silently returned null for every page. It now
  searches all four `URL [Vendor n]` columns — needed anyway, since a capture can
  land in any slot.
- Similar-row cards in the extension showed "no price · no size" for every row,
  having read the retired columns. They now show the cheapest vendor slot.

### Added — counted packs land as a count (2026-08-09)
- **A pack the shop counts instead of weighing now writes its piece count.** A
  30-egg tray lands as `Size[Vendor n] = 30` with `Unit type = By Unit`, instead of
  leaving the size blank — which, now that the baseline is the cheapest slot, meant
  the row got no baseline at all. `unitCount` is threaded from `StoreProduct`
  through the action payload, the purchase log and `fieldsFromPurchase`.
- ⚠️ **A published pack weight still wins.** Plenty of packs state both, and
  `10 x 100ml` carries a count of 10 as well as 1000 ml — taking the count first
  would file a litre of milk as ten units and price it per bottle. The count is used
  only where there is no weight, which is exactly the egg-tray case.
- ⚠️ The purchase log's `packSizeG` is a **cooldown** figure and is deliberately
  converted to grams for a counted pack (30 eggs × 55 g → 1650 g). The history page
  now suppresses it when a count is known, so a tray isn't filed as 1650 By Gram.
- `parseName()` accepts a pack weight stated after a **comma** — `Egg tray, 350g` —
  as well as in parentheses. That weight is what lets a counted row be compared per
  gram rather than per piece (30 quail eggs vs 10 hen's eggs); the comma form was
  previously dropped in silence. Parentheses win where a name states both.
  ⚠️ A size in the name imposes **no** matching requirement — it prices, it never
  filters — unlike every other parenthetical, which is a hard requirement. Verified
  end to end: a `(300g)` egg row matches both a 10-pack and a 30-pack, and the
  winner is decided per kg. Now covered by its own test suite so it stays that way.

### Fixed
- **A capture with no readable size no longer asserts `Unit type = By Gram`.** It
  defaulted to that, so a Replace on a By-Unit egg row would silently flip it and
  leave its piece counts being read as grams. Now that `Unit type ` is what says
  whether `Size[Vendor n]` is grams or pieces, that default was actively dangerous;
  no size means no unit type is claimed, and the row keeps what the user set.

### Pending
- Read Ingredients DB + active meal plan (default: Plan 1.8k) via Notion.
- Name parser: strip parentheticals/trailing qualifiers → search term;
  keyword list (organic, fresh, frozen, enriched, wholegrain, skinless, …)
  → must-match constraints.
- FairPrice store module (search → standard product shape).
- Sheng Siong (AllForYou.sg) store module.
- Price-per-100g normalisation + must-match filtering.
- Parse the "Used '1' Plan" formula string for monthly usage.
- Telegram alert: store, per-100g saving (amount + %), deal duration,
  link, monthly usage — one message per qualifying deal.
- Daily scheduled run.
