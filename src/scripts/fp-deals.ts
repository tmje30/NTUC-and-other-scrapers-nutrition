import { readGroceryTargets } from "../core/notion.js";
import { fairprice } from "../core/stores/fairprice.js";
import { findDeal } from "../core/compare.js";
import { config } from "../core/config.js";

/** End-to-end (FairPrice only): plan targets → search → deals. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const targets = (await readGroceryTargets()).filter((t) => t.inActivePlan);
const comparable = targets.filter((t) => t.baselinePer100g != null); // By-Gram in v1

console.log(
	`Plan '${config.activePlanNumber()}': ${targets.length} targets, ${comparable.length} By-Gram comparable. Searching FairPrice…\n`,
);

const deals = [];
for (const t of comparable) {
	try {
		const products = await fairprice.search(t.search.searchTerm);
		const deal = findDeal(t, products);
		if (deal) {
			deals.push(deal);
			console.log(
				`✅ ${t.name}: ${deal.product.name} @ ${deal.productPer100g.toFixed(3)}/100g ` +
					`vs ${deal.baselinePer100g.toFixed(3)} (−${deal.savingPct.toFixed(0)}%, ` +
					`save ~$${deal.monthlySavingSgd.toFixed(2)}/mo)${deal.product.onSale ? " [SALE]" : ""}`,
			);
		} else {
			console.log(`·  ${t.name}: no deal (baseline ${t.baselinePer100g?.toFixed(3)}/100g)`);
		}
	} catch (e: any) {
		console.log(`⚠  ${t.name}: ${e.message}`);
	}
	await sleep(800); // be polite
}

console.log(`\n${deals.length} deals found.`);
