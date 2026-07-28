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

const { deals, targetsConsidered, errors } = await runOnce();
console.error(
	`Plan '${config.activePlanNumber()}': ${targetsConsidered} targets → ${deals.length} deals` +
		(errors.length ? `, ${errors.length} store errors` : ""),
);

await mkdir("public", { recursive: true });
await writeFile("public/index.html", renderDealsPage(deals), "utf8");
console.error("Wrote public/index.html");

if (dryRun) {
	console.error(`DRY RUN — would send: "${deals.length} deals → ${config.siteUrl()}"`);
} else if (deals.length) {
	await sendSummary(deals.length, config.siteUrl());
	console.error(`Sent summary: ${deals.length} deals → ${config.siteUrl()}`);
} else {
	console.error("No deals today — nothing sent.");
}
