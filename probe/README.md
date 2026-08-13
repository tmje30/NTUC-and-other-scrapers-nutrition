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

### `placement/` — answered, and **deleted** (2026-08-13)

The question it existed for: everything above worked because a request arrived
*from Singapore*. A cron trigger has no incoming request, so Cloudflare places it
anywhere. Durable Objects are the only placement control, and the hint is
region-coarse — `apac` covers Tokyo, Sydney, Hong Kong and Seoul as readily as
Singapore.

**Answer: `apac` reaches Singapore roughly half the time, and a name that lands
there stays there.** So placement is winnable, but not on one draw — which is why
`ss-worker` probes eight Durable Object names and uses the first that can reach
Sheng Siong, rather than trusting a single fixed name. The first single-name
attempt landed in **Seoul** and stayed, permanently unable to scan.

⚠️ **The one thing worth carrying forward from this probe is the mistake it
made.** It keyed its Singapore verdict on the `loc` field of `cdn-cgi/trace` —
and `loc`, fetched from *inside* a Worker, is the **original caller's** country,
not the object's. With the laptop on a Danish VPN, objects demonstrably serving
from `SIN` reported `loc=DK`. Its headline "15 of 16 landed in Singapore" was
therefore partly measuring the laptop, and is overstated. Read **`colo`**, and
treat even that as a hint: the only authoritative test is whether Sheng Siong
returns a `101` upgrade rather than the `200` that means a challenge page. That
is what `ss-worker`'s `reachable()` does.

The probe was deleted rather than fixed. It was a worse copy of a check
`ss-worker` now performs correctly on every run, and a live endpoint printing
`PASS` / `NO SG` from the wrong field would keep telling future readers something
false. Source is in git history if it is ever wanted back.
