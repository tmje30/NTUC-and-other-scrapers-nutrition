# Can Cloudflare do the Sheng Siong scan instead of the laptop?

Throwaway probes, kept for the measurements. **Nothing here runs in production**
and nothing here is deployed — every result below came from
`wrangler dev --remote`, which executes on Cloudflare's edge and tears itself
down afterwards.

The question they answer: HANDOVER's 2026-08-11 experiment established that Sheng
Siong challenges addresses **outside Singapore** and does not care whether they
are residential or datacenter. That makes a Cloudflare Worker a candidate to
replace the laptop — *if* it can be made to run in Singapore.

## What was measured (2026-08-12)

### `worker.mjs` — reachability and cost

| run | colo | result |
| --- | --- | --- |
| 1 | CPH 🇩🇰 | 🔴 challenged — laptop was behind a VPN |
| 2 | CPH 🇩🇰 | 🔴 challenged — *phone hotspot's* VPN, still on |
| 3 | **SIN** 🇸🇬 | ✅ **DDP session opened**, `{"msg":"connected","session":"…"}` |
| 4 | **SIN** 🇸🇬 | ✅ **full 50-term scan: 561 products, 0 errors, 26.7 s** |

⚠️ **Runs 1 and 2 are the useful failure.** Both looked like "Cloudflare is
blocked" and neither was — the laptop's egress was Danish. This is the *third*
time a VPN has been mistaken for a WAF policy change in this project; the
2026-07-30 "Incapsula now challenges residential IPs" entry was the same
confound and cost a whole browser-minting subsystem. **Check
`curl https://cloudflare.com/cdn-cgi/trace` before believing any block.**

Two further findings:

- **The WAF guards the front door, not the protocol.** In every SIN run the HTML
  page came back challenged (`page.challenged: true`) while the DDP WebSocket
  upgraded cleanly to 101. Speaking Meteor instead of scraping pages, which
  `shengsiong.ts` already does, walks past the thing that blocks everyone else.
- **The free tier is not the constraint.** The whole scan fits one invocation:
  50 searches ride a single WebSocket (so the 50-subrequest cap is untouched),
  and parsing the full 615-product payload measures **0.75 ms of CPU** locally
  against a 10 ms allowance. Requests/day is 100 000; the scan needs one.

### `placement/worker.mjs` — the remaining unknown

Everything above worked because a request arrived *from Singapore*. A cron
trigger has no incoming request, so Cloudflare places it anywhere. Durable
Objects are the only placement control, and the hint is region-coarse — `apac`
covers Tokyo, Sydney, Hong Kong and Seoul as readily as Singapore.

This probe asks for `apac` repeatedly, reports which colos it actually gets, and
re-queries any Singapore hit to check whether the object **stays** there. A DO
that drifts would work for days and then quietly stop, which is precisely the
failure shape this project keeps getting bitten by.

```
cd probe/placement && npx wrangler dev --remote     # then /?tries=8
```

**Not yet run.** Until it is, the honest position is: Cloudflare can serve the
on-demand path (you tap, from Singapore) for free, and the unattended 05:30 scan
still needs the laptop or the ~US$5/mo Singapore VPS that HANDOVER recommends.
