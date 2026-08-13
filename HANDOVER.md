# Handover — Grocery Deal Scraper

Read this first, then `LEARNINGS.md` (deep technical detail + gotchas) and
`CHANGELOG.md` (what shipped). Memory files also auto-load via `MEMORY.md`.

*⚠️ **Last reviewed 2026-08-11, and the review found three faults the code could
not show.** The runner had silently not scanned for two days, nothing had ever
started the Telegram inbox, and an empty scan had been pushed as a success. All
three are fixed — see "Next session" — but the lesson generalises: **before
writing any code here, check what actually ran.** `push-ss.log`,
`Get-ScheduledTaskInfo`, and the `date` inside `data/shengsiong-latest.json`
answer in under a minute, and a green tick from any one layer means nothing.*

*⚠️ **Code-reviewed 2026-08-12, and the one bug worth the trip was a repeat.** A
thousands separator made a $1,500 Carousell listing read as **$1** — and because
deals rank by percentage saved, it sorted to the top of the page. That is the same
comma that broke iHerb's weights the day before, in a different file. Fixed, along
with a workflow-output hardening and two dead helpers; five copies of `sgtDate` and
two of `report()` became one module each. **Two findings were left alone on
purpose** — the stock-template README (because the Notion worker may yet be built
here) and `exclusions.ts`'s missing tests. Read "Two findings deliberately left
alone" under "Next session" before touching either.*

*The system is live and self-running. The parts most
likely to bite a newcomer, all flagged ⚠️ below: the Incapsula browser mint, the
two comparison dimensions, and — for the Chrome extension — the fact that
FairPrice's JSON-LD is invalid on **every** product while Sheng Siong publishes
no readable data at all.*

*⚠️ **Before you diagnose ANY shop as blocked, read "Your IP decides what you can
scrape" below.** On 2026-08-05 a whole afternoon's conclusions about Watsons were
wrong because the machine was on a VPN. The same probe, same minute, gives
opposite answers from a datacenter address and a residential one.*

*⚠️ **And read the OTHER half of that lesson, 2026-08-11: a shop can render
products and then take them away.** Watsons was declared a dead end twice, by two
sessions, on the honest evidence that a real browser shows only its footer. It
serves 52 prices and 96 product links at 7–16 s and is **wiped by ~22 s** — so
too-early and too-late produce the identical empty shell, and "never worked" is
indistinguishable from "you looked at the wrong moment". Never conclude a shop is
blocked from a single fixed delay; use `waitFor` (`browser-cdp.ts`). Full story:
**[`docs/session-2026-08-11-vendors.md`](docs/session-2026-08-11-vendors.md)**.*

*Short version of where things are. The macro work is finished and committed. The
2026-08-05 session did **no** feature work: it scoped the multi-vendor question
(searching shops beyond FairPrice/Sheng Siong), built a probe to answer it with
measurements instead of guesses, and found two live faults in the running system
— see "Infrastructure truths" below. **What's still outstanding is the same thing
it was yesterday**: nobody has yet pressed the extension, the nutrition lookup or
the four deal-card buttons in anger on a real shopping trip.*

## TL;DR

A daily job reads the user's Notion **Ingredients** DB + active plan, scrapes
**FairPrice** and **Sheng Siong** for cheaper prices per 100g/kg (per L for
liquids), and posts **one Telegram message → a GitHub Pages page** listing the
deals. **It is LIVE and self-running, including Sheng Siong.**

Sheng Siong is blocked from GitHub's IPs, so it runs via a **hybrid**: a runner
(the user's **laptop**, daily) scans Sheng Siong and commits
`data/shengsiong-latest.json`; the cloud reads that file. FairPrice runs in the
cloud directly. If the file is missing/stale the page degrades to FairPrice-only.

⚠️ **This was designed as a "residential IP" hybrid and that premise is WRONG**
(measured 2026-08-11). Sheng Siong challenges addresses **outside Singapore**; it
does not care whether they are residential or datacenter. A Singapore datacenter
address served a full 60-term scan while a US one was refused the same hour. The
laptop works because it is in Singapore, not because it is on a home line — so a
**Singapore VPS** could replace it, along with the Pi that was being considered.
See "RESOLVED: the constraint is the COUNTRY" under *Your IP decides what you can
scrape*. Nothing has been migrated; the hybrid below is still what runs.

⚠️ **A VPS may not be needed either (proved 2026-08-12, evening).** A Cloudflare
Durable Object created with `locationHint: "apac"` landed in Singapore on 15 of 16
attempts and stayed there, and a Worker in that colo already scans Sheng Siong
clean. That closes the last open question — an unattended cloud job *can* be put in
Singapore, for free. **Still not migrated**, and drift beyond a few minutes is
unproven. See *Next session — pick up here (as of 2026-08-12, evening)*.

There is a second, **manual** way in: the **Chrome extension** in `extension/`
("Nutrition Plan Extension"), which captures a product page you're looking at
straight into the Ingredients DB — either as a new row or over an existing one.
Unlike the daily job it writes to **Ingredients**, not the grocery List, and it
only ever acts on a button press. See its section below.

Since 2026-08-04 the **deals page can write to Ingredients too**: each card's
**Add** files the discovered product as a new row, and **Replace** re-bases the
ingredient that seeded the search on it. So there are now three doors into
Ingredients — the extension, the history page and the deals page — and they share
`src/core/ingredient-write.ts` rather than each having their own.

⚠️ **Changed 2026-07-30:** Incapsula now challenges *residential* IPs too, not
just datacenter ones. The runner therefore needs **Google Chrome installed** — it
launches Chrome briefly to earn a session cookie when (and only when) it gets
blocked. See "Incapsula" below. A missing shop is no longer silent: it shows on
the page and in the daily Telegram message.

⚠️ **Changed 2026-08-09 — where a price is stored moved entirely.** The Ingredients
DB's baseline columns (`Price,SGD`, `Weight /Units of New Product `,
`Vendor, Current `) are gone or renamed `… - Delete? `, and the **price book**
(`Vendor 1..4` + `Price [Vendor n]` + `Size[Vendor n]` + `URL [Vendor n]`) is now the
only record of any price, with `Price,SGD [Cheapest]` and friends as formulas over
it. Every Add/Replace writes a vendor slot. This had already broken the daily scan
silently — it was finding **zero** targets. Full story:
**[`docs/session-2026-08-09-price-book.md`](docs/session-2026-08-09-price-book.md)**;
rules in `src/core/vendor-slots.ts`.

⚠️ **Also changed 2026-08-09 — Buy now writes `Price per kg/L` and links
`List [Ingredients]` directly.** Both columns already existed on the live
`grocery List` schema, unused. Buy now fills `Price per kg/L` with the
discount listing's own $/kg or $/L (read straight off the deal card, not
recomputed), and sets `List [Ingredients]` to a relation pointing at the
**existing** Ingredients page the deals-page matcher already picked — never a
new page. The row `Name` also changed shape, from `Ingredient, Brand, size` to
`Ingredient (size) [Brand]`. See "Add to grocery list" below, and
**[`docs/session-2026-08-09-buy-button-price-per-kg.md`](docs/session-2026-08-09-buy-button-price-per-kg.md)**
for the full story, including a live write/read-back/archive test.

⚠️ **New 2026-08-11 — the price book fills itself, and asks when it isn't sure.**
`vendor-scan` now routes **NTUC, Sheng Siong, Guardian, My Protein, Carousell,
Watsons and Iherb** (was three). The first live `--write` recorded **50 prices**
across NTUC and Sheng Siong on rows that had **none** — 49 Sheng Siong slots were
tagged and every one was empty. A pick it is uneasy about (a catering pack, a size
read off a range, a marketplace rescue) is **not written**: it is queued to
`data/vendor-review.json` and asked about on a **fourth page, `review.html`**, with
one Telegram message linking to it.
⚠️ **"Don't use" is a PRICE BOOK decision and does not touch the deals page** — the
single exception is its `wrong-item` reason, by explicit decision. `ALL_ITEMS`
("ignore forever") stays the deals page's own red Ignore. See
**[`docs/session-2026-08-11-vendor-review.md`](docs/session-2026-08-11-vendor-review.md)**.
⚠️ **Watsons, Iherb, Carousell and Shopee are LAPTOP-ONLY** — headless is detected
by all four, so they cannot run in GitHub Actions.

⚠️ **New 2026-08-10 — the first INBOUND path: text your list to the bot.**
`npm run tg-poll` long-polls Telegram on the laptop, parses a texted grocery list,
matches each line to Ingredients, and writes the `grocery List` rows itself. Lines
it isn't sure about it asks about with inline buttons; lines that match nothing
get priced at the shops and published as a third page, `new-items.html`. Runs on
the laptop for the same reason the Sheng Siong scan does — pricing a new item
means asking Sheng Siong, and Sheng Siong answers a residential IP.
Everything about it is free: no Notion Worker, no model call, no paid lookup.
See "Telegram intake" below.

⚠️ **Changed 2026-08-11 — the inbound path moved to a WEBHOOK, and the poller is
retired.** A list texted at ~18:20 was answered at **21:11**: the laptop entered
Modern Standby at 18:26 and Telegram held the message for 2 h 45 m. Nothing was
broken — nothing was awake. A Cloudflare Worker (`relay/`) now takes the webhook and
fires `repository_dispatch` at `.github/workflows/tg-inbox.yml`, which runs the same
inbox code via `npm run tg-handle`. Reply in **20–60 s with the laptop shut**.
⚠️ **A bot has a webhook OR serves `getUpdates`, never both**, so this REPLACES
`npm run tg-poll` — leave the poller running and it 409s on every call and the chat
looks dead. ⚠️ **Pricing a brand-new item still needs the laptop** (Sheng Siong
challenges datacenter IPs): those items queue in `data/tg-inbox-state.json`, the chat
says so, and `npm run tg-drain` prices them every 15 minutes.
⚠️ **Added 2026-08-12 — a question nobody answers is filed after ONE HOUR.** Asked for
by the user: an unanswered near-miss used to leave the line nowhere at all. After
`ASK_TTL_MS` the item goes onto the grocery List **as typed — Name only, no
Ingredients relation, no price, and nothing created in the Ingredients DB** — the
buttons are replaced with the outcome and the chat gets one summary. The clock is the
relay Worker's **Cloudflare cron** (every 15 min → `tgsweep` → `tg-sweep.yml` →
`npm run tg-sweep`), because GitHub's `schedule:` is queued by hours here; real
deadline 60–75 min. Before the relay is deployed the poll loop sweeps instead, so it
only fires while the laptop is awake. Switch-over order,
secrets, verification and the way back:
**[`relay/README.md`](relay/README.md)**; the why:
**[`docs/session-2026-08-11-telegram-webhook.md`](docs/session-2026-08-11-telegram-webhook.md)**.
⚠️ **Check the sleep log before diagnosing a quiet bot:**
`Get-WinEvent -ProviderName Microsoft-Windows-Kernel-Power` (506 = entering standby,
507 = exiting). A sleeping process leaves no trace in any application log — the
silence looks exactly like an idle poller.

### Session notes

Deep dives on one session each, kept for the *why*:

- [`docs/session-2026-08-11-vendors.md`](docs/session-2026-08-11-vendors.md) — **Watsons renders, then gets wiped**; the `waitFor` fix, iHerb's capsule counts, Guardian in maintenance, and ⚠️ **the comma that turned `1,500 g` into `1.5 g` in the price book**
- [`docs/session-2026-08-11-telegram-webhook.md`](docs/session-2026-08-11-telegram-webhook.md) — **the inbox moves to the cloud**: a texted list answered 2 h 45 m late because the laptop slept, and the Cloudflare relay that fixes it ⚠️ **a bot has a webhook OR `getUpdates`, never both — this REPLACES the poller**
- [`docs/session-2026-08-11-vendor-review.md`](docs/session-2026-08-11-vendor-review.md) — **the daily scan's shops now fill the price book**, and the scan's third answer: *"not sure — you decide"* ⚠️ **"Don't use" ≠ "ignore forever"; never write one into `exclusions.ts`**
- [`docs/session-2026-08-11-price-per-kg.md`](docs/session-2026-08-11-price-per-kg.md) — **`$399.00/kg` for a box of eggs**: a piece count read as grams, and the `packWeightOf` rule that fixes it (all three sites now fixed)
- [`docs/session-2026-08-09-vendor-scan.md`](docs/session-2026-08-09-vendor-scan.md) — **the price book fills itself** from Guardian/MyProtein/Carousell; 7 of 9 tagged slots written live ⚠️ **supersedes four per-vendor claims in `vendor-scoping.md`**
- [`docs/session-2026-08-09-buy-button-price-per-kg.md`](docs/session-2026-08-09-buy-button-price-per-kg.md) — Buy writes price/kg and links Ingredients directly
- [`docs/session-2026-08-09-price-book.md`](docs/session-2026-08-09-price-book.md) — the price book replaces the baseline
- [`docs/session-2026-08-03-extension.md`](docs/session-2026-08-03-extension.md) — the Chrome extension
- [`docs/vendor-scoping.md`](docs/vendor-scoping.md) — searching shops beyond FairPrice and Sheng Siong ⚠️ column inventory partly superseded

## Live system

- **Repo:** https://github.com/tmje30/NTUC-and-other-scrapers-nutrition — **PUBLIC**
  (Pages needs public on the free plan; no secrets in repo), branch `main`.
- **Live page:** https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/
  Sections, in order: "🔻 On sale now", "In your plan", "Other items on offer",
  "Close matches · not exactly what you asked for", "Recently bought · not
  searched". Cards show `Item [packsize] Price $x  −%`, the found product, price
  per kg/L **or per piece**, and `uses ~X/month`. A ⚠️ banner under the header
  means a shop was missing from the scan.
- **Four pages, not one:** `index.html` (deals), `history.html`, `new-items.html`
  and — since 2026-08-11 — **`review.html`**, every price the vendor scan was
  unsure about, with OK / Don't-use buttons. ⚠️ Unlike `new-items.html` it has
  **no freshness gate**: a pending question makes no claim about today and gating
  it would silently drop it. Staleness is handled per-question by `prunePending`
  (7 days). The empty state renders rather than 404s, because the Telegram link is
  unconditional and a 404 reads as broken.
- **Cloud schedule:** GitHub Actions `.github/workflows/daily.yml`,
  `cron: "0 0 * * *"` = 00:00 UTC = **08:00 SGT**, plus manual `workflow_dispatch`.
  ⚠️ **08:00 is a FLOOR on when the shops are scraped, not the delivery time**
  (set 2026-08-11; was `0 2 * * *`). A discount read at 5am may not be the one on
  the shelf. GitHub queues free-repo crons by ~3–3¾ h and the scrape happens when
  the run STARTS, so both the scrape and the digest land about **11:30 SGT**.
  See "Infrastructure truths". "It didn't run" is usually "not yet".
- **Telegram:** reuses the user's Notion-Worker bot **@Big_Notion_Bot**, chat
  `7626546412`. Secrets `NOTION_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
  are GitHub Actions secrets. Locally they live in `.env` (gitignored).
- **Runtime:** portable Node/TS core (`src/core/`), run with `tsx`. Node 22+.

## How the hybrid works

```
Laptop (Task Scheduler, 05:30 SGT)        Cloud (Actions, runs ~11:30 SGT)
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
- **Catching up after a missed run:** the two halves heal at different times. A
  laptop shut at 05:30 runs the missed scan when it wakes (`StartWhenAvailable`),
  so Sheng Siong prices land in the repo by mid-morning — but the 10:00 page was
  already built FairPrice-only and nothing looks again. The **Rescan** button in
  the page's ⚠️ banner closes that gap: it fires `repository_dispatch: rescan` at
  `daily.yml`, which rescans, redeploys Pages and re-sends the Telegram digest.
  Open the laptop first (it scans by itself), then press Rescan. No token ⇒ the
  button links to the workflow page, where *Run workflow* does the same job.

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

### Phone runner (SHELVED 2026-08-11 — do not pick this up)

⚠️ **The user's decision, 2026-08-11: "we won't be doing the phone setup now."**
Everything below is kept as a record of what was built and proven, **not as
pending work.** Do not start on the Termux scheduling, the battery settings or the
PAT recipe unless the user reopens it — they read as a live TODO list and they are
not one.

Two reasons it is shelved rather than merely paused: the laptop already covers the
runner role, and — since the VPN measurements the same day (see "OPEN QUESTION"
under *Your IP decides what you can scrape*) — the residential-IP premise the phone
existed to serve may not hold at all. If a server can do this, the phone is
redundant twice over.

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

## Telegram intake — texting a grocery list (added 2026-08-10)

```
  you text:  2kg chicken breast   →  one match ≥0.70  →  grocery List row, with the
             1L milk                                      ingredient's own price,
             bananas x6                                   vendor and $/kg, and a
             harissa paste                                List [Ingredients] relation
                                  →  several close   →  "which of these?" — one
                                                        button per candidate row
                                  →  nothing close   →  "nothing looks like this" —
                                                        create it, or just price it
                                        both asks also carry:
                                          🔎 No — re-search   (the next tranche of rows)
                                          🆕 New item — create in Ingredients
                                          ✖️ Cancel — typo    (forget the line)
```

⚠️ **The keyboard's ORDER is load-bearing, and `src/tests/intake-candidates.test.ts`
pins it.** Candidates first, one per row; then re-search; then create; then
**Cancel, always last**. The button that discards a line sits furthest from the
candidates, so a thumb aiming at the last ingredient cannot land on it. Every ask
carries all three ways out even when nothing matched at all — a new item still
needs somewhere to go, and a typo still needs forgetting.

### ⚠️ The ask asks "which one", not "is this it" (rewritten 2026-08-11)

The three faults the first live run exposed were all one shape — *the flow looks
like it worked* — and all three are fixed together, because they are the same
conversation:

- **Fault 28 — a tie was invisible.** `bestRow` returned the single highest
  scorer and kept the FIRST on a tie, so `1 x milk` linked silently to
  `Milk (Low Fat)` only because Notion returned that row earlier; reorder the
  query and the same text files against `Milk ( Normal)`. Both scored **1.000**.
  ⚠️ **The bug was the QUESTION, not the threshold.** The rule asked "is the best
  match good enough?" when what decides whether to ask is "**is there only
  one?**" — and those come apart precisely on the short generic words people
  text. Lowering `ACCEPT` would not have helped (1.000 beats any threshold) and
  would have made every confident single match nag.
  `rankRows` now returns the whole ranked list; `candidatesFor` keeps everyone
  within **`CANDIDATE_MARGIN` (0.05)** of the leader; `decideItem` links silently
  only when the leader clears `ACCEPT` **and is alone**. Ties break by name, so
  the same question always produces the same buttons.
