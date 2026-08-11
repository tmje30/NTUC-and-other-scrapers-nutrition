# The inbox moves to the cloud — "I sent a telegram but nothing happened"

**2026-08-11.** The complaint was latency, not breakage. Everything worked; nothing
was awake.

## What actually happened

The session opened by checking what ran, not by reading code — the rule at the top of
`HANDOVER.md`. Three facts, in this order:

| | |
| --- | --- |
| the scheduled task | alive, `0x800710E0` on the 15-min trigger = *instance already running*, healthy |
| the poller process | alive since 17:29, **nothing processed since 21:11:21** |
| Telegram | **0 updates queued** for `@Grocery69_bot` |

Those last two together said the message had not reached the bot *at all* — a queued
update would have been visible, a handled one would have moved the state file. So the
first theory was a wedged poll loop. **That theory was wrong**, and the test used to
support it was invalid: forcing a second `getUpdates` from outside did not make the
poller log a `409 Conflict`, but neither did it against a freshly restarted poller, so
the test proves nothing in either direction. Worth remembering — it looks like a clean
liveness probe and isn't one.

The Windows event log settled it in one query:

```
17:29:03  Kernel-Power 507  exiting Modern Standby   → poller starts 17:29:09
18:26:27  Kernel-Power 506  ENTERING Modern Standby  → the text arrives; Telegram queues it
20:59:21  Kernel-Power 507  exiting Modern Standby   → 94 × "poll failed: fetch failed"
21:11:19                    the list is processed    → 7 rows + 2 questions
```

**The laptop was asleep for 2 h 45 m and Telegram held the message for it.** The
7 grocery rows and the two questions were all correct — just hours late. The user's
summary: *"the grocery text came 3 hours later btw.. that was way too long"*.

⚠️ **`Get-WinEvent -ProviderName Microsoft-Windows-Kernel-Power` belongs in the same
first-minute checklist as `push-ss.log`.** On a Modern Standby machine a sleeping
process leaves no trace in any application log: no error, no gap marker, nothing but
a silence that looks exactly like an idle poller.

## Why GitHub alone could not fix it

The user's question was the right one: *"can this not be done using github? must my
laptop be on?"*

- **Telegram cannot call GitHub.** `setWebhook` POSTs Telegram's own JSON to a fixed
  URL. `POST /repos/{repo}/dispatches` requires `Authorization: Bearer`, an
  `Accept` header and an `{event_type, client_payload}` body. Telegram sends a
  `secret_token` header and its own body, and nothing else. There is no way to wire
  the two together directly.
- **Actions `schedule:` is worse than the laptop.** This repo has already measured
  free-public-repo cron queueing at ~3–3¾ h. A 5-minute cron would reproduce exactly
  the delay being removed.
- **`repository_dispatch` starts promptly** — the Buy button has depended on that
  since 2026-07-29.

So the minimum viable shape is one always-on thing that speaks both protocols. It can
be tiny, and it is: `relay/worker.mjs` holds no state, reads no Notion, and decides
nothing about groceries.

## What splits, and where the line falls

The important realisation is that **almost none of the inbox needed the laptop.**

| | needs | runs |
| --- | --- | --- |
| parse a list, match it to Ingredients, write the grocery-list row | Notion | **cloud** |
| ask about a near-miss; every button tap; price-book review taps | Notion | **cloud** |
| price an item with **no** Ingredients row | a residential IP | **laptop** |

Only the last one is stuck, because it means asking Sheng Siong. So `deferPricing`
leaves those items on a queue and **says so in the chat**; `npm run tg-drain` prices
them on the laptop's next wake, every 15 minutes.

⚠️ **The cloud does not scan FairPrice-only instead, and that is deliberate.** A
new-item card comparing one shop is indistinguishable from one comparing five. Late is
recoverable; quietly narrower is not.

## The three things that were nearly wrong

**1. State had nowhere to live.** A webhook has no process. Every update is a fresh
Actions run on a fresh checkout, so an ask held in memory or in `.sessions/` is a
question the user answers into the void: they tap, the run that reads the tap has never
heard of the token, and it replies "already answered" about something nobody answered.
That is fault 29 with a new cause and an identical appearance from the sofa. State is
now `data/tg-inbox-state.json`, committed — the same reasoning that put
`vendor-review.json` in the repo.

**2. Two runs write that file at once, by design.** Two taps land seconds apart and
each is its own run. The asks are therefore stored as a **list keyed by token**, not
the map they are in memory, so `merge-data.ts` — built for exactly this collision and
proven against the real 06:17 one — can merge them. ⚠️ The removals are what make a
merge essential rather than a union: answering a question *deletes* its ask, and a
union would put the answered question back on screen with live buttons. There is
deliberately **no `concurrency` group** on the workflow; GitHub keeps one pending run
per group and cancels the rest, which would lose the middle taps of a burst.

**3. The laptop drainer would have clobbered the cloud.** `commitAndPushData`'s
recovery writes the run's whole file over the new remote — correct for a scan, because
today's scan is the whole truth about today. For the state file it would resurrect
every question answered since the drainer last read it. Hence
`DataPushOptions.reapply`: the drainer keeps *theirs* and removes only the queue
entries it actually priced.

## Latency, and the one thing the relay must do itself

An Actions run takes 20–60 s to start. That is fine for a grocery list and **not** fine
for a button tap: Telegram expires a callback query id in about a minute, and letting
it expire is precisely fault 29. So the relay answers `answerCallbackQuery` itself, at
the edge, in ~50 ms. The Actions run's own `ack()` then fails as already-answered,
which it has swallowed by design since 2026-08-11 morning. For a text the relay sends
`sendChatAction: typing`, so the chat visibly reacts within a second — the complaint
this whole change came from was a chat that sat there doing nothing.

⚠️ **Everything answers 200 except a bad secret.** Telegram re-sends any update it did
not get a 2xx for, so a 500 on a malformed body means the same update arrives again and
again, writing the same grocery row each time. The failures worth reporting are
reported *into the chat* — including a failed dispatch, which would otherwise reproduce
the original complaint exactly.

## Also fixed, both found by reading real output

- **`Carrots x 1kg` parsed to the name `"Carrots x"`.** `x` means `*`; the size strip
  runs first and takes the multiplier's number with it, stranding the `x`. It scored
  0.65 against `carrots, Normal` and asked a question it knew the answer to — `Carrots`
  scores 1.000. ⚠️ Stripped as a whole word, never a character: the old leading
  character class would turn `Xylitol` into `ylitol`.
- **`Current Price ` never went missing — the user made it a formula.** Seven
  `no "currentPrice" column found` warnings per texted list, about a column in plain
  sight. Resolving it to null was always correct; only the message lied.
  `computedColumnFor()` now tells *gone* from *computed*, using the same wording table
  `resolveListProps` matches on so the two cannot disagree. ⚠️ A doc comment claiming a
  guard is not a guard — the same lesson as `pricePerKgLabelFor` that morning.
