# Handover — Grocery Deal Scraper

Read this first, then `LEARNINGS.md` (deep technical detail + gotchas) and
`CHANGELOG.md` (what shipped). Memory files also auto-load via `MEMORY.md`.

*Last reviewed 2026-08-05. The system is live and self-running. The parts most
likely to bite a newcomer, all flagged ⚠️ below: the Incapsula browser mint, the
two comparison dimensions, and — for the Chrome extension — the fact that
FairPrice's JSON-LD is invalid on **every** product while Sheng Siong publishes
no readable data at all.*

*⚠️ **Before you diagnose ANY shop as blocked, read "Your IP decides what you can
scrape" below.** On 2026-08-05 a whole afternoon's conclusions about Watsons were
wrong because the machine was on a VPN. The same probe, same minute, gives
opposite answers from a datacenter address and a residential one.*

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

Sheng Siong is blocked from datacenter IPs, so it runs via a **residential-IP
hybrid**: a runner (the user's **laptop**, daily) scans Sheng Siong and commits
`data/shengsiong-latest.json`; the cloud reads that file. FairPrice runs in the
cloud directly. If the file is missing/stale the page degrades to FairPrice-only.

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

## Live system

- **Repo:** https://github.com/tmje30/NTUC-and-other-scrapers-nutrition — **PUBLIC**
  (Pages needs public on the free plan; no secrets in repo), branch `main`.
- **Live page:** https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/
  Sections, in order: "🔻 On sale now", "In your plan", "Other items on offer",
  "Close matches · not exactly what you asked for", "Recently bought · not
  searched". Cards show `Item [packsize] Price $x  −%`, the found product, price
  per kg/L **or per piece**, and `uses ~X/month`. A ⚠️ banner under the header
  means a shop was missing from the scan.
- **Cloud schedule:** GitHub Actions `.github/workflows/daily.yml`,
  `cron: "0 2 * * *"` = 02:00 UTC, plus manual `workflow_dispatch`.
  ⚠️ **It nominally means 10:00 SGT and actually delivers ~13:20–13:50 SGT** —
  GitHub queues scheduled runs on free public repos by ~3.5 h, measured every day
  01–04 Aug. See "Infrastructure truths". "It didn't run" is usually "not yet".
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

Each deal card has a **Buy** button on the left. The page is static, so it
can't hold a Notion token: Buy opens a **pre-filled GitHub issue** ("Add: [NTUC]
Milk", payload in a ```json block), you tap Submit, and
`.github/workflows/add-to-list.yml` does the privileged half —

⚠️ **It was called "Add" until 2026-08-04, and only the LABEL changed.** The CSS
class, the `AddPayload`, the `grocery-add` issue label, the `Add: ` title prefix
the workflow's allowlist matches, and `add-to-list.yml` itself are all still
`add`. It was renamed on the page because a second button called **Add** now sits
on the same card and writes to **Ingredients** instead — two buttons saying "Add"
that hit different databases is exactly the mis-tap worth a rename. Renaming the
machinery too would have broken every in-flight issue for nothing, so don't.

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

### ⚠️ The daily job runs ~3.5 hours late, every day

`daily.yml` is `cron: "0 2 * * *"` and every doc says **10:00 SGT**. Measured
actual firing times:

| date | fired (UTC) | late by |
| --- | --- | --- |
| 08-01 | 05:30 | +3h30 |
| 08-02 | 05:31 | +3h31 |
| 08-03 | 05:46 | +3h46 |
| 08-04 | 05:18 | +3h18 |

So the Telegram digest actually lands about **13:20–13:50 SGT**. This is ordinary
GitHub Actions queueing on a free public repo, not a fault — but "it didn't run"
is almost always "it hasn't run *yet*". **To land near 10:00 SGT the cron would
have to be ~`30 22 * * *`** (the previous day). Not changed; the user's call.

### ⚠️ The laptop runner scans into a doomed push when the network is late

Real failure, 2026-08-05 07:23. `run.cmd` does `git pull` then `npm run push-ss`
and **ignores the pull's exit code**:

```
fatal: unable to access 'https://github.com/…': Could not resolve host: github.com
```

The laptop had woken before DNS was up. The pull failed, the scan then ran fine
(58 terms, 0 errors), committed — and the push was **rejected** because the clone
was 12 commits behind. Today's Sheng Siong data sat stranded locally; the cloud
build went FairPrice-only. Recovered by hand with `git pull --rebase && git push`.

**Not yet fixed.** Two changes are wanted, neither made:
1. `gitPush` in `push-shengsiong.ts` should rebase-and-retry on rejection — the
   pattern `add-to-list.yml` already uses for cooldown pushes.
2. `run.cmd` should not scan when the pull failed.

⚠️ **The Rescan button cannot help here.** It only renders inside the ⚠️ banner,
which only appears when a shop is **missing from a build that happened**. "No
build at all" has no button. Its absence on a healthy page is correct behaviour,
not a bug — that confused the user on 2026-08-05.

## Next session — pick up here (as of 2026-08-05)

### Uncommitted

The whole 2026-08-05 vendor investigation: `src/core/browser-cdp.ts`,
`src/core/marketplace-size.ts`, `src/scripts/vendor-probe.ts`,
`src/tests/marketplace-size.test.ts`, `docs/vendor-scoping.md`, plus the
`vendor-probe` line in `package.json` and one import in `src/tests/run.ts`.
`npm run check` clean, **`npm test` 167 passing** (was 109). The tree is rebased
onto `58ce49c`.

Everything the previous handover listed as uncommitted **is now committed and
pushed**, the orphaned worktree is gone, and `CHANGELOG.md` / `extension/README.md`
have caught up. Old item 18 is closed.

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
- **`npm test` — 195 offline cases, free and in the repo** (`src/tests/`). Seven suites: pack-shot selection
  and its commodity gate, nutrition-panel parsing, macro-reply parsing, name derivation, marketplace size
  parsing, cooldown length (including the Weekly Buy route), and the deals page's markup
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

Rules for any writer:
1. **Match the vendor by NAME to find the index.** The mapping is per-row —
   `Vendor 1` is Shopee on `Whey [Titan]` and Watsons on the CereVe lotion.
2. **If no index names that shop, write nothing.** Never claim a free slot.
3. **Never write `Vendor, Current ` from a scan.** Moving the baseline is a
   deliberate act — that is what *Replace* is for.

⚠️ **`Vendor 3` has no `Vendor 3 URL` property and that is deliberate** — it is
the *open* slot (Google, Amazon), and an undirected search has no fixed shop to
link. Do not add the property.

⚠️ **A live bug, not yet fixed:** `ingredient-write.ts:107` writes the captured
product's URL into `Vendor 1 URL` unconditionally — the slot belonging to whatever
shop `Vendor 1` names. Capture from Guardian and a Guardian URL lands in the
Watsons slot. 52 rows are exposed. Both writers (extension *Add*, page *Add*).

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
| **Carousell** | ✅ works end to end | **headed** browser for search (headless renders 0 — detected), plain `fetch` for the listing page, whose JSON-LD carries price + machine-readable `itemCondition` |
| **Guardian** | ✅ browser tier renders prices | no anti-bot at all, just an SPA. Next step is pinning the card selector; its `/graphql` is the cheaper long-term route |
| **MyProtein** | 🟠 28 products, 28 priced, **0 with a size** | names are "Impact Whey Protein + Collagen"; size lives in an on-page **Amount** variant. Needs a second fetch per product |
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
- `npm run check` — typecheck.
- `npm test` — **195** offline cases (`src/tests/`). Free, fast, no network.

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

*Mostly optional — but **22 is not**: the laptop runner can currently scan
successfully and still lose the data. Items 22–27 were added 2026-08-05 and are
listed first because they are the live ones.*

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
17. **Dead code left behind on purpose, to keep the diff honest.** The extension's
    `macros-for` worker handler and the `needsLookup` flag `add-item` returns both
    lost their only caller when the automatic lookup went. Harmless, but they
    describe a behaviour that no longer exists, which is the kind of comment that
    misleads a year from now. `hasMacros()` in `flow.js` is a third, older one.
18. **Docs not yet caught up with the 2026-08-04 redesign:** `CHANGELOG.md` and
    `extension/README.md`. This file is current.
19. ~~Sheng Siong pack shots reach the extension only~~ **done** 2026-08-04 —
    both stores now reach both surfaces. FairPrice's search payload carries
    `images` (10/10 products, free); Sheng Siong's carries `imgKey` but **not**
    `totalImg`, so `resolveShengSiongPackShots` establishes the count with a HEAD
    probe. Verified live: `totalImg` 3 → indices [0,1,2], 2 → [0,1], unknown key →
    [0] alone, each under 2 s. Probing happens in `build-site.ts` **after** the
    deals are chosen — a couple of dozen products, not the 1,100-odd the scan
    returns — deduped by key and wrapped so a failure can never stop the page
    building.
22. **Fix the runner's push (2026-08-05).** Rebase-and-retry in `gitPush`, and
    stop `run.cmd` scanning when `git pull` failed. See "Infrastructure truths".
    **This is the highest-value item here — it protects the live system.**
23. **Fix the `Vendor 1 URL` misfile** (`ingredient-write.ts:107`) — writes the
    captured URL into slot 1 whatever shop `Vendor 1` names. 52 rows exposed.
    Small and self-contained.
24. **Decide the category→vendor routing** (see the vendor section). The one with
    the most upside: `Suppliments` is 30 rows the scan has never looked at.
25. **Correct the documented schedule**, or move the cron. Everything says 10:00
    SGT; it actually delivers ~13:20–13:50.
26. **Marketplace adapters are NOT cleared to build.** Carousell works
    mechanically but found nothing cheaper than the baseline. Probe more items
    first — `npm run vendor-probe` is free.
27. **Shopee needs a one-time hand sign-in** before it can be probed at all.
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
