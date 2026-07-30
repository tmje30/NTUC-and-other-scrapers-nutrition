# One-tap Add

The deals page's **Add** button is always a plain link to a pre-filled GitHub
issue: tap Add, tap Submit, and the `add-to-list` workflow writes the Notion row
and records the cooldown. That path needs no credentials, no JavaScript and no
service, and it is what you get if everything else here is switched off.

**One-tap** removes the second tap. The page fires `repository_dispatch` at the
same workflow itself:

```
tap Add ──POST──► api.github.com ──repository_dispatch──► add-to-list workflow
                                                           ├─ Notion row
                                                           └─ cooldowns.json
```

No server is involved. `api.github.com` answers cross-origin requests, so the
page can call it directly — verified 2026-07-29 with a preflighted authenticated
POST from `tmje30.github.io`, which returned a readable 401 rather than being
blocked. Because the response is readable, the button reports what actually
happened instead of guessing.

## Turning it on

1. Create a **fine-grained PAT** at
   https://github.com/settings/personal-access-tokens — repository access
   **Only select repositories** → this repo, permission **Contents: Read and
   write** (that's what the dispatch endpoint requires). See HANDOVER's PAT
   gotchas: "Public repositories" access silently locks permissions read-only.
2. On the deals page, tap **⚡ enable one-tap** at the bottom and paste it.

That's it. The token is stored in that browser's `localStorage` and nowhere
else — not in the repo, not in the page source, not in a build artifact. Tap the
same footer link again to remove it.

Repeat step 2 once per device or browser you use the page from.

## Setting up a second person (partner sharing the page)

She needs **no GitHub account at all** — one-tap authenticates as your token, so
she never sees GitHub. Two ways to get the token onto her phone:

1. **Send her a setup link** (easiest). Append the token as a fragment:

   ```
   https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/#add-token=YOUR_TOKEN
   ```

   She taps it once. The page stores the token and strips it from the address
   bar; from then on Add is one press for her too. The fragment is never sent to
   any server — **but it stays in whatever chat you sent it through**, so treat
   that message as the secret it is, and delete it afterwards if that bothers you.

2. **She pastes it**, same as you: ⚡ enable one-tap → paste.

**Use a separate token per person** — two fine-grained PATs from your account,
labelled per phone. Then losing one phone means revoking one token, and the
other keeps working.

If she'd rather use the two-tap issue path (she'd need her own GitHub account),
add her login to the **`ADD_EXTRA_LOGINS`** repo variable — comma-separated, no
spaces, under Settings → Secrets and variables → Actions → Variables. Without
that, the workflow ignores issues from anyone but the repo owner, and her taps
would do nothing at all with no error shown.

### Both of you adding at once

Safe. Two adds land as two workflow runs; each rebases and retries its
`cooldowns.json` push if the other got there first. And if you both tap the same
card, the second add finds the existing un-ticked row and leaves it alone rather
than duplicating the line.

There is deliberately **no `concurrency` group** on the workflow — see LEARNINGS
2026-07-30 for why serialising would have silently dropped adds.

## What the button says

| state | meaning |
|---|---|
| `…` | request in flight |
| `✓ sent` | **done** — GitHub accepted the job (HTTP 204). The row appears in Notion ~15s later |
| `retry` | GitHub refused; the button restores itself after 4s |
| `token?` | 401/403 — the saved token is bad or revoked, so it has been **forgotten**. The next tap opens the issue instead |

`✓ sent` is the final state; nothing polls afterwards, so the button never
changes again. It says "sent" rather than "added" because the dispatch is
accepted before the workflow runs — claiming the row exists would be a guess.
(This label was originally `queued`, which read as a pending state and left you
waiting for an update that was never coming.)

Where the ~15s goes, measured: ~4s for GitHub to allocate a runner, ~5s of
checkout/setup/`npm ci`, **~2s of actual Notion work**, then teardown. It's the
cost of having no always-on server; it isn't Notion being slow.

## Trade-offs, stated plainly

- **The token can write to this repo.** Anyone with your unlocked phone could
  push to it. It's a public repo with no secrets in it, and the token is
  revocable in one click, but that's the exposure.
- **A failure *inside* the workflow is quiet.** With the issue path, a failed
  add leaves a comment on the issue; with one-tap there's no issue to comment
  on. You'd notice by the row not appearing. (There's no Telegram ping either —
  that was removed by request.) If this ever bites, the fix is a step in
  `add-to-list.yml` that opens an issue when the job fails.
- **It degrades, never breaks.** No token, cancelled prompt, revoked token, or
  JavaScript disabled all fall back to the two-tap issue flow.

## The relay alternative (built, not deployed)

`src/index.ts` has an `addToGroceryList` webhook that does the same relay from a
Notion Worker, kept for the case where you'd rather not put a GitHub token in a
browser. It is **not** the recommended path: it carries the Notion Workers
billing floor (~$10/month), needs deploying and keeping alive, and a Notion
webhook returns no CORS headers — so the page must fire it blind (`mode:
"no-cors"`) and can only ever say "sent". Set the `ADD_ENDPOINT` repo variable
and add it to the `build-site` step's `env:` to switch the page over to it.
