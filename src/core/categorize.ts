/**
 * Keyword tagging for the Chrome extension: a product name → the Ingredients
 * DB's `Catagory` option, and a pack size → its `Unit type `.
 *
 * Both are only ever PRE-SELECTIONS in an editable dropdown. The extension
 * validates whatever is finally chosen against the live schema before writing,
 * so nothing here can invent a Notion option.
 *
 * Categories are matched to live options by a distinctive PATTERN, never by
 * their literal string. The DB's options carry typos and inconsistent spacing
 * ("[5[ Sugar/Sweetners", "[6]Sauces / Wines /Vinegars"); hardcoding those would
 * break the moment one is tidied up, and re-break if it is tidied differently.
 */

import { parseWeight, parseUnitCount } from "./stores/weight.js";

export type CategoryKey =
	| "protein" | "carbs" | "produce" | "sugar" | "fat" | "tea" | "sauce"
	| "spice" | "household" | "supplement";

/** How to recognise each category among the LIVE `Catagory` options. */
export const CATEGORY_PATTERNS: Record<CategoryKey, RegExp> = {
	protein: /meat|dairy|protein/i,
	carbs: /wheat|rice|carb/i,
	produce: /fruit|veg/i,
	sugar: /sugar|sweet/i,
	fat: /fat|oil/i,
	tea: /tea|coffee/i,
	sauce: /sauce|wine|vinegar/i,
	spice: /spice/i,
	household: /household/i,
	supplement: /suppl/i,
};

/**
 * Name keywords → category. ORDER MATTERS: the first hit wins, so the specific
 * rules sit above the general ones. "Garlic Bread" must land in carbs, not
 * produce, which is why every bakery word is tested before the vegetable list.
 */
const RULES: [RegExp, CategoryKey][] = [
	// Non-food first — a scented household good otherwise reads as food.
	[/\b(tissue|toilet|bathroom|napkin|wipes?|towels?|detergent|dishwash\w*|cleaner|bleach|soap|shampoo|conditioner|sanitiz\w*|freshener|garbage|trash\s*bag)\b/i, "household"],
	[/\b(vitamin|supplement|collagen|probiotic|multivitamin|fish\s*oil|capsules?|softgel|tablets?)\b/i, "supplement"],

	// Drinks before produce, so "Carrot Juice" is not a vegetable.
	[/\b(coffee|kopi|espresso|latte|tea|teh|matcha|chamomile|earl\s*grey|pu\s*erh)\b/i, "tea"],

	// Bakery / grain before produce and protein ("Garlic Bread", "Carrot Cake").
	[/\b(bread|loaf|loaves|bun|buns|toast|croissant|pastry|cake|biscuit|cracker|cookie|wafer|noodle|pasta|spaghetti|macaroni|vermicelli|bee\s*hoon|kway\s*teow|rice|oat|oatmeal|cereal|granola|muesli|flour|dumpling|prata|tortilla|wrap)\b/i, "carbs"],

	[/\b(sugar|honey|syrup|molasses|jam|sweetener|stevia|gula|jaggery|muscovado)\b/i, "sugar"],
	[/\b(oil|butter|margarine|ghee|lard|shortening|mayonnaise|mayo)\b/i, "fat"],
	[/\b(sauce|vinegar|wine|soy|shoyu|kecap|mirin|sriracha|ketchup|mustard|dressing|paste|belacan|blachan|miso)\b/i, "sauce"],
	[/\b(salt|pepper|peppercorn|cinnamon|cumin|coriander\s*(?:seed|powder)|turmeric|paprika|chilli\s*powder|curry\s*powder|masala|clove|cardamom|nutmeg|star\s*anise|bay\s*leaf|oregano|thyme|rosemary|spice)\b/i, "spice"],

	// Pulses sit here, not in produce: dried dhall/lentils are what this plan
	// counts as a protein source, and they are bought dry like a staple.
	[/\b(chicken|beef|pork|mutton|lamb|duck|fish|salmon|tuna|prawns?|shrimps?|squid|sotong|crabs?|eggs?|milk|cheese|yogh?urt|cream|tofu|tau\s*kwa|beancurd|bean\s*curd|whey|protein|hams?|bacon|sausages?|luncheon|dhall?|daal|dal|lentils?|chickpeas?|chana|channa|soybeans?)\b/i, "protein"],

	[/\b(cabbages?|lettuce|carrots?|potatoe?s?|tomatoe?s?|onions?|garlic|ginger|bananas?|apples?|oranges?|pears?|grapes?|melons?|berry|berries|spinach|broccoli|cauliflower|cucumbers?|pumpkins?|brinjal|eggplants?|okra|beans?|peas?|corn|mushrooms?|kale|celery|leeks?|radish|beet(?:root)?s?|limes?|lemons?|avocadoe?s?|mangoe?s?|papayas?|pineapples?|durians?|lychees?|kiwis?|peach(?:es)?|plums?|apricots?|fruits?|vegetables?|veg|salad|herbs?|chill?ie?s?)\b/i, "produce"],
];

/** Best-guess category key for a product name, or null when nothing matches. */
export function categorize(name: string): CategoryKey | null {
	const s = String(name || "");
	if (!s.trim()) return null;
	for (const [re, key] of RULES) if (re.test(s)) return key;
	return null;
}

/**
 * Resolve a category key to one of the LIVE `Catagory` option strings.
 * Returns null when no live option matches — the caller then leaves the
 * dropdown unset rather than inventing an option.
 */
export function matchCategoryOption(key: CategoryKey | null, liveOptions: string[]): string | null {
	if (!key) return null;
	const re = CATEGORY_PATTERNS[key];
	return liveOptions.find((o) => re.test(o)) ?? null;
}

export interface SizeGuess {
	/** `Weight /Units of New Product ` — grams, millilitres, or a piece count. */
	amount: number | null;
	/** `Unit type ` — one of the live options, decided by what the size IS. */
	unitType: "By Gram" | "By ml" | "By Unit" | null;
}

/**
 * Pack size text → the number and unit type to write.
 *
 * A COUNT wins over a weight. Shops label counted goods both ways ("Fresh Eggs
 * (10s) 550g"), and the Ingredients row is planned in the unit the thing is
 * bought in — the same per-piece rule the comparison engine uses for eggs, tea
 * bags and slices. Volume → By ml, plain weight → By Gram.
 */
export function guessSize(sizeText: string): SizeGuess {
	const raw = String(sizeText || "").trim();
	if (!raw) return { amount: null, unitType: null };

	// A weight/volume UNIT in the text settles it, and must be tested first: a
	// multipack reads as a count otherwise — parseUnitCount("2 x 1 L") returns 2,
	// so "2 x 1 L" of milk was written as 2 pieces instead of 2000 ml.
	if (/\b\d+(?:[.,]\d+)?\s*(?:g|gm|gms|gram|grams|kg|kgs|ml|cl|dl|l|ltr|litre|liter)\b/i.test(raw)) {
		const w = parseWeight(raw);
		if (w && w.grams != null && w.grams > 0) {
			return { amount: w.grams, unitType: w.volumetric ? "By ml" : "By Gram" };
		}
	}
	// No unit given → a bare count is a piece count ("10s", "(6 pcs)").
	const count = parseUnitCount(raw);
	if (count != null && count > 0) return { amount: count, unitType: "By Unit" };

	const w = parseWeight(raw);
	if (w && w.grams != null && w.grams > 0) {
		return { amount: w.grams, unitType: w.volumetric ? "By ml" : "By Gram" };
	}
	return { amount: null, unitType: null };
}
