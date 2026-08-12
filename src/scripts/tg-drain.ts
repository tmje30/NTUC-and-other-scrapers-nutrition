import { execSync } from "node:child_process";
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
import type { NewItemResult, NewItemsFile } from "../core/new-items.js";
import { sgtDate } from "../core/sgt.js";

/**
 * Price the new items the cloud couldn't. **The only part of the inbox that still
 * needs this machine.**
 *
 * ```
 *   cloud (tg-inbox.yml)  →  queue in data/tg-inbox-state.json
 *   laptop (this, every 15 min, self-gating)
 *      → scan FairPrice · Sheng Siong · Guardian · MyProtein · Carousell
 *      → data/new-items-latest.json  →  push + repository_dispatch
 *      → clear the queue, push the state file
 * ```
 *
 * ⚠️ **Why it can't move to the cloud, when everything else did.** Pricing an item
 * with no Ingredients row means searching the shops, and Sheng Siong challenges
 * datacenter IPs while answering a residential one. The cloud could only ever produce
 * a FairPrice-only comparison — which is worse than a late one, because a card
 * comparing one shop looks exactly like a card comparing five.
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
const SOURCE = process.env.RUNNER_SOURCE ?? "laptop";

/**
 * Ask the cloud to rebuild Pages now — `repository_dispatch`, which runs promptly.
 * Without a `GITHUB_TOKEN` the file is still committed and the page appears on the
 * next daily run: later, never lost. Same as `push-shengsiong.ts`.
 */
function dispatch(): void {
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
		dispatch();
	},
};

useBotToken(config.telegramInboxBotToken());

const state = await readState(COMMITTED_STATE_PATH);
if (!state.queue.length) {
	// The common case, and it must be cheap: this runs every 15 minutes.
	console.error("Nothing queued for pricing.");
	process.exit(0);
}

const blocking = Object.values(state.pending).filter((a) => a.blocking).length;
if (blocking) {
	// ⚠️ Same gate the poller applies, for the same reason: until a near-miss is
	// answered we don't know whether the item is new at all, and pricing something
	// that turns out to be the milk you already buy puts it on a page nobody wanted.
	console.error(`${blocking} question(s) still open — leaving ${state.queue.length} item(s) queued.`);
	process.exit(0);
}

const priced = state.queue.map((q) => q.raw);
console.error(`Pricing ${priced.length} queued item(s)…`);

// `notion` is required by the type and genuinely unused on this path — pricing asks
// shops, not Notion. It comes from the same `.env` the poller used, so this costs
// nothing to provide and keeps the dependency honest rather than optional.
const notion = new Client({ auth: config.notionToken() });
await maybeDrain({ notion, publisher }, state);

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