- **Fault 30 — a "new" item reached no list.** It was queued, priced, published
  on a page, and never written anywhere you shop from. Both ways out now sit on
  every ask:
  - **`🔎 No — re-search`** — *"a different ingredient that is similar"* (the
    user's own words, 2026-08-11). It looks again at the **Ingredients DB**, not
    at the shops, skipping everything already offered. ⚠️ It deliberately ignores
    the review bar: being asked at all means the confident answers were already
    turned down, so "nothing else is close" is a worse answer than a faint one
    the user can see and reject.
  - **`🆕 New item — create in Ingredients`** — creates the row *and* puts the
    item on the grocery list against it, which is the half that fixes the fault.
    It confirms first, showing exactly what it will write, because creating a row
    in a live personal workspace has no undo. ⚠️ **Cancelling that confirm returns
    to the question**, it does not settle it — "I didn't mean create" and "forget
    this line" are different statements, and there is a button for each.
- **`✖️ Cancel — typo`** (added 2026-08-11, on request) — forgets the line
  entirely: it leaves the pricing queue and nothing is written. ⚠️ Safe to tap
  precisely *because* nothing has been written yet — a near-miss is only written
  once answered — so there is nothing to undo, only a queue entry to remove. It is
  the cheap way out of `chicken tight`, which would otherwise cost a Notion row to
  delete and a page to un-publish.
- **Fault 29 — a tap could be acknowledged and thrown away.** See below.

⚠️ **The new row is marked `{New}`, in BRACES, and the brackets are not
interchangeable** (the user's choice on 2026-08-11, from three options). `( )` is
a **defining property** in this project's bracket standard — a hard requirement on
the product title — so `(New) Harissa Paste` would demand the word "new" from
every listing at every shop, match nothing, and appear in no section of the deals
page, while looking perfectly ordinary in Notion. `{ }` is the *ignored* bracket:
stripped from the search term and from every matching decision. It marks the row
unreviewed to a human and is invisible to the scan.
`src/tests/intake-candidates.test.ts` pins the contrast in both directions.

⚠️ **The created row gets a `Catagory` guess and a `Unit type `, and NO price or
size.** The unit type is inferred from what was typed — `2kg` → By Gram, `1L` →
By ml, `x6` → By Unit, nothing → By Gram — the same inference
`fieldsFromPurchase` makes from a pack. Price and size belong to a **vendor
slot**, and a slot holding a size with no price and no shop is not a price-book
entry but a half-fact `readBaseline` would have to step over. The shop scan fills
those in properly. The category is resolved against Notion's **live options** at
write time and dropped if absent — this tool never invents schema.

### ⚠️ `$399.00/kg` for a box of eggs — a count read as grams (fixed 2026-08-11)

**Caught by reading the live grocery list back**, not by any test. The bot had
filed `egg (Omega 3 Enriched) (550g)` with `Price per kg/L` = **$399.00/kg**. It
is a **$3.99 box of ten**.

`Size[Vendor n]` holds whatever `Unit type ` says it holds, so on a By-Unit row it
is a count of eggs. The sum divided by it as though it were grams:
`3.99 ÷ 10 × 1000 = 399` — which is genuinely *the price of a thousand eggs*, then
labelled per kilogram. ⚠️ `pricePerKgLabelFor`'s own header claimed it refused to
do exactly this; its guard was a falsy check, which a count of `10` sails through.
**The comment described the intent and the code did the opposite** — worth
remembering when a doc comment is the only thing asserting a rule.

Three answers, in the order they were tried:

| | eggs, $3.99 for 10, `(550g)` in the name |
| --- | --- |
| divide by the count | ❌ `$399.00/kg` |
| refuse outright | ⚠️ blank, when the row plainly states 550 g |
| **divide by the weight** | ✅ **`$7.25/kg`** (the user's call) |

So `packWeightOf()` in `notion.ts` is now the one rule for what a pack weighs, and
**both** readers use it — `readGroceryTargets` for the deal comparison and
`readIngredientRows` for the texted list. A counted row with no stated weight
quotes **per piece** instead (`$0.40/pc`), which is the figure you use at the
shelf between a box of 10 and a box of 30.

⚠️ **Notion's own `Cheapest Price/Kg ` formula was never wrong** — it prints
`3.99 /10 pc` on these rows, i.e. it already knows they are counted. The bad
number was this project's, in the grocery List's `Price per kg/L`. Two columns,
two databases, one of them ours: check which you are looking at before
diagnosing.

⚠️ **Rows already written keep their bad figure.** Only the eggs row was affected
(every other list row is By-Gram/By-ml, where `size` really is grams).

✅ **The two remaining places in `vendor-scan.ts` are now fixed too** (same day,
later session — the one that owns that file). `referencePer100g()` divided
`pricePer1000` by 10 and called it a per-100g price — `$39.90/100g` against a true
`$0.73` on the eggs row — which made every genuine listing fall below the
counterfeit floor and be discarded, with an authoritative-looking reason; it now
divides by `packWeightOf()` per slot. `slotLabel()` in `scripts/vendor-scan.ts`
printed `/kg` unconditionally; one `perLabel()` helper now serves both it and the
`✓` line, quoting **what will be stored** rather than the product's own
`pricePer100g`. Full detail in
[`docs/session-2026-08-11-price-per-kg.md`](docs/session-2026-08-11-price-per-kg.md).
⚠️ Note `pricePer1000` itself is **not** the bug — its header is careful, and
comparing slots within one row is valid. The fault is only ever labelling its
output "/kg" or mixing it with a real per-100g figure.

### ⚠️ A parked row is offered here, and picking it wakes it (2026-08-11)

**Found by texting the live bot**: "2L milk, skimmed" came back offering
`Milk ( Normal)` and `Milk (Low Fat)` at 0.65 each, and **not** `Milk (Skimmed)`,
which scores **1.000**. It was not scored badly — it was invisible.
`readIngredientRows` dropped every row tagged `Not in Use ATM` alongside the
`Don't Search` ones, so the single row the user meant was the one row that could
not be offered.

The user's call: **texting an item is an explicit "I am buying this" and outranks
a snooze set weeks ago.** So:

- Parked rows are read, flagged `parked`, and offered with a **💤** on the button.
- ⚠️ **A parked row is NEVER linked silently, however well it scores** —
  `decideItem` forces the ask. Picking one un-parks it, which is a write to a tag
  the user set by hand, and that must be a deliberate tap rather than the
  by-product of a confident match.
- Picking one calls `unparkIngredient`, which removes **only** that tag. A failure
  is reported and does not lose the list line that was already written.

⚠️ **`Don't Search` is a different tag and is still dropped outright.** The two
look alike and are not: one is this tool's own reversible snooze, the other is the
user's permanent instruction, and nothing in this repo may write, clear or offer a
button that undoes it. `unparkIngredient` refuses on such a row independently, so
the rule is enforced twice.

⚠️ This makes the inbox's view **wider than the deals page's** — 90 rows against
84 before the change. That asymmetry is intentional: the scan pushes items at you
and must respect the snooze; the inbox answers a question you asked.

⚠️ **A question about a `new` item does NOT block the shop scan; a near-miss
does.** `maybeDrain` gates on `blocking` rather than on `pending` being empty. A
near-miss must block — until it is answered we don't know whether the item is new
at all — but an optional "shall I file this?" left unanswered would otherwise mean
a batch containing one unfamiliar item never gets priced.

Run it with `npm run tg-poll` (`--once` to drain and exit, `--no-push` to skip the
commit/dispatch). It long-polls `getUpdates`, so it answers in about a second and
costs nothing to leave running.

### ⚠️ The webhook flow supersedes everything in this subsection (2026-08-11)

**Read [`relay/README.md`](relay/README.md) first.** Once the Cloudflare relay holds
the webhook, `npm run tg-poll` cannot run at all — a bot has a webhook *or* serves
`getUpdates`, never both, so the poller 409s on every call and the chat looks dead.
The scheduled task below is **disabled** in that configuration and replaced by
`Grocery New-Item Pricing` → `tg-drain-run.cmd`, a 15-minute batch job that only
prices items the cloud couldn't.

Everything below is kept because it is still exactly right for the *poller*, which
remains the documented way back (`npm run tg-webhook -- delete`, re-enable the task)
and the way to run the inbox with no Cloudflare account at all. The three things that
differ in the webhook flow: state lives in **`data/tg-inbox-state.json`** (committed,
merged) rather than `.sessions/`, there is no offset, and new-item pricing is deferred
rather than immediate.

⚠️ **The one-hour auto-file works in both flows, from different clocks** (2026-08-12).
The poller sweeps inside its own loop, so it is accurate to ~25 s but only runs while
this machine is awake; the webhook flow gets its clock from the relay Worker's
Cloudflare cron instead, which is why that configuration is the one that actually keeps
the promise. Either way the decision itself is `expiredAsks` in `src/core/tg-inbox.ts`
and the write is `writeItem(deps, item, null)` — the same unlinked row.

⚠️ **The poller ran as a scheduled task from 2026-08-11, because until then nothing
started it.** The inbox existed only while someone remembered to launch it by hand — and
a bot that answers only when watched doesn't look off, it looks broken. It is
also what made fault 29 possible: a button tapped with no poller running is
answered by nobody, and when one finally starts, Telegram refuses the stale
callback id and the tap is consumed and lost.

- **Task:** `Grocery Telegram Inbox` → `tg-poll-run.cmd` (in the repo root — see
  below). Triggered **at logon**, then **repeated every 15 minutes** with
  `MultipleInstances: IgnoreNew`, so a repeat while the poller is alive does
  nothing and a repeat after it died starts it again. **That repetition is the
  supervisor**; there is no other one. `ExecutionTimeLimit` is **0 (none)** — this
  process is meant to run for days, and any limit would eventually kill it
  mid-poll. `RestartOnFailure` 3 × 5 min covers a crash between repetitions.
- ⚠️ **It runs in the DEV clone, not `shengsiong-runner\repo`** — it needs
  `NOTION_TOKEN` and `TELEGRAM_BOT_TOKEN`, and the `.env` holding them lives
  there; the Sheng Siong clone deliberately has no `.env` at all. Two
  consequences: the poller runs whatever source is checked out (a broken tree
  crash-loops it, visibly, in the log), and `commitAndPushData` refuses to reset
  a dirty tree, so a session's edits are never sacrificed to publish a page.
- **Log:** `C:\Users\newuser\shengsiong-runner\tg-poll.log`, beside the scan's,
  rolled by the wrapper past ~5 MB — a process that retries a dead network every
  5 s is a slow leak otherwise. `runInbox` catches a failed poll, waits 5 s and
  carries on, so sleep/wake and dropped Wi-Fi need no help from the scheduler.
- ⚠️ **`tg-poll-run.cmd` is in the repo and the task points straight at it** —
  unlike `run.cmd`, there is no live-copy-plus-reference-copy pair to keep in
  step, because there is only one copy. Don't create a second one.

To check it is up: `Get-ScheduledTaskInfo -TaskName "Grocery Telegram Inbox"`
(`LastTaskResult` **267009** = still running, which is the healthy state), or look
for the `tg-poll` node process. `npm run tg-diag` remains the answer to "why isn't
it seeing my messages".

⚠️ **This project has its own bot as of 2026-08-10: `@Grocery69_bot`.** It both
sends the daily digest and serves the poller — one bot, both directions — and
`TELEGRAM_BOT_TOKEN` alone configures it. `TELEGRAM_INBOX_BOT_TOKEN` exists for
the case where the two roles need different bots and is normally **blank**;
`config.telegramInboxBotToken()` falls back to the outbound token, and that
fallback is the expected path, not a degraded one.

⚠️ **Why it needed a bot of its own.** The project used to send through
`@Big_Notion_Bot`, and that bot has a webhook pointing at the user's deployed
Notion Worker (`.../telegramWebhook`) — the only way their calendar/notes bot
receives anything. A bot can have a webhook **or** serve `getUpdates`, never
both, so a poller on that token gets `409 Conflict: can't use getUpdates method
while webhook is active` on every call and the chat simply looks dead: messages
arrive, they go to Notion, and the poller sees nothing. Discovered the hard way
on 2026-08-10 — "I wrote the list and nothing happened". **Sending** through a
webhooked bot was always fine; only polling is refused.

⚠️ **`deleteWebhook` is NOT the fix and must never be run on `@Big_Notion_Bot`.**
It is the only delivery path the Notion Worker has, and removing it breaks that
worker silently, in a different project.

⚠️ **The GitHub Actions secret `TELEGRAM_BOT_TOKEN` is a separate copy** — the
cloud sends the daily digest with whatever is stored there, not with `.env`. Move
the two together or the digest arrives from a different bot depending on where
the run happened. (Harmless, just confusing.)

The chat id does not change between bots: `TELEGRAM_CHAT_ID` is positive, so it
is a private chat, and a private chat's id **is** the user's Telegram user id —
identical for every bot they talk to. A new bot still has to be **Started** once
before it may message you first.

`npm run tg-diag` answers "why isn't it seeing my messages" in one command:
which bot the token belongs to, whether a webhook is stealing the updates, and
what is queued. It is read-only and peeks at `offset: 0`, so it can never
acknowledge a message the poller hasn't handled.

- **Where the pieces are.** `list-parse.ts` (quantity grammar, pure),
  `list-intake.ts` (Ingredients reader + the three-way verdict),
  `tg-inbox.ts` (the loop, state, buttons), `new-items.ts` (shop scan + page),
  `scripts/tg-poll.ts` (git push + `repository_dispatch`).
  `grocery-list.ts` gained `addTextedItem()` beside `addToGroceryList()`.
- **Why the laptop and not the cloud.** Pricing a new item means asking Sheng
  Siong, which challenges datacenter IPs. The cloud could only ever answer
  FairPrice-only. The laptop already runs the 05:30 scan for exactly this reason.
  ⚠️ Unlike `push-shengsiong.ts`, this process holds `NOTION_TOKEN` **and**
  `TELEGRAM_BOT_TOKEN` — it has to, since filing the row is the point. Keep it off
  the phone runner, which deliberately carries only a narrow GitHub PAT.
- ⚠️ **A size and a count are different numbers.** `2kg chicken` is one thing
  weighing two kilos; `chicken x2` is two things. They go to different columns and
  reading one as the other is silent. `list-parse.test.ts` pins every form.
  A near-miss of the same kind: `1.5kg flour` had its `1.` stripped as a list
  number and became `5kg` — the numbering pattern now requires trailing
  whitespace, and there is a test for it.
- ⚠️ **`addTextedItem` leaves unknown columns blank, never zero.** An ingredient
  with an empty price book has no price to quote, and `Price , To Buy ` = $0.00
  does not read as "unknown", it reads as free. It also adds `count` to `Amount `
  rather than 1 — texting "eggs x6" twice means twelve.
- ⚠️ **A near-miss asks one question per message**, not one message with six sets
  of buttons. A mis-tap here points `List [Ingredients]` at the wrong ingredient
  and quotes that ingredient's price — the row then reads perfectly and is about a
  different food. The buttons are replaced with the outcome once answered, so a
  settled question can't be tapped again. **One candidate per keyboard ROW**, never
  two side by side: these labels are ingredient names, and Telegram shrinks text to
  fit, so two columns is two truncated names and a coin flip between two foods.
- ⚠️ **The offset is persisted AFTER handling.** Telegram treats a fetch at an
  offset as an acknowledgement of everything before it: advance early and a crash
  loses the message, never advance and it replays forever. A crash mid-batch
  re-runs the batch, which the grocery list's title dedupe absorbs.
  ⚠️ **It advances even when the handler THREW, and that stays deliberate** — the
  alternative turns one poison update into an infinite loop blocking every message
  behind it. What changed on 2026-08-11 is that the failure now **says so in the
  chat** ("I dropped that one — …"). One line to a console nobody is watching was
  what let fault 29 look like success.
- ⚠️ **Clearing the button spinner may never gate the work** (fault 29, fixed
  2026-08-11). `handleCallback` used to `await answerCallback(cb.id)` *before*
  deleting the pending entry and doing the write. The user tapped while no poller
  was running; by the time one started, Telegram had expired the query id
  (`"query is too old and response timeout expired"`), the await threw, and the
  handler aborted before writing anything — while the offset advanced. `ack()`
  now swallows that failure and logs it. A spinner nobody is still watching is
  worth nothing; the write is worth everything.
- ⚠️ **Only the configured chat is answered.** The bot token is shared with the
  user's Notion Worker bot; anything from another chat is dropped in silence.
- **Nothing here spends money.** No macro lookup, no model call — see "Nothing
  spends money unasked". Parsing is deterministic and reuses `match.ts`, so the
  synonyms, exclusions and thresholds are the ones already tuned for the scan.

### `new-items.html` — the third page

⚠️ **A new-item card makes a different claim from a deal card, on purpose.** Every
deal card is "cheaper than the price you already record"; a new item has no
recorded price, so there is nothing to be a percentage of. The card shows each
shop's best listing with its $/kg or $/L, marks the cheapest, and shows a `−%`
**only** where the shop itself flags a sale against its own list price.

⚠️ **It searches FIVE shops, not the daily scan's two** (added 2026-08-10, same
day). FairPrice, Sheng Siong, **Guardian, MyProtein and Carousell** — the last
three already had working store modules but were reachable only through
`vendor-scan.ts`, which asks a shop *only when an Ingredients row names it in
`Vendor 1..4`*. A brand-new item has no row, so under that rule it would only ever
be searched at the two supermarkets — exactly backwards, since an item with no row
is the one you least know where to buy. The directed-search rule exists to stop an
automated scan writing a price into a slot the user didn't ask for; this writes
nothing to Notion, so it doesn't apply. List is `NEW_ITEM_SHOPS` in `new-items.ts`.

⚠️ **Carousell is reduced with `cheapestPlausible`, never with the minimum.** On a
marketplace the cheapest listing is usually the scam, and here there is no
recorded price for the item, so `vendor-scan.ts`'s reference floor cannot run —
the median guard is the only one left. An unpriced marketplace listing is
**dropped**, not kept as a whole-pack fallback the way a real shop's is: with no
size there is nothing to take a median over, so it can't be guarded at all. Every
marketplace offer is labelled `[marketplace listing]` on the card, because a
stranger's asking price sitting unlabelled beside an NTUC shelf price reads as the
same kind of number. `src/tests/new-items.test.ts` pins the contrast: the same
five listings reduce to $2.00 at a real shop and $45.00 on a marketplace.

⚠️ **It uses the LIVE Sheng Siong module, never `shengsiong-file`** — and this was
a real bug for the few hours between the two commits on 2026-08-10. The file
reader answers only the terms in that day's committed daily scan, and a new item's
term is never among them, so Sheng Siong returned **zero results, silently, every
time**: no error, no warning, just a shop quietly absent from every new-item card.
The scan only ever runs on the residential runner, which is where the live module
works. Don't "simplify" this back to `run.ts`'s `STORES`.

⚠️ **It carries no Buy / Add / Replace buttons, and that is not an omission.** All
three write through an `AddPayload`, which requires the id of an **existing**
Ingredients page. A new item has none, and the alternative would be making that
field optional across a live write path.

⚠️ **A new item is priced here and lands on the grocery list only if you say so.**
This section used to claim "The texted item is already on the grocery list by the
time the page exists — the bot put it there", which was **false** (corrected
2026-08-10): `handleMessage` wrote a row only for a `linked` verdict, so a texted
item the DB didn't know got a price comparison on a web page and appeared on **no
list**. Since 2026-08-11 every new item is offered
**`🆕 New item — create in Ingredients`**, which creates the row *and* writes the
list line against it — see "The ask asks which one" above. Declining still gets
you the page, which is the old behaviour and often the right one: you wanted to
know what harissa paste costs, not to start stocking it.

Hand-off is the Sheng Siong pattern exactly: the laptop writes
`data/new-items-latest.json`, commits, pushes, and fires
`repository_dispatch: newitems` at `daily.yml`; `build-site.ts` renders the page
alongside the other two. A file not dated today is skipped rather than published —
a page headed "New items" showing last week's prices is worse than no page. No
`GITHUB_TOKEN` just means the page waits for the next daily run instead of
appearing immediately.

## Add to grocery list (+ cooldowns)

Each deal card has a **Buy** button on the left. The page is static, so it
can't hold a Notion token: Buy opens a **pre-filled GitHub issue** ("Add: Milk",
payload in a ```json block), you tap Submit, and
`.github/workflows/add-to-list.yml` does the privileged half —

⚠️ **It was called "Add" until 2026-08-04, and only the LABEL changed.** The CSS
class, the `AddPayload`, the `grocery-add` issue label, the `Add: ` title prefix
the workflow's allowlist matches, and `add-to-list.yml` itself are all still
`add`. It was renamed on the page because a second button called **Add** now sits
on the same card and writes to **Ingredients** instead — two buttons saying "Add"
that hit different databases is exactly the mis-tap worth a rename. Renaming the
machinery too would have broken every in-flight issue for nothing, so don't.

1. writes the row to the Notion **grocery List** DB: Name
   `Fish sauce (750ml) [Knife Brand]` — the ingredient, then the PACK SIZE and
   BRAND of the listing on offer, which is how you pick it off the shelf —
   `Price , To Buy ` = the discounted price, `Current Price ` = what you pay for
   your own pack, `Vendor ` = the store, **Amount left empty**. Column names are
   resolved from the live schema, not hardcoded — they drift (see LEARNINGS
   2026-07-29).
   ⚠️ **Brand and size were added to the Name on 2026-08-06**, from `p.brand` and
   a shelf label built in `shelfSize()`. Both are optional segments: a shop
   publishing no brand (~4% of Sheng Siong listings) still gives a clean line, and
   an in-flight issue raised before the fields existed produces the shorter title
   rather than throwing. ⚠️ The brand is verbatim — **never** with "brand"
   appended, because `Tiger Brand`, `Snow Brand` and `House Brand` are real brand
   names. ⚠️ A brand the ingredient name already states is not repeated, so
   `Fish Sauce [Knife]` does not become "Fish Sauce [Knife] (750ml) [Knife]".
   ⚠️ A counted pack reads `30 pcs`, not the grams `packSizeG` holds for the
   cooldown.
   ⚠️ **The title's shape changed again on 2026-08-09**, from the comma-joined
   `Ingredient, Brand, size` to `Ingredient (size) [Brand]` — parens for the
   pack, brackets for the brand. Same optionality and de-dup rules as above,
   just a different separator. See `groceryRowTitle()` in `grocery-list.ts`.
   ⚠️ **Also since 2026-08-09**, two more columns are written on a new row:
   `Price per kg/L` — the discount listing's own $/kg or $/L, taken straight
   off the deal card (`pricePerKgLabel()` in `site.ts`), blank for a
   piece-priced product — and `List [Ingredients]` — a **relation** to the
   Ingredients page the deals-page matcher already picked
   (`AddPayload.ingredientId`). This links to the EXISTING page; it never
   creates one. Neither is rewritten on a repeat tap (same rule as
   price/vendor/amount — their column, their value, once set). Full story:
   [`docs/session-2026-08-09-buy-button-price-per-kg.md`](docs/session-2026-08-09-buy-button-price-per-kg.md).
   ⚠️ **Name carried a `[NTUC] ` prefix until 2026-08-06.** The shop was always
   written to `Vendor ` as well, so the prefix only duplicated it; the list reads
   better as a column of names beside a column of shops. Consequence: the shop is
   now recorded in **exactly one place**, so a `Vendor ` column that stopped
   resolving would lose it silently (only a console warning — it used to survive
   in the title).
   ⚠️ **What `findOpenRow` dedupes on moved twice in one day, so read it here
   rather than assuming.** It matches the whole title. Dropping the vendor prefix
   briefly made that "one row per ingredient, across shops"; adding brand and size
   narrowed it again to **one row per (ingredient, brand, pack size)**. So the same
   listing tapped twice still collapses to one row — which is the double-tap this
   guard exists for — while two genuinely different packs list separately, which is
   right: they are different things to buy. Only a shop that publishes neither
   brand nor size falls back to ingredient-only matching;
2. records a **cooldown** in `data/cooldowns.json` and commits it;
3. comments the result on the issue and closes it. **No Telegram ping** — the
   user gets one daily digest and doesn't want adds narrating themselves.

**Cooldown = `pack size ÷ monthly usage × 0.75`** — the 25% haircut brings the
item back before the cupboard is empty, leaving a window to catch a deal. 1 kg
of garlic at 500 g/month → 2 months of cover → **46 days**. No monthly usage
(anything outside the active plan) → flat **14 days**.

⚠️ **Unless the row is tagged `Weekly Buy` (added 2026-08-05), which is checked
FIRST and skips the sum entirely: flat 5 days, whatever was bought.** Some things
are bought on a rhythm rather than when they run out — bananas are a weekly shop
whether you came home with three or a dozen — so a bigger pack must not buy more
silence. Left to the formula, a 2 kg buy against 1 kg/month goes quiet for 46
days: six weeks of not being shown a fruit the user buys every week. Five and not
seven for the same reason the sum keeps its haircut.

The tag rides in the `AddPayload` (`weeklyBuy`, optional so an issue still open
from an older page parses and simply takes the old route), set by `addPayload()`
at page-build time from `PlanTarget.weeklyBuy`. It is **not** a matching rule — a
weekly item is searched, scored and priced exactly like any other. `planCooldown`
now takes its flags as an options object rather than a fourth and fifth positional
boolean, because `planCooldown(a, b, now, true, true)` is a call nobody can read.
⚠️ The failure mode here is silent in both directions: dropped, the pack size wins
and a staple disappears for six weeks; applied too widely, every cooldown collapses
to 5 days. `src/tests/cooldown.test.ts` pins both ends. Entries are keyed on the
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

### ⚠️ Two taps at once — how the data files stay merged (fixed 2026-08-05)

Both write workflows commit a JSON file and push. Tap twice within a few seconds
— which is exactly how the page gets used — and the second push is rejected.

**The old recovery was `git pull --rebase`, and it did not work.** Rebasing
replays the commit, and two entries appended to the same JSON array seconds apart
is a *content* conflict, so the rebase died and took the run with it — **after**
the page had already shown "✓ ignored". Measured damage on 2026-08-05: 3 of 9
item-action runs failed and three real corrections were silently lost (two
`Ignore for good`, one `Mismatch`). Nothing surfaced it; the entries simply were
not in `data/exclusions.json` afterwards.

The retry now takes the new remote **wholesale** and re-applies this run's own
change on top:

```
push rejected → git fetch && git reset --hard origin/main
              → npx tsx src/scripts/merge-data.ts /tmp/data-base /tmp/data-mine data
              → commit, push again (5 attempts)
```

- `/tmp/data-base` is snapshotted **before** the apply step, `/tmp/data-mine`
  **once** after the commit — not per attempt, or a third run landing mid-retry
  gets picked up as if it were ours.
- ⚠️ **It is a three-way merge, not a union.** These files are not append-only:
  `reset` removes a cooldown and `never-buy` settles a purchase. A union would
  resurrect exactly what someone just removed. Rule: start from theirs, drop what
  I removed, upsert what I added or changed, leave the rest alone. Where they
  removed something I merely edited, the **removal wins** — re-adding a cooldown
  the user just cleared re-silences an item they asked to see again.
- ⚠️ **A `concurrency` group is still not the answer.** GitHub keeps only *one*
  run pending per group and cancels the rest, so a burst of taps would lose the
  middle ones outright (LEARNINGS 2026-07-30). That note stands.
- Identity per list lives in `DATA_FILES` in `src/core/merge-data.ts`. ⚠️ A
  blocked product is `(key, url)` — **not** `key` alone, because every
  `Ignore for good` writes `key: "*"` and keying on that would collapse two
  different products into one. That was the second correction lost that morning.
- `src/tests/merge-data.test.ts` (21 cases) replays the real 06:17 collision.
  The first run of it caught a genuine bug: the "append mine" pass resurrected
  entries the *other* run had removed.

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

### `Don't Search` — the permanent version (added 2026-07-31)

A second `Select` option the **user** sets by hand in Notion. Same effect as
`Not in Use ATM` — `readGroceryTargets()` drops the row, so it is never
searched, never compared, and appears in no section of the page — but the two
must not be conflated:

| | who writes it | undone by |
| --- | --- | --- |
| `Not in Use ATM` | this tool (the page's "Not in use" button) | meant to be undone |
| `Don't Search` | the user, in Notion | **nothing here.** Permanent |

**Nothing in this repo may ever write, clear, or offer a button that undoes
`Don't Search`.** `park.ts` is already safe: it only ever *appends* to the tag
list, so a hand-set tag survives every write.

Both tags are dropped in one place — `readGroceryTargets()` in
`src/core/notion.ts` — which is why a tagged row cannot leak into the page via
some other path. Currently 5 rows carry it (53 → 48 targets), including the two
omega-3 `Egg Yolk` / `Egg White` rows; the whole-`egg` row is *not* tagged and
is still searched.

⚠️ **Compare tags through `normTag()`, never with `===`.** The option was first
created as `Don'r Search` (an `r`) and renamed by hand the same day. Both
spellings are listed in `DONT_SEARCH_TAGS`, and `normTag` folds case, curly
apostrophes and stray spacing. A suppression tag that silently stops matching is
the worst kind of bug: everything keeps "working" and the user gets back items
they asked never to see again.

### Correction menu — teaching the matcher (added 2026-08-02)

The `⋯` button under the percentage on every deal card (and under *closest* on a
close match) holds three actions. The point of all three is that they **teach the
matcher**, rather than just hiding today's card:

- **Ignore for good** — the permanent product block described in "Ignore" below.
  ⚠️ **It moved here from the CTA column on 2026-08-05** and the weekly snooze
  moved out to the button, by request; see that section.
- **Mismatch item** — bans words for that item, permanently. The page proposes
  the title's words the item never asked for (`suggestExclusionTerms`), and the
  user edits the list before anything is saved — because "extra" honestly
  includes the brand.
- **Almost, but no** — blocks ONE product for ONE item, for a near-miss whose
  defining property can't be confirmed (the item wants unpasteurized; the shop
  doesn't say). There's no word to ban, so the product itself is the exclusion.

`src/core/exclusions.ts` (pure) + `exclusions-file.ts` → `data/exclusions.json`,
applied in `findDeal`/`findReview` and keyed by `cooldownKey`, so a correction on
"Onion (White)" also covers "Onion (not red)".

⚠️ A single-word term folds through the matcher's own tokenizer, so "tissue"
catches "Tissues". A **phrase** uses a separator-tolerant regex instead, because
stemming "3 in 1" yields "in" — which would have excluded most of the shop.

### The two ignores, and which is which (swapped 2026-08-05)

⚠️ **These two traded places on 2026-08-05, at the user's request.** Both *actions*
are exactly as they were — only the control that emits each one changed. Any older
note saying "the red Ignore button is permanent" describes the layout before this.

| control | action | scope | undo |
| --- | --- | --- | --- |
| **`Ignore 1wk`** — the button under Buy | `ignore-week` | the **ingredient** | Reset, from the foot of the page |
| **`Ignore for good`** — top of the `⋯` menu, red | `ignore-product` | the **product**, for every item | **none** — edit `data/exclusions.json` |

⚠️ **They are different scopes, not two durations of one thing.** The button
snoozes the *ingredient* (nothing is searched for it until Monday); the menu entry
retires a *product* (that listing never appears again, under any ingredient). A
permanent ingredient-level ignore is not this — that is the `Don't Search` tag the
user sets by hand in Notion.

The reasoning for the swap: the reversible correction is the one reached for most
often, so it belongs one tap away; the irreversible one belongs behind the
`<details>`, where it takes two.

⚠️ **Both are RED** (asked for the same day, after the weekly button briefly
shipped grey). So colour does NOT distinguish them — red marks "this takes
something off the page", and what separates the two is the label, the action and
the menu's extra tap. The weekly button carries `class="act week ignore"`: `week`
sizes it and lets the label wrap, `ignore` is the shared paint, reused rather than
copied so the two cannot drift to different reds in light or dark mode. It must
**not** pick up the confirm dialog along with the class — there is a test for
exactly that.

⚠️ **`.cta { max-width: 78px }` is load-bearing.** The column is stretch-sized by
its widest child, so "Ignore 1wk" on one line widened it by ~45px and took that
straight out of the product name on a phone — the same width the four-row card
split was made to win back. Capped, the label wraps to two short lines. Widen it
and every card loses text. `.act.week` carries the `white-space: normal` that lets
it wrap; `.act.ignore` is now colour only, since `.panel .act` sizes it.

`src/tests/deals-page.test.ts` has a `deals page — the two ignores` suite that
pins the pairing: which control emits which action, that only the permanent one is
red and confirms, and that the issue titles name the product and the ingredient
respectively. Getting this backwards is invisible — both say "Ignore", both settle
on "✓ ignored", and the difference only surfaces days later as a product that
never comes back.

### Ignore for good — retiring a product outright (added 2026-08-03)

The red **Ignore for good** entry at the top of the `⋯` menu (the CTA-column
button until 2026-08-05). Unlike the other two corrections beside it, it is scoped
to the **product**, not the ingredient: this listing
is never offered again, **for any item**, permanently. The ingredient is untouched
— still in the plan, still searched, and every other product still competes for
it. That distinction is the whole point of the button, so it is repeated in the
confirm dialog, the issue body and the workflow's reply.

Mechanically it is a `BlockedProduct` under the key `ALL_ITEMS` (`"*"`), which
`exclusionReason` matches alongside the item's own key. A real key is a stemmed
base noun, so it can never be `*`. Adding one **replaces** any per-item blocks on
the same product (the narrower entries would say nothing new), and blocking an
already-ignored product is a no-op.

⚠️ There is no button that undoes it. Coming back means deleting the entry from
`data/exclusions.json` — hence the confirm dialog, which no other correction has
except *Not in use*.

### The deal card, as it now stands (redesigned 2026-08-04)

The card grew from "here is a cheaper price, want it on the list?" to "…and is
this what the ingredient should BE?". Five controls, in two groups:

```
[Buy]      Peanut Butter, Smooth                         −31%
[Ignore    [500g] Price $8.20                              ⋯
 1wk]      FairPrice · Skippy Peanut Butter Spread       [Add]
           [500g] $5.65 on sale (−15%)               [Replace]
           $11.30/kg vs $16.40/kg                    [Macros]
           uses ~400g/month                     has macro
```

- **Buy** / **Ignore 1wk** — left column. Buy is the one button pressed on
  purpose; the snooze beneath it is the correction reached for most often. Neither
  belongs beside the three quieter controls, which is why they stay in their own
  column, and the 12px gap stays even though the lower button is now reversible —
  a mis-tap still costs a week of not being offered the item.
  ⚠️ **Until 2026-08-05 the lower button was the permanent `Ignore`.** See "The two
  ignores" above.
- **Add** — file today's match into **Ingredients** as a NEW row.
- **Replace** — re-base the ingredient that *seeded* this search on today's match.
  Writes `Name` (a generic name derived from the product), `Price,SGD`,
  `Weight /Units of New Product `, `Unit type ` and `Vendor, Current `.
  Confirmed first; there is no undo.
- **Macros** — a per-card toggle, red when off, green and reading `+ Macros` when
  on. See "Nothing spends money unasked" below.
- **has macro / no macro** — on the usage line: whether this listing's nutrition
  is free to file.

⚠️ **Why the text is five short rows and not four long ones.** The three new
controls needed somewhere to live, and a floated rail only costs text width while
it is *taller* than the text beside it. Splitting "item [size] price" across two
lines makes rail and text the same height, so the rail is free — and the usage
line, which `clear: both`s below it, gets the full card width back. Undo that
split and every product name loses ~80px on a phone.

⚠️ **`Unit type ` is written by Replace even though it isn't in the four columns
the button advertises**, and it has to be: re-base a 500 g item onto a 1 L bottle
and the size column becomes 1000, but a stale `By Gram` then claims a kilogram of
liquid and every per-100g figure built on it is wrong. Size and its unit move
together or not at all.

⚠️ **`rebase-ingredient` is NOT `replace-ingredient`** — see `item-actions.ts`.
The history page's version does not rename and does write the URL; this one
renames and does not. The rename is load-bearing: a row's name is the search term
the daily scan uses, so re-basing without it leaves the scan hunting for the thing
you just replaced.

### Nothing spends money unasked (2026-08-04)

**The rule: no button on any surface may start a paid nutrition lookup on its own.**
Before this, adding a row looked macros up automatically whenever the four boxes
were empty — so an ordinary tap could quietly spend up to 29 cents on figures
nobody had asked for and nobody read.

| surface | how a lookup starts now |
| --- | --- |
| deals page | the **+ Macros** toggle, per card, off by default |
| Chrome extension | the **Find Macros** button, which fills the boxes *before* the row is written |
| history page | still automatic — see below |

⚠️ **The free panel is checked FIRST, before the toggle.** A product whose shop
published a nutrition table costs nothing even with **+ Macros** on, because the
shop's own label beats a model's answer. That order lives in `macrosFor()` in
`item-action.ts`, and it is why the `has macro` tag matters: it tells you which
case you are in before you decide whether to arm the toggle.

⚠️ **The history page's "Add to Ingredients" still looks up automatically**, by
passing `findMacros: true` explicitly. That is deliberate, not an oversight: the
default is now OFF everywhere, and this one button opts back in because filing a
purchase is a one-off deliberate act on something you already bought, unlike a
deals card you are still browsing. If that turns out to be the wrong call, delete
the flag — nothing else needs to change.

## History page — `public/history.html` (added 2026-08-03)

A second page on the same Pages site, linked from the footer of the deals page.
The deals page answers "what should I buy today"; everything it has to forget to
stay readable lives here. `src/core/history.ts`, built by `build-site.ts` in a
try of its own so a Notion hiccup can never take the deals page down with it.

Four sections:

- **Not in use** — every ingredient tagged `Not in Use ATM`, from
  `readParkedIngredients()`. This list exists because `readGroceryTargets` drops
  those rows so early that a parked item otherwise has no listing *anywhere* —
  park something in March and it is simply gone. **Reset** removes that one tag
  (`unparkIngredient`), preserving every other, and refuses outright on a row
  that also carries `Don't Search`.
- **Bought** — the purchase log, with three buttons per row.
- **Already filed** — the same rows once settled, kept as a record.
- **Never buy again** — the `ALL_ITEMS` blocks from `data/exclusions.json`, i.e.
  exactly what the red Ignore button writes. One mechanism, one file, so this
  list cannot disagree with what the scan actually skips. Listed but **not
  undoable from the page** on purpose.

### ⚠️ `cooldowns.json` is not a history — hence `data/purchases.json`

`withCooldown` and `withoutCooldown` both **drop expired entries on every
write**, by design: that file answers "what is suppressed right now". So there
was no record of what had been bought, and the history page needed one.
`src/core/purchases.ts` (pure) + `purchases-file.ts` → `data/purchases.json`,
appended by `add-to-list.ts` after the Notion row lands, and **never trimmed** —
it is the only place this system remembers a price it once saw.

The log started empty on 2026-08-03. Adds made before that are **not
recoverable**; the cooldown entries that recorded them have long since been
swept.

### The three buttons on a bought row

- **Add to Ingredients** — a NEW Ingredients row: generic Name, `Items Exact
  Name`, price, size, `Unit type `, `Catagory`, `Vendor, Current `, URL, plus the
  four macro columns. `src/core/ingredient-write.ts`.
- **Replace Current** — writes price, size, vendor and URL onto the *existing*
  ingredient row and nothing else. Unlike the Chrome extension's "Replace With
  This", it deliberately does **not** rename the row: there you are looking at a
  product page and chose the rename; here the button means "same thing, new
  price".
- **Never buy again** — the same `ALL_ITEMS` block as Ignore, plus it settles
  *every* open purchase row naming that product, not just the one tapped.

⚠️ `ingredient-write.ts` copies two rules from `extension/notion-client.js` and
they must stay in step: **a blank field is omitted, never written as null** (so a
missing size can't blank a size the row had), and **select values are validated
against the live schema** — an unknown option is dropped with a warning, never
created, because writing one makes Notion invent it.

### Macro lookup — `src/core/macros.ts`

Claude Sonnet 5 with `web_search` + `web_fetch`, run *before* the row is written
so the four columns land with it. Three tiers, recorded and reported: the product
page, then a search, then generic values for the food. The reply says which, and
flags generic values for checking.

The prompt's load-bearing instruction is that **state decides the numbers** —
raw vs cooked meat, dry vs boiled pasta — because a lookup that gets the food
right and the state wrong is worse than one returning nothing: nothing is
visibly missing and a wrong number quietly poisons the plan formulas.

Guards: `max_uses: 4` caps the per-tap cost; any figure outside 0–100 g is
dropped; protein + fat + carbs over 105 g rejects the whole answer (that shape
means per-serving figures read as per-100g). **Every failure path returns null
and the row is written without nutrition** — a macro lookup must never lose an
add.

⚠️ Needs `ANTHROPIC_API_KEY` (repo secret + `.env`). Unset is supported and
costs nothing: rows are created without nutrition and the reply says to fill it
in.

⚠️ **Cost: US$0.29–0.41 per lookup, NOT the 6–7 cents this file used to say.**
Measured 2026-08-04 over eight real calls. Input tokens are ~90% of the bill
(123k–280k per call — `web_fetch` drops whole 340–390 KB pages into context);
two searches were 2 cents of a 41-cent call. Fresh produce and raw meat now skip
the tools entirely and cost **~$0.003** (see "Nutrition, end to end" below).
`lookupMacros` prints tokens/searches/cost on every call — the 5× error survived
as long as it did because nothing printed it.

⚠️ **`web_fetch` cannot read Sheng Siong — it is in `UNFETCHABLE_DOMAINS`.**
Same Incapsula wall that forced the daily scraper onto DDP. It does not fail
fast, it *stalls*: measured 2026-08-03, one Sheng Siong lookup took **245s**
mostly waiting on a page that was never going to answer, then fell back to
search anyway. Blocking the domain sends it straight to search — the identical
answer in **51s**. FairPrice is deliberately not blocked; its pages are
server-rendered and often carry a real panel.

Belt and braces on top: `TIMEOUT_MS` 180s with one retry, against the SDK's own
10-minute/2-retry defaults. A timed-out lookup writes the row without nutrition,
which is the module's whole failure posture.

`npm run macro-test -- "<product>" [--url …] [--store …]` runs one lookup and
prints what would be written, touching nothing. Use it before trusting a new
food category, especially one where raw-vs-cooked matters.

The four Notion columns are in `ING_MACRO_PROPS`, and their names are the worst
in the schema — `Fats per 100 g ` has a space *before* the g **and** a trailing
one; `Carbs`/`Fiber` are trailing-space only; `Protein` has neither.

### Shared chrome

`src/core/page-chrome.ts` holds the stylesheet and the one-tap dispatch script
both pages use. Extracted from `site.ts` when the second page arrived — two
pages on one site that a user moves between should not be able to drift apart
visually.

## Chrome extension — "Nutrition Plan Extension" (added 2026-08-02)

`extension/` — capture a grocery product page straight into the Notion **Ingredients** DB. Modelled on the
sibling *Inventory Price Upkeeper* extension (`C:\Users\newuser\Claude\Inventory Price upkeeper worker
[Notion]\extension`), with its Unverified/verified review workflow, ABV and SKU removed, and Supplier
renamed to Vendor. Full detail in `extension/README.md`; the essentials:

- **Two writes, never automatic.** *Add to Ingredients* creates a row; *Replace With This* appears beside
  **each** similar existing row and repoints it at this product (asks first, showing before → after).
- **The naming split:** `Name` gets the generic title in the **user's bracket standard**, `Items Exact Name`
  the shop's full title + brand, verbatim. Done by `src/core/generic-name.ts`, deterministically.
  See "The bracket standard" below.
- Also writes `Price,SGD`, `Weight /Units of New Product `, `Unit type `, `Catagory`, `Vendor, Current `
  and `Vendor 1 URL`.
- **And the four per-100g nutrition columns** — read off the shop's panel where there is one, off its
  back-of-pack photo where there isn't, and looked up only when neither exists. See "Nutrition, end to end"
  below; that section, not this one, is where the cost and the gates are explained.
- `npm run ext:build` regenerates `extension/dist/` — **required after editing `synonyms.json`**, which is
  baked into the bundle at build time. `extension/dist/` is gitignored, so a fresh clone must build before
  the extension will load.

⚠️ **Where it reads prices from — don't "simplify" this.** FairPrice's product
JSON-LD is invalid on **every** product (0/40 pages parsed; a stray brace in
their template plus unescaped supplier text). `__NEXT_DATA__` is valid on 40/40,
but its INLINE copy goes stale on an in-site navigation. So the reader uses the
inline blob when its slug matches the URL and otherwise **re-fetches the page
same-origin** — 40/40 complete either way, with zero extra requests on a directly
opened page. See LEARNINGS 2026-08-03.

⚠️ **Sheng Siong works a completely different way.** It publishes nothing
readable — no JSON-LD, no meta tags, no server-rendered data, no `<h1>`, and one
site-wide `<title>`. So the extension asks the page's own Meteor app via
`Products.getOneByIdOrSlug` (the scraper's method), injected with
`world: "MAIN"` because a content script can't see `window.Meteor`. Returns a
numeric `netWeight`; the UNIT comes from `packSize`, or a 12 × 1 L carton files
itself as 12000 By Gram. See `extension/README.md`.

⚠️ **Three things that will bite whoever edits it:**

1. **API version 2025-09-03, not 2022-06-28.** This project's Notion dialect queries **data sources**
   (`/v1/data_sources/{id}/query`) and creates pages with `parent.data_source_id`. The reference extension
   speaks the old dialect — copying an endpoint across from it will 404.
2. **Property names are copied verbatim, typos and all** — `Catagory`, `Unit type `,
   `Weight /Units of New Product `, `Vendor, Current `. They live in `src/core/ingredients-schema.ts`, which
   `notion.ts` re-exports from so the scraper and the extension can't drift. "Correcting" a name silently
   breaks the write.
3. **It must never create Notion schema.** Both selects are validated against the live options before every
   write; a value Notion doesn't already have is refused, not sent. A stray select value becomes a permanent
   schema option, which is exactly what the global Notion rule forbids.

The extension imports `src/core/` (match, generic-name, categorize, ingredients-schema) — shared, not
copied. Nothing under `src/` imports from `extension/`; the sharing goes one way only.

## The bracket standard — how an ingredient `Name` is written

The user's own naming convention, read by `parseName` in `src/core/parse.ts`. **It
applies to `Name` and nothing else** — `Items Exact Name` is never parsed, only
written and displayed, and its job is provenance: what the shop actually called the
thing.

| | means | effect on the scan |
| --- | --- | --- |
| `[ ]` | brand | **never** part of the search text; a hard filter only when the row is tagged `Brand Specific` |
| `( )` | defining property | a **hard requirement** — a candidate failing it is never published as a deal, only surfaced as a close match |
| `{ }` | ignored | excluded from the search term **and** from every matching decision |

Two special forms inside `( )`: `(not red)` is a hard exclusion, and
`(Normal)`/`(Regular)`/`(Plain)` mean the basic range — identical to writing no
property, but they switch on variant exclusion, so `Milk (Normal)` rejects
low-fat / skimmed / flavoured / plant milk.

⚠️ **A parenthetical that is only a pack size — `(600g)`, `(6 x 250ml)` — is a
SIZE, not a property.** No shop prints your pack size, so treating it as a
requirement matched nothing. This is also how a By-Unit item counted in slices gets
a weight to be priced against.

**The extension proposes this shape** (`structuredName`, added 2026-08-04):

```
"Skippy Peanut Butter Spread - Creamy"  →  Peanut Butter Spread [Skippy] {Creamy}
"[BCRS] Farmhouse Milk - Fresh"         →  Milk [Farmhouse] {Fresh}
```

⚠️ **The variant goes in `{ }`, not `( )`, and that is deliberate.** `(Crunchy)`
would reject every product whose title omits the word — including the smooth jar
on offer this week that would have been a fine substitute. Braces keep the words
visible without letting them silently kill matches. Promoting one to `( )` is a
judgement only the user can make, so it stays a hand edit.

⚠️ **Pre-existing brackets in a shop title are stripped first.** FairPrice really
ships `"[BCRS] Farmhouse Milk - Fresh"`, and leaving it would have `parse.ts` read
"BCRS" as the brand.

⚠️ **`deriveGenericName` stays plain and is NOT the box value.** It feeds the
category guess and the similar-rows search, both of which would match on
punctuation; `find-similar` runs its input through `stripStructure` for the same
reason — the brand in `[ ]` is precisely what must not drive a search.

The split point is the shop's own dash (`Tuna Flakes - In Water`), the one
separator FairPrice and Sheng Siong both use consistently.

## Nutrition, end to end (added 2026-08-04)

Both "Add to Ingredients" buttons — the history page's and the extension's — fill the four per-100g columns
(`Protein per 100g`, `Fats per 100 g `, `Carbs per 100g `, `Fiber per 100g `). A row without them silently
breaks the plan formulas built on top, which is the whole reason this exists.

**Four sources, cheapest first.** Read them in this order; each is a fallback for the one above. The
percentages are from a 32-product survey of live FairPrice pages (see "Next session" below).

| # | source | cost | share | when |
|---|---|---|--:|---|
| 1 | the shop's own panel, parsed | **free** | 28% | page publishes `Nutritional Data` |
| 2 | model, no tools | **~$0.003** | 31% | fresh produce / raw meat — no label exists to find |
| 3 | model + the shop's back-of-pack photo | **~$0.03** | 34% | the shop published a back or side pack shot |
| 4 | model + web search & fetch | **$0.29–0.41** | 6% | everything else — front shot only, or a shop with no photos |

⚠️ **Source 1 is now reachable from the DAILY SCAN too, not just a product page.**
Measured 2026-08-04: FairPrice's **search** payload carries `Nutritional Data` on
**34 of 72** products — the scraper already had it in `raw` and nobody had looked.
So `StoreProduct.nutritionHtml` carries it through, `site.ts` parses it at build
time, and the four figures ride in the Add/Replace payloads. A deal card marked
`has macro` files its nutrition with **no page fetch, no model and no API call**.
Sheng Siong publishes nothing readable and always leaves the field unset.

⚠️ Sources 2–4 are the paid ones and **none of them runs on its own any more** —
see "Nothing spends money unasked" above.

**Where the code lives.** `src/core/macro-prompt.ts` holds everything that *decides* an answer — system
prompt, tool set, parsing, sanity gate, `isCommodityFood`, and the `packShotsFor` image gate. It has **no
Node imports**, because the extension bundles it verbatim. The two transports are thin:
`src/core/macros.ts` (Node, official SDK) and `extension/macros-client.js` (browser, raw `fetch`); both
build their user turn with `macroUserContent` rather than assembling it themselves.
`src/core/nutrition-panel.ts` is source 1 and is fully deterministic — the `generic-name.ts` house rule,
no model.

⚠️ **The panel must be read off the slug-anchored product object, never searched for in the page.** The
payload also carries the recommendations carousel. On the Skippy Peanut Butter page the product's own object
has **no** panel while **four rival peanut butters do** — a first-match search returns a competitor's label
as this product's, which is wrong and entirely plausible-looking. An early measurement made exactly that
mistake and reported "4 of 5 products have a panel"; the true slug-anchored rate is **4 of 16**.

⚠️ **Every panel is PER SERVING, never per 100g** — measured servings 32 g, 35 g, 236 ml, 100 g. The parser
scales, and *refuses* a panel whose serving size isn't stated. A 32 g peanut-butter serving read as 100 g is
wrong by 3×, in the direction that looks fine. Row labels are matched **exactly**, so Skippy's
`- Saturated Fat` sub-row can't be taken for `Total Fat`, nor `Added Sugars` for carbohydrate.

⚠️ **`max_content_tokens` on web_fetch was tried and REJECTED — do not retry it.** Capping the fetch at 8k
made one product 25% cheaper and another **27% dearer**: starved of page text the model simply searches
more, and search results are large too. Related: **identical configs rerun a day apart varied ±30%**
(123k→93k input tokens on one product, 189k→236k on another), so **anything under ~30% here is noise, not
a result.** Measure more than once before believing a lever.

**The extension's UI.** Four boxes side by side under "Per 100g", above the Add button, in both popup and
side panel. Pre-filled and marked green when source 1 fired (captioned with the serving it was scaled
from); blank otherwise. Filled boxes are written **with** the row and cost nothing. Every box is editable,
so a figure you disagree with is one you overtype.

⚠️ **Blank boxes stay blank until you press `Find Macros` (changed 2026-08-04).** They used to trigger a
paid lookup automatically once the row was written, which patched the figures in behind you. Now the button
appears only when a lookup is possible (no free panel **and** a key is set), and it fills the BOXES rather
than the row — so the figures arrive where you can read them, edit them or clear them, and only then does
Add write them. Worker handler `find-macros` looks up and returns without writing; `macros-for` (which
patches a written row) has no caller left.

The note under the boxes says which wait to expect — about 5 s reading a back-of-pack photo, 10–30 s
without one — using `packShotsFor`, the same function the worker gates on, imported rather than
re-implemented so the panel cannot promise a path the lookup won't take. ⚠️ Those strings must never say
"when you add"; nothing happens on Add any more, and a note promising figures that then don't appear is how
a user stops trusting the panel.

⚠️ **"Are there macros?" is the WORKER's answer, and the panel must not compute its own.** `macrosFrom()`
in `background.js` runs each box through `macroOf()` (parse + the 0–100 g sanity gate) and returns null only
if all four come back null; the reply carries that as `macrosFromForm`, which is what `flow.js` branches on.
(It also still returns `needsLookup`, which nothing reads any more — see Remaining work 17.)
A client-side "is any box non-empty?" check is not the same question — a box holding junk
reads as filled there and as empty in the worker, so the panel would promise a path the lookup won't take.
One such helper was written and never wired up; it was deleted on 2026-08-04. Don't reintroduce it.

**Key goes on the extension Options page**, beside the Notion token. Blank = the whole feature is off and
rows add exactly as before. Needs `https://api.anthropic.com/*` in `host_permissions` plus the
`anthropic-dangerous-direct-browser-access` header (a service worker sends a browser `Origin`).

## Infrastructure truths (found 2026-08-05 — read before diagnosing anything)

Three facts about how this system actually runs, all of which contradicted the
docs or a reasonable assumption. None was a code bug; all three cost real time.

### ⚠️ Your IP decides what you can scrape

The user's laptop was on a **VPN** (`AS212238 Datacamp Limited`, geolocated
Singapore). That address is a *datacenter* address, and shops treat it as one:

| | on the VPN | on the real line (`AS4773 MobileOne`) |
| --- | --- | --- |
| Watsons | **403** on every URL, incl. `robots.txt` | **200** |
| FairPrice / Guardian | 200 | 200 |

Watsons was denied at the **Akamai edge** — a 296-byte `errors.edgesuite.net`
"Access Denied", and crucially **no `_abck`/`bm_sz` cookies were ever set**, so
Bot Manager never even scored the request. A real headed Chrome was refused
identically. That combination means *the address*, not the client.

⚠️ **A headed-Chrome/cookie trick cannot fix an address-based deny.** An early
version of this note said "reuse `incapsula.ts`" and that was wrong.

⚠️ **The client matters too, independently.** On the *same* residential IP,
`curl` gets 403 from Watsons while Node's `fetch` gets 200. So "blocked" needs
both variables pinned before it means anything. `npm run vendor-probe` now prints
its own egress IP and flags datacenter addresses for exactly this reason.

This also puts a question mark over the 2026-07-30 entry claiming "Incapsula now
challenges *residential* IPs too". That may simply have been the VPN. Not
re-tested; treat the claim as unconfirmed.

#### ⚠️ RESOLVED (2026-08-11): the constraint is the COUNTRY, not the connection

**Read to the end before acting.** This section starts as an experiment and ends
with a result that contradicts the design premise of the whole hybrid above: Sheng
Siong challenges addresses that are **not in Singapore**, and does not care whether
they are residential or datacenter. The measurements are kept in the order they
were taken, because two wrong conclusions were reached along the way and the way
they were wrong is the useful part.

**The question being asked.** Can the laptop stop being load-bearing? Today two
jobs pin work to it: the 05:30 `push-ss` scan and — the real motivation — the
`tg-poll` Telegram inbox, which genuinely wants 24/7 and currently only runs while
the laptop is open. The scan itself does **not** need an always-on box
(`StartWhenAvailable` catches up a missed run); the inbox does.

The reasoning chain, and where it broke:

1. Rent a cloud VPS → **datacenter IP** → the thing this whole section says is
   blocked. So: no.
2. Therefore put a small always-on box (Pi / N100 mini PC) on the **home
   broadband**, where the IP is genuinely residential.
3. *"Can the server not just run a VPN?"* — assumed **no**, on the grounds that
   commercial VPN exits are themselves datacenter ASNs, and this section's own
   table shows a Datacamp exit getting 403 from Watsons.
4. **Step 3 was tested on 2026-08-11 and did not hold up.**

**What was measured**, from `AS60068 Datacamp Limited` (89.187.162.213, Singapore
— a *commercial VPN exit*, flagged by the probe's own datacenter warning):

| shop | this section's record (08-05, `AS212238`) | measured 08-11 (`AS60068`) |
| --- | --- | --- |
| **Sheng Siong** | *(never tested on a VPN)* | ✅ **99 products for "milk"** |
| Watsons | **403**, Akamai edge deny | **200** (still `no-data` — SPA shell) |
| Guardian | 200 | 503 — ⚠️ **not the VPN, see below** |

⚠️ **The Sheng Siong run was clean.** `.sessions/shengsiong.json` was moved aside
first, so there was **no cached Incapsula cookie**, and no new one was minted
(Chrome never launched, `.sessions/` gained nothing). Bare client, datacenter
address, no session credential, full results. Whatever blocked GitHub Actions did
not block this.

⚠️ **Note the two Datacamp exits are different networks** — `AS212238` on 08-05,
`AS60068` on 08-11. "It's Datacamp" is not one address pool, so reasoning from the
org name (which is what `egress()` matches on) is weaker than it looks.

**The full-scan test was then run, and it passed.**
`npm run push-ss -- --force --no-push` over the same VPN: **60 terms, 0 errors,
765 products, 39 terms with hits.** This matters because the 2026-07-30 failure
took the opposite shape — *all 62 searches died at the WebSocket upgrade* — and
nothing resembling it occurred. The zeros in the output ("Pu Erh", "Muscovado
Sugar") are genuine no-match terms; the script counts errors separately and
reported none. So the "one lucky search" objection is **answered**.

### ⚠️⚠️ THE ANSWER: it is GEOGRAPHY, not "datacenter vs residential"

**Three addresses were measured on 2026-08-11, within about an hour, same code,
and the cached cookie moved aside for each:**

| address | where | result |
| --- | --- | --- |
| `AS60068` Datacamp | 🇸🇬 **Singapore** (VPN exit) | ✅ **60 terms, 0 errors, 765 products** |
| `AS8075` Microsoft/Azure | 🇺🇸 Chicago (GitHub Actions) | 🔴 challenged by Incapsula |
| `AS174` Cogent | 🇺🇸 Los Angeles (VPN exit) | 🔴 challenged; **cookie mint did not save it** |

The US Cogent run is the one that settles it. It minted a fresh cookie through
headed Chrome — successfully — and the DDP handshake **still** failed with
`Unexpected server response: 200`, the exact 2026-07-30 signature. Three different
networks, two countries: the only variable that tracks the outcome is **which
country the address is in.**

⚠️ **So "Sheng Siong needs a RESIDENTIAL IP" is wrong, and has probably always been
wrong.** The laptop works because it is **in Singapore**, not because it is on a
home line. That premise is load-bearing for the entire hybrid design above — the
runner, the file hand-off, the shelved phone — and it was never the real
constraint.

⚠️ **This also retro-explains the 2026-07-30 "Incapsula now challenges residential
IPs too" entry**, which never made sense on its own. That session was almost
certainly on the VPN with a foreign exit, exactly as the 08-05 Watsons session
was. It was not a WAF policy change; it was the same confound, twice, eleven days
apart, and it cost a whole browser-minting subsystem. The suspicion was already
recorded above as "treat the claim as unconfirmed" — it now has direct support.

**What follows for the server question:**

- A **Singapore VPS** (DigitalOcean `sgp1`, AWS `ap-southeast-1`, Vultr/Linode SG,
  ~US$5/mo) is the indicated answer. It removes the laptop *and* makes the Pi
  unnecessary, and gives `tg-poll` the 24/7 host that was the real motivation.
- ⚠️ **Not yet directly tested.** Every Singapore success so far is through one
  commercial VPN exit. A VPS in an SG region is a *different* address, and the
  honest state is "strongly indicated", not "proven". Test it with
  `npm run ss -- "milk"` on the box before migrating anything.
- ⚠️ **Do not deploy the thing that was tested.** A shared VPN exit has reputation
  pooled across every user of it and drifts without warning. A dedicated VPS IP is
  the more stable address even though it is the untested one.
- **Then duration** — the scan at 05:30, unattended, for a week, read off
  `push-ss.log`. Geography being the variable does not repeal the intermittency
  warning above; it only explains which addresses are eligible in the first place.

⚠️ **`incapsula.ts` should NOT be ripped out on the strength of this.** From an
eligible address the cached-cookie path means no browser opens anyway, so it costs
nothing to keep; and the minting fallback is what will be needed the day the WAF
tightens on Singapore addresses too. What changed is the *diagnosis*, not the
machinery: a mint failing is now evidence the address is foreign, not evidence the
site got harder.

⚠️ **A shared VPN exit is the worst of the candidate addresses for the long run,
even though it is the one that was tested.** Its reputation is pooled across every
user of that exit and drifts without warning; a dedicated VPS IP is far more
stable. Do not conclude "the VPN works" and then deploy the VPN.

⚠️ **`RUNNER_SOURCE` was unset for the test run, so `data/shengsiong-latest.json`
was written with `source: "phone"`** — the default at `push-shengsiong.ts:32` is
`"phone"`, a runner that (as of the same day) will never exist. Any run that loses
that env var files itself under a plausible-looking wrong name, in the one field
you would use to trace where a scan came from. Recommended: default it to
`"unknown"` rather than to any real runner, so a misconfiguration is visible
instead of merely wrong. **Not yet changed.**

⚠️ **Guardian's 503 is NOT evidence against the VPN — it is site maintenance.**
This note first recorded it as the VPN's cost ("a VPN'd server trades one shop for
another"), which was wrong: a concurrent session the same day established Guardian
is simply down, and the standing action is "re-run when their maintenance ends".
Worth keeping as a worked example of this section's own lesson — a 503 taken while
on a VPN reads as an address problem when it is nothing of the sort, and the only
thing that separated the two was another measurement.

So the honest tally of the VPN's *cost* is: **not yet known.** No shop has been
shown to break on it. That is different from "it costs nothing", and the whole
vendor table still needs re-taking off the VPN before any move is decided.

⚠️ **A vendor build was running in a second session while these numbers were
taken, with the VPN on.** Any shop reachability it recorded on 2026-08-11 is
subject to this same confound — check its egress before trusting it. This is the
2026-08-05 mistake repeating itself in a new place.

### ⚠️ The daily job runs ~3.5 hours late, every day

`daily.yml` is `cron: "0 2 * * *"` and every doc says **10:00 SGT**. Measured
actual firing times:

| date | fired (UTC) | late by |
| --- | --- | --- |
| 08-01 | 05:30 | +3h30 |
| 08-02 | 05:31 | +3h31 |
| 08-03 | 05:46 | +3h46 |
| 08-04 | 05:18 | +3h18 |

So the Telegram digest used to land about **13:20–13:50 SGT**. This is ordinary
GitHub Actions queueing on a free public repo, not a fault — but "it didn't run"
is almost always "it hasn't run *yet*".

⚠️ **The delay is in STARTING the run, so it is also when the shops are
scraped.** This is the fact that decides how to set the cron, and it is easy to
get backwards. The 08-10 run had `cron: "0 2 * * *"` and its recorded start was
`04:00:06Z` — everything the workflow does, including the scraping, happened from
04:00 UTC. The cron is a *request* time, not a run time.

⚠️ **Set 2026-08-11 to `cron: "0 0 * * *"` = 08:00 SGT, as a FLOOR on the
scrape.** The user's reasoning: a discount read at 5am may not be the one on the
shelf, so the scan must not run early. With the queue on top, the scrape and the
digest both land about **11:30 SGT**.

⚠️ **The clever version was tried and reverted the same day.** `30 20 * * *` set
the cron 3½ h early so the run would *start* at 08:00, which usually worked and
put the digest at breakfast. But the delay is a **queue, not a promise**: on a
quiet night it would fire the scrape at 04:30, which is exactly what the floor
exists to prevent. Trading a guaranteed floor for a good average is the wrong way
round when the data has a shelf life. It also briefly cut the Sheng Siong runner's
head start from ~6½ h to ~1¼ h; at 11:30 that margin is comfortable again.

### ⚠️ The laptop runner scans into a doomed push when the network is late — FIXED 2026-08-10

Real failure, 2026-08-05 07:23. `run.cmd` does `git pull` then `npm run push-ss`
and **ignores the pull's exit code**:

```
fatal: unable to access 'https://github.com/…': Could not resolve host: github.com
```

The laptop had woken before DNS was up. The pull failed, the scan then ran fine
(58 terms, 0 errors), committed — and the push was **rejected** because the clone
was 12 commits behind. Today's Sheng Siong data sat stranded locally; the cloud
build went FairPrice-only. Recovered by hand with `git pull --rebase && git push`.

**Both halves fixed 2026-08-10.**

1. **`src/core/git-data-push.ts`** — `commitAndPushData()`, now used by *both*
   residential writers (`push-shengsiong.ts` and `tg-poll.ts`, which had the
   same bare `git push`). On rejection it takes the new remote wholesale
   (`fetch` + `reset --hard`), writes the file's own bytes back over it,
   re-commits and pushes again — 5 attempts.
   ⚠️ **It is a whole-file re-apply, NOT `merge-data.ts`'s three-way merge, and
   the two must not be unified.** These files are regenerated in full by the run
   that writes them, so today's scan is the whole truth about today;
   `cooldowns.json` / `purchases.json` accumulate entries from runs that never
   see each other, which is the only reason that merge exists.
   ⚠️ **A dirty clone vetoes the reset.** `tg-poll.ts` runs on the dev machine
   (it needs `NOTION_TOKEN`), where the tree may hold real work — so anything
   uncommitted that isn't the data file aborts the recovery with an error naming
   the files. The scan is still committed locally; land it with
   `git pull --rebase` by hand. Discarding a session's edits to save one page
   build is not a trade a script gets to make.
   ⚠️ **A failed `fetch` throws immediately** rather than burning the other four
   attempts: that is no network or no credential, not a race, and the user needs
   to see it.
2. **`run.cmd` no longer scans when the pull failed.** It retries `git pull`
   (⚠️ **six times, 30 s apart since 2026-08-11** — it was twice at 20 s, which
   was not enough; see the next section), and if it still fails, logs
   `NOT scanning` and exits 1 without starting a five-minute scan into a network
   that isn't there. Uses `ping` for the wait, not `timeout`, which needs a
   console Task Scheduler doesn't give it.
   **The live `C:\Users\newuser\shengsiong-runner\run.cmd` and the repo's
   `laptop-run.cmd` were both updated** — they must stay in step.

`src/tests/git-data-push.test.ts` pins all of it against a real bare repo in the
temp directory — the recovery, the dirty-clone veto, the offline fail-fast and
both no-op cases. ⚠️ It is the **only** suite that shells out, and the only one
with top-level `await`; `src/tests/run.ts` therefore imports it dynamically and
last, or the other suites' `describe()` calls land inside its await windows and
mislabel their own cases.

### ⚠️ The 05:30 task does not run at 05:30 — it runs on WAKE (found 2026-08-11)

The guard above worked exactly as designed and the system still lost **two days**
(08-10 and 08-11, both FairPrice-only). The pull failed, so it correctly refused
to scan — but nothing then got a second chance:

```
==== Tue 08/11/2026  6:48:48 : run start ====
fatal: unable to access '…': Could not resolve host: github.com
---- git pull failed (attempt 1) - waiting 20s for the network
```

…and the log simply stops there. Three facts, each of which had to be true:

- ⚠️ **The task fires at ~06:47, not 05:30.** `StartWhenAvailable` runs a missed
  calendar trigger when the machine next wakes, and the laptop is asleep at 05:30
  — so in practice this job *always* starts in the first seconds after wake,
  which is precisely when DNS is not up yet. The scheduled time is close to
  fiction; **assume every run is a wake-up race.**
- ⚠️ **`RunOnlyIfNetworkAvailable` is already `true` and does not help.** It asks
  whether an adapter has a connection, not whether DNS resolves, and on wake the
  adapter comes up first. Don't reach for it as the fix; it is already on.
- ⚠️ **The process was KILLED mid-wait.** `Get-ScheduledTaskInfo` reported
  `2147943467` = **1067, `ERROR_PROCESS_ABORTED`** — the laptop went back to
  sleep during the 20-second `ping`. No in-script retry can survive that, which
  is why the fix had to be at the task level too.

**Fixed 2026-08-11, in two places:**

1. `run.cmd` / `laptop-run.cmd` — **6 attempts, 30 s apart** (~2.5 minutes of
   patience) instead of 2 at 20 s.
2. The **task itself** now carries `RestartOnFailure`: **3 restarts, 10 minutes
   apart**, plus `ExecutionTimeLimit` raised `PT15M` → `PT30M` to cover the
   longer retry budget on top of a five-minute scan. This is the half that
   covers `ERROR_PROCESS_ABORTED`, and it only works because the wrapper hands
   its real exit code back — a wrapper that always returned 0 would buy no
   restarts at all. Re-exported to `C:\Users\newuser\shengsiong-runner\task.xml`.

⚠️ **Both fixes live outside the repo and git cannot see either.** `task.xml` and
the live `run.cmd` are on one machine. The previous `run.cmd` is kept beside it as
`run.cmd.2026-08-11.bak`.

To check the settings survived:

```bash
powershell -c "(Get-ScheduledTask -TaskName 'ShengSiong Daily Scan').Settings | Format-List RestartInterval,RestartCount,ExecutionTimeLimit"
```

### ⚠️ A scan of ZERO terms is not a scan (found 2026-08-11, dating from 08-09)

On 2026-08-09 the runner fetched a `targets.json` that listed **no terms**,
"scanned" all zero of them, and wrote, committed, pushed and exited 0:

```
Scanning Sheng Siong for 0 terms…
Wrote data/shengsiong-latest.json (0 terms, 0 errors).
```

Every layer agreed it was a success. Task Scheduler saw `0`; the log line reads
like a clean run; and the cloud reader checked only the **date**, so it would have
called that file fresh, reported "0 products", published the page with **no ⚠️
banner**, and returned nothing for every Sheng Siong lookup all day. It survived
only because the phone happened to push a real scan over it hours later.

Guarded at both ends, and deliberately not just one:

- **Writer** — `fetchTerms()` in `push-shengsiong.ts` throws on an empty list, so
  the file is never created. The pre-existing `errors === terms.length` guard did
  not catch this: it is `&& terms.length > 0`, so zero terms slipped straight
  through it.
- **Reader** — `isUsableScan()` in `stores/shengsiong-file.ts` requires a term
  count above zero as well as today's date, so an empty file that somehow exists
  (an old one in a stale clone, a future regression) reads as **missing** and
  raises the banner instead of publishing silence.
- `push-ss`'s own **self-gate** uses the same predicate, or a bad empty file dated
  today would block the runner from replacing it for the rest of the day.
- The banner says **"today's file arrived empty"** for this case; `staleDays` is
  `0`, and "the latest data is 0 days old" reads as healthy.

⚠️ **A term that legitimately found nothing is still a term that was searched.**
The guard counts *terms*, never products — `Muscovado Sugar: 0` is a normal line
on a healthy run, and requiring products would throw away good scans.
`src/tests/scan-file.test.ts` pins both directions.

⚠️ **The Rescan button cannot help here.** It only renders inside the ⚠️ banner,
which only appears when a shop is **missing from a build that happened**. "No
build at all" has no button. Its absence on a healthy page is correct behaviour,
not a bug — that confused the user on 2026-08-05.

## Next session — pick up here (as of 2026-08-12, evening)

*Started as "why does a CMD window keep opening on me every five minutes". That
question turned out to be the thread: it led to a cadence nobody had asked for, a
job that has been failing silently, and the probe that decides whether this laptop
is in the system at all.*

### Where this stopped, and what is safe to assume

**Done and verified tonight:**

- Both CMD windows are hidden (`run-hidden.vbs`, both tasks re-pointed).
- The placement probe ran and **passed** — a Cloudflare cron can run in Singapore.
- `tg-drain`'s silent pull failure is **fixed and tested** — `--autostash` plus an
  `errorlevel` check. Verified against the dirty tree that was breaking it: exit 0,
  pull succeeded, no leftover stash, every working-tree edit intact.
- The plan is written: **[`docs/retire-the-laptop.md`](docs/retire-the-laptop.md)**.
  Read it before touching any of this; it carries the decisions and the rejected
  ideas so they are not re-derived.

**BUILT AND VERIFIED: the Worker port** — `ss-worker/`, deployed as
`https://ss-worker.tmje30.workers.dev`, 35 new tests, `npm test` green at 821 + 33
+ 35. It scans Sheng Siong from Cloudflare and produces output that matches the
laptop's, field for field. What it does NOT yet do is write: `GITHUB_TOKEN` is
unset, so it fails closed and the cron is a no-op. See "what is left" below.

#### ⚠️⚠️ The probe's verdict was wrong, and this is the important entry

Last night's `PASS — landed in Singapore and stayed there` **overstated the
result, and the flaw is in the probe's own logic.** It keys its verdict on
`loc === "SG"` from `cdn-cgi/trace`. ⚠️ **`loc` fetched from inside a Worker
reports the ORIGINAL CALLER's country, not the object's.** Last night the laptop
was in Singapore, so `loc` read `SG` no matter where the object actually was.

Proved by accident tonight: the laptop was on a **Danish VPN** (`188.126.94.205`,
`colo=CPH`, `loc=DK`), and objects demonstrably serving from `SIN` reported
`loc=DK`. The probe then declared `NO SG` on a run where half its objects were in
Singapore.

⚠️ **Read `colo`. Never `loc`.** And even `colo` is only a hint — the authoritative
test is the DDP upgrade itself, where `101` means the country is right and `200` is
Incapsula's challenge page. `ss-worker` gates on that, not on the trace.

#### ⚠️⚠️ `apac` placement is much less reliable than reported

Three consecutive draws tonight: **HKG, KIX (Osaka), SIN.** Earlier: **ICN
(Seoul).** The `apac` hint covers Tokyo, Seoul, Hong Kong, Sydney and Singapore
alike, and the real hit rate looks like roughly half — not 15 in 16.

⚠️ **The first design used one fixed object name** (`sheng-siong-sg`) on the
reasoning that one long-lived object is placed once and stays. It does — and the
very first one landed in **Seoul** and stayed there, permanently unable to scan.
A single name is a single draw, and betting the system on it is the mistake.

**The fix, and it is the load-bearing part of `worker.ts`:** eight candidate names,
each probed with one cheap upgrade attempt, first reachable one wins. Placement per
name is sticky so the winner keeps winning; at ~50% a miss is vanishingly unlikely.
Live proof: `sg-0:HKG✗ sg-1:KIX✗ sg-2:SIN✓`, then a clean scan.

#### The fidelity diff — the thing that actually had to be proved

Same four terms, Worker vs the committed file the Node runner produced:

| | |
|---|---|
| Common products compared | **79** |
| Fields identical on | **79 of 79** |
| Products with any difference | **2** |

⚠️ **Both differences are a real promotion ending, not a porting fault.** Two fish
fillets read `priceSgd 5 / listPriceSgd 7.95 / onSale true` yesterday and
`7.95 / null / false` today, with `pricePer100g` following correctly at
`7.95/350×100 = 2.271`. Everything else — name, brand, `packWeightG`,
`volumetric`, `unitCount`, `dietaryAttributes`, `url`, `imageKey` — matched
exactly. `Bread` returned 48/48 identical, which is the term where the two-pass
merge matters most, so both passes are working.

⚠️ **A same-time diff was NOT possible** because the laptop's VPN put its egress in
Denmark, so the Node scanner could not reach Sheng Siong to run alongside. The
comparison above is against yesterday's committed file. Worth redoing with the VPN
off, though the result above is already strong.

#### What is left

1. ⚠️ **`wrangler secret put GITHUB_TOKEN`** in `ss-worker/` — a fine-grained PAT,
   this repo, Contents: read and write. Until then the Worker refuses to scan on
   the real path and the cron logs "skipped" without touching Sheng Siong.
2. **Wire `scan-request.yml`** to call the Worker instead of committing the marker,
   with `SCAN_SECRET` as an Actions secret. The button itself does not change.
3. **Phases 2–4** of the plan: the failure notification, then standing the laptop
   down.
4. ⚠️ **Rotate `SCAN_SECRET`.** The one currently set was generated for tonight's
   verification and is sitting in a scratchpad file, not anywhere durable.

**Also found, not fixed:** `parseUnitCount`'s docstring offers `"10 eggs"` as an
example and that string **does not parse** — the regex needs `10s`, `10 pcs`,
`2 per pack` or `6 x`. Left alone because it is shared with the laptop scanner and
changing it would change both; pinned in `ss-worker/scan.test.ts` so the next
reader is not misled. Eggs are a known sore point here.

⚠️⚠️ **The plan's original claim that `ss-scan.ts` "already runs clean from a
Worker" was mine, and it was false.** I wrote it without checking. The scan stack is
Node-only end to end: `ddp.ts` imports the `ws` npm package and uses its Node event
API, `incapsula.ts` spawns Chrome through `node:child_process`, and `ss-scan.ts`
writes with `node:fs` and shells out to git. None of it can run in a Worker.

What exists is `probe/worker.mjs`, a **probe** — 255 lines that genuinely scanned
(561 products, 0 errors, 26.7 s), with two gaps that matter:

1. Its `mapProduct` is labelled in its own comment as *"a stand-in for
   `parseWeight`"*. The real parser (`stores/weight.ts`) is pure and ports directly,
   but it has to actually be used.
2. **It makes one pass per term where the real scan makes two.**
   `shengsiong.ts:143` queries each term with `ecommPromotionFilter.active` both
   `true` and `false` and merges on `slug` — `false` alone truncates by relevance and
   pushes the promoted items, *the actual deals*, off the end.

⚠️ **This is why it was stopped rather than rushed.** The Worker's output becomes
`data/shengsiong-latest.json`, which the whole cloud side reads as fact. A port that
is subtly wrong does not fail loudly — it publishes wrong prices. This project has
been bitten by exactly that shape twice in a week (the comma that made a $1,500
listing cost $1; the zero-term scan that read as fresh). A faithful port with tests
against the same fixtures is a session's work, and it is the right next thing.

⚠️ **Auth is already settled, so that decision need not be reopened:** the deals page
is public and cannot hold a secret, so the button keeps firing
`repository_dispatch: sscan` and `scan-request.yml` calls the Worker with a secret
from Actions secrets. Details in the plan.

**State of the tree:** nothing is committed. `run-hidden.vbs`,
`docs/retire-the-laptop.md`, the HANDOVER and `tg-drain-run.cmd` edits, and the
pre-existing `probe/` and `relay/` changes are all sitting in the working tree. The
placement probe is **still deployed** as `cf-placement-probe` for tomorrow's drift
check.

### ⚠️⚠️ PROVED: a Cloudflare cron CAN run in Singapore — the laptop is retirable

⚠️ **SUPERSEDED IN PART — read "The probe's verdict was wrong" above first.** The
conclusion below (a Cloudflare cron can be made to run in Singapore) still holds
and was confirmed independently by `ss-worker` scanning live from `SIN`. But the
**numbers** below are wrong: the probe keys on `loc`, which reports the caller's
country rather than the object's, so "15 of 16" measured the laptop as much as the
object. Real `apac` hit rate looks closer to half. ⚠️ `probe/placement/` is still
deployed as `cf-placement-probe` and **will report misleading verdicts** — either
fix it to key on `colo` or delete it (`cd probe/placement && npx wrangler delete`);
`ss-worker` no longer depends on it.

`probe/placement/` was written the night before and never validly run. It ran
tonight and the verdict is **PASS**.

Deployed as `cf-placement-probe`, two rounds of 8 Durable Objects created with
`locationHint: "apac"`:

| Round | SIN | Elsewhere | Errors |
|---|---|---|---|
| 1 | 7 | 0 | 1 |
| 2 | 8 | 0 | 0 |

Every object that placed at all placed in **SIN**. The one round-1 error was
`Worker not found.` seconds after upload — propagation, did not recur. Two round-1
objects re-queried minutes later were still SIN with `stuck: true`.

**Why this matters:** the previous entry (`chore: probe Cloudflare as a Sheng Siong
runner`) proved a Worker in the SIN colo scans Sheng Siong happily — 561 products,
0 errors, 26.7 s, no browser — but *only for requests arriving from Singapore*. A
cron has no request to be placed near, and that was the open question blocking
retirement of the laptop. It is now answered. Both laptop tasks, and the whole
`data/scan-request.json` mailbox, are deletable in principle.

⚠️ **Stickiness is proved over MINUTES, not days.** The failure mode this must not
have is the one the probe's own docstring names: a DO that drifts "would work for
days and then quietly stop". Tonight cannot rule that out. Two consequences:

- The probe is **still deployed** so the same objects can be re-queried tomorrow
  for drift. `cd probe/placement && npx wrangler delete` when done with it.
- ⚠️ Whatever gets built **must call `cdn-cgi/trace` before scraping** and refuse
  to believe a "blocked" result from outside SG. That converts a silent drift into
  a loud failure instead of a quietly stale page. The relay README already gives
  this advice for a different reason; it is now load-bearing.

⚠️ **The probe must be DEPLOYED, never `wrangler dev`.** `--remote` has dropped
Durable Object support and errors on every stub call; plain `wrangler dev` runs the
objects *on this laptop*, in Singapore, and would return a triumphant PASS proving
nothing. This is why the `INCONCLUSIVE` verdict exists at all — the first attempt
reported a clean `NO SG` when in fact all eight calls had errored before placing
anything, and a false negative there would have kept the laptop forever.

### ⚠️⚠️ `Grocery New-Item Pricing` reports success while pulling nothing (found 2026-08-12, NOT fixed)

Task Scheduler showed **Last Result 0** at 21:29:44 while `tg-drain.log` recorded
`error: cannot pull with rebase: You have unstaged changes.` for the same run.

[`tg-drain-run.cmd:40`](tg-drain-run.cmd) does `git pull --quiet --rebase 2>>"%LOG%"`
and **never checks whether it worked**. On failure the script carries on against a
stale clone; `npm run tg-drain` finds an empty queue, prints `Nothing queued for
pricing.`, and exits 0 — and that exact string is what suppresses the log header.
So the run is silent *and* green.

⚠️ The wrapper's own closing comment (lines 56–59) says this lesson was already
learned once — "a wrapper that always returned 0 let Task Scheduler report success
on a run where everything failed". It propagates **npm's** exit code faithfully and
**git's** not at all.

**What set it off tonight:** uncommitted edits in the dev clone (`probe/`, `relay/`).
Any dirty tree does it, and the dev clone is where sessions work — so this fires
often. A pricing request queued by the cloud would never reach this laptop and
nothing anywhere would say so. Same shape as the poller's 2,547 silent failures.

**Fix (not applied):** check `errorlevel` after the pull; log a timestamped failure
and exit non-zero. ~4 lines. Left alone tonight because the user's question was the
window, and because this job may be deleted outright — see the open items below.

### The CMD windows — fixed, and it had to be a shim, not a setting

`ShengSiong Scan Request` fires every 5 min for 23h55 (**288/day**) and
`Grocery New-Item Pricing` every 15 min (**96/day**). Task Scheduler's `Exec` action
has no "hidden" option under `InteractiveToken`, so each run painted a console
window — about one every four minutes, all day, on the user's desktop.

[`run-hidden.vbs`](run-hidden.vbs) (repo root) now fronts both. Tasks re-pointed to
`wscript.exe //B //Nologo "<shim>" "<target.cmd>"`.

⚠️ **Window style `0` AND `bWaitOnReturn` `True`, both deliberate.** `0` is genuinely
invisible where `powershell -WindowStyle Hidden` paints-then-hides (a flicker, at this
frequency). `True` makes wscript block and return the real exit code, so
`ExecutionTimeLimit` and `MultipleInstancesPolicy=IgnoreNew` still work — with `False`
every run reports instant success and slow runs pile up.

⚠️ **Do not wrap the target in `cmd.exe /c "..."`.** `cmd` strips the first and last
quote of the whole string, and with spaces in both paths (`Claude Private projects`,
`shengsiong-runner`) that tore the path in half and returned 1 without running
anything. `WshShell.Run` starts a `.cmd` by itself; the extra `cmd.exe` was never
needed. This cost a debugging round tonight.

Verified: exit-code passthrough `7`, missing-argument guard `2`, and the **real**
scan-request job exit `0` in 4.2 s with its log line written. `LogonType` is still
`InteractiveToken` after `schtasks /change` — that command prints a run-as-password
warning which is spurious for an interactive task, but **check the XML after any
`/change`**, because it can convert a task to password-based.

⚠️ **Hiding a job makes its log the only way to notice it failing.** That makes the
`tg-drain` finding above more important, not less.

### ⚠️ The 5-minute cadence was never asked for (user, 2026-08-12)

Worth recording because it shaped a whole subsystem. What the user asked for was
"Rescan should actually rescan" — they tapped it and got the same page back. The
**every-5-minutes-all-day poll was the implementation's choice**, not a requirement,
and it was made hours after the Cloudflare relay had *retired* the Telegram poller
for being exactly this pattern.

**What the user actually wants: one full scan at 09:00 and one at 11:00 SGT.**
Their words: that is when they plan the day around what is on sale, and *"everything
else is a waste"*.

⚠️ **The current schedule cannot hit those times.** `daily.yml` requests 08:00 SGT
and free-repo crons queue by 3–3¾ h — the comment in that file calls the cron a
*floor* for this reason. One scan a day, landing between 08:00 and lunchtime. The
**Worker cron is the reliable clock** (already demonstrated by `tgsweep` firing every
15 min), which is the same machinery the placement result above unlocks.

### Open — in the order I would take them

1. **Re-check probe drift tomorrow**, then delete the probe. One `curl` with
   `?id=place-msq4fu18-0`; `stuck:false` changes the plan completely.
2. **Fix the `tg-drain` silent pull failure** regardless of what happens to the job
   — 4 lines, and it is lying right now.
3. **Move the scan to Cloudflare**: Worker cron at 01:00 and 03:00 UTC (= 09:00 and
   11:00 SGT) → DO pinned `apac` → verify SG via `cdn-cgi/trace` → scan → commit.
   Then delete `ShengSiong Scan Request`, `ShengSiong Daily Scan`, the
   `scan-request.json` mailbox, and `Grocery New-Item Pricing` (its Sheng Siong
   pricing is the same capability). Both CMD windows go with them.
4. **Decide on the relay's 15-min `tgsweep`.** It is not a scan and costs nothing
   locally — it files unanswered bot questions after an hour. Keep it if the bot's
   ask-about-an-item flow is used; it is pure waste if not, and deleting the trigger
   stops the one-hour rule silently.

### Network note — two `git pull` timeouts, and it was NOT a VPN

`ss-request.log` has failures at 20:45 and 21:30, both `Failed to connect to
github.com port 443 after ~21 s`. Checked immediately after: `curl` reached
github.com in **1.19 s**, and `cdn-cgi/trace` reported `loc=SG colo=SIN
ip=119.56.76.250` — egress was Singapore the whole evening. So this is **not** the
VPN confound that has now been mistaken for a WAF change three times. Intermittent,
undiagnosed, and currently harmless because the retry is the next run. Note it if it
gets worse.

### What 2026-08-12 (daytime) did — a code review, and the one bug it found that costs money

No feature work. A read-only diagnosis of the whole tree, then the three findings
worth acting on plus the two cleanups behind them. **Nothing in the running system
changed behaviour** — 756 tests pass (was 733), `tsc --noEmit` clean.

⚠️ **Start by knowing what the review did NOT find**, because it is the useful
half: the workflows are sound. Every one of them passes untrusted input
(`github.event.issue.body`, `client_payload`) through `env:` rather than
interpolating it into a `run:` block, which is the correct pattern and is done
consistently across all four. `exclusions.ts` was read closely looking for a defect
and has none — the `ALL_ITEMS` subsumption in `withBlockedProduct` is correct in
both directions. The tree was clean, typecheck green and every test passing before
the review started.

**What was fixed (4 commits, branch `claude/code-review-diagnosis-a3xw5w`):**

1. ⚠️⚠️ **The comma that made a $1,500 Carousell listing cost $1.** The one that
   costs money. `readListing` read the JSON-LD price with `([\d.]+)`, which stops at
   a thousands separator — `"1,500.00"` captured `1`. It passed every guard, and
   because `findDeal` ranks by *percentage saved*, the mispriced listing sorted to
   the **top of the page**. **This is the same fault as the iHerb weight comma fixed
   the day before**, one file over. `parseCards` 50 lines above it, and
   `watsons.ts`/`iherb.ts`, had always handled it correctly — this one parser was
   the outlier, and it was the only parser in that file **not exported**, buried in
   the fetch where no test could reach it. Now `parseOfferPrice`, with 10 cases.
   *Lesson worth generalising: the comma has now bitten twice in two days, in two
   files. If a third price or weight reader is written, `[\d,]` is the default.*
2. **A shop's product title could end the workflow's output block.** `report()`
   used a literal `EOF` heredoc delimiter, and the text either side of it is not
   ours — `itemName` reaches it from `ISSUE_BODY`, having started as a title a
   Carousell seller typed. Randomised per call now. Never wide open (the `if:` gate
   means the owner still had to tap Add), but a two-line fix.
3. **Two dead back-compat helpers deleted** — `matchesTarget`, `parseWeightGrams`.
   Zero callers anywhere.
4. **`sgtDate` and `report()` are one module each** (`core/sgt.ts`,
   `core/workflow-report.ts`). `sgtDate` had five copies; `report()` had two, which
   is why fix 2 had to be applied twice. ⚠️ The find here was a **naming collision**:
   `item-action.ts` had grown a *different* `sgtDate` whose docstring warns "never
   `toISOString().slice(0, 10)`" — exactly what the other five do. Now `sgtDate`
   (data) and `sgtLongDate` (display), with 13 tests on the 00:00–08:00 SGT window
   the daily scan actually runs in. See CHANGELOG for why the `+8h` form was kept.

### ⚠️ Two findings deliberately left alone — read before "fixing" either

**1. The README is still 100% the stock Notion Workers template — LEAVE IT for
now (user's call, 2026-08-12).** All 19 KB of it documents `worker.sync()`,
`worker.tool()` and `ntn workers deploy`; none of it mentions groceries.
`SYSTEM-GUIDE.md` is the real document. On a repo that is public by necessity
(GitHub Pages on the free plan) the landing page therefore describes a different
project, which *sounds* like an obvious cleanup.

⚠️ **It is not obvious, and the reason is forward-looking.** The user may build the
Notion worker in this repo — `src/index.ts` already holds a written, reviewed,
`NOT DEPLOYED YET` webhook (the one-tap Add relay, see `docs/one-tap-add.md`), and
`.examples/` holds five SDK samples. While that is still on the table the template
README is **live reference material for work about to be done**, and deleting it
buys a tidier landing page at the cost of the SDK reference right before it is
needed. Revisit when the worker question is settled either way: if the worker gets
built, the README should cover both halves; if it is abandoned, delete the template
prose, `.examples/`, and the `@notionhq/workers-template` name and `0.0.0` version
still sitting in `package.json`.

**2. `exclusions.ts` has no tests — the largest untested hot path left.** 281
lines, pure, no I/O, and `exclusionReason` runs against **every** product in both
`findDeal` and `findReview`. A regression there silently suppresses real deals or
lets corrected ones back onto the page, and "silently" is the operative word — the
module's own docstring explains it returns a *reason* rather than a boolean
precisely so the scan can log what it dropped, "a silently vanishing product is how
a bad exclusion goes unnoticed for weeks". It was read closely during the review
and no defect was found, so this is coverage, not a known bug.

⚠️ **It is also the cheapest test to write in the repo** — pure functions, no
network, no Notion, no clock. `termHits`, `isBlocked`, `exclusionReason`,
`withExcludedTerms`, `withBlockedProduct` and `suggestExclusionTerms` all take
plain values. The `ALL_ITEMS` interaction is the part most worth pinning: a global
ignore *replaces* per-item blocks on the same product, and a per-item block on an
already-globally-ignored product is a no-op. Both directions are currently correct
and nothing enforces that.

*Smaller leftovers from the same review, all mechanical:* `cloudflare/` is
referenced in `config.ts:72` and `add-to-list.yml:8` but the directory is `relay/`
(stale rename); `.env.example` is missing `GROCERY_LIST_DS_ID`, whose fallback in
`grocery-list.ts:37` is a hard-coded live Notion data-source UUID; and
`git-data-push.ts` builds its git commands as shell strings, so `RUNNER_SOURCE`
reaches `git commit -m "…"` unquoted (`execFileSync` with an argv array removes the
class). ⚠️ **`package-lock.json` is tab-indented and plain `npm install` rewrites it
with spaces** — a ~1,100-line phantom diff with no dependency change. It is
generated, not authored; do not chase it into the tabs convention.

### What 2026-08-11 (evening) did — the price book stopped being empty

The daily scan had been searching NTUC and Sheng Siong every day and **throwing the
prices away**: 49 rows named Sheng Siong and not one had a price. Both shops are now
`vendor-scan` routes, and the first live `--write` recorded **50 prices, refused 6,
and queued 16** for review.

**Pick up here, in this order:**

1. **The matcher, not the scrapers.** iHerb returns 43 priced products for its own
   rows and `evaluate()` accepts none; two Watsons toothpaste rows do the same with
   23 and 28. Both stores are verified working — this is `evaluate()` being
   conservative about supplement and personal-care naming. It is the single biggest
   blocker to the new shops being worth anything.
2. **Shopee.** Signed in (`.sessions/chrome-shopee`, gitignored) but no module. It
   is a **marketplace**, so it needs the whole Carousell apparatus —
   `cheapestPlausible`, the price floor, seller reputation — plus scroll-and-settle
   for a lazy-loaded grid. Without those it files counterfeits as bargains.
3. **Schedule `vendor-scan`.** It runs only by hand today. ⚠️ It cannot go in
   `daily.yml` as-is: Watsons, iHerb and Carousell need a headed browser, so it
   belongs on the laptop beside the Sheng Siong task. Then lower
   `PENDING_TTL_DAYS` to 2 **and** add a re-ask counter in the same change — a
   2-day expiry with no counter re-asks the same pack forever.
4. **Guardian** — nothing to do; re-run when their maintenance ends.
5. **The review buttons have never been tapped in anger.** The payloads were
   verified by pulling them out of the rendered HTML and through the real parser
   (which is how the missing `key` was caught), but no issue has gone through the
   workflow yet.

⚠️ **`data/vendor-review.json` is committed on purpose** — the published
`review.html` is built from it by `build-site.ts`, so a queue that never reaches the
repo means a Telegram link to questions that are not there. The scan pushes it via
`commitAndPushData`, and the message omits the link when that push fails.

### What 2026-08-11 (morning) did — three live faults, none of them on the list

The session started by checking the running system against this file rather than
by picking up item 28. All three faults were **operational**, invisible from the
code, and two of them had been eating the product daily:

1. **The Sheng Siong runner had not scanned for two days** (08-10, 08-11) — the
   page was FairPrice-only both mornings. Fixed: the wake race now gets ~2.5
   minutes of retries *and* the task restarts itself 3 times. See "The 05:30 task
   does not run at 05:30".
2. **Nothing ever started the Telegram inbox.** It only ran when launched by
   hand. Fixed: `Grocery Telegram Inbox`, a logon task that repeats every 15
   minutes and restarts the poller if it died. See "Telegram intake".
3. **A zero-term scan was written, pushed and reported as success** on 08-09, and
   the cloud reader would have published it with no warning. Fixed at both ends.
   See "A scan of ZERO terms is not a scan".

⚠️ **Two of those three fixes are NOT in git** — the live `run.cmd` and both
scheduled tasks live on one machine. The repo carries `laptop-run.cmd` and
`tg-poll-run.cmd` as the readable copies; `task.xml` and `tg-poll-task.xml` are
exported beside them in `C:\Users\newuser\shengsiong-runner\`.

⚠️ **All three are the same shape as the "green tick" gotcha** below: every layer
reported success while the product got quietly worse. Nothing here was found by a
test, and nothing here would have been. When picking up this project, **check what
actually ran before writing code** — `push-ss.log`, `Get-ScheduledTaskInfo`, and
the date inside `data/shengsiong-latest.json`.

### ⚠️ Start here next session — 5, 10 and 11, in that order

Everything below this heading is history. These three are the work:

**A. Use it for real (Remaining work 11, 13, 16).** Still the biggest untested
surface in the project and the only item on this list that can't be done by
reading code. The Chrome extension, the nutrition lookup and the four deal-card
buttons have all been proven by tests, rendered markup and live page fetches, and
**not one of them has been pressed on a real shopping trip.** Order, by how badly
a fault would bite:
1. **Replace** — renames a hand-maintained row, no undo. Try it on something you
   don't care about and check the generic name it derives is one you'd have picked.
2. **The + Macros toggle arms both roads** — one-tap flips `"findMacros":false` in
   the JSON, two-tap rewrites the URL-encoded copy in the issue body. Both were
   asserted against markup; neither has been fired at the live workflow.
3. **A `has macro` card costs nothing** — the run log should say
   `Nutrition: using the shop's own panel — free, no lookup.` A cost line there
   means the free path didn't fire.

**B. Shopee needs a one-time hand sign-in** before it can be probed at all
(Remaining work 27). Nothing else about Shopee is blocked on code.

**C. Cross-check the price book against the user's own formulas.** The user built
`Size of Cheapest Vendor`, `Price,SGD [Cheapest]` and `Cheapest Vendor ` partly so
this code wouldn't have to walk the slots. It still walks them — it needs
`Item Name [Vendor n]` from the *same* slot, and four independently-computed
formulas can disagree with each other where one slot cannot — but the formulas
make an excellent **check**: compare what the slot walk picked against what Notion
published, and complain when they differ.
⚠️ Measured 2026-08-11 over 72 priced rows: **price 72/72, size 72/72, vendor
64/72**. The 8 vendor differences are one shape — where the `Vendor 1` select is
empty, the formula returns the literal string `"Vendor 1"` while the code returns
blank. **The code is right**; a shopping list saying you bought tissue from a shop
called "Vendor 1" would be worse than saying nothing. So the check must compare
price and size strictly and treat that vendor case as expected, or it will cry
wolf on eight rows every run.

### Then the inbox faults — 28, 29 and 30 are all done

The user answered the three open questions the same morning, and all of it
shipped:

| asked | answered | built |
| --- | --- | --- |
| re-search **what**? | "a different ingredient that is similar" | `nextCandidates()` — the Ingredients DB, next tranche, skipping what was rejected |
| `(New)` or `{New}`? | **`{New}`** | `newIngredientFields()`; `( )` would have made "new" a hard requirement and matched nothing |
| the empty third bullet | "was a mistake" | no third button |

Plus a fourth rule, on **By Unit**: a counted row's weight may be in the `Name`
**or** in `Item Name [Vendor n]`, and if it is in neither the item is sold by the
piece — a blank is an answer, not a gap. `readGroceryTargets` reads both now; see
Remaining work 0 for what that changed on the live DB (nothing yet, and why).

**What has NOT been done:** none of this has been used in anger. The ask, the
re-search button and the create button were built against tests and a restarted
poller; nobody has texted the bot since. Do that first — text something you
already stock, something ambiguous ("milk"), and something you don't.

`npm test` **572 passing** (was 508 this morning), `npm run check` clean.

### The state at 2026-08-10, evening

### Committed and pushed — the tree is clean

Everything from 2026-08-10 is on `main` as three commits:

```
f00ce6f docs: first live run of the inbox, and three faults it exposed
3e67a0f feat: this project gets its own Telegram bot (@Grocery69_bot)
793d6fc fix: a rejected push no longer loses the day's scan
```

`npm run check` clean, **`npm test` 508 passing** (was 496 at the start of the
day; 376 in the last handover).

⚠️ `src/scripts/tg-poll.ts` sits in the **first** commit because its `gitPush`
rewrite belongs there, but it also carries the one-line inbox-bot token switch
from the second — the two could not be split without hunk surgery. Don't read
`793d6fc` as the whole push fix and nothing else.

⚠️ **The live `C:\Users\newuser\shengsiong-runner\run.cmd` was edited too**, and
git does not see it — it lives outside the repo, so no commit covers it. If
`laptop-run.cmd` is ever reverted, revert that by hand as well or the two drift.
The next 05:30 SGT run is the first to use the new pull guard.

### What 2026-08-10 (evening) actually did

- **Remaining work 22 — fixed** (see "Infrastructure truths"). The highest-value
  item on the list; the runner could previously scan perfectly and lose the data.
- **Remaining work 23 — found already fixed** by the 2026-08-09 price book, in
  both writers. Only the docs still described the bug.
- **This project now has its own Telegram bot, `@Grocery69_bot`** — it sends the
  digest and serves the poller. `.env` and the GitHub Actions secret
  `TELEGRAM_BOT_TOKEN` both hold it (secret updated 2026-08-10 12:13 UTC).
  `TELEGRAM_INBOX_BOT_TOKEN` is deliberately **blank**; the fallback in
  `config.ts` is the normal path now. `@Big_Notion_Bot` is untouched.
- **The inbox ran live, end to end, for the first time.** `/start` answered, a
  real texted list parsed, matched, and written to the grocery List, and two
  near-misses asked with buttons. It works — and it turned up the three faults
  below, which are Remaining work 28–30.

### First real use — what it exposed

⚠️ **Read these three together before touching `tg-inbox.ts`.** All three are the
same family: the flow *looks* like it worked.

1. A tie between two equally-good rows is invisible (28).
2. A tap that arrives with nothing polling is acknowledged and thrown away (29).
3. An item ruled "new" is priced on a page but never reaches the grocery list
   (30) — and this file claimed the opposite until today.

### The three-item macro plan

**Finished**: #3 shipped, #2 was measured and rejected, #1 shipped.

- ✅ **#3 — skip search for fresh commodities.** `isCommodityFood()` in `macro-prompt.ts`.
  Frozen chicken $0.41 → **$0.0030** (34s → 2.5s) and broccoli $0.081 → **$0.0027** (17.7s → 2.2s), with
  the same or better figures — the chicken no longer throws the 24.8 g protein outlier the searching
  version did (~17–18 g is right). Gate is narrow on purpose: `produce` category, **or** a meat/fish/egg
  word **with** a `fresh|frozen|chilled|raw|live` state. That state requirement is what keeps branded dairy
  and "Tuna Flakes - In Water" on the full lookup. 25 classification cases tested.
- ❌ **#2 — `max_content_tokens` cap.** Measured and rejected, see the ⚠️ above. Don't revisit.
- ✅ **#1 — pack-shot images.** Shipped 2026-08-04. See below.

**The outstanding work is now the first real use** of the extension, the nutrition feature and the four new
deal-card buttons — "Remaining work" items 11, 13 and 16. Everything in this area has been proven by Node
harness, offline test, live page fetch and a rendered page; nobody has yet pressed any of it in anger.

**What to check on that first real run**, in order of how badly it would bite:

1. **Replace on a real ingredient.** It renames a row you maintain by hand and there is no undo. Try it on
   something you don't care about first, and confirm the generic name it derives is one you'd have chosen.
2. **The + Macros toggle actually arms both roads.** One-tap flips `"findMacros":false` in the JSON;
   two-tap rewrites the URL-encoded `"findMacros": false` in the issue body. Both were asserted against
   rendered markup, neither has been fired at the live workflow.
3. **A `has macro` card costs nothing.** Its figures should land straight from the payload — the run log
   says `Nutrition: using the shop's own panel — free, no lookup.` If you see a cost line, the free path
   didn't fire.

### #1 — reading the label off the shop's pack shots (shipped 2026-08-04)

The lookup is handed FairPrice's own back-of-pack photograph instead of being sent to find the panel on the
web. Measured on Skippy Peanut Butter:

| variant | input tok | searches | secs | tier | cost |
|---|--:|--:|--:|---|--:|
| text only | 123,389 | 2 | 54 | search | $0.2877 |
| + 2 pack shots (front + back) | 13,885 | 0 | 8 | product-page | $0.0296 |
| + 2 pack shots (rerun) | 13,885 | 0 | 8 | product-page | $0.0314 |
| **as shipped — back shot only** | **10,767** | **0** | **5.2** | **product-page** | **$0.0239** |

Same answer every way: 22.8 g protein, which is right for Skippy. The saving is not the searches (2 cents
of a 29-cent call) — it is that `web_fetch` stops dropping a 340–390 KB page into context.

**Over a real basket** — 32 live FairPrice products across 16 search terms, surveyed offline (free):

| path | share | cost each |
|---|--:|--:|
| the shop's own panel | 28% | free |
| fresh commodity, no tools | 31% | ~$0.003 |
| **back-of-pack photo** | **34%** | **~$0.03** |
| text only | 6% | ~$0.29 |

**$3.80 → $0.94** to add all 32.

**Where it lives.** `selectPackShots` picks the views; **`packShotsFor` is the gate every caller should
use** (it adds the commodity refusal). `macroUserContent` builds the images-then-text content array for
both transports, so the Node side and the extension cannot disagree about what was asked. `content.js`
returns `own.images` off the slug-anchored object, `flow.js` carries it into `macros-for`, `background.js`
forwards it. `macro-test.ts` takes a repeatable `--image <url>` and prints how many were actually attached.

⚠️ **The FRONT shot is deliberately excluded, and that exclusion is the entire gate.** Images back-fired on
frozen chicken ($0.60 against $0.41, and the 24.8 g outlier) because a pack with no panel leaves only
marketing copy to read. So a listing publishing **nothing but a front shot gets no images** and takes the
ordinary path — that is what left the two silken tofus on the expensive path in the survey above, and it is
the gate working. `packShotsFor` additionally refuses photos to anything `isCommodityFood` catches, which
blocks the same failure from the other end.

⚠️ **Do NOT filter the photos by the product's SKU** — the obvious-looking rule, and wrong. FairPrice reuses
one photo across a range: "[BCRS] Farmhouse Milk - Fresh" (`clientItemId` 13281014) publishes
`10966597_LXL1_20230327.jpg` as its own side view, and an SKU filter throws away the only label shot it has.
Read `own.images` off the slug-anchored object — same anti-carousel rule as the panel, and simpler.

⚠️ **The date suffix in the filename is optional** — `13051601_BXL1.jpg` as well as
`47440_BXL1_20250411.jpg`. A pattern that requires it silently drops a good share of the back shots.

### Sheng Siong pack shots (added 2026-08-04)

**Sheng Siong now has pack shots too**, which matters more than FairPrice's did: it publishes no nutrition
data of any kind AND `web_fetch` cannot read its pages, so every product used to take the worst path there
is — ~$0.29 guessing from a web search. Verified end to end on "Bake For You Peanut Butter - Crunchy":
**$0.0296, 9.3 s, 0 searches, `product-page` tier**, and the figures (24.0 / 48.8 / 21.1 / 5.2) match what
the photo actually shows — checked by eye, not just believed.

```
https://ssecomm.s3.ap-southeast-1.amazonaws.com/products/{sm|md|lg}/{imgKey}.{0..totalImg-1}.jpg
```

`src/core/stores/shengsiong-images.ts` builds them. Public S3, **not** behind Incapsula — the only Sheng
Siong URLs in this project an ordinary `fetch` can reach.

⚠️ **`totalImg` is load-bearing and is in the DETAIL record only.** An index past the end returns **403**,
not 404, and an unreachable image fails the whole API request rather than being skipped — so the count is
never guessed. Two routes to it, because the two surfaces have different data:

| surface | how the count is known |
| --- | --- |
| Chrome extension | `Products.getOneByIdOrSlug` returns `totalImg` — free, already called |
| deals page | `resolveShengSiongPackShots` HEAD-probes the bucket, since search results carry `imgKey` but no count |

The probe runs in `build-site.ts` **after** the deals are chosen — two dozen products rather than the
1,100-odd the scan returns — deduped by key, run in parallel, and wrapped in its own try so a photograph can
never stop the page building. Indices are contiguous, so the first 403 ends the series.

⚠️ `StoreProduct.imageKey` is a first-class field and not left in `raw` **because the runner strips `raw`**
before committing `data/shengsiong-latest.json`. Anything the cloud needs has to survive that strip.

⚠️ **Index 0 is always the front** — it is the thumbnail the search results use, and it is the marketing
face. Verified by looking at both: index 0 was "Cholesterol Free / Trans Fat Free", index 1 the nutrition
panel, legible and carrying its own Per-100g column. `shengSiongPackShots` returns index 0 anyway and
`packShotsFor` drops it, so the "never the front" rule stays in one place.

⚠️ `lg` is the largest size the bucket serves — `sm` 17 KB, `md` 85 KB, `lg` 256 KB; `xl`, `org`,
`original` and the bare path all 403.

### Testing without burning money

- `npm run macro-test -- "<product>" [--url …] [--store …] [--as …] [--image <url> …]` — one real lookup,
  writes nothing to Notion, prints tier, basis, timing and **cost**. It mirrors production (it derives
  `categoryKey` the same way the real callers do — it didn't until 2026-08-04, which made it under-report
  both cost and behaviour). `--image` is repeatable and takes the shop's URLs **unfiltered**, exactly as
  the extension hands them over; the line it prints says how many of them `packShotsFor` actually attached,
  so "3 image URLs given, 1 attached" is the gate working.
- **`npm test` — 241 offline cases, free and in the repo** (`src/tests/`). Nine suites: pack-shot selection
  and its commodity gate, nutrition-panel parsing, macro-reply parsing, name derivation, marketplace size
  parsing, cooldown length (including the Weekly Buy route), the concurrent-write merge, the grocery-list row, and the deals page's markup
  (including the two ignores — see above). No test
  runner and no new dependency — each file registers cases into `harness.ts` and `run.ts` sets the exit code.
  Nothing here calls Notion, a shop or Anthropic: a test that costs 29 cents is a test nobody runs.
  ⚠️ They cover exactly the functions where being *quietly* wrong is the danger — a misread serving size is
  out by 3× and looks plausible, a pack-shot gate that stops matching FairPrice's filenames silently costs
  10× per lookup, and a drifting commodity gate spends real money. None of those announce themselves.
  These lived in a scratchpad and were thrown away with the session **four times** before landing here on
  2026-08-04; the first run caught two bugs in its own fixtures.
- ⚠️ A lookup costs real money. The account ran out of credit mid-session on 2026-08-04. Budget ~$0.30 per
  tools-path call, **~$0.03 per pack-shot call**, ~$0.003 per commodity call.

## Searching shops beyond FairPrice and Sheng Siong (scoped 2026-08-05)

Full detail in **`docs/vendor-scoping.md`** — that file governs; this is the
orientation. Nothing here is built beyond the probe.

### The Notion side, and what the columns mean

A **Website Used** DB exists (database `3b169a18-4fe7-80b3-a7d6-f8359719b1df`,
data source `3b169a18-4fe7-80ad-b5f9-000b8824812f`): `Name`, `URL`,
`URL - discount related `, `Text`. Both URL columns were **empty until
2026-08-05**, when all nine rows were filled (NTUC, Sheng Siong, Watsons,
Guardian, Iherb, Shopee, Carousell, Google Search, and a **My Protein** row
added that day).

⚠️ **Two different prices live on every Ingredients row and they must never be
conflated** (stated by the user, 2026-08-05):

| | columns | meaning |
| --- | --- | --- |
| **baseline** | `Price,SGD` + `Weight /Units of New Product ` + `Vendor, Current ` | what the user **actually pays**, and where. Every discovery is measured against this |
| **price book** | `Vendor 1/2/3` + `Price [Vendor n]` + `Size[Vendor n]` + `Vendor n URL` | where else it can be found and what **that shop** charges. NOT what the user pays |

Measured over 94 rows: `Price,SGD` 71/94, `Vendor, Current ` **7/94**, `Vendor 1`
52/94, and `Price [Vendor n]` / `Size[Vendor n]` **0/94 — never filled, ever**.
Filling the price book is the point of the feature.

⚠️ **That last figure is the *before* picture and is now out of date.** Add/Replace fill a
slot on every tap (2026-08-09), and `npm run vendor-scan` fills them automatically for the
shops a row tags — 7 slots written on 2026-08-10 across Guardian, MyProtein and Carousell.
The census is also stale: re-count before quoting it. See
[`docs/session-2026-08-09-vendor-scan.md`](docs/session-2026-08-09-vendor-scan.md).

Rules for any writer:
1. **Match the vendor by NAME to find the index.** The mapping is per-row —
   `Vendor 1` is Shopee on `Whey [Titan]` and Watsons on the CereVe lotion.
2. **If no index names that shop, write nothing.** Never claim a free slot.
3. **Never write `Vendor, Current ` from a scan.** Moving the baseline is a
   deliberate act — that is what *Replace* is for.

⚠️ **`Vendor 3` has no `Vendor 3 URL` property and that is deliberate** — it is
the *open* slot (Google, Amazon), and an undirected search has no fixed shop to
link. Do not add the property.

⚠️ ~~**A live bug:** `ingredient-write.ts:107` writes the captured product's URL
into `Vendor 1 URL` unconditionally~~ — **fixed by the price book itself**
(2026-08-09), confirmed 2026-08-10 in both writers. `Vendor 1 URL` no longer
exists; every capture resolves its slot by matching the shop's NAME against the
row's own `Vendor 1..4` tags and writes `URL [Vendor n]`, so there is no fixed
index left to misfile into. `ingredient-write.ts` and the extension's
`notion-client.js` both route through `vendor-slots.ts` for this.

### Searches must be DIRECTED

Don't look for bread at Watsons or a face lotion at NTUC. Routing is `Vendor[n]`
tags first, then **`Catagory`** as the default for the 89 rows with no useful tag:
grocery categories → FairPrice + Sheng Siong; **`Suppliments` (30 rows) → iHerb +
MyProtein**; **`Household Supplies` (7 rows) → Watsons + Guardian**.

⚠️ This **retires the deny-list question** (old item 20). Neither category is
excluded — each is asked at the right kind of shop instead. `Suppliments` is the
**largest category in the DB and the scan has never looked at one of them**.

⚠️ **`Sheng Siong` is tagged on ZERO rows.** So the tags mean "*also* look here",
never "only look here" — code that treats an empty tag as "don't search" would
silently kill the FairPrice scan on 42 rows.

### `npm run vendor-probe` — measure, don't guess

```shell
npm run vendor-probe -- "whey protein"                      # fetch tier, all shops
npm run vendor-probe -- "vitamin c" --only watsons,guardian # narrow it
npm run vendor-probe -- "whey protein" --browser --headed   # + real Chrome over CDP
npm run vendor-probe -- "whey protein" --browser --headed --login shopee
```

Writes nothing anywhere. Reports, per shop, whether a **price AND a pack size**
can be had — and what to do about it if not. Prints its own egress IP first.

| shop | status, 2026-08-05 | note |
| --- | --- | --- |
| **Carousell** | ✅ **built** — `stores/carousell.ts` | **headed** browser for search (headless renders 0 — detected). ⚠️ **`itemCondition` is NOT usable** — all 10 listings sampled said `UsedCondition`, incl. ones badged New; gate on the card badge. ⚠️ Rendered text drops every lowercase `s`; ⚠️ the slug drops decimal points (`2.5kg`→`2 5kg`→**5 kg**) |
| **Guardian** | ✅ **built** — `stores/guardian.ts` | ⚠️ **No browser needed.** `/catalogsearch/` now 302s to the homepage (which is why it looked like an empty SPA); its **`/graphql` answers a plain `fetch`** with price, stock and size-in-name |
| **MyProtein** | ✅ **built** — `stores/myprotein.ts` | ⚠️ A product page is a `ProductGroup` of **42 variants, $36.91–$611, only 20 stating a weight**. There is no single price; each variant is its own product and one without a weight is dropped |
| **iHerb** | 🔴 403 even from residential | genuinely client-side. Sibling project's fix: CDP + `SEARCH_OVERRIDES` (`/search?kw=`, `resultHrefRe:/\/pr\//`, **name is in the link's `title` attribute**) |
| **Watsons** | 🔴 park it | reachable from residential, but an Angular SAP-Commerce SPA whose product API is behind Akamai Bot Manager. Guessed OCC paths 404 with a sensor script injected; a real browser renders only the footer. **Payoff is ONE row** in a category you may not want |
| **Shopee** | 🔑 auth wall | every anonymous route → `error 90309999` / `is_login:false`; the browser is redirected to a "Login Required" page. Needs a **hand** sign-in once in a persisted profile. ⚠️ Nothing in this repo may type a credential |

### ⚠️ The marketplace result nobody expected

Carousell works — and on whey it found **nothing worth buying**:

```
cheapest PLAUSIBLE on Carousell   $3.400/100g
baseline, Whey [Titan]            $2.500/100g
baseline, whey [Atlas]            $2.620/100g
```

**36% worse than what the user already pays.** The three listings that *did* beat
the baseline (ON Gold Standard 5 lbs at S$37 and S$38, Dymatize ISO100 5LBS at
S$40 — against ~S$120 retail) are exactly the ones the plausibility gate rejects.

⚠️ **Never take the minimum on a marketplace — the minimum is usually the scam.**
`cheapestPlausible` clusters candidates and drops anything below ~55% of the
median. One term on one day is not a verdict, but **probe more items before
building any marketplace adapter**: the premise has not paid off yet.

### `marketplace-size.ts` — and two bugs it already caught

Reading a size out of free text a stranger typed. Of 47 real Carousell listings:
100% carried a price, **62% a size**; the rest are dropped (no size = no data).

⚠️ `lbs` dominates ("5 lbs", "5LBS", "5Lb", "1.58LBS"). `stores/weight.ts` knows
only g/kg/ml/L, so without lb/oz every supplement reads as sizeless. This module
is **separate from `weight.ts` on purpose** — that one parses a size a supermarket
published as a field; this one parses a sentence, where every failure flatters.

Two bugs found in the first live run, both now covered by tests:
- `"…Protein 1.6-5 LBS"` — a **range sharing one unit** read as a flat 5 LBS.
  Only the second number carries the unit, so the multi-size check couldn't see
  it. Now rejected as `range`.
- `"2 X MuscleBlaze … - 2lb"` — read as 2 lb, not 4, because the multiplier-to-unit
  gap was 46 chars against a 40-char limit. Was $9.04/100g, now $4.52.

Both made a bad deal look good — the same family as the 32 g serving read as 100 g.

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
- `npm run ext:build` — rebuild the Chrome extension's `dist/` (see above).
- `npm run vendor-probe -- "<term>"` — can each shop yield a price AND a pack
  size? Writes nothing. `--only a,b`, `--browser`, `--headed`, `--login shopee`.
  ⚠️ Prints its egress IP first — a 403 from a datacenter address means nothing.
  ⚠️ **Stale for Guardian and Carousell** — it probes Guardian's dead
  `/catalogsearch/` URL and still trusts Carousell's `itemCondition`. See the
  vendor-scan session note.
- `npm run vendor-scan` — search the shops each row TAGS in `Vendor 1..4` and fill
  `Price/Size/URL/item Name [Vendor n]`. **Report-only; `--write` to record.**
  `--only guardian,carousell,myprotein`. ⚠️ Only ever UPDATES a slot that already
  names the shop — never claims a free slot, never evicts, never writes
  `Unit type `. Carousell opens a real Chrome window.
- `npm run check` — typecheck.
- `npm test` — **615** offline cases (`src/tests/`). Free, fast, no network.

## Key technical facts (details in LEARNINGS.md)

- **Notion SDK v5** = query `dataSources.query`, NOT `databases.query`. Ingredients
  data source `34b69a18-4fe7-80e6-904e-000b208cf560`. Property names have
  typos/trailing spaces — match exactly (`Price,SGD`, `Catagory`, `Unit type `,
  `Weight /Units of New Product `, `Used '1'/'2'/'3' Plan`).
- **Active plan** = the meals tagged `Main` in Meal prep's `Current Plan` (data
  source `34b69a18-4fe7-8086-83fa-000b24c37d2b`): their sub-item lines'
  ingredients, daily `Amount Used ` summed, monthly = daily × 20. No fallback and
  no env var: nothing tagged `Main` = empty plan (logged). The old
  `Used 'N' Plan` / `ACTIVE_PLAN_NUMBER` path is gone. Rows tagged
  `Not in Use ATM` or `Don't Search` are dropped here — see "Don't Search" above.
  `readGroceryTargets()` reads the WHOLE grocery inventory (excludes
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
- **`StoreProduct.nutritionHtml`** = the shop's own nutrition table, when it
  publishes one. FairPrice fills it from the SEARCH payload (34/72 products, free);
  Sheng Siong leaves it unset. Decides the `has macro` tag and lets Add/Replace
  write the four columns without paying. ⚠️ Never read numbers out of it directly —
  every panel is per SERVING, and `parseNutritionPanel` does the scaling and
  refuses one whose serving size isn't stated.
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

## Remaining work

*Mostly optional. Items 22–27 were added 2026-08-05; 28–30 are the inbox faults
from its first live use; **31–33 were the operational faults found and fixed on
2026-08-11** and are recorded as done because the next reader needs to know the
system has a supervisor now.*

**0. ⚠️ Five By-Unit rows state no pack weight anywhere — mostly correct, and one
of them isn't.** A counted row is compared **per piece**, and counting doesn't
normalise size, so a smaller piece wins on price every time. The guard against that
is the pack weight written down somewhere, which lets the comparison fall back to
price-per-gram (see "Counted packs" in SYSTEM-GUIDE.md).

⚠️ **The rule, from the user on 2026-08-11: the weight may be in the row's `Name`
OR in `Item Name [Vendor n]`, and if it is in neither, the item is sold by the
piece only.** So a blank here is a legitimate answer, not a backlog — a razor
cartridge, a tissue roll and a stock cube have no meaningful weight and want none
invented. `readGroceryTargets` reads both places as of that date.

⚠️ **Only the CHEAPEST slot's item name is read, never another slot's.** That
weight divides that slot's price; borrowing Guardian's 550 g to divide FairPrice's
price invents a per-100g figure that is no shop's — silent, plausible and wrong.

⚠️ **Measured against the live DB on 2026-08-11: all five have an EMPTY
`Item Name [Vendor n]`, so nothing changed yet.** That column only arrived on
2026-08-09; it fills as `vendor-scan`, Add and Replace touch each row, and the
fallback starts working for free when it does. The one row still worth a hand
edit is the eggs — 30 pieces at $6.20 with no weight is exactly the quail-egg
exposure the rule exists for.

Measured 2026-08-09, of 9 By-Unit targets (re-checked 2026-08-11, unchanged):

| row | states a weight |
| --- | --- |
| `Pu Erh (Tea bags) (100 x 2g)` | ✅ 200 g (2.0 g/piece) |
| `Bread, Wholemeal, [FairPrice] (600g)` | ✅ 600 g (30.0 g/piece) |
| `egg  (Omega 3 Enriched) (550g)` | ✅ 550 g (55.0 g/piece) |
| `Green Tea (50 x 2g)` | ✅ 100 g (2.0 g/piece) |
| **`Eggs, Whole, small, {cheap}`** | ❌ — **this is the quail-egg exposure** |
| **`Bread, Whole grain (Low GI), [Gardinier]`** | ❌ |
| **`Razor Cartridge Refill - Hydro 5 [Schick]`** | ❌ |
| **`Bathroom Tissue Roll - 4 Ply`** | ❌ |
| **`chicken soup cube`** | ❌ |

Fix by renaming in Notion — `Eggs, Whole, small, 350g, {cheap}` or
`Eggs, Whole, small (350g), {cheap}`; both parse, parentheses win if you write both.
Filling `Item Name [Vendor 1]` with the shop's own wording ("Fresh Eggs (10s) 550g")
now works just as well and is the thing a vendor scan does for you. The other four
are piece-only by the rule above and need nothing; the eggs row is the one that
motivated it.

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
8. ~~Pu Erh / Muscovado / omega-3 eggs finding nothing~~ **done** 2026-07-31 —
   all three were naming problems, none was a scraping problem. See below.
9. Optional: more `GENERIC_FORM_PATTERNS` / variety tuning as false matches
   appear. `Whey` is the last search still returning nothing from both shops —
   worth checking whether it should be named "protein powder".
10. ~~`Egg White (…)` can match "White Egg"~~ **moot** — both omega-3 egg rows
    were tagged `Don't Search` on 2026-07-31, so neither is scanned. The
    underlying weakness stands if they ever come back: the matcher is
    bag-of-words, so `{egg, white}` is identical in either order and only word
    order separates "Egg White" from a white-SHELLED "White Egg".
11. **The Chrome extension has never been used in anger.** Everything about it
    was verified through Node harnesses and browser probes — 40/40 FairPrice
    pages, 6 Sheng Siong products, and both writes proven against the live DB —
    but nobody has yet sat down and captured a shop for real. First actual use is
    the outstanding test.
12. ~~Pack-shot images for the macro lookup (#1)~~ **done** 2026-08-04 — the
    lookup reads the label off the shop's own back-of-pack photo. $0.2877 → 
    **$0.0239** and 54s → **5.2s** on Skippy, same answer; 34% of a real 32-product
    basket now takes that path. Full detail and the two gates in "Next session"
    above. **Sheng Siong still contributes no photos** — the obvious next step.
13. **The nutrition feature has never been used in anger either.** The panel
    parser, the commodity gate and the four boxes were verified with offline
    tests and live page fetches, and the lookup itself with 8 real API calls —
    but no one has yet added a real row through the extension with nutrition
    switched on. First actual use is the outstanding test.
14. ~~The offline test scripts live only in a scratchpad~~ **done** 2026-08-04 —
    `src/tests/`, **109 cases**, `npm test`. No runner, no dependency. Pack-shot
    parsing/reply parsing/commodity gate were re-created from scratch (the earlier
    scratchpad copies were already gone); the deals-page suite is new.
16. **The four new deal-card controls have never been fired at the live workflow.**
    Buy / Add / Replace / + Macros and the has-macro tag were proven by rendering
    the real page and asserting its markup, not by pressing them. `Replace` is the
    one to try first and carefully — it renames a hand-maintained row with no undo.
17. ~~Dead code left behind on purpose~~ **done 2026-08-11** — `macros-for` and
    `needsLookup` removed, `hasMacros()` was already gone. ⚠️ **The FREE path was
    kept and is what most captures use**: `derive` parses the shop's own nutrition
    panel at render time, fills the four boxes and costs nothing. Only
    **Find Macros** pays. Removing a handler that could silently spend 41 cents
    while leaving the free one is the whole point of the change.
18. ~~Docs not caught up with the 2026-08-04 redesign~~ **done** — `extension/README.md`
    was corrected for the price book on 2026-08-10 and for the deleted `macros-for` /
    `needsLookup` on 2026-08-11; `CHANGELOG.md` has been kept current since.
19. ~~Sheng Siong pack shots reach the extension only~~ **done** 2026-08-04 —
    both stores now reach both surfaces. FairPrice's search payload carries
    `images` (10/10 products, free); Sheng Siong's carries `imgKey` but **not**
    `totalImg`, so `resolveShengSiongPackShots` establishes the count with a HEAD
    probe. Verified live: `totalImg` 3 → indices [0,1,2], 2 → [0,1], unknown key →
    [0] alone, each under 2 s. Probing happens in `build-site.ts` **after** the
    deals are chosen — a couple of dozen products, not the 1,100-odd the scan
    returns — deduped by key and wrapped so a failure can never stop the page
    building.
22. ~~Fix the runner's push (2026-08-05)~~ **done** 2026-08-10 —
    `src/core/git-data-push.ts` re-applies and retries a rejected push (for
    `tg-poll.ts` as well as `push-shengsiong.ts`), and `run.cmd` now refuses to
    scan when `git pull` failed. Full story and the three warnings in
    "Infrastructure truths".
23. ~~Fix the `Vendor 1 URL` misfile~~ **already done** — closed by the
    2026-08-09 price book, verified 2026-08-10. Both writers resolve the slot
    from the row's own `Vendor n` tags and write `URL [Vendor n]`; the column the
    bug wrote to no longer exists. `extension/README.md` still described the old
    flat columns and was corrected at the same time.
24. **Decide the category→vendor routing** (see the vendor section). The one with
    the most upside: `Suppliments` is 30 rows the scan has never looked at.
25. ~~Correct the documented schedule, or move the cron~~ **done 2026-08-11** —
    `cron: "0 0 * * *"` = 08:00 SGT, chosen as a **floor on when the shops are
    scraped** rather than as a delivery time. The queue puts the run, and so the
    scrape and the digest, at ~11:30. ⚠️ An earlier-firing cron aimed at an 08:00
    arrival was tried and reverted the same day — the delay is a queue, not a
    promise. See "Infrastructure truths".
34. **Cross-check the slot walk against the user's own Notion formulas.** See
    "Start here next session" (C) for the measurement and the one expected
    difference. Cheap, local, no API cost.
26. **Marketplace adapters are NOT cleared to build.** Carousell works
    mechanically but found nothing cheaper than the baseline. Probe more items
    first — `npm run vendor-probe` is free.
27. **Shopee needs a one-time hand sign-in** before it can be probed at all.
28. ~~The ask is a yes/no on ONE guess; it should offer every candidate~~
    **done 2026-08-11** — `rankRows` + `candidatesFor`, one button per candidate,
    and a silent link only when the leader clears `ACCEPT` **and is alone**. See
    "The ask asks which one". Original note follows, for the measurements.

    *(Asked for by the user, 2026-08-10, after texting `1 x milk` and having it
    linked silently.)*

    Measured against the live DB that evening — this is a tie, not a
    near-miss:

    ```
    "milk"    LINK  1.000  Milk (Low Fat)
              LINK  1.000  Milk ( Normal)
    "eggs"    LINK  1.000  egg  (Omega 3 Enriched) (550g)
              LINK  1.000  Eggs, Whole, small, {cheap}
    "chicken" LINK  0.850  Chicken thigh, Boneless  [Seara]
              LINK  0.800  chicken soup cube
    ```

    ⚠️ **`bestRow` returns the single highest scorer and keeps the FIRST on a
    tie**, so `1 x milk` linked to `Milk (Low Fat)` only because Notion returned
    that row earlier. Reorder the query and the same text files against
    `Milk ( Normal)`. `decideItem` then sees 1.000, clears `ACCEPT` and never
    asks.

    ⚠️ **The bug is the QUESTION, not the threshold.** The rule asks "is the best
    match good enough?"; what decides whether to ask is "is there only one?".
    Those come apart precisely on the short generic words people actually text.
    Lowering `ACCEPT` would not fix it — 1.000 beats any threshold — and would
    make every confident single match nag.

    **Wanted:** `bestRow` returns the ranked list, not one row; when the runners-up
    are within a small margin of the top (a tie certainly, and probably ~0.05),
    ask **which one** with one button per candidate rather than ✅/🆕.

29. ~~A button tap can be acknowledged and thrown away~~ **done 2026-08-11** —
    `ack()` swallows a failed `answerCallback` and the work carries on; the
    offset still advances on a throw (deliberately — see "Telegram intake") but
    the failure is now reported in the chat instead of only to a console. Also
    narrowed at the root by item 32: there is a poller running now. Original
    note follows.

    **⚠️ A button tap can be acknowledged and thrown away.** Seen live on
    2026-08-10:

    ```
    update 523965592 failed: answerCallbackQuery HTTP 400:
      "Bad Request: query is too old and response timeout expired…"
    ```

    `handleCallback` awaits `answerCallback(cb.id)` — which only stops Telegram's
    spinner — **before** deleting the pending entry and doing the write. The user
    tapped while no poller was running; by the time one started the query id had
    expired, the await threw, and the handler aborted before writing anything.
    `pumpOnce` caught it, logged one line to a console nobody was watching, and
    **still advanced the offset**, so the tap was consumed and the answer lost.

    **Wanted:** clearing the spinner is cosmetic and must never gate the work —
    wrap it in its own try/catch and carry on. Then decide, separately, whether a
    handler that throws should advance the offset at all (a failed Notion write is
    currently dropped just as silently).

30. ~~A "new" item never reaches the grocery List~~ **done 2026-08-11.** All three
    questions the note below asked were answered by the user that morning and
    built the same day:
    - **re-search WHAT** → *"a different ingredient that is similar"* — the
      **Ingredients DB**, offering the next tranche and skipping what was already
      turned down. `nextCandidates()`.
    - **`(New)` vs `{New}`** → **`{New}`**, option 1: the ignored bracket, so the
      row is still searched. `newIngredientFields()`.
    - **the empty third bullet** → *"was a mistake"* — there is no third button.

    Original note follows.

    **⚠️ A "new" item never reaches the grocery List, and this file said it did.**
    `handleMessage` writes a row only for `verdict === "linked"`; `"new"` items go
    to `state.queue`, and `drainQueue` scans the shops, texts a summary and
    publishes `new-items.html` — **no Notion write anywhere in that path**. The
    `new-items.html` section above used to claim "The texted item is already on
    the grocery list by the time the page exists — the bot put it there". It does
    not. Corrected 2026-08-10.

    So today, texting something you don't already stock gets you a price
    comparison on a web page and **nothing on the list you shop from**.

    **What the user asked for (2026-08-10) — replace the single 🆕 with TWO
    buttons**, so the ask offers: the candidate rows (item 28), plus

    - **`No — re-search`** — look again for another similar product and **send a
      new message** with the option(s) found.
      ⚠️ **Ambiguous as stated: re-search WHAT?** Either (a) the Ingredients DB,
      excluding the rows already rejected, offering the next tranche, or (b) the
      shops. Read in context — it sits beside "new item", and item 28 is about
      offering more rows — (a) is the likely reading. **Confirm before building.**
    - **`New item — create in Ingredients`** — create the Ingredients row itself
      (not just price it), and while creating:
      - set `Catagory` to the right category — `categorize()` already guesses one
        and `createIngredient` already validates it against the live options;
      - set `Unit type ` to whatever suits the item (`By Gram` / `By ml` /
        `By Unit`) — the texted quantity usually says which (`2L` → By ml, `1kg` →
        By Gram, `x6` → By Unit), and `fieldsFromPurchase` already does this
        inference for the history page;
      - **prefix the `Name` with `(New)`** so it stands out as unreviewed.

    ⚠️ **`(New)` collides head-on with the bracket standard, and silently.**
    `parseName` reads `( )` as a **defining property — a hard requirement on the
    product title**. A row called `(New) Harissa Paste` would demand the word
    "new" in every candidate, match nothing at either shop, and appear in no
    section of the deals page — while looking perfectly fine in Notion. Three ways
    out, and this is the user's call:
    1. use `{New}` instead — braces are the "ignored" bracket, excluded from the
       search term *and* from every matching decision, which is exactly this job;
    2. keep `(New)` and add an explicit exemption for it in `parse.ts`;
    3. keep `(New)` and accept the row isn't scanned until the prefix is removed
       by hand — which may in fact be the point of marking it.

    ⚠️ Creating a row is the one action here with no undo and it writes to a live
    personal workspace, so it should confirm, the way *Not in use* and *Replace*
    do. It must also obey the standing rule: **never create Notion schema** — an
    unknown `Catagory` option is dropped with a warning, never added.

    ⚠️ The user's list ended with an **empty third bullet**, so a third button may
    have been intended and not written down. Ask.

31. ~~The runner loses a morning to the wake-up DNS race~~ **done 2026-08-11** —
    6 pull attempts 30 s apart, and `RestartOnFailure` (3 × 10 min) on the task
    itself, which is the only cover for the process being killed mid-wait.
    ⚠️ It had already cost **two consecutive days** of FairPrice-only pages
    before anyone looked. Full story in "The 05:30 task does not run at 05:30".
32. ~~Nothing starts the Telegram inbox~~ **done 2026-08-11** — the
    `Grocery Telegram Inbox` task, `tg-poll-run.cmd`, logon + a 15-minute
    repetition as its supervisor. See "Telegram intake".
    ⚠️ **This narrows fault 29 but does not fix it.** A tap can still arrive
    inside the window between the poller dying and the repetition restarting it,
    and `handleCallback` still lets a failed `answerCallback` abort the write.
33. ~~A zero-term scan is written and reported as success~~ **done 2026-08-11** —
    the writer refuses to publish one, the reader refuses to trust one, and
    `src/tests/scan-file.test.ts` pins both. See "A scan of ZERO terms is not a
    scan".

20. ~~`Household Supplies` is being searched, and probably should not be~~
    **superseded by routing** (item 24) — it is not excluded, it is asked at a
    pharmacy instead. Original note follows.

    **`Household Supplies` is being searched, and probably should not be.**
    `NON_GROCERY_CATEGORIES` in `notion.ts` is a DENY-list of exactly two
    (`Suppliments`, `Filler`), so any new `Catagory` option is scanned by
    default. The live options now include `Household Supplies` — priced per 100 g
    and compared against food, which is not a meaningful comparison. One line adds
    it; the user was asked on 2026-08-04 and had not yet answered.
    ⚠️ The deny-list shape means this recurs every time a category is added.
    Consider inverting it to an allow-list if the option set keeps growing.
21. Two known extension quirks, neither a bug:
    - A Sheng Siong egg carton reads `550 g / By Gram`, because they record the
      piece count in the NAME ("Fresh Eggs (10s)") and not in `packSize`. Switch
      the dropdown to `By Unit` by hand if you want it planned per egg.
    - When a shop's brand field doesn't appear in its own title (`T.Valley` vs
      "Tamar Valley Dairy"), the generic-name stripper can't match them, so the
      Name box keeps the full title. Edit it before adding.

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

### Three more, measured the same day — none was a scraping fault

**Pu Erh.** Sheng Siong does not stock it at all (0 for every spelling).
FairPrice does, under **`Pu'Er`**, **`Puer`** and **`Pu Er`** — three spellings,
none of them the item's own "Pu Erh". Added as synonyms. The apostrophe form
needs its own entry because synonyms run on the RAW string, before punctuation
is stripped, so no other rule can see it. Note the one real product
("Imperial Glutinious Rice Puer Tea Bags") publishes no pack weight, so it still
cannot be priced — matching it was only half the battle.

**Muscovado.** Never a search problem: FairPrice returns three products for
`muscovado`. Two separate things were wrong.
- The item is `Muscovado Sugar (Brown)`, and every shop titles it *Dark*
  Muscovado Sugar — never "brown" — so it failed its own `(Brown)` requirement.
  Fixed with `muscovado` → `brown muscovado`: muscovado IS unrefined brown
  sugar, so **adding the word is truer than deleting the requirement**.
- Even matched, **there is no deal.** The baseline is 0.468/100g and the
  cheapest muscovado at FairPrice is 0.767. Nothing beats what the user already
  pays. "Returns nothing" and "is not cheaper" look identical on the page — check
  which one you have before changing code.

**Omega-3 eggs.** Two faults, one of them a latent bug worth remembering:
- `tokens()` drops any token starting with a digit, so `Omega 3` and `Omega 6`
  both reduced to `["omega"]` — **the matcher could not tell them apart**, and
  both shops sell both. Fixed by folding them to the single tokens `omega3` /
  `omega6`, which survive tokenisation and stemming intact.
- The item demands `Enriched`, a word no shop prints on an omega-3 egg.
  FairPrice uses it on **bread** ("Gardenia Enriched White Bread") and on one
  unrelated "Nuyolk Vitamins Enriched Eggs", so it could not simply be deleted
  from `MUST_MATCH_KEYWORDS`. Instead `parseName()` now runs its keyword hay
  through `normSynonyms()` first, so the phrase rule `omega 3 enriched` →
  `omega3` retires the word for these items only. Verified against all 53
  targets: the only other changes are cosmetic (`wholemeal`→`wholegrain`,
  `skimmed`→`skim`, both of which already folded together downstream — `skim`
  was added to the keyword list to keep parity).

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
