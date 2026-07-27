import { fairprice } from "../core/stores/fairprice.js";

/** Live-test the FairPrice module. Usage: npm run fp -- tofu milk banana */

const terms = process.argv.slice(2);
if (!terms.length) terms.push("tofu");

for (const term of terms) {
	console.log(`\n===== FairPrice: "${term}" =====`);
	try {
		const products = await fairprice.search(term);
		console.log(`${products.length} products`);
		for (const p of products.slice(0, 8)) {
			const per = p.pricePer100g != null ? `${p.pricePer100g.toFixed(3)}/100g` : "per100g=?";
			const sale = p.onSale ? `  SALE (was ${p.listPriceSgd})` : "";
			console.log(
				`  • ${p.name} [${p.brand ?? "-"}]  $${p.priceSgd}  ${p.packWeightG ?? "?"}g  ${per}${sale}`,
			);
		}
	} catch (e: any) {
		console.log("  ERROR:", e.message);
	}
}
