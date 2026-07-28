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

const { deals, targetsConsidered, errors } = await runOnce();
console.error(
	`Plan '${config.activePlanNumber()}': ${targetsConsidered} targets → ${deals.length} deals` +
		(errors.length ? `, ${errors.length} store errors` : ""),
);

await mkdir("public", { recursive: true });
await writeFile("public/index.html", renderDealsPage(deals), "utf8");
await writeFile("public/summary.json", JSON.stringify({ count: deals.length, generatedAt: new Date().toISOString() }), "utf8");
console.error(`Wrote public/index.html (${deals.length} deals) and public/summary.json`);
