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

const { planDeals, otherDeals, targetsConsidered, searchTerms, errors } = await runOnce();
const total = planDeals.length + otherDeals.length;
console.error(
	`Plan '${config.activePlanNumber()}': ${targetsConsidered} targets → ${planDeals.length} plan + ${otherDeals.length} other deals` +
		(errors.length ? `, ${errors.length} store errors` : ""),
);
if (errors.length) {
	const byStore = new Map<string, { count: number; sample: string }>();
	for (const e of errors) {
		const cur = byStore.get(e.store) ?? { count: 0, sample: e.message };
		byStore.set(e.store, { count: cur.count + 1, sample: cur.sample });
	}
	for (const [store, { count, sample }] of byStore) {
		console.error(`  ${store}: ${count} errors — e.g. "${sample}"`);
	}
}

await mkdir("public", { recursive: true });
await writeFile("public/index.html", renderDealsPage(planDeals, otherDeals), "utf8");
await writeFile(
	"public/summary.json",
	JSON.stringify({ count: total, planCount: planDeals.length, otherCount: otherDeals.length, generatedAt: new Date().toISOString() }),
	"utf8",
);
console.error(`Wrote public/index.html (${total} deals) and public/summary.json`);

// Publish the search terms so residential runners (phone/laptop) can fetch them
// without a Notion token. Wrapped so a failure here never breaks the page/notify.
try {
	await writeFile(
		"public/targets.json",
		JSON.stringify({ generatedAt: new Date().toISOString(), terms: searchTerms }),
		"utf8",
	);
	console.error(`Wrote public/targets.json (${searchTerms.length} terms)`);
} catch (e: any) {
	console.error(`Warning: failed to write public/targets.json: ${e.message}`);
}
