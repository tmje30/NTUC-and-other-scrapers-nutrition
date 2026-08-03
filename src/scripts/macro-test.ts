import { lookupMacros, macrosConfigured } from "../core/macros.js";

/**
 * Try the macro lookup on one product, without writing anything to Notion.
 *
 * The whole point of this script is that "Add to Ingredients" is the one button
 * that costs money and calls out to the internet, so it should be possible to
 * see exactly what it would write BEFORE trusting it with a real row. Use it to
 * check the key works, to sanity-check a food where raw-vs-cooked matters, or to
 * see which of the three tiers a given product lands on.
 *
 *   npm run macro-test -- "Seara Frozen Chicken Thigh 2kg"
 *   npm run macro-test -- "Captain Oats Instant 1kg" --url https://... --store "Sheng Siong"
 *
 * Costs roughly 6-7 US cents per run. Never prints the API key.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};
const product = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true)[0];

if (!product) {
	console.error('Usage: npm run macro-test -- "<product name>" [--url <url>] [--store <shop>] [--as <ingredient name>]');
	process.exit(1);
}

if (!macrosConfigured()) {
	console.error(
		"No ANTHROPIC_API_KEY found.\n" +
			"  Local:  add it to .env\n" +
			"  Cloud:  gh secret set ANTHROPIC_API_KEY\n" +
			"Without it, Add to Ingredients still works — rows are just written without nutrition.",
	);
	process.exit(1);
}

console.error(`Looking up "${product}"…`);
const started = Date.now();
const res = await lookupMacros({
	product,
	url: flag("url"),
	store: flag("store"),
	ingredientName: flag("as"),
});
const secs = ((Date.now() - started) / 1000).toFixed(1);

if (!res) {
	console.error(`\nNo figures came back (${secs}s). The row would be created without nutrition.`);
	process.exit(1);
}

const g = (n: number | null) => (n == null ? "  —  " : `${n.toFixed(1).padStart(5)}g`);
console.log(
	`\n${product}  (${secs}s)\n` +
		`  Protein per 100g   ${g(res.proteinPer100g)}\n` +
		`  Fats per 100 g     ${g(res.fatsPer100g)}\n` +
		`  Carbs per 100g     ${g(res.carbsPer100g)}\n` +
		`  Fiber per 100g     ${g(res.fiberPer100g)}\n` +
		`\n  Source: ${res.source}\n  Basis:  ${res.basis}\n`,
);
if (res.source === "generic") {
	console.log("  ⚠️  Generic values, not this product's own label — check before trusting them.\n");
}
