# The Telegram relay — getting the laptop out of the loop

```
Telegram ──webhook──▶ Cloudflare Worker ──repository_dispatch──▶ Actions: tg-inbox.yml
                      (free, always on,                          (parse · match ·
                       ~50 ms, holds no state)                    write the row · ask)
                                                                        │
                                    a genuinely NEW item needs a shop ──┘──▶ laptop,
                                                                          next 15 min
```

**Why:** a list texted at ~18:20 on 2026-08-11 was answered at **21:11**. The laptop
entered Modern Standby at 18:26 and Telegram held the message for 2 h 45 m. Nothing
was broken — there was simply nothing awake to hear it.

**Why a Worker and not just GitHub:** Telegram cannot call GitHub. `setWebhook` POSTs
Telegram's own JSON to a fixed URL; `POST /repos/{repo}/dispatches` needs an
`Authorization: Bearer` header and an `{event_type, client_payload}` body, and
Telegram sends neither. And Actions **cron** is not a substitute — free public repos
queue scheduled runs by ~3–3¾ h, which is the latency being removed. Only
`repository_dispatch` starts promptly.

**Cost:** nothing. Cloudflare's free tier is 100 000 requests/day; this repo is
public so Actions minutes are free.

---

## What you need first

- A Cloudflare account (free).
- A **fine-grained GitHub PAT**, this repo only, **Contents: read and write** — that
  is the permission `repository_dispatch` requires. Nothing else.
- A webhook secret: any long random string. Generate one and put it straight into
  `.env` (gitignored), so the two places that need it can both read it and it never
  appears in shell history or on screen:
  ```bash
  node -e "console.log('WEBHOOK_SECRET='+require('crypto').randomBytes(24).toString('hex'))" >> .env
  ```

## 1. Deploy the Worker

```bash
cd relay
npx wrangler login
npx wrangler deploy
```

⚠️ One per line, not `&&`: this machine's shell is **Windows PowerShell 5.1**, where `&&`
is a parser error ("not a valid statement separator in this version"). Every `cd relay`
below is likewise its own line. `wrangler login` opens a browser — it cannot be scripted.

Note the URL it prints — `https://grocery-telegram-relay.<subdomain>.workers.dev`.

## 2. Give it its four secrets

```bash
npx wrangler secret put WEBHOOK_SECRET
```

Then the same for `TELEGRAM_BOT_TOKEN` (the value from `.env`), `GITHUB_TOKEN` (the
PAT from above) and `ALLOWED_CHAT_ID` (`7626546412`). Each prompts for the value, so
none of them lands in shell history. `REPO` is already in `wrangler.toml`.

## 3. Stop the poller — **before** registering the webhook

⚠️ A bot has a webhook **or** serves `getUpdates`, never both. Leave the poller
running and it gets `409 Conflict` on every call and the chat just looks dead — the
exact trap `@Big_Notion_Bot` set on 2026-08-10.

```bash
schtasks /Change /TN "Grocery Telegram Inbox" /DISABLE
```

Then kill the running process (it lives for days, so disabling the task alone leaves
it up):

```bash
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name like '%node%'\" | Where-Object { $_.CommandLine -like '*tg-poll*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
```

## 4. Carry the open questions across

The poller's questions live in `.sessions/tg-inbox.json`; the cloud reads
`data/tg-inbox-state.json`. Without this step, any question already on screen has
live buttons that no run has ever heard of — you tap, and get "already answered".

```bash
npm run tg-adopt-state
```

Then commit and push `data/tg-inbox-state.json`. ⚠️ **After** step 3, never before:
while the poller is alive it owns that file and will answer a tap behind your back.

## 5. Register the webhook

```bash
npm run tg-webhook -- set https://grocery-telegram-relay.<subdomain>.workers.dev
```

It reads `WEBHOOK_SECRET` from `.env` — the same value you gave the Worker — and
**refuses to register without one**: a webhook with no `secret_token` accepts an update
from anyone who guesses the URL, which is a stranger writing to the grocery list. A
third positional argument still works, but puts the secret in shell history.

It prints which bot it is about to change and **refuses outright** if that is
`@Big_Notion_Bot`, whose webhook is the user's Notion Worker's only delivery path in
another project.

