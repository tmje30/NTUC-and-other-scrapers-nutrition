import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { commitAndPushData } from "../core/git-data-push.js";
import { ASK_TTL_MS, COMMITTED_STATE_PATH, readState, sweepExpiredAsks, writeState } from "../core/tg-inbox.js";
import { useBotToken } from "../core/telegram.js";

/**
 * File the questions nobody answered. **The clock behind the one-hour rule.**
 *
 * ```
 *   Cloudflare cron, every 15 min ──dispatch──▶ tg-sweep.yml ──▶ THIS
 *                                                                  │
 *          asked > 1 h ago  →  grocery List row, Name only, no relation
 *                           →  buttons replaced, one summary in the chat
 *                           →  data/tg-inbox-state.json committed
 * ```
 *
 * ⚠️ **Why a separate script and not a step in `tg-drain`.** The drain needs the
 * laptop (Sheng Siong answers a residential IP and challenges a datacenter one),
 * and the laptop sleeps — which is the entire reason the inbox moved to a webhook.
 * A timeout that only fires while the laptop is awake is the original complaint
 * wearing a different hat. This needs nothing but Notion and Telegram, so it runs
 * in the cloud.
 *
 * ⚠️ **It never prices anything**, even when run by hand on the laptop. Filing an
 * expired ask can leave the pricing queue unblocked, but draining it here would
 * make a two-purpose job out of one that has to be safe to run every fifteen
 * minutes. `tg-drain` picks the queue up on its own schedule.
 *
 * ⚠️ **Idempotent by title, not by lock.** Two sweepers overlapping (the cron and
 * an arriving text, seconds apart) would each see the same ask in their own
 * checkout. `addTextedItem` dedupes on the row title, so the second write bumps
 * `Amount ` rather than creating a duplicate row — imperfect but harmless, and the
 * window is a few seconds every fifteen minutes. The `concurrency` group in
 * `tg-sweep.yml` closes the cron-against-cron half of it.
 *
 * Usage:
 *   npm run tg-sweep              # file whatever has expired, commit, push
 *   npm run tg-sweep -- --no-push # file and report, but don't commit
 *   npm run tg-sweep -- --dry-run # say what would be filed, touch nothing
 */

const NO_PUSH = process.argv.includes("--no-push");
const DRY_RUN = process.argv.includes("--dry-run");

const state = await readState(COMMITTED_STATE_PATH);
const open = Object.keys(state.pending).length;
if (!open) {
	// The common case, and it must be cheap: this runs every fifteen minutes.
	console.error("No open questions.");
	process.exit(0);
}

if (DRY_RUN) {
	const now = Date.now();
	for (const [t, ask] of Object.entries(state.pending)) {
		const age = Date.parse(ask.askedAt ?? "");
		const mins = Number.isFinite(age) ? Math.round((now - age) / 60_000) : null;
		console.error(
			`${t}  ${ask.item.name}  ${mins == null ? "no timestamp" : `${mins} min`}` +
				`${mins != null && now - age >= ASK_TTL_MS ? "  → would file" : ""}`,
		);
	}
	process.exit(0);
}

// As the inbox bot, not the digest bot — the edit has to land on the message the
// user is actually looking at. See `config.telegramInboxBotToken`.
useBotToken(config.telegramInboxBotToken());

const notion = new Client({ auth: config.notionToken() });
const { filed, stamped } = await sweepExpiredAsks({ notion }, state);

if (!filed.length && !stamped) {
	console.error(`${open} question(s) open, none older than an hour.`);
	process.exit(0);
}
console.error(`Filed ${filed.length} expired question(s); started the clock on ${stamped}.`);

await writeState(state, COMMITTED_STATE_PATH);
if (NO_PUSH) {
	console.error("--no-push: state file written but not committed.");
	process.exit(0);
}

await commitAndPushData({
	file: COMMITTED_STATE_PATH,
	message: `data: filed ${filed.length} unanswered question(s) after an hour`,
	/**
	 * ⚠️ **Keep THEIRS and remove only the asks this run filed.** Between reading the
	 * file and pushing it, a text or a tap may have rewritten it in the cloud —
	 * writing our whole copy over that would put back a question the user has since
	 * answered, on screen, with live buttons, and would drop any item they queued
	 * meanwhile. All this run is entitled to say is "these questions are settled".
	 *
	 * The re-stamped `askedAt`s are deliberately NOT re-applied: they are a clock
	 * start, worth nothing if it costs a question. The next sweep stamps them again.
	 */
	reapply(theirs, mine) {
		if (!theirs) return mine; // nothing upstream to preserve
		const file = JSON.parse(theirs);
		const done = new Set(filed);
		file.asks = (Array.isArray(file.asks) ? file.asks : []).filter(
			(a: { token?: string }) => !done.has(String(a?.token)),
		);
		file.updatedAt = new Date().toISOString();
		return `${JSON.stringify(file, null, 2)}\n`;
	},
});
