import { readFile } from "node:fs/promises";
import { dispatchRepositoryEvent } from "../core/gh-dispatch.js";
import { isLiveRequest, isRequestServed, readScanRequest } from "../core/scan-request.js";
import { SCAN_FILE, scanAndPush } from "../core/ss-scan.js";
import { sgtDate } from "../core/sgt.js";

/**
 * The laptop's answer to the page's Rescan button.
 *
 * ⚠️⚠️ **ORPHANED as of 2026-08-13 — nothing writes the marker this reads.**
 * `scan-request.yml` now calls the Cloudflare Worker directly instead of committing
 * `data/scan-request.json`, because `ss-worker` reaches Sheng Siong from a Durable
 * Object placed in Singapore and the laptop is no longer the only address the shop
 * will answer. This script still works if a marker appears, and the scheduled task
 * that runs it may still be enabled — but it will now find nothing, every five
 * minutes, forever. **It is kept, not deleted, as the emergency path**: if the cloud
 * ever stops reaching the shop, `npm run scan-request` writes a marker by hand and
 * this drains it. Do not "fix" the silence; the silence is correct.
 *
 * The flow it was built for:
 *
 * ```
 *   tap Rescan → repository_dispatch: sscan → scan-request.yml commits
 *   data/scan-request.json → THIS (every 5 min) pulls, sees it, scans Sheng
 *   Siong → pushes → repository_dispatch: rescan → the cloud rebuilds the page
 *   and sends ONE Telegram message, with Sheng Siong in it
 * ```
 *
 * It existed because the cloud could not reach Sheng Siong and cannot reach this
 * laptop either — there is no inbound port here, and there should not be. A
 * file in the repo was the whole channel: the cloud writes it, the laptop pulls
 * it. Nothing is listening on this machine.
 *
 * ⚠️ **Doing nothing is the common case and must stay cheap.** Most runs find
 * no request and exit in milliseconds without touching the network, because
 * this fires every five minutes all day. Only a request dated today, and not
 * already answered, costs anything.
 *
 * ⚠️ The `git pull` belongs to the wrapper (`ss-request-run.cmd`), not here —
 * same as the morning runner, and for the same reason: a laptop that wakes
 * before DNS is up should not start a five-minute scan into a network that
 * isn't there.
 *
 * Usage:
 *   npm run ss-on-request              # the Task Scheduler job
 *   npm run ss-on-request -- --dry-run # say what it would do, scan nothing
 */

const DRY_RUN = process.argv.includes("--dry-run");

async function scanGeneratedAt(): Promise<string | null> {
	try {
		return JSON.parse(await readFile(SCAN_FILE, "utf8"))?.generatedAt ?? null;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const today = sgtDate();
	const request = await readScanRequest();

	if (!isLiveRequest(request, today)) {
		// Quiet on purpose. This is the every-five-minutes no-op, and a line of log
		// each time would bury the runs that did something under three hundred that
		// didn't.
		if (request) console.error(`Scan request is for ${request.date}, not ${today} — expired, ignoring.`);
		return;
	}

	if (isRequestServed(request!, await scanGeneratedAt())) {
		console.error(`Request from ${request!.requestedAt} already answered by a later scan — nothing to do.`);
		return;
	}

	console.error(`Scan requested at ${request!.requestedAt}${request!.reason ? ` — ${request!.reason}` : ""}.`);
	if (DRY_RUN) {
		console.error("--dry-run: would scan Sheng Siong and dispatch a rebuild.");
		return;
	}

	// `force`, because the request is explicitly asking for prices newer than
	// whatever is on disk — including a file that is already fresh for today.
	const result = await scanAndPush({ force: true, source: process.env.RUNNER_SOURCE ?? "laptop" });

	// ⚠️ Only after a successful push. Dispatching a rebuild on a scan that never
	// landed would rebuild the page from the same old file and clear the warning's
	// cause without fixing it — the user would tap Rescan and get their stale page
	// back, which is precisely the bug this whole path exists to fix.
	if (result.status === "pushed") await dispatchRepositoryEvent("rescan");
	else console.error(`Scan ended "${result.status}" — not asking for a rebuild.`);
}

main().catch((e) => {
	console.error(e?.stack ?? String(e));
	process.exit(1);
});
