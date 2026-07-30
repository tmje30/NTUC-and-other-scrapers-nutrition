# Handover — Grocery Deal Scraper

Read this first, then `LEARNINGS.md` (deep technical detail + gotchas) and
`CHANGELOG.md` (what shipped). Memory files also auto-load via `MEMORY.md`.

## TL;DR

A daily job reads the user's Notion **Ingredients** DB + active plan, scrapes
**FairPrice** and **Sheng Siong** for cheaper prices per 100g/kg (per L for
liquids), and posts **one Telegram message → a GitHub Pages page** listing the
deals. **It is LIVE and self-running, including Sheng Siong.**

Sheng Siong is blocked from datacenter IPs, so it runs via a **residential-IP
hybrid**: a runner (the user's **laptop**, daily) scans Sheng Siong and commits
`data/shengsiong-latest.json`; the cloud reads that file. FairPrice runs in the
cloud directly. If the file is missing/stale the page degrades to FairPrice-only.

## Live system

- **Repo:** https://github.com/tmje30/NTUC-and-other-scrapers-nutrition — **PUBLIC**
  (Pages needs public on the free plan; no secrets in repo), branch `main`.
- **Live page:** https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/
  (two sections: "In your plan" + "Other items on offer"; cards show
  `Item [packsize]  −%`, `$/kg · $/100g`, `store · product`, `uses ~X/month`).
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
  `npm run push-ss`, logs to `..\push-ss.log`.
- **Task:** Windows Task Scheduler **"ShengSiong Daily Scan"**, daily 05:30 SGT.
  `StartWhenAvailable` (runs if the laptop was off/asleep at 05:30), runs on
  battery, `InteractiveToken` (runs as the logged-in user → Git Credential Manager
  auth works, **no PAT stored**). Registered from `..\task.xml`.
- **Self-gating:** `push-ss` skips if today's SGT-dated file already exists, so
  extra runs are instant no-ops. `--force` rescans; `--no-push` skips git.
- To reconfigure the task: `schtasks /Query|/Run|/Change|/Delete /TN "ShengSiong
  Daily Scan"`. Check it ran: `type C:\Users\newuser\shengsiong-runner\push-ss.log`.

### Phone runner (optional redundancy — PAUSED)

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
  **Incapsula blocks datacenter IPs** (DDP handshake gets a `200` challenge instead
  of upgrading); works from residential IPs, no browser needed — hence the hybrid.
- **Match quality** = `FORM_WORDS` negative filter in `compare.ts` (rejects
  "Banana"→"Banana Milk", "Butter"→"Peanut Butter", etc.). Soft matches fixed by
  renaming the ingredient in Notion.
- **Price/units:** compare per 100g; display per kg (per L for volumetric ml/L
  items — `volumetric` flag on `StoreProduct`).
- **Adding items** is pure Notion: the runner has no hardcoded list — it fetches
  terms live from the Pages `targets.json` (which the cloud rebuilds from Notion).

## Remaining work (all optional)

1. ~~Schedule → 10:00 SGT~~ **done** — `daily.yml` runs `cron: "0 2 * * *"`
   (02:00 UTC = 10:00 SGT), which also gives the laptop more morning windows to
   push before the cloud reads.
2. **Finish the phone runner** (Termux scheduling) — optional redundancy; see above.
3. Optional: By-Unit items (eggs) comparison; bump GH Actions `actions/*` versions
   (Node 20 deprecation warning); more `FORM_WORDS` tuning as false matches appear.

## Gotchas for whoever continues

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
