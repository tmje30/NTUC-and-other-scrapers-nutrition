import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { commitAndPushData } from "../core/git-data-push.js";
import {
	COMMITTED_STATE_PATH,
	maybeDrain,
	readState,
	writeState,
	type Publisher,
} from "../core/tg-inbox.js";
import { useBotToken } from "../core/telegram.js";
import {
	CLOUD_NEW_ITEM_SHOPS,
	NEW_ITEM_SHOPS,
	scanNewItems,
	type NewItemResult,
	type NewItemsFile,
} from "../core/new-items.js";
import { sgtDate } from "../core/sgt.js";

/**
 * Price the new items the inbox queued. **Runs in GitHub Actions since 2026-08-17;
 * it no longer needs this machine.**
 *
 * ```
 *   cloud (tg-inbox.yml)  →  queue in data/tg-inbox-state.json
 *   cloud (tg-sweep.yml → price-new-items.yml, every 15 min, self-gating)
 *      → scan FairPrice · Guardian · MyProtein  (direct)
 *              Sheng Siong                      (via ss-worker, from Singapore)
 *      → data/new-items-latest.json  →  push
 *      → clear the queue, push the state file
 * ```
 *
 * ⚠️⚠️ **The old reason this "could not move to the cloud" was wrong twice over,
 * and is kept here because it was believed for a fortnight.** It read: "Sheng Siong
 * challenges datacenter IPs while answering a residential one." The block is by
 * **country**, not by datacenter — and since 2026-08-13 `ss-worker` has scanned
 * Sheng Siong daily from a Cloudflare datacenter in Singapore. `SHOPS` below routes
 * through it, so a US runner gets real Sheng Siong prices.
 *
 * ⚠️ **In the cloud this prices FOUR shops, not five.** Carousell 403s a US address
 * on every path, listing pages included (measured 2026-08-16). It is not blocked
 * from Singapore and needs no browser there, but harvesting it that way needs an
 * HTML parser that does not exist yet — see `CLOUD_NEW_ITEM_SHOPS`. Run this on the
 * laptop (`npm run tg-drain`) and it still uses all five.
 *
 * ⚠️ **It replaces the forever-running poller as this machine's Telegram job.** A
 * webhook and `getUpdates` cannot both serve one bot, so once the relay is live the
 * poller must not run at all (it would 409 on every call). This is a short, ordinary
 * batch job instead: it exits in milliseconds when the queue is empty, which is
 * almost always.
 *
 * Usage:
 *   npm run tg-drain              # price whatever is queued, publish, push
 *   npm run tg-drain -- --no-push # scan and reply, but don't commit/dispatch
 */

const NO_PUSH = process.argv.includes("--no-push");
const OUT = "data/new-items-latest.json";

/**
 * Where this run is happening, which decides both the shop list and the label that
 * ends up in the committed file.
 *
 * ⚠️ `GITHUB_ACTIONS` is set to `"true"` by the runner itself and by nothing else,
 * so this cannot be spoofed by a stale `.env` the way a hand-set flag could.
 */
const IN_ACTIONS = process.env.GITHUB_ACTIONS === "true";
const SOURCE = process.env.RUNNER_SOURCE ?? (IN_ACTIONS ? "cloud" : "laptop");
const SHOPS = IN_ACTIONS ? CLOUD_NEW_ITEM_SHOPS : NEW_ITEM_SHOPS;

/**
 * Ask the cloud to rebuild Pages now — `repository_dispatch`, which runs promptly.
 * Without a `GITHUB_TOKEN` the file is still committed and the page appears on the
 * next daily run: later, never lost. Same as `push-shengsiong.ts`.
 */
function dispatch(): void {
	// ⚠️ **From Actions this would be a no-op that LOOKS like it worked.** GitHub
	// refuses to start a workflow from a `repository_dispatch` sent with a
	// workflow's own `GITHUB_TOKEN` (anti-recursion) — the API returns 204 and
	// nothing runs. The rebuild is a dependent job in `price-new-items.yml`
	// instead, so this path is skipped rather than fired and believed.
	if (IN_ACTIONS) {
		console.error("In Actions — the rebuild is a dependent job, not a dispatch.");
		return;
	}
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.error("No GITHUB_TOKEN — pushed the file; the page will build on the next run.");
		return;
	}
	execSync(
		`curl -sS -X POST -H "Accept: application/vnd.github+json" ` +
			`-H "Authorization: Bearer ${token}" ` +
			`https://api.github.com/repos/${config.repo()}/dispatches ` +
			`-d "{\\"event_type\\":\\"newitems\\"}"`,
		{ stdio: "inherit" },
	);
}

