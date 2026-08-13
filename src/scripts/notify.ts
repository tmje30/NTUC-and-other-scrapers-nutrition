import { readFile } from "node:fs/promises";
import { sendSummary, type WeightGapNote } from "../core/telegram.js";
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
