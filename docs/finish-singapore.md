# Plan — finish the Singapore side

*Written 2026-08-31. Step 1 is built; steps 2–5 are not. Decisions taken by the user
this session are recorded under "What was decided" — they close two questions that
[`daily-vendor-sweep-scope.md`](daily-vendor-sweep-scope.md) deliberately left open.*

## What "finished" means

Three things are outstanding, and only the first is what anyone would call broken:

1. **Carousell, Watsons and iHerb have not run since 2026-08-17**, when the laptop
   came off the rota. They are 14 of the 120 row×vendor pairs in the price book.
2. **Nothing sweeps the price book on a schedule.** `npm run vendor-scan` is still a
   command someone types. Scoped in `daily-vendor-sweep-scope.md`; unbuilt.
3. **Cloud new-item pricing has never priced a real item.** The workflow deploys and
   four shops answer, but no queued item has passed through it since the move.

## What was decided (user, 2026-08-31)

| question | answer |
|---|---|
| Where does the Singapore-originating box live? | **The laptop comes back, narrowly** — not a VPS. "Something working" first. |
| What fires it? | **Waking up.** |
| How often? | **Daily, alongside the cloud sweep.** |

⚠️ **The VPS is deferred, not rejected.** The measurement that would decide it is
recorded under "If the laptop leg disappoints" below, so picking it up later does not
mean re-deriving the case for it.

## ⚠️ The three shops are two problems, not one

This was stated as "they need the laptop" and that is true but useless — the reasons
differ, and one of them had already stopped being true.

| shop | why it was off | needs Chrome? |
|---|---|---|
| **Carousell** | **Geography.** Behind Cloudflare, 403s every country but SG, and a Worker propagates the *caller's* country — proven twice, including the `via=alarm` variant that sheds the caller's country and then presents as `US`. | **No** — since 2026-08-17 |
| **Watsons** | Headless is detected; Akamai renders the grid then **wipes** it (52 prices at 7–16 s, 484 B of footer at 22 s). | **Yes, headed** |
| **iHerb** | Plain `fetch` gets 403; headless is detected. No wipe. | **Yes, headed** |

So the laptop leg is all three shops, but Chrome launches for **two**.

## ✅ Step 1 — Carousell off Chrome (BUILT 2026-08-31)

`ROUTES` in `src/core/vendor-scan.ts` routed Carousell through `stores/carousell.ts`,
the CDP path. `new-items.ts` had already moved to `carousellViaWorker` on 2026-08-17
and left `vendor-scan` behind — the two disagreed about the same shop for two weeks.

⚠️ **And the Worker hop here is NOT about geography**, which is the confusing part:
this route only ever runs from Singapore anyway. What Carousell refuses is the
**client**. Measured 2026-08-17, same laptop, same minute, same URL:

| client | `/search/` | `/p/` listing |
|---|---|---|
| Node's `fetch` (undici) | **403** | ✅ 200 |
| `curl -L` | ✅ 200 | ✅ 200 |
| `ss-worker`'s fetch | ✅ 200 | ✅ 200 |

Parity was checked before the new-items swap and is inherited here: **HTML 45 priced
cards, CDP 47**, same term, minutes apart.

