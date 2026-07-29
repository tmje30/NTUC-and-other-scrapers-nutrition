# One-tap Add (optional — built, not deployed)

## What ships today

The deals page's **Add** button needs no extra infrastructure. Tapping it opens
a pre-filled GitHub issue on this repo; you tap *Submit*, and the `add-to-list`
workflow writes the Notion grocery-list row and records the item's cooldown.
Two taps, nothing running, no credentials anywhere near the browser.

## What this is

The upgrade to **one** tap: a webhook capability in `src/index.ts`
(`addToGroceryList`) that the page can POST to directly.

It is a thin relay, not a second implementation. It authenticates the tap and
fires a `repository_dispatch` at the *same* workflow:

```
page ──POST──► Notion Worker webhook ──repository_dispatch──► add-to-list workflow
                                                               ├─ Notion row
                                                               └─ cooldowns.json
```

**Why not have the worker write the Notion row itself?** The cooldown has to be
committed to `data/cooldowns.json`, and a worker can't push to git. Splitting
the two halves across two runtimes would let an add half-succeed — row created,
cooldown lost — and the item would keep reappearing as a deal you already own.
One workflow does both or neither.

## The trade-off, stated plainly

A Notion webhook returns no CORS headers. The page therefore sends a "simple"
request (`POST`, `text/plain`, no custom headers, `mode: "no-cors"`) so the
browser doesn't preflight it. The request is delivered; **the response comes
back opaque**. The button says `sent`, not `✓ added` — the row appears in Notion
a few seconds later, and if something failed you'd find out from the run log
rather than from the page. That's the honest cost of one tap, and it's why the
issue button remains the default.

The same constraint is why the shared token travels in the request body: an
`Authorization` header would trigger a preflight.

## Deploying it, when you want it

1. **GitHub token** — a fine-grained PAT for this repo only, with
   *Contents: Read and write* and *Metadata: Read*. (See HANDOVER's PAT gotchas:
   repository access must be **All** or **Only select repositories**, never
   "Public repositories".)

2. **Add token** — any long random string. This is what stops a stranger who
   finds the webhook URL posting to your grocery list. The page asks for it once
   and keeps it in the browser's localStorage.

   ```bash
   openssl rand -hex 24
   ```

3. Put both in `.env`, then push them to the deployed worker:

   ```bash
   ntn workers env push
   ```

4. **Deploy and read back the URL:**

   ```bash
   ntn workers deploy
   ```

   ```bash
   ntn workers webhooks list
   ```

5. **Point the page at that URL** — set the repo variable `ADD_ENDPOINT`
   (Settings → Secrets and variables → Actions → Variables) and add it to the
   `build-site` step's `env:` in `.github/workflows/daily.yml`:

   ```yaml
   ADD_ENDPOINT: ${{ vars.ADD_ENDPOINT }}
   ```

   The next daily build renders real buttons instead of issue links. Clear the
   variable to fall straight back to the issue path — nothing else changes.

## Things worth knowing first

- **Cost.** Deploying this repo's worker puts it on the Notion Workers billing
  floor (~$10/month from Aug 2026, plus a fraction of a cent per run). The
  default issue path costs nothing.
- **Five strikes.** Five consecutive bad tokens short-circuit the webhook until
  the worker is redeployed. Intended protection, but worth remembering if the
  button goes quiet after you've been fiddling with the token.
- **`env.GITHUB_TOKEN`, not `context.notion`.** The relay never touches Notion,
  so it needs no `NOTION_API_TOKEN`.
