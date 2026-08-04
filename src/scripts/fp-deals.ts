import { readGroceryTargets } from "../core/notion.js";
import { fairprice } from "../core/stores/fairprice.js";
import { findDeal } from "../core/compare.js";

/** End-to-end (FairPrice only): plan targets → search → deals. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const targets = (await readGroceryTargets()).filter((t) => t.inActivePlan);
// Comparable in either dimension — per 100g, or per piece for a counted item.
const comparable = targets.filter((t) => t.baselinePer100g != null || t.baselinePerUnit != null);

console.log(
	`Main plan: ${targets.length} targets, ${comparable.length} comparable. Searching FairPrice…\n`,
);

const deals = [];
for (const t of comparable) {
	try {
		const products = await fairprice.search(t.search.searchTerm);
		const deal = findDeal(t, products);
		if (deal) {
			deals.push(deal);
			console.log(
				`✅ ${t.name}: ${deal.product.name} @ ${deal.productPrice.toFixed(3)}/${deal.dimension === "unit" ? "each" : "100g"} ` +
					`vs ${deal.baseline.toFixed(3)} (−${deal.savingPct.toFixed(0)}%, ` +
					`save ~$${deal.monthlySavingSgd.toFixed(2)}/mo)${deal.product.onSale ? " [SALE]" : ""}`,
			);
		} else {
			const base =
				t.baselinePer100g != null
					? `${t.baselinePer100g.toFixed(3)}/100g`
					: `${t.baselinePerUnit?.toFixed(3)} each`;
			console.log(`·  ${t.name}: no deal (baseline ${base})`);
		}
	} catch (e: any) {
		console.log(`⚠  ${t.name}: ${e.message}`);
	}
	await sleep(800); // be polite
}

console.log(`\n${deals.length} deals found.`);
