# One-tap Add

Every button on the deals, review and history pages — **Buy**, **Ignore ▾**, the ⋯
corrections, **scan now** — is a plain link to a pre-filled GitHub issue: tap it, tap
Submit, and the matching workflow does the work. That path needs no credentials, no
JavaScript and no service, and it is what you get if everything else here is switched off.

**One-tap** removes the second tap. The page intercepts the click and fires
`repository_dispatch` at the same workflow:

```
tap Buy ──X-Add-Secret──► relay POST /add ──repository_dispatch──► add-to-list workflow
                           (Cloudflare, holds                      ├─ Notion row
                            the GitHub token)                      └─ cooldowns.json
```

There are two ways to make that POST and the project has used both. **The relay is the
one in service.** The other is kept because it is the fallback, not because it is a
choice you should be making.

## Why the relay, and not a token in the browser

The original design put a fine-grained GitHub PAT in each browser's `localStorage` and
POSTed `api.github.com` directly, with no server anywhere. It genuinely worked:
`api.github.com` answers a preflighted authenticated cross-origin POST from
`tmje30.github.io` (verified 2026-07-29), so the page could both fire the dispatch and
read the real status.

What it could not do is last.

```
2026-07-28  PAT created — 90 days, GitHub's default
2026-10-07  last successful one-tap dispatch
2026-10-26  PAT expires. GitHub emails twice; both land unread
            → first tap afterwards gets 401 → the page deletes the dead token
            → every tap from then on silently opens the GitHub issue form
2026-11-12  "the discount page keep opening github when i click on buy. what happened?"
```

Nothing was broken for those five weeks: the page degraded exactly as designed, and said
nothing because there was nothing to say. **A credential in a browser is a credential
nobody renews**, and one that expires takes the feature with it quietly. So the
privileged half moved into the relay the shopping page already used, where one token
renews in one place and `wrangler tail` can show it failing.

The page now carries only `ADD_SECRET`, which is public in the page and bounded to three
events. See `relay/README.md` for what that does and does not buy.

## Turning it on

Two secrets with the same value — the relay checks it, the page build bakes it in.

```bash
node -e "console.log('ADD_SECRET='+require('crypto').randomBytes(24).toString('hex'))" >> .env
```

```bash
cd relay && npx wrangler secret put ADD_SECRET
```

```bash
gh secret set ADD_SECRET --body "<the same value>"
```

Then any page build picks it up. `ADD_ENDPOINT` needs no setting — it defaults to the
relay's `/add`, derived from the same host as `listEndpoint` so the two cannot drift.

**Nothing is enabled per device.** That is the point: a borrowed phone, your partner's
phone and a fresh browser all one-tap immediately, and there is no footer toggle on a
relay build because there is nothing to turn on.

⚠️ **Both halves or neither.** `relayOneTap` requires an endpoint *and* a secret; a build
with one of them falls back to the issue link rather than sending
`X-Add-Secret: undefined` and having every tap refused.

## Setting up a second person (partner sharing the page)

Nothing to do. She opens the page and taps. She needs no GitHub account, no token and no
setup link — the credential is in the page, which is the problem the relay solved.

If she'd rather use the two-tap issue path (she'd need her own GitHub account), add her
login to the **`ADD_EXTRA_LOGINS`** repo variable — comma-separated, no spaces, under
Settings → Secrets and variables → Actions → Variables. Without that, the workflow
ignores issues from anyone but the repo owner, and her taps would do nothing at all with
no error shown.

### Both of you adding at once

Safe. Two adds land as two workflow runs; each rebases and retries its `cooldowns.json`
push if the other got there first. And if you both tap the same card, the second add
finds the existing un-ticked row and leaves it alone rather than duplicating the line.

There is deliberately **no `concurrency` group** on the workflow — see LEARNINGS
2026-07-30 for why serialising would have silently dropped adds.

## What the button says

| state | meaning |
|---|---|
| `…` | request in flight |
| `✓ sent` | **done** — the dispatch was accepted. The row appears in Notion ~15s later |
| `retry` | refused; the button restores itself after 4s |
| `refused` | 401 from the relay — the baked secret no longer matches. One-tap stops intercepting, so the next tap opens the issue instead |
| `token?` | the same, on a PAT build: the saved token is bad or revoked and has been **forgotten** |

Both routes read a **real status**, which is why neither says "sent" for a refusal. An
earlier design POSTed a Notion Worker webhook with `mode: "no-cors"` and could only ever
claim success; it was never configured in any build and has been removed.

`✓ sent` is the final state; nothing polls afterwards, so the button never changes again.
It says "sent" rather than "added" because the dispatch is accepted before the workflow
runs — claiming the row exists would be a guess. (This label was originally `queued`,
which read as a pending state and left you waiting for an update that was never coming.)

Where the ~15s goes, measured: ~4s for GitHub to allocate a runner, ~5s of
checkout/setup/`npm ci`, **~2s of actual Notion work**, then teardown. It's the cost of
having no always-on server; it isn't Notion being slow.

## Trade-offs, stated plainly

- **The secret is public in the page.** Anyone who finds the URL can add a grocery row,
  snooze an item or ask for a scan. That is the same trade the shopping list already
  makes, and it is bounded by the relay's `ADD_EVENTS` allow-list: **not** a repo write,
  and so not a path to editing `src/` and having the next scheduled run execute it with
  `NOTION_TOKEN`. The PAT it replaced *could* push to the repo.
- **The relay is now load-bearing for the buttons.** It was already the clock for three
  cron jobs and the whole Telegram path, so this adds no new thing to keep alive — but a
  relay that is down means two taps, not one.
- **A failure *inside* the workflow is quiet.** With the issue path, a failed add leaves a
  comment on the issue; with one-tap there is no issue to comment on. You would notice by
  the row not appearing. If this ever bites, the fix is a step in `add-to-list.yml` that
  opens an issue when the job fails.
- **It degrades, never breaks.** A missing secret, a rotated secret, a dead PAT, a relay
  that is down, or JavaScript disabled all fall back to the two-tap issue flow. Every
  button is a real `<a href>` on every build; one-tap is only an interception. That
  property is why the one-tap code is allowed to be as simple as it is.

## The PAT route, still there

`oneTapScript` emits one script with two transports. A build with no `ADD_SECRET` renders
the PAT route instead, and the footer shows **⚡ enable one-tap** for pasting a
fine-grained token (repository access **Only select repositories** → this repo,
permission **Contents: Read and write**, which is what the dispatch endpoint requires;
HANDOVER's PAT gotchas note that "Public repositories" access silently locks permissions
read-only). The token stays in that browser's `localStorage` and nowhere else.

It is the fallback for a fork or a local build, not a recommendation. If you set one up
anyway, put a **calendar reminder on its expiry date** — a browser cannot warn you, and
the five weeks above are what that costs.
