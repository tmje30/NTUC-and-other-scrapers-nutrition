# Handover — Grocery Deal Scraper

Read this first, then `LEARNINGS.md` (deep technical detail + gotchas) and
`CHANGELOG.md` (what shipped). Memory files also auto-load via `MEMORY.md`.

*Last reviewed 2026-07-31. The system is live and self-running; the parts most
likely to bite a newcomer are the Incapsula browser mint and the two comparison
dimensions, both flagged ⚠️ below.*

## TL;DR

A daily job reads the user's Notion **Ingredients** DB + active plan, scrapes
**FairPrice** and **Sheng Siong** for cheaper prices per 100g/kg (per L for
liquids), and posts **one Telegram message → a GitHub Pages page** listing the
deals. **It is LIVE and self-running, including Sheng Siong.**

Sheng Siong is blocked from datacenter IPs, so it runs via a **residential-IP
hybrid**: a runner (the user's **laptop**, daily) scans Sheng Siong and commits
`data/shengsiong-latest.json`; the cloud reads that file. FairPrice runs in the
cloud directly. If the file is missing/stale the page degrades to FairPrice-only.

⚠️ **Changed 2026-07-30:** Incapsula now challenges *residential* IPs too, not
just datacenter ones. The runner therefore needs **Google Chrome installed** — it
launches Chrome briefly to earn a session cookie when (and only when) it gets
blocked. See "Incapsula" below. A missing shop is no longer silent: it shows on
the page and in the daily Telegram message.

## Live system

- **Repo:** https://github.com/tmje30/NTUC-and-other-scrapers-nutrition — **PUBLIC**
  (Pages needs public on the free plan; no secrets in repo), branch `main`.
- **Live page:** https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/
  Sections, in order: "🔻 On sale now", "In your plan", "Other items on offer",
  "Close matches · not exactly what you asked for", "Recently bought · not
  searched". Cards show `Item [packsize] Price $x  −%`, the found product, price
  per kg/L **or per piece**, and `uses ~X/month`. A ⚠️ banner under the header
  means a shop was missing from the scan.
- **Cloud schedule:** GitHub Actions `.github/workflows/daily.yml`. **10:00 SGT**
  (`cron: "0 2 * * *"` = 02:00 UTC), plus manual `workflow_dispatch`.
- **Telegram:** reuses the user's Notion-Worker bot **@Big_Notion_Bot**, chat
  `7626546412`. Secrets `NOTION_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
  are GitHub Actions secrets. Locally they live in `.env` (gitignored).
- **Runtime:** portable Node/TS core (`src/core/`), run with `tsx`. Node 22+.

## How the hybrid works

```
Laptop (Task Scheduler, 05:30 SGT)        Cloud (Actions, 10:00 SGT)
  npm run push-ss:                           npm run build-site:
   - fetch terms from public targets.json     - scan FairPrice live
   - live Sheng Siong scan (residential IP)   - read data/shengsiong-latest.json
   - write data/shengsiong-latest.json          (dated today? cross-store : FP-only)
   - git commit + push  ──────────────────►   - deploy Pages page
                                              - npm run notify → Telegram digest
```

- **Cloud reader:** `src/core/stores/shengsiong-file.ts` reads
  `data/shengsiong-latest.json`, used **only if `date` == today (SGT)**, else Sheng
  Siong contributes nothing (FairPrice-only). It **never makes a live SS call**, so
  the datacenter-IP block is irrelevant in the cloud. `run.ts` defaults to this file
  source; `SHENGSIONG_LIVE=1` forces the live DDP module (local testing only). The
  runner script (`push-shengsiong.ts`) always uses live SS. **No workflow-file edit
  was needed** to wire this up.
- **Data file shape:** `{ date, generatedAt, source, terms, results: {searchTerm:
  StoreProduct[]} }`. `raw` payloads are stripped before writing (file ~96 KB).
  `source` is `phone` or `laptop` (from `RUNNER_SOURCE`).
- **Fallback chain:** laptop → cloud FairPrice floor. (Phone is optional extra
  redundancy — see below.)

### Laptop runner (primary residential runner — DONE, running)

- **Dedicated clone:** `C:\Users\newuser\shengsiong-runner\repo` (separate from the
  dev repo so the daily job never collides with development).
- **Wrapper:** `C:\Users\newuser\shengsiong-runner\run.cmd` — sets
  `RUNNER_SOURCE=laptop`, adds node+git to PATH, does `git pull` then
  `npm run push-ss`, logs to `..\push-ss.log`. A reference copy lives in the repo
  as `laptop-run.cmd`; **edit the live one and keep the copy in step.**
  It ends `endlocal & exit /b %RC%` — without that it always returned 0 and Task
  Scheduler reported success on a run where everything failed (fixed 2026-07-30).
- **Task:** Windows Task Scheduler **"ShengSiong Daily Scan"**, daily 05:30 SGT.
  `StartWhenAvailable` (runs if the laptop was off/asleep at 05:30), runs on
  battery, `InteractiveToken` (runs as the logged-in user → Git Credential Manager
  auth works, **no PAT stored**). Registered from `..\task.xml`.
- **Self-gating:** `push-ss` skips if today's SGT-dated file already exists, so
  extra runs are instant no-ops. `--force` rescans; `--no-push` skips git.
- To reconfigure the task: `schtasks /Query|/Run|/Change|/Delete /TN "ShengSiong
  Daily Scan"`. Check it ran: `type C:\Users\newuser\shengsiong-runner\push-ss.log`.
  Task result: `Get-ScheduledTaskInfo -TaskName "ShengSiong Daily Scan"` — this is
  now trustworthy (0 = really succeeded, 1 = really failed).

### Incapsula — the runner needs a browser (since 2026-07-30)

Sheng Siong's WAF started answering **every** plain-HTTP request, homepage
included, with a JS challenge (HTTP 200 + a script) instead of content, from
residential IPs too. All 62 searches failed at the WebSocket upgrade with
`Unexpected server response: 200` and the scan silently went FairPrice-only.

What was measured, cheapest first (don't re-litigate these — they were tested
against the live site):

| attempt | result |
| --- | --- |
| browser-like headers only | still challenged |
| replaying the challenge's own cookies | still challenged (the JS must run) |
| headless Chrome (`--headless=new`) | still challenged (headless is detected) |
| **headed Chrome** | **clears it; its cookie makes DDP connect** |

So `src/core/stores/incapsula.ts` launches the installed Chrome with a throwaway
profile, lets it solve the challenge the way any visit does, harvests the
`incap*` cookies and caches them to **`.sessions/shengsiong.json`** (gitignored —
it's a session credential). The cookie rides on the DDP handshake
(`DdpClient.setCookie`).

- **The cached cookie is tried first**, so an ordinary run opens no browser.
  Chrome only appears once the cookie stops working, and then a small window
  flashes for ~15s. Minting happens **at most once per process**; a failure is
  remembered and rethrown, never retried.
- **The block is intermittent.** Some hours a bare client connects with no cookie
  at all. So "it worked when I tried it" proves little either way — check
  `push-ss.log`, not a one-off hand run.
- Needs Chrome on PATH or at a standard location; `CHROME_PATH` overrides.
- Uses CDP over the existing `ws` dependency. **No Playwright, nothing installed.**
- This reuses a real browser session; it does not solve or reimplement the
  challenge. Keep it that way (see the captcha-fallback skill's line on this).

### Phone runner (optional redundancy — PAUSED)

⚠️ **Blocked by the Incapsula change.** Termux has no Chrome, so the phone can no
longer mint a cookie for itself — it would only work in the hours the WAF happens
not to challenge, or by copying a `.sessions/shengsiong.json` over from the
laptop. Finishing the Termux scheduling below is pointless until that's solved.

The phone→cloud **push path is proven** (an Android phone ran `npm run push-ss`
from its residential IP and pushed a real scan). Only the **Termux scheduling** is
unfinished — `git pull` on the phone wasn't landing `phone-run.sh`
(`./phone-run.sh` → "no such file"), and the job wasn't registered. Since the
laptop now covers the runner role, this is optional. To finish later:
- On the phone, in `~/NTUC-and-other-scrapers-nutrition`: `git pull` (diagnose why
  it didn't update — check `git log --oneline -1`, `git status`), `chmod +x
  phone-run.sh`, `pkg install termux-api -y`.
- Register: `termux-job-scheduler --script ~/NTUC-and-other-scrapers-nutrition/
  phone-run.sh --period-ms 10800000 --network any --persisted true` (runs every 3h;
  script self-gates). Confirm with `--pending`.
- Android battery: set Termux + Termux:API to **Unrestricted**; on Xiaomi/MIUI also
  enable **Autostart** and lock Termux in recents.
- Phone auth = fine-grained PAT baked into the remote:
  `git remote set-url origin https://tmje30:$T@github.com/tmje30/NTUC-and-other-scrapers-nutrition.git`
  (see PAT gotchas below).

## Add to grocery list (+ cooldowns)

Each deal card has an **Add** button on the left. The page is static, so it
can't hold a Notion token: Add opens a **pre-filled GitHub issue** ("Add: [NTUC]
Milk", payload in a ```json block), you tap Submit, and
`.github/workflows/add-to-list.yml` does the privileged half —

1. writes the row to the Notion **grocery List** DB: Name `[NTUC] Milk`,
   `Price , To Buy ` = the discounted price, `Current Price ` = what you pay for
   your own pack, Vendor = the store, **Amount left empty**. Column names are
   resolved from the live schema, not hardcoded — they drift (see LEARNINGS
   2026-07-29);
2. records a **cooldown** in `data/cooldowns.json` and commits it;
3. comments the result on the issue and closes it. **No Telegram ping** — the
   user gets one daily digest and doesn't want adds narrating themselves.

**Cooldown = `pack size ÷ monthly usage × 0.75`** — the 25% haircut brings the
item back before the cupboard is empty, leaving a window to catch a deal. 1 kg
of garlic at 500 g/month → 2 months of cover → **46 days**. No monthly usage
(anything outside the active plan) → flat **14 days**. Entries are keyed on the
stemmed base noun (`onion`), so one entry covers "Onion (White)", "Onions" etc.
— but deliberately NOT "Garlic Powder" when you bought "Garlic". `runOnce()`
drops snoozed targets *before* collecting search terms, so neither the cloud nor
the Sheng Siong runner looks for them; the page lists them under "Recently
bought · not searched".

⚠️ The Notion integration now needs **write** access: "Insert content"
capability, and the **grocery List** DB shared with it. Reading alone is no
longer enough.

**One-tap (no server, no cost):** tap **⚡ enable one-tap** at the foot of the
page and paste a fine-grained PAT (this repo, Contents: read/write). The page
then fires `repository_dispatch` at the same workflow straight from the browser
— `api.github.com` allows cross-origin calls, so nothing sits in between. The
token lives only in that browser's localStorage. Any failure (no token,
revoked, JS off) falls back to the two-tap issue flow. See
`docs/one-tap-add.md`.

**Two people share this** (the user + partner: same Telegram chat, same grocery
List DB, same page link). The partner needs **no GitHub account** — send her
`…/#add-token=TOKEN` and one tap sets her up (the page stores it and strips the
fragment). Use a separate PAT per phone so one can be revoked alone. Simultaneous
adds are safe: the workflow has **no `concurrency` group** on purpose (it would
cancel pending runs and lose adds — LEARNINGS 2026-07-30) and the cooldown push
rebases and retries instead. For the two-tap fallback from a non-owner account,
add the login to the `ADD_EXTRA_LOGINS` repo variable, or the workflow ignores it
silently.

The `addToGroceryList` webhook in `src/index.ts` does the same relay from a
Notion Worker. Kept, but **not deployed and not recommended** — it costs the
Workers billing floor and can't read its own response.

### Item actions: Reset / Not in use

Each row under "Recently bought · not searched" has two buttons, taking the same
road as Add (pre-filled issue by default, one tap when a token is saved) but
routed to `.github/workflows/item-actions.yml` — deliberately a separate workflow
from `add-to-list.yml`, since undoing a snooze has a different blast radius from
writing to Notion.

- **Reset** — clears that cooldown, so the next daily run searches the item again.
- **Not in use** — tags the Notion ingredient **`Not in Use ATM`** (which
  `readGroceryTargets` already skips) *and* clears the cooldown, so it leaves the
  page too. Asks for confirmation first, because undoing it means removing the tag
  by hand in Notion.

Both are live and proven in production. Two rules baked into `src/core/park.ts`:
the tag is **appended** to the row's existing tags, never assigned over them (they
are the item's search config), and the write **refuses** unless the option already
exists on the property — this tool never invents Notion schema.

Issue titles use a fixed **`Item: `** prefix, which is what the workflow's
allowlist matches, so renaming a button can't break the two-tap path.

## Commands (run from repo root, needs `.env`)

- `npm run push-ss` — residential runner: fetch terms → SS scan → write
  `data/shengsiong-latest.json` → git push. `--force` / `--no-push`.
- `npm run build-site` — full scan → `public/index.html`, `summary.json`,
  `targets.json`. (Uses the SS file by default; `SHENGSIONG_LIVE=1` for live SS.)
- `npm run dry-run` / `npm start` — scan + (dry: print / real: send Telegram).
- `npm run ss -- tofu milk` / `npm run fp -- tofu` — test a store module (live).
- `npm run deals` — cross-store deal list to console.
- `npm run targets` — resolved active-plan grocery targets.
- `npm run add -- --payload '<json>'` — add one item to the grocery list and set
  its cooldown by hand. `--dry-run` prints the plan without writing anything.
- `npm run item-action -- --payload '<json>'` — the Reset / Not in use half.
  `{"v":1,"action":"reset"|"park","key":"…","ingredientId":"…","name":"…"}`.
  `--dry-run` reads Notion but writes nothing.
- `npm run check` — typecheck.

## Key technical facts (details in LEARNINGS.md)

- **Notion SDK v5** = query `dataSources.query`, NOT `databases.query`. Ingredients
  data source `34b69a18-4fe7-80e6-904e-000b208cf560`. Property names have
  typos/trailing spaces — match exactly (`Price,SGD`, `Catagory`, `Unit type `,
  `Weight /Units of New Product `, `Used '1'/'2'/'3' Plan`).
- **Active plan** = read `Used 'N' Plan` formula (N from `ACTIVE_PLAN_NUMBER`,
  default 1). `readGroceryTargets()` reads the WHOLE grocery inventory (excludes
  `Suppliments`/`Filler` categories) and flags `inActivePlan`.
- **FairPrice** = SSR-scrape `GET /search?query=`, parse `__NEXT_DATA__`; weight
  from `metaData.DisplayUnit` (the `Weight` field is wrong).
- **Sheng Siong** = Meteor DDP over WebSocket (`wss://shengsiong.com.sg/websocket`,
  `ws` lib). Method `Products.getByAllSlugs(filters, misc, page, size)` — 4
  positional args; query in `filters.searchFilter.slug`. Weight from `packSize`.
  ⚠️ **`ecommPromotionFilter.active` is not inert scaffolding** — `true` returns
  ONLY promoted products, which silently hid the rest of the catalogue until
  2026-07-31 (28 of 70 terms returned nothing). `search()` now runs the term
  **twice**, `true` then `false`, and merges on `slug`; both are needed because
  the server truncates by relevance at `PAGE_SIZE` (50) and promoted items can
  fall past the cut. `page` is cumulative, not an offset — ask for a bigger page
  rather than paginating. See LEARNINGS 2026-07-31.
  **Incapsula** answers the DDP handshake with a `200` challenge instead of
  upgrading — always from datacenter IPs, and since 2026-07-30 intermittently from
  residential ones too, which is why the runner now needs Chrome (see above).
- **Match quality** = `FORM_WORDS` negative filter in `compare.ts` (rejects
  "Banana"→"Banana Milk", "Butter"→"Peanut Butter", etc.). Soft matches fixed by
  renaming the ingredient in Notion.
- **Price/units — TWO dimensions.** Most items compare per 100g and display per kg
  (per L for volumetric ml/L items). Items counted in pieces (`By Unit` — eggs,
  slices, tea bags) compare **per piece**, because that's how they're bought and
  planned; the card then reads `$0.222 each` and brackets `[30 pcs]`. Which one is
  used is decided **per candidate, by what the shop published**: a count → per
  piece; only a weight → per 100g against a size written into the item's own name,
  e.g. `Bread, Wholemeal, [FairPrice] (600g)`. Every FairPrice bread is
  weight-only and nearly every egg carton carries a count, which is why both
  routes exist. `Deal.dimension` says which; never read `baseline`/`productPrice`
  without checking it.
- **Guards on the per-piece route** (counting hides size where weight doesn't):
  pieces only compare when both stated sizes are within **2.5×**, and a plain
  "egg" item rejects another bird's / preserved / cooked eggs — without that,
  "Eggs, Whole, small" accepted *Cooked Quail Eggs* at 24% off.
- **A size in `( )` is a size, not a defining property.** Properties are hard
  requirements on the product title, and no shop prints your pack size, so `(600g)`
  used to demand the literal word "600g" and matched nothing.
- **`packSize` vs `packWeightG` vs `monthlyAmount` vs `monthlyAmountG`:** the first
  of each pair may be a piece count. Anything mixing with a product's weight
  (monthly saving, cooldown length) must use the `…G` figure — otherwise "40 slices
  a month" reads as 40 grams and one loaf buys a year of silence.
- **Adding items** is pure Notion: the runner has no hardcoded list — it fetches
  terms live from the Pages `targets.json` (which the cloud rebuilds from Notion).

## Remaining work (all optional)

1. ~~Schedule → 10:00 SGT~~ **done** — `daily.yml` runs `cron: "0 2 * * *"`
   (02:00 UTC = 10:00 SGT), which also gives the laptop more morning windows to
   push before the cloud reads.
2. ~~By-Unit (eggs) comparison~~ **done** 2026-07-30 — both dimensions, see above.
3. ~~Bump `actions/*` off Node 20~~ **done** 2026-07-30 — checkout v7, setup-node
   v7, configure-pages v6, upload-pages-artifact v5, deploy-pages v5, plus
   `actions: read` which deploy-pages has wanted since its v4.
4. **Watch the Incapsula situation.** The mint works, but it's a WAF that changed
   once and can change again. First signal will be the ⚠️ banner / Telegram line,
   not silence. If Chrome stops clearing it, the next rung is a real browsing
   profile or an anti-detection browser — *not* a solving service.
5. **Phone runner** — blocked by the above (no Chrome on Termux); optional anyway.
6. ~~Sheng Siong returning 0 for terms it clearly stocks~~ **done** 2026-07-31 —
   it was `ecommPromotionFilter.active: true` restricting every search to
   promoted products. Both passes now merge; 437 → 1166 products, 19 → 25 deals.
7. ~~Lentils returning nothing~~ **done** 2026-07-31 — see "Naming an item so the
   shops can find it" below.
8. Optional: more `GENERIC_FORM_PATTERNS` / variety tuning as false matches
   appear. Still-empty searches are genuine naming problems, not pricing ones:
   `Whey`, `Muscovado Sugar`, `Pu Erh`, and the `omega 3 enriched` egg variants.
   Each is fixed the same way lentils were — find the word the shop actually
   indexes, then rename in Notion and/or add a synonym.

## Naming an item so the shops can find it (worked example, 2026-07-31)

When a search returns 0 from a shop, the usual cause is that **the item is named
after a word the shop does not index** — not a pricing or blocking problem.
Measure before changing anything; `npm run ss -- <term>` and
`npm run fp -- <term>` answer it in seconds. For lentils:

| query | Sheng Siong |
| --- | --- |
| `lentil` | **0** |
| `dhall` | **10** — Masoor Dhall Split, Toor Dhall, Channa Dhall … |
| `masoor` | 3 |
| `dal` | 10, but **every one is DALEE frozen duck** |

Two fixes, and both were needed:

1. **Notion**: the ingredient was renamed `Lentil (…)` → **`Dahl (…)`**, so the
   base noun folds onto the shop's spelling. This is the user's call, not the
   code's — renaming in Notion is the intended fix for a bad search term.
2. **`synonyms.json`**: `lentil` / `lentils` → `dhall`, plus `channa` →
   `chickpea`.

Three things this taught, worth reusing:

- **Direction matters.** Synonyms fold both the query and the candidate, but
  only one direction puts a *findable* word into the search. `dhall → lentil`
  would have kept querying a word neither shop indexes.
- **Add the plural explicitly.** Synonyms are applied BEFORE stemming, so
  `\blentil\b` never matches "Lentils" — which is exactly how FairPrice titles it
  ("Shahi Golden Masoor Dhal Split - Red Lentils").
- **A short synonym can collide with a brand.** `dal` looks like the obvious
  entry and is the worst one: it returns ten DALEE duck products. It is safe
  only because it folds to `dhall` before it is ever used as a query.

⚠️ **A synonym change takes TWO runs to reach Sheng Siong.** The runner does not
compute search terms — it fetches them from the deployed
`targets.json`, which only the cloud rebuilds. So: push → **cloud run**
(regenerates `targets.json`) → **runner scan** (uses the new terms) → cloud run
(uses the new data). Left alone this resolves itself in about a day; to do it
now, trigger `daily.yml`, then `npm run push-ss -- --force`. Verify with
`curl -s <pages-url>/targets.json`.

## Gotchas for whoever continues

- **A green tick is not a working system.** The wrapper returned 0 no matter what,
  so Task Scheduler showed success while every search failed for a day. Whenever
  you add a scheduled step, ask what it looks like when it *fails* — and make that
  reach the user. That's why a missing shop now hits the page and Telegram, and why
  the daily message sends even with zero deals.
- **Driving Chrome over CDP — three traps, all hit in one evening:**
  - *Never hardcode the debug port.* A leftover Chrome still holds it, the new one
    starts with no debugger, and `/json/list` answers from the **stale** browser —
    so you drive a browser you never navigated. This is the entire reason a
    hand-run mint worked and the scheduled one didn't.
  - *Killing the spawned pid does not kill Chrome.* Its first process exits and the
    browser re-parents. Close over CDP, then kill the tree, then sweep by the
    launch's own unique profile path.
  - *Don't detect a challenge by looking for `_Incapsula_Resource`.* Incapsula
    injects that into the **real** page too. Detect the challenge by what it is:
    ~950 bytes, no `<title>`, "Incapsula incident".
- **A retry that launches a browser needs a circuit breaker.** One failing mint,
  retried by 70 searches, left 42 stray Chrome processes.

- **Workflow files push normally** (fixed 2026-07-29). The `gh` token previously
  lacked the `workflow` scope, so `.github/workflows/*` had to go through the
  GitHub web editor; `gh auth refresh -s workflow` settled that for good. If a
  push is ever rejected with "refusing to allow an OAuth App to … workflow",
  check `gh auth status` for the `workflow` scope and re-run that command.
  (`gh auth refresh` reported "not logged in" from one PowerShell window while
  working fine elsewhere on the same machine, same binary, same credential —
  never explained. `gh auth login -s workflow` works from that state.)
- **Fine-grained PAT (phone/laptop push):** Repository access must be **All** or
  **Only select repositories** (NOT "Public repositories", which locks perms
  read-only), and Repository permission **Contents: Read and write** (add via
  "+ Add permissions" → search "Contents", then set the access dropdown — "Read
  and write" is the *level*, not a searchable permission name). Most reliable auth
  = bake the token into the remote URL (two slashes after `https:`!). The laptop
  uses Credential Manager instead, so it needs no PAT.
- **PowerShell** wraps native-command stderr as red `NativeCommandError` — not a
  real failure; check the actual message/exit code.
- Don't paste tokens where they'll appear in screenshots/scrollback — two PATs were
  burned that way during setup (both since deleted).
