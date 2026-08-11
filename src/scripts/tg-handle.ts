import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { COMMITTED_STATE_PATH, handleUpdate, readState, writeState } from "../core/tg-inbox.js";
import { escapeHtml as esc, sendHtml, useBotToken, type TgUpdate } from "../core/telegram.js";

/**
 * One Telegram update, handled in the cloud. The webhook half of the texted-list
 * flow — the counterpart to `tg-poll.ts`, which does the same job by long-polling
 * on the laptop.
 *
 * ```
 *   Telegram ──▶ relay/worker.mjs ──repository_dispatch──▶ tg-inbox.yml ──▶ THIS
 *                                                                            │
 *                        parse · match · write the grocery-list row ·  ◀──────┘
 *                        ask about a near-miss                     (Notion only)
 * ```
 *
 * ⚠️ **Why it exists: the laptop sleeps and Telegram waits.** A list texted at
 * ~18:20 on 2026-08-11 was answered at 21:11 — the laptop went into Modern Standby
 * at 18:26 and nothing in the system was awake to hear it. Everything the inbox does
 * apart from pricing a brand-new item needs only the Notion API, so it can run where
 * nothing sleeps.
 *
 * ⚠️ **`deferPricing` is set, and that is the one behavioural difference from the
 * poller.** Pricing a new item means asking Sheng Siong, which challenges datacenter
 * IPs. Rather than quietly producing a FairPrice-only comparison that looks like a
 * five-shop one, new items stay on the queue in the state file and the laptop prices
 * them on its next wake (`npm run tg-drain`).
 *
 * ⚠️ **State lives in the repo, not in this process.** There is no process — each
 * update is a fresh checkout. See `COMMITTED_STATE_PATH`. This script does NOT
 * commit: `tg-inbox.yml` does, because the retry-and-merge that a rejected push
 * needs is already written there and proven by `add-to-list.yml`.
 *
 * Usage: `TG_UPDATE='{"update_id":…}' npm run tg-handle`
 */

const raw = process.env.TG_UPDATE;
if (!raw || raw === "null") {
	console.error("No TG_UPDATE in the environment — nothing to handle.");
	process.exit(1);
}

let update: TgUpdate;
try {
	update = JSON.parse(raw);
} catch (e: any) {
	// Loud, not silent: the only way here is the relay or the workflow mangling the
	// payload, and that breaks every message rather than one.
	console.error(`TG_UPDATE is not valid JSON: ${e.message}`);
	process.exit(1);
}

// As the inbox bot, not the digest bot — the reply must come from the bot the user
// texted. See `config.telegramInboxBotToken`.
useBotToken(config.telegramInboxBotToken());

const notion = new Client({ auth: config.notionToken() });
const state = await readState(COMMITTED_STATE_PATH);

// Which items were already waiting to be priced before this update. Compared by the
// raw line, the same identity the merge rule and `handleCallback`'s de-queue use.
const before = new Set(state.queue.map((q) => q.raw));

await handleUpdate({ notion, deferPricing: true }, state, update);

const added = state.queue.filter((q) => !before.has(q.raw));
if (added.length) {
	// ⚠️ **Say that pricing is deferred, and say why.** Silence here would rebuild
	// the original complaint in miniature: the row is on the list, the shops were
	// never asked, and nothing on screen distinguishes "waiting" from "forgotten".
	await sendHtml(
		`🕒 ${added.length === 1 ? "This one needs" : `These ${added.length} need`} a shop price: ` +
			`<b>${esc(added.map((a) => a.name).join(", "))}</b>\n` +
			`<i>Sheng Siong only answers a home connection, so I'll price ${
				added.length === 1 ? "it" : "them"
			} when the laptop next wakes and send you the page.</i>`,
	);
}

await writeState(state, COMMITTED_STATE_PATH);
console.error(
	`Handled update ${update.update_id}: ${Object.keys(state.pending).length} question(s) open, ` +
		`${state.queue.length} item(s) queued for pricing.`,
);
