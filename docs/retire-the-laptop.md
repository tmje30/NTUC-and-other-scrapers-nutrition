# Plan — retire the laptop, scan from Cloudflare

*Written 2026-08-12 evening. Nothing here is built yet. Evidence and measurements
are in HANDOVER.md under "Next session — pick up here (as of 2026-08-12, evening)".*

## What the user actually wants

**One full scan in the morning. If it fails, press a button and get one.** Their
words: that is when they plan the day around what is on sale, and *"everything else
is a waste"*.

⚠️ **This is a narrower requirement than the system currently tries to meet, and
that is the point.** The running system polls 288 times a day for a button press and
96 times a day for a pricing queue. Neither cadence was ever asked for — see
HANDOVER, *"The 5-minute cadence was never asked for"*.

## The idea this plan turns on (user's, 2026-08-12)

> If the scheduled scan fails, I can start one from the button. So I only need the
> morning scan.

That is right, and it reorders the work. The two paths have very different risk:

| | How it is placed in Singapore | Proven? |
|---|---|---|
| **On demand** (button) | The tap *arrives* from Singapore, so Cloudflare runs the Worker in the SIN colo automatically | ✅ Yes — 561 products, 0 errors, 26.7 s, no browser |
| **Scheduled** (cron) | A cron has no request to be placed near, so it needs a Durable Object with `locationHint: "apac"` | ⚠️ Works, but only measured over minutes |

Every fragile piece — the location hint, the drift risk, the stickiness nobody has
observed for more than a few minutes — exists **only** for the scheduled half.

⚠️ **So build the manual path FIRST.** Once a button reliably produces a scan, the
scheduled scan no longer has to be reliable: a cron that drifts out of Singapore
becomes a warning banner and one tap, not a broken system. This is what makes the
unproven drift acceptable rather than a blocker.

## Correcting the record before anyone builds on it

⚠️ **The Rescan button does NOT scan in the cloud today.** It commits a marker and
the laptop's five-minute job does the work — [`site.ts:663`](../src/core/site.ts)
says so plainly: *"it does nothing at all if no laptop is awake"*. Pressing it with
the lid shut does nothing, ever. The probe proved the cloud *can* do this; no code
has been written.

⚠️ **The button is on the deals page, not in Telegram.** The Telegram message
carries a link. The button lives inside the missing-shop warning banner and does not
exist on a good day, so the route is: text → link → `↻ Rescan Sheng Siong`.

## Phases

### Phase 1 — the on-demand scan in the cloud

The foundation. Everything else falls back to this, so it is built and proven first.

⚠️⚠️ **CORRECTION (2026-08-12, later the same evening). This plan originally said
"not a rewrite of the scan itself — `ss-scan.ts` already runs clean from a Worker".
That is WRONG, and it was written without checking.** The repo's scan stack is
Node-only from top to bottom:

| Module | Blocker |
|---|---|
| `stores/ddp.ts` | `import WebSocket from "ws"` — the npm package, `ws.on("message")`. Workers use `fetch(…, {Upgrade})` → `res.webSocket` → `accept()` → `addEventListener`. |
| `stores/incapsula.ts` | `node:child_process` (spawns Chrome), `node:fs`, `node:net`, `node:os`. Cannot exist in a Worker at all. |
| `ss-scan.ts` | `node:fs/promises` and `commitAndPushData`, which shells out to git. |

What *is* proven is `probe/worker.mjs` — a 255-line Worker-native reimplementation
that really did scan (561 products, 0 errors, 26.7 s). ⚠️ **But it is a probe, and
two gaps matter before its code is trusted with live data:**

1. Its `mapProduct` is explicitly labelled *"a stand-in for `parseWeight`"*. The
   real one must use `stores/weight.ts` — which is pure, no imports, and drops
   straight into a Worker.
2. **It runs ONE pass per term; the real scan runs two.** `shengsiong.ts:143`
   queries each term with `ecommPromotionFilter.active` both `true` and `false` and
   merges on `slug`, because `false` alone truncates by relevance and pushes the
   promoted items — the actual deals — off the end. A one-pass port would look like
   it worked and quietly lose deals.

⚠️ **Fidelity is the whole risk here.** The Worker writes
`data/shengsiong-latest.json`, which the entire cloud side reads as fact. A subtly
wrong mapping does not fail — it publishes wrong prices, which is the exact class of
fault this project has been bitten by repeatedly (the comma that made a $1,500
listing cost $1; the scan of zero terms that read as fresh). Port it deliberately,
with the offline tests written against the same fixtures the Node module uses.

**The file it must produce** (`stores/shengsiong-file.ts` is the reader):
`{ date, terms: <count>, source, results: { [term]: StoreProduct[] } }`. ⚠️ A file
dated today with `terms: 0` is explicitly *not* a scan — `isUsableScan` rejects it,
and the Worker must refuse to write one for the same reason the runner does.

