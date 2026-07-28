import { runOnce } from "../core/run.js";
import { config } from "../core/config.js";

/** Full cross-store deal scan (FairPrice + Sheng Siong). */

const { planDeals, otherDeals, targetsConsidered, errors } = await runOnce();

console.log(
	`Plan '${config.activePlanNumber()}': ${targetsConsidered} comparable targets → ${planDeals.length} plan + ${otherDeals.length} other deals\n`,
);
for (const d of [...planDeals, ...otherDeals]) {
	console.log(
		`✅ ${d.target.name}\n` +
			`    ${d.product.store}: ${d.product.name} @ ${d.productPer100g.toFixed(3)}/100g ` +
			`vs ${d.baselinePer100g.toFixed(3)} (−${d.savingPct.toFixed(0)}%)${d.product.onSale ? " [SALE]" : ""}\n` +
			`    save ~$${d.monthlySavingSgd.toFixed(2)}/mo  ·  ${d.product.url}`,
	);
}
if (errors.length) {
	console.log(`\n${errors.length} store errors:`);
	for (const e of errors.slice(0, 10)) console.log(`  ⚠ ${e.target} @ ${e.store}: ${e.message}`);
}
