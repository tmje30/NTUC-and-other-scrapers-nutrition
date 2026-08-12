import { scanAndPush } from "../core/ss-scan.js";

/**
 * Phone / laptop runner (residential IP). Sheng Siong blocks the cloud's
 * datacenter IP, so this runs where the IP is trusted:
 *
 *   1. Fetch the search terms from the public Pages file (no token needed).
 *   2. Run the Sheng Siong scan only (plain Node DDP, no browser, KB-sized).
 *   3. Write data/shengsiong-latest.json and git-push it.
 *
 * The cloud daily job reads that file for Sheng Siong prices; if today's file
 * isn't there it falls back to FairPrice-only. Carries ONE narrow secret (a
 * fine-grained GitHub PAT with contents:write) — no Notion or Telegram tokens.
 *
 * The scan itself lives in `src/core/ss-scan.ts`, shared with `ss-on-request.ts`
 * (the same scan, started by a tap on the page instead of by the clock).
 *
 * Usage:
 *   npm run push-ss              # skip if today's file already exists, then push
 *   npm run push-ss -- --force   # rescan even if fresh
 *   npm run push-ss -- --no-push # scan + write locally, don't commit/push
 */

// ⚠️ The explicit catch is what gives Task Scheduler a non-zero exit code, and
// `run.cmd` hands that straight back to it. Without it a failed scan reports
// "Last Run Result: 0" and the failure is invisible.
await scanAndPush({
	force: process.argv.includes("--force"),
	push: !process.argv.includes("--no-push"),
	// ⚠️ `run.cmd` sets this; a bare `npm run push-ss` by hand does not, and the
	// commit then claims the phone produced it. Cosmetic — it only labels the
	// commit message and the payload's provenance — but worth setting when you
	// run this yourself: `RUNNER_SOURCE=laptop npm run push-ss`.
	source: process.env.RUNNER_SOURCE ?? "phone",
}).catch((e: any) => {
	console.error(e?.stack ?? String(e));
	process.exit(1);
});
