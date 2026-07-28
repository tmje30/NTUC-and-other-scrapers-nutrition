# Handover — Grocery Deal Scraper

Read this first, then `LEARNINGS.md` (deep technical detail + gotchas) and
`CHANGELOG.md` (what shipped). Memory files also auto-load via `MEMORY.md`.

## TL;DR

A daily job reads the user's Notion **Ingredients** DB + active plan, scrapes
**FairPrice** and **Sheng Siong** for cheaper prices per 100g/kg (per L for
liquids), and posts **one Telegram message → a GitHub Pages page** listing the
deals. **It is LIVE and self-running.** FairPrice works everywhere; Sheng Siong
is blocked from the cloud (see blocker below) — the next phase fixes that with a
phone/laptop hybrid.

## Live system (deployed, working)

- **Repo:** https://github.com/tmje30/NTUC-and-other-scrapers-nutrition — **PUBLIC**
  (Pages needs public on the free plan; no secrets in repo), branch `main`.
- **Live page:** https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/
  (two sections: "In your plan" + "Other items on offer"; cards show
  `Item [packsize]  −%`, `$/kg · $/100g`, `store · product`, `uses ~X/month`).
- **Schedule:** GitHub Actions `.github/workflows/daily.yml`. **Currently 06:00 SGT**
  (`cron: "0 22 * * *"`). ⚠️ User wanted **10:00 SGT** (`"0 2 * * *"`) — NOT yet
  applied (needs a one-line web-editor edit; see TODO).
- **Telegram:** reuses the user's Notion-Worker bot **@Big_Notion_Bot**, chat
  `7626546412`. Secrets `NOTION_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
  are set as GitHub Actions secrets. Locally they live in `.env` (gitignored).
- **Runtime:** portable Node/TS core (`src/core/`), run with `tsx`. Node 22+.

## Commands (run from repo root, needs `.env`)

- `npm run build-site` — full scan → writes `public/index.html` + `summary.json`.
- `npm run dry-run` / `npm start` — scan + (dry: print / real: send Telegram).
- `npm run ss -- tofu milk` — test Sheng Siong module.
- `npm run fp -- tofu` — test FairPrice module.
- `npm run deals` — cross-store deal list to console.
- `npm run targets` — resolved active-plan grocery targets.
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
- **Match quality** = `FORM_WORDS` negative filter in `compare.ts` (rejects
  "Banana"→"Banana Milk", "Butter"→"Peanut Butter", etc.). Soft matches fixed by
  renaming the ingredient in Notion.
- **Price/units:** compare per 100g; display per kg (per L for volumetric ml/L
  items — `volumetric` flag on `StoreProduct`).
- **Gotcha:** dotenv v17 prints a promo banner to stdout — load with
  `config({ quiet: true })`. It once corrupted a piped GitHub secret.

## The blocker

**Sheng Siong's Incapsula blocks GitHub's datacenter IP** — the DDP WebSocket
handshake gets a `200` challenge instead of upgrading ("DDP websocket:
Unexpected server response: 200"). It works fine from a **residential IP**
(local), with NO browser needed (plain Node DDP). FairPrice has no such wall.
Confirmed it's IP-reputation based (browser headers didn't help). The user's
other project (`C:\Users\newuser\Claude\Inventory Price upkeeper worker [Notion]`,
`Price-Scout Template`) hits the same class of wall and solves it by driving the
user's REAL local Chrome over CDP — i.e. it also runs locally/residential.

## Agreed next phase: phone/laptop hybrid (DESIGNED, NOT YET BUILT)

Keep FairPrice in the cloud; run Sheng Siong from a residential IP. User has an
**Android phone** (always on them, 500 GB data) = primary runner; **laptop** =
fallback; cloud FairPrice = floor.

**Design (approved by user):**
1. **Cloud (daily cron):** `build-site` scans FairPrice live, and reads a small
   `data/shengsiong-latest.json` for Sheng Siong. If that file's `date` == today
   (SGT) → cross-store page; else → FairPrice-only. Also publish the search-terms
   list to Pages (`public/targets.json`) so runners can read it without a token.
   Deploy page + send Telegram (unchanged path).
2. **Phone (primary, Termux/Android):** a tiny job shortly before the cron —
   fetch terms from the public `targets.json` (no login), run the **Sheng Siong
   scan only** (residential IP, no browser, KB-sized), and **push**
   `data/shengsiong-latest.json` to the repo. Skip if today's file already exists.
3. **Laptop (fallback, Task Scheduler):** the SAME script; runs only if the phone
   didn't push today's file.
4. **Fallback chain:** phone → laptop → cloud-FairPrice. One shared page.

**Nice properties:** phone carries only ONE narrow secret — a fine-grained GitHub
PAT (this repo, contents: write). No Notion/Telegram tokens on the phone. No Pages
or workflow-file changes needed.

**To build:**
- `src/scripts/push-shengsiong.ts` (runs on phone + laptop): fetch terms → live
  Sheng Siong scan → write `data/shengsiong-latest.json` {date, results:
  {searchTerm: StoreProduct[]}} → git commit+push (skip if already fresh today).
- Cloud: a file-backed Sheng Siong source that reads `data/shengsiong-latest.json`
  (used by `run.ts` in place of the live SS module when in cloud); `build-site`
  writes `public/targets.json`.
- Setup guides: Termux (install node/git, clone, schedule via cron/termux-job-
  scheduler + wake-lock + battery-optimization exemption) and Windows Task Scheduler.

**User must do (with guidance):** create the fine-grained GitHub PAT; set up
Termux on the phone (~10 min) + the laptop scheduled task.

**Caveat:** Android may skip the phone job some days (Doze/battery) — the laptop +
cloud-FairPrice fallback absorbs that.

## TODO (priority order)

1. **Build the phone/laptop hybrid** (above) — the main next task.
2. **Schedule → 10:00 SGT:** edit `.github/workflows/daily.yml` line 6 to
   `cron: "0 2 * * *"` (and the comment) via the GitHub **web editor**
   (https://github.com/tmje30/NTUC-and-other-scrapers-nutrition/edit/main/.github/workflows/daily.yml)
   — a local push can't touch workflow files (token lacks `workflow` scope; the
   non-interactive `gh auth refresh` device-flow does NOT work from the agent shell).
3. Optional: By-Unit items (eggs) comparison; bump GH Actions `actions/*` versions
   (Node 20 deprecation warning); more `FORM_WORDS` tuning as false matches appear.

## Gotchas for whoever continues

- **Workflow files** can't be pushed with the current `gh` token (no `workflow`
  scope) — the user edits them via the GitHub web editor. `gh secret set` and
  normal file pushes DO work.
- **PowerShell** wraps native-command stderr as red `NativeCommandError` — not a
  real failure; check the actual message/exit code.