⚠️ **On a brand-new `workers.dev` subdomain, expect this to fail first** with
`Bad Request: bad webhook: Failed to resolve host: Temporary failure in name resolution`.
Nothing is misconfigured — **Telegram's own resolvers lag a new subdomain by up to about
an hour**, while Google/Cloudflare/Quad9/OpenDNS all answer it and `curl` from here works.
It failed twice at ~25 min and succeeded untouched at ~70 min on 2026-08-12. Just wait and
re-run. Don't debug it, and don't leave the bot deaf meanwhile: put the poller back
(see "Going back") if the wait will be long.

## 6. Replace the laptop's Telegram job

Pricing a brand-new item still needs a **Singapore** IP — Sheng Siong's Incapsula
challenges by country, and Actions runners are US Azure. (Not residential-vs-datacenter:
that premise was disproven on 2026-08-11, see `HANDOVER.md` "it is GEOGRAPHY".)
`tg-drain-run.cmd` is the replacement job — a short batch run instead of a forever-poller.

```bash
schtasks /Create /TN "Grocery New-Item Pricing" /TR "'C:\Users\newuser\Claude Private projects\NTUC and other scrapers nutrition\tg-drain-run.cmd'" /SC MINUTE /MO 15 /IT /F
```

`/IT` (interactive token) matters for the same reason as the Sheng Siong scan: it runs
as the logged-in user, so Git Credential Manager authenticates the push and no PAT is
stored on disk.

## 7. Check it

Text the bot. You should see a typing indicator within a second and the reply
20–60 s later. If not:

```bash
npm run tg-webhook
```

Is it registered, and what was Telegram's last error? Then, from `relay/`:

```bash
npx wrangler tail
```

The live log: did the delivery arrive, did the dispatch fire?

`npm run tg-diag` still answers "which bot is this and what is queued".

---

## Going back

```bash
npm run tg-webhook -- delete
schtasks /Change /TN "Grocery Telegram Inbox" /ENABLE
schtasks /Change /TN "Grocery New-Item Pricing" /DISABLE
```

The poller works again immediately. It reads `.sessions/tg-inbox.json`, which is
still there — but questions answered in the cloud meanwhile are only in
`data/tg-inbox-state.json`, so answer or ignore whatever is outstanding before
switching back rather than in the middle.

## What lives where, after this

| | where it runs | when |
| --- | --- | --- |
| parse a texted list, match it, write the grocery-list row | **cloud** | 20–60 s |
| ask about a near-miss, handle every button tap | **cloud** | 20–60 s |
| price-book review taps (`vy`/`vn`) | **cloud** | 20–60 s |
| file a question nobody answered (the one-hour rule) | **cloud** | 60–75 min |
| price a genuinely new item + publish `new-items.html` | **laptop** | ≤15 min awake |
| the daily Sheng Siong scan | **laptop** | 05:30, unchanged |
| the daily deals page + digest | **cloud** | unchanged |

⚠️ **The Worker is also the CLOCK, not just the doorbell** (added 2026-08-12). Its
`[triggers] crons = ["*/15 * * * *"]` fires a `tgsweep` dispatch every fifteen minutes,
and `tg-sweep.yml` files any question older than an hour as a plain grocery-list row.
GitHub's own `schedule:` could not do this — free public repos queue cron by ~3–3¾ h,
so "after an hour" would land past four. **Delete the cron trigger and the timeout
silently stops happening**; nothing else in the cloud is watching. `npx wrangler tail`
shows each tick, and the Actions tab shows a run every 15 minutes (most exit in
seconds having found nothing).

⚠️ **Until the Worker is deployed, the poller is what sweeps** — in its own loop, every
25 s, but only while the laptop is awake. That is the one part of the one-hour promise
that still depends on this machine, and deploying the relay is what removes it.

⚠️ **State lives in the repo now** (`data/tg-inbox-state.json`), because a webhook has
no process to hold it in — every update is a fresh checkout. Two taps seconds apart
are two runs writing that file, resolved by the three-way merge in
`src/core/merge-data.ts`; there is deliberately **no `concurrency` group** on the
workflow, because GitHub cancels pending runs in a group and would lose the middle
taps of a burst.

⚠️ **The repo is public.** What that file carries is grocery text, Ingredients row
names and Notion page ids — the same class of thing `vendor-review.json` has carried
since 2026-08-11. Keep tokens and other chats' contents out of it.
