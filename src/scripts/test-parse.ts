import { parseName, parseMonthlyUsage } from "../core/parse.js";

/** Quick sanity check of the parsers against real Notion values. */

const names = [
	"Pu Erh (Tea bags)",
	"Bread, Wholemeal, Sunshine",
	"Chicken Breast (Seara)",
	"Egg Yolk ( enriched) ",
	"Egg Whites, cheap",
	"Eggs, Whole (small), cheap ",
	"Frozen Veg(Mixed)",
	"Milk (Skimmed)",
	"Milk (Low Fat)",
	"Honey (Raw)",
	"Bread, Whole grain (Low GI), Gardinier",
	"Squid Ring(unbreaded)",
	"3 mix cargo Rice (happy family)",
	"Lentil  (Chana Dahl)",
	"Soy Sauce (light)",
];

console.log("=== parseName ===");
for (const n of names) {
	const p = parseName(n);
	console.log(`${JSON.stringify(n)}\n   → term=${JSON.stringify(p.searchTerm)}  must=[${p.mustMatch.join(", ")}]`);
}

const usages = [
	"2 x | Daily |  0.13 SGD\n10 x / 0.1Pk | Weekly[5] |  0.63 SGD\n40 x / 0.4Pk | Monthly[20] |  2.5 SGD",
	"140 g | Daily |  0.7 SGD\n700 g / 0.4Pk | Weekly[5] |  3.48 SGD\n2800 g / 1.4Pk | Monthly[20] |  13.93 SGD",
	"1 g | Daily |  0.59 SGD\n5 g / 0Pk | Weekly[5] |  2.93 SGD\n20 g / 0.1Pk | Monthly[20] |  11.73 SGD",
	"7 x | Daily |  1.45 SGD\n35 x / 1.2Pk | Weekly[5] |  7.23 SGD\n140 x / 4.7Pk | Monthly[20] |  28.93 SGD",
	"", // not in plan
];

console.log("\n=== parseMonthlyUsage ===");
for (const u of usages) {
	console.log(`${JSON.stringify(u.slice(0, 40))}… → ${JSON.stringify(parseMonthlyUsage(u))}`);
}