/**
 * Tell the workflow whether anything was actually priced.
 *
 * ⚠️ The rebuild job keys on this. Without it the only alternatives are rebuilding
 * Pages every 15 minutes — this job runs that often and is a no-op almost every
 * time — or never rebuilding promptly at all. A no-op that still redeploys the site
 * would also churn the Pages deployment history and make a real publish impossible
 * to spot.
 */
function reportPriced(priced: boolean): void {
	const out = process.env.GITHUB_OUTPUT;
	if (!out) return; // running on the laptop; nothing is listening
	try {
		appendFileSync(out, `priced=${priced ? "true" : "false"}\n`);
	} catch (e: any) {
		// Never fail a completed scan over its own bookkeeping — the file is
		// committed and pushed by this point, so the worst case is a late page.
		console.error(`Could not write GITHUB_OUTPUT: ${e?.message ?? e}`);
	}
}

const publisher: Publisher = {
	async publish(results: NewItemResult[]): Promise<void> {
		await mkdir("data", { recursive: true });
		const payload: NewItemsFile = {
			date: sgtDate(),
			generatedAt: new Date().toISOString(),
			source: SOURCE,
			results,
		};
		await writeFile(OUT, JSON.stringify(payload), "utf8");
		console.error(`Wrote ${OUT} (${results.length} items).`);
		if (NO_PUSH) {
			console.error("--no-push: skipping git commit/dispatch.");
			return;
		}
		// This file IS regenerated in full by this run, so the default whole-file
		// re-apply is right for it — unlike the state file below.
		await commitAndPushData({
			file: OUT,
			message: `data: priced ${results.length} new item(s) from Telegram (${SOURCE})`,
		});
		// ⚠️ Reported AFTER the push, not after the scan. The rebuild job reads the
		// committed file, so claiming "priced" before it reaches the remote would
		// race a deploy against its own input.
		reportPriced(true);
		dispatch();
	},
};

useBotToken(config.telegramInboxBotToken());

const state = await readState(COMMITTED_STATE_PATH);
if (!state.queue.length) {
	// The common case, and it must be cheap: this runs every 15 minutes.
	console.error("Nothing queued for pricing.");
	reportPriced(false);
	process.exit(0);
}

const blocking = Object.values(state.pending).filter((a) => a.blocking).length;
if (blocking) {
	// ⚠️ Same gate the poller applies, for the same reason: until a near-miss is
	// answered we don't know whether the item is new at all, and pricing something
	// that turns out to be the milk you already buy puts it on a page nobody wanted.
	console.error(`${blocking} question(s) still open — leaving ${state.queue.length} item(s) queued.`);
	reportPriced(false);
	process.exit(0);
}

const priced = state.queue.map((q) => q.raw);
console.error(`Pricing ${priced.length} queued item(s)…`);

// `notion` is required by the type and genuinely unused on this path — pricing asks
// shops, not Notion. It comes from the same `.env` the poller used, so this costs
// nothing to provide and keeps the dependency honest rather than optional.
const notion = new Client({ auth: config.notionToken() });
await maybeDrain({ notion, publisher, scan: (items) => scanNewItems(items, SHOPS) }, state);

await writeState(state, COMMITTED_STATE_PATH);
if (NO_PUSH) {
	console.error("--no-push: state file written but not committed.");
	process.exit(0);
}

await commitAndPushData({
	file: COMMITTED_STATE_PATH,
	message: `data: priced ${priced.length} queued item(s) from Telegram`,
	/**
	 * ⚠️ **Keep THEIRS and remove only what this run priced.** The cloud rewrites
	 * this file on every text and every tap, so writing our whole copy over a newer
	 * remote would put back questions the user has answered since we read it — on
	 * screen, with live buttons, as if the answer had never happened. All this run is
	 * entitled to say is "these queue entries are done".
	 */
	reapply(theirs) {
		if (!theirs) return "";
		const file = JSON.parse(theirs);
		const done = new Set(priced);
		file.queue = (Array.isArray(file.queue) ? file.queue : []).filter(
			(q: { raw?: string }) => !done.has(String(q?.raw)),
		);
		file.updatedAt = new Date().toISOString();
		return `${JSON.stringify(file, null, 2)}\n`;
	},
});
