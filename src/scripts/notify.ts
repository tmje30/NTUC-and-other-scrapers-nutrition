import { readFile } from "node:fs/promises";
import { sendListSummary, sendSummary, type ListSummary, type WeightGapNote } from "../core/telegram.js";
import { config } from "../core/config.js";

/** Reads public/summary.json (from build-site) and sends the single Telegram message. */

const { count, warning, weightGaps } = JSON.parse(await readFile("public/summary.json", "utf8")) as {
	count: number;
	warning?: string;
	/** Optional: summary.json files written before 2026-08-13 have no such field. */
	weightGaps?: WeightGapNote[];
};

const gaps = weightGaps ?? [];

// A warning earns a message even with no deals: a runner that has silently
// stopped working otherwise looks exactly like a quiet shopping day.
//
// ⚠️ `gaps` deliberately do not appear in this condition — see `sendSummary`. A
// missing weight is a standing property of a Notion row, not something that broke
// today, so it rides along with a message being sent anyway rather than
// generating a fresh one every morning until the row is edited.
if (count > 0 || warning) {
	await sendSummary(count, config.siteUrl(), warning, gaps);
	console.error(
		`Sent summary: ${count} deals${warning ? ` — ${warning}` : ""}` +
			`${gaps.length ? ` — ${gaps.length} item(s) need a size in the name` : ""} → ${config.siteUrl()}`,
	);
} else {
	console.error("No deals today — no message sent.");
}

/**
 * The shopping list, as a second message. See `sendListSummary` for why it is separate
 * from the deals summary rather than a line inside it.
 *
 * ⚠️ **Its own try, and deliberately AFTER the deals message.** The deals summary is the
 * message this workflow exists to send; a missing or malformed `list.json` must not cost
 * it. A missing file is the normal state on any run whose `build-site` list block failed,
 * and it is not worth a red run on its own — the page itself already says what went wrong.
 */
try {
	const summary = JSON.parse(await readFile("public/list.json", "utf8")) as ListSummary;
	const listUrl = `${config.siteUrl().replace(/\/+$/, "")}/list.html`;
	await sendListSummary(summary, listUrl);
	console.error(
		summary.count > 0
			? `Sent list: ${summary.count} item(s), $${summary.full.toFixed(2)} → $${summary.discounted.toFixed(2)} → ${listUrl}`
			: "Grocery list is empty — no list message sent.",
	);
} catch (e: any) {
	if (e?.code === "ENOENT") console.error("No public/list.json — list message skipped.");
	else console.error(`Warning: grocery list message failed: ${e.message}`);
}