⚠️ Needs `SCAN_SECRET` (present in the dev clone's `.env`) and a reachable
`ss-worker`. A missing secret **throws** rather than falling back to Chrome — a
broken configuration must not hide behind a slower path that happens to work. The
CDP `carousell` export is untouched and is still what `vendor-probe --browser`
exercises. 993 + 33 + 35 tests pass.

## Step 2 — the laptop leg, on wake

**One new task, cloned from `ShengSiong Daily Scan`, which is already the right
shape.** Its exported XML carries both of the settings this needs:

- `<StartWhenAvailable>true</StartWhenAvailable>` — **this is the wake trigger.** A
  daily calendar trigger the machine sleeps through is run when the machine next
  becomes available. This is not a new mechanism: it is exactly why the 05:30 scan
  actually fired at ~06:47, logged as a fault on 2026-08-11 because the morning
  deals had a deadline. **The price book has no deadline, so the same behaviour is
  the feature.**
- `<LogonType>InteractiveToken</LogonType>` — ⚠️ **load-bearing, and easy to get
  wrong.** "Run whether user is logged on or not" gives the task a session-0
  desktop, where a *headed* Chrome has nothing to render into. Watsons and iHerb
  would fail in a way that reads exactly like detection. Keep it interactive.

Command: `npm run vendor-scan -- --only watsons,iherb,carousell --write`
(`--only` takes a comma list and matches the `Vendor n` option by substring —
`vendor-scan.ts:88`.)

Wrapper: a new `vendor-sweep-run.cmd`, fronted by `run-hidden.vbs` so it does not
paint a console window, with the **6 × 30 s `git pull` retry** copied from
`laptop-run.cmd`. That retry is not defensive padding — it exists because the laptop
wakes before DNS is up, and `RunOnlyIfNetworkAvailable` does **not** cover it (it
asks whether an adapter has a connection, not whether a name resolves).

Keep `RestartOnFailure` 3 × 10 min: it is the only cover for the machine going back
to sleep mid-run, which Task Scheduler records as 1067 `ERROR_PROCESS_ABORTED` and no
amount of in-script retrying survives.

### ✅ Which clone it runs in — DECIDED 2026-08-31: the runner clone

The sweep needs `NOTION_TOKEN` and `SCAN_SECRET`, and the obvious home is the **dev
clone** — which is the hazard: a job there runs *whatever source is checked out*, and
that tree is **meant** to be mid-edit. It holds uncommitted Danish work as this is
written. An unattended **write to Notion** from a half-finished tree is a different
risk from a poller crash-looping visibly in a log.

**Decision: put an `.env` in `C:\Users\newuser\shengsiong-runner\repo` and run the
sweep there.** Measured before choosing, because two of these three facts decided it:

- the runner clone **already has `node_modules`**, and its `package.json` is
  **identical to `origin/main`** — `npm run vendor-scan` works there today;
- ⚠️ **no shim has ever run `npm install`** — not `laptop-run.cmd`, not
  `ss-request-run.cmd`, not `tg-drain-run.cmd`. A *new* clone would therefore fail its
  first unattended run on a missing dependency, with nobody watching;
- git auth is **machine-level** (`credential.helper=helper-selector`), not a token in
  `.env`, so pushes work from any clone on this laptop.

⚠️ **The reason that clone had no `.env` has expired.** It was "a scan-only clone needs
no secrets". A sweep that writes prices into Notion does.

The two rejected options, so they are not re-proposed:

| | rejected because |
|---|---|
| **a third clone** (`vendor-sweep\repo`) | Equally safe, strictly more to drift: a fourth folder, a second `.env` to keep in step through a token rotation, and an `npm install` nothing automates. |
| **dev clone + clean-tree gate** | It would have skipped every day since 2026-08-17. **A skip produces no output, which is indistinguishable from "no prices changed"** — the failure shape this project has hit four times. |

⚠️ **Two disabled tasks still point at that folder** (`ShengSiong Daily Scan`,
`ShengSiong Scan Request`). Leave them disabled: `MultipleInstancesPolicy` is per-task,
so two tasks sharing one clone can collide on `git pull` (`index.lock`).

### ⚠️ Nothing in the laptop path installs dependencies

Latent, not active — the runner clone matches `main` exactly today. But the day a
`package.json` change lands, every laptop task pulls it and then runs against stale
`node_modules`, and how that fails depends on which dependency moved.

**The new wrapper should compare `package-lock.json` across the pull and `npm ci` when
it moved.** Cheap, and it closes the trap for whatever else is scheduled here later.

## Step 3 — the cloud leg, daily

The other 106 pairs, in Actions, after the morning digest.

⚠️ **The one decision that decides whether it is real:** `vendor-scan`'s Sheng Siong
route is `SHENGSIONG_LIVE === "1" ? shengsiong : shengsiongFile`, and in Actions that
reads the **committed scan file** — which only holds the ~60 terms the daily scan
searched. Any other term finds nothing, and finding nothing is indistinguishable from
"not stocked". **The cloud sweep must route Sheng Siong through
`shengsiongViaWorker`**, as `CLOUD_NEW_ITEM_SHOPS` already does. Without that, half
of it is theatre: it would run daily, report success, and write nothing. This is the
most likely explanation for the 2026-08-11 finding that 49 rows tagged Sheng Siong
had no price between them.

`--only ntuc,"sheng siong",guardian,"my protein"` — Carousell, Watsons and iHerb must
be excluded here, not merely expected to fail.

⚠️ **First cloud run report-only** (omit `--write`). It will show, for the first time,
how many slots today's scan would make **dearer** — the number that says how well the
cheaper-only rule is holding.

## Step 4 — prove the path that has never run

Text the bot something that matches no ingredient. That exercises cloud new-item
pricing end to end, and it is the last unexercised thing in the Singapore system.
Nothing else on this list depends on it, so it can happen any time.

## Step 5 — make the silence loud

Two legs now, on two machines, both able to fail quietly. **A disabled task and a day
with no price changes produce identical output: nothing.** This project has now been
bitten by that shape four times (the poller's 2,547 silent failures, the two-day
scan gap, the empty scan pushed as a success, the backstop dead for four mornings).

So the sweep must report **which legs ran**, not just what changed — and the failure
notifier that first fired on 2026-08-18 should cover the laptop leg's absence, not
only its errors.

## If the laptop leg disappoints

The VPS case, kept so it does not have to be re-derived:

- **Watsons answered 200 from a Singapore *datacenter* address** (`AS60068`,
  2026-08-11). The 403 on 08-05 was one specific pool (`AS212238`), not
  datacenter addresses as a class — so a VPS is not disqualified.
- `CHROME_CANDIDATES` (`incapsula.ts:39`) already lists `/usr/bin/google-chrome` and
  `/usr/bin/chromium`, and `CHROME_PATH` overrides it. **The browser code is already
  portable to Linux.**
- Two unknowns, both answerable in one afternoon with
  `npm run vendor-probe -- "<term>" --only watsons,iherb,carousell --browser`, which
  prints its own egress IP and distinguishes a 403 from an SPA shell:
  1. does a **headed Chrome on Xvfb** get past Watsons' and iHerb's detection?
  2. does *that* VPS's address get denied at Akamai the way `AS212238` was?

Rent by the month, measure, then decide.