**Auth — settled 2026-08-12.** ⚠️ **The deals page is public, so it cannot hold a
scan secret.** The button therefore keeps firing `repository_dispatch: sscan`
exactly as it does today; `scan-request.yml` stops committing a marker for the
laptop and instead calls the Worker with a secret held in **Actions secrets**. The
Worker is reachable only by Actions and by its own cron, and the page is unchanged.

⚠️⚠️ **Consequence this plan originally got wrong: the Durable Object is needed on
EVERY path, not just the cron.** The earlier claim that the on-demand path is "the
easy one" because a tap from Singapore is placed in Singapore was mistaken — the
tap does not reach the Worker. **GitHub Actions** does, from a US runner, and a
Worker placed near that request runs in the US and is challenged on every search.
So placement is load-bearing for the button too.

### ✅ Phase 1 is BUILT (2026-08-12 night) — `ss-worker/`

Deployed at `https://ss-worker.tmje30.workers.dev`; 35 tests; verified against the
Node runner at 79-of-79 fields identical on real products. **It cannot write yet:**
`GITHUB_TOKEN` is unset, so it fails closed and the cron no-ops. Full detail,
including two corrections to what this plan assumed about placement, is in
HANDOVER under *"Where this stopped"*. Remaining to finish Phase 1: set the token,
rotate `SCAN_SECRET`, and point `scan-request.yml` at the Worker.

- A Worker endpoint that scans Sheng Siong when called and commits
  `data/shengsiong-latest.json`, then dispatches the page rebuild.
- ⚠️ **Authenticate it.** Fail-closed on a shared secret, exactly as the relay does
  — the URL is public the moment it is guessed. Reuse the relay's pattern and its
  existing fine-grained PAT (Contents: read and write).
- ⚠️ **Call `cdn-cgi/trace` before trusting any "blocked" result.** If the Worker is
  not in SG, say so instead of reporting a block — a VPN or a placement drift has
  been mistaken for a WAF change three times in this project's history.
- Re-point the Rescan button at it; drop the `sscan` marker path.
- **Done when:** the laptop is shut, the button is pressed, and prices arrive.

### Phase 2 — say so when the morning scan fails

Small, and the plan has a hole without it.

- ⚠️ `daily.yml` has **no `if: failure()` step**. If the scan dies, the workflow
  stops before the Telegram step: no message, no page, no link, no button. The
  fallback assumes you are *told* it failed, and today total failure is silent.
