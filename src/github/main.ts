import { runOnce } from "../core/run.js";
import { sendDeals, formatDeal } from "../core/telegram.js";
import { config } from "../core/config.js";

/**
 * Entry point for the GitHub Actions daily run (the free default runtime).
 * `--dry-run` (or DRY_RUN=1) prints the messages instead of sending — no
 * Telegram token needed. The same core runs unchanged under the optional
 * Notion Worker wrapper.
 */

const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

const { deals, targetsConsidered, errors } = await runOnce();
console.error(
	`Plan '${config.activePlanNumber()}': ${targetsConsidered} targets → ${deals.length} deals` +
		(errors.length ? `, ${errors.length} store errors` : ""),
);

if (dryRun) {
	console.log(`\n=== DRY RUN: ${deals.length} message(s) ===\n`);
	for (const d of deals) console.log(formatDeal(d) + "\n---");
} else if (deals.length) {
	const sent = await sendDeals(deals);
	console.error(`Sent ${sent} Telegram message(s).`);
} else {
	console.error("No deals today — nothing sent.");
}
