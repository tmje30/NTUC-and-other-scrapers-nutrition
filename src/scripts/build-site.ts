import { mkdir, writeFile } from "node:fs/promises";
import { runOnce } from "../core/run.js";
import { renderDealsPage } from "../core/site.js";
import { config } from "../core/config.js";

/**
 * Runs the scan and writes the GitHub Pages site:
 *   public/index.html  — the styled deals page
 *   public/summary.json — { count } for the notify step
 * The workflow deploys public/ to Pages, then runs notify.ts.
 */

const { planDeals, otherDeals, targetsConsidered, errors } = await runOnce();
const total = planDeals.length + otherDeals.length;
console.error(
	`Plan '${config.activePlanNumber()}': ${targetsConsidered} targets → ${planDeals.length} plan + ${otherDeals.length} other deals` +
		(errors.length ? `, ${errors.length} store errors` : ""),
);

await mkdir("public", { recursive: true });
await writeFile("public/index.html", renderDealsPage(planDeals, otherDeals), "utf8");
await writeFile(
	"public/summary.json",
	JSON.stringify({ count: total, planCount: planDeals.length, otherCount: otherDeals.length, generatedAt: new Date().toISOString() }),
	"utf8",
);
console.error(`Wrote public/index.html (${total} deals) and public/summary.json`);