- Add a failure notification carrying the same retry button.
- Note the partial-failure case already works well: Sheng Siong missing gives a
  message, a page, a dated warning ("yesterday's data is the latest", "today's file
  arrived empty") and the button.

### Phase 3 — move the morning scan to Cloudflare, with a retry window

Only now, with a working manual fallback and a loud failure path underneath it.

**The schedule (user's call, 2026-08-12): retry every 15 min from 09:00 to 11:00
SGT, and stop the moment a run succeeds.** If nothing has succeeded by 11:00, the
button takes over.

- Worker cron → Durable Object with `locationHint: "apac"` → verify SG → scan →
  commit → dispatch the page rebuild.
- **Nine attempts, almost always one.** `crons = ["*/15 1-2 * * *", "0 3 * * *"]`
  — 01:00 UTC is 09:00 SGT, and the second entry adds the final 11:00 attempt that
  a `1-2` range would miss.
- ⚠️ **"Stop when it succeeds" is a check, not state.** The Worker holds no state
  between invocations, so each run asks whether today's scan already landed and
  exits in milliseconds if it did. The freshness test already exists — it is the
  same `fresh` / `staleDays` logic the warning banner uses in `build-site.ts`, which
  correctly treats *"today's file arrived empty"* as **not** fresh. Reuse it; do not
  invent a second definition of "succeeded".
- ⚠️ **This is a retry loop, not the old poll.** The task being deleted polled 288
  times a day asking *"has anyone pressed a button?"*. This asks *"did the morning
  scan work yet?"* nine times and stops. Same shape, different question, ~3% of the
  runs — and none of them on the user's desktop.

**How it triggers the page.** The Worker commits Sheng Siong data and fires
`repository_dispatch: rescan`; `daily.yml` then scans FairPrice, builds the page
with fresh Sheng Siong data already in it, deploys and sends **one** Telegram
message.

- ⚠️ **The dispatch is what makes the timing possible.** A `schedule:` trigger on a
  free public repo queues by 3–3¾ h — `daily.yml`'s own comment calls its 08:00 SGT
  cron a *floor* for this reason, and a 09:00 scan that lands at noon is useless for
  planning a day. `repository_dispatch` runs promptly, which is why the relay
  already uses it for `tgsweep`. **The Worker is the clock; Actions is the worker.**
- Decide whether `daily.yml`'s own `schedule:` stays as a backstop or is dropped.
  Keeping it risks a second scan landing hours late; dropping it means the Worker
  cron is the only clock.
- ⚠️ The 08:00 SGT floor rule survives untouched — a discount read at 5am may not be
  the one on the shelf (user's call, 2026-08-11). A 09:00 start clears it anyway.
- **Done when:** a morning scan lands without the laptop being on, and the second
  attempt of the day is a no-op.

### Phase 4 — stand the laptop down, but keep it

⚠️ **DISABLE, do not delete (user's call, 2026-08-12).** The laptop stays as an
emergency runner in case Cloudflare does not pan out or something else goes wrong.
It has carried this system since day one, and the cost of keeping it is a couple of
disabled tasks and a clone on disk.

**Disabled, kept re-enablable in one click:**

- `ShengSiong Daily Scan` — the emergency runner itself. Leave the task, `run.cmd`,
  the `shengsiong-runner` clone and `run-hidden.vbs` in place.
- `Grocery New-Item Pricing` / `tg-drain` — once Phase 1 gives the cloud Sheng Siong
  pricing this has nothing left to do, but it is the same fallback argument.

**Actually deleted, because the design they serve is gone:**

- `ShengSiong Scan Request` — the every-5-minutes task, and the original complaint
  that started all of this. The button will not need a laptop to answer it.
- `data/scan-request.json`, `ss-on-request.ts`, `scan-request.yml`,
  `ss-request-run.cmd` — the marker mailbox, whole.

⚠️ **A disabled emergency runner needs a written way back or it is not a fallback.**
Record in HANDOVER: which tasks to re-enable, in what order, and the trap — a clone
left standing for weeks must be pulled before it is trusted, and `tg-drain`'s pull
is the one that has been failing silently (below).

## Do regardless of this plan

1. ⚠️ **Fix the `tg-drain` pull check.** It reports success while pulling nothing
   (HANDOVER has the detail). It is lying *right now*, and it stays in the system
   until Phase 4. Two changes: `--autostash` so a dirty dev clone stops blocking the
   pull, and an `errorlevel` check so real failures surface.
2. **Re-check the placement probe for drift**, then `cd probe/placement && npx
   wrangler delete`. One curl with `?id=place-msq4fu18-0`. Less load-bearing than it
   was — Phase 1 does not depend on it — but a `stuck:false` would change Phase 3.

## Open — needs a decision

- **Keep the relay's 15-minute `tgsweep`?** Not a scan, costs nothing locally, files
  unanswered bot questions after an hour. Worth keeping only if the bot's
  ask-about-an-item flow is used. ⚠️ Deleting the trigger stops the one-hour rule
  silently — nothing else watches for it.
- **Does `daily.yml` keep its own `schedule:` as a backstop?** See Phase 3.

## Decided

- **09:00–11:00 SGT, retry every 15 min, stop on success; the button covers anything
  still broken after 11:00** (2026-08-12). This replaced a proposed fixed second scan
  at 11:00 — a retry that stops when it works is strictly better than a second scan
  that runs whether or not the first one did.
- **The laptop is kept as an emergency runner — disabled, not deleted** (2026-08-12).

## Considered and rejected — do not re-derive

**Creating an Ingredients row up front for a queued item, marked `{queued}`, then
filling it in when the price arrives (proposed and dropped 2026-08-12).**

The instinct was sound — a queued item is invisible while it waits. It was dropped
because the queue does not touch Ingredients at all: `drainQueue` prices the item,
reports in chat and publishes to `new-items.html`, and the hour-expiry message says
outright *"nothing was added to your Ingredients DB"*. Not writing to Ingredients
unasked is a deliberate policy, not an oversight. ⚠️ Phase 1 also removes most of
the reason: once the Worker scans from Singapore the queue drains in seconds, so
"queued" stops being a state anyone sees.

⚠️ **If any future idea involves editing an ingredient's `Name`, know what it costs
before proposing it:**

- `cooldownKey` is derived from the search term, which comes from `Name`
  ([`cooldown.ts:108`](../src/core/cooldown.ts)). **Any** rename gives the row a new
  key and detaches its cooldown history, so something bought last week can reappear
  as a fresh deal with nothing flagging it.
- A rename that adds detail also **narrows every future search**. `Oranges` →
  `Oranges, Italian` stops the scan finding deals on any other orange, which is
  almost never what "record what I actually got" means.
- The store's wording belongs in **`Items Exact Name`**, whose entire job is
  provenance ([`ingredient-write.ts:276`](../src/core/ingredient-write.ts)). Writing
  it there costs nothing and breaks nothing.

## What this plan is NOT

- Not a change to FairPrice, which has always worked from Actions.
- Not dependent on a Singapore VPS. That was the fallback when the placement
  question was open; it is no longer needed unless drift proves real.
- ⚠️ **Not a lift-and-shift of the existing scan** — see the correction in Phase 1.
  This line previously claimed the opposite and was wrong.
