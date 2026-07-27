import { readPlanTargets } from "../core/notion.js";
import { config } from "../core/config.js";

/** Print the resolved active-plan grocery targets (the v1 "shopping list"). */

const targets = await readPlanTargets();

console.log(`Active plan: '${config.activePlanNumber()}'  →  ${targets.length} grocery targets\n`);
for (const t of targets) {
	const base =
		t.unitType === "By Gram"
			? `${t.baselinePer100g?.toFixed(3)} SGD/100g`
			: `${t.baselinePerUnit?.toFixed(3)} SGD/unit`;
	const unit = t.unitType === "By Gram" ? "g" : "x";
	console.log(
		`• ${t.name}\n` +
			`    search=${JSON.stringify(t.search.searchTerm)} must=[${t.search.mustMatch.join(",")}] cat=${t.category} [${t.unitType}]\n` +
			`    beat ${base}   uses ~${t.monthlyAmount}${unit}/mo (${t.monthlyPacks.toFixed(1)} packs, ${t.monthlyCostSgd.toFixed(2)} SGD)`,
	);
}
