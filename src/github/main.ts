import { mkdir, writeFile } from "node:fs/promises";
import { runOnce } from "../core/run.js";
import { renderDealsPage } from "../core/site.js";
import { sendSummary } from "../core/telegram.js";
import { config } from "../core/config.js";

/**
 * Local all-in-one run (scan → write page → send the single summary message).
 * CI uses the split `build-site` + Pages deploy + `notify` instead, so the page
 * is live before the message links to it. `--dry-run` writes the page but sends
 * nothing.
 */

const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

const { planDeals, otherDeals, targetsConsidered, recommendations, errors } = await runOnce();
const total = planDeals.length + otherDeals.length;
console.error(
	`Plan '${config.activePlanNumber()}': ${targetsConsidered} targets → ${planDeals.length} plan + ${otherDeals.length} other deals` +
		(recommendations.length ? `, ${recommendations.length} close matches` : "") +
		(errors.length ? `, ${errors.length} store errors` : ""),
);

await mkdir("public", { recursive: true });
await writeFile(
	"public/index.html",
	renderDealsPage(planDeals, otherDeals, new Date(), recommendations),
	"utf8",
);
console.error("Wrote public/index.html");

if (dryRun) {
	console.error(`DRY RUN — would send: "${total} deals → ${config.siteUrl()}"`);
} else if (total) {
	await sendSummary(total, config.siteUrl());
	console.error(`Sent summary: ${total} deals → ${config.siteUrl()}`);
} else {
	console.error("No deals today — nothing sent.");
}
