import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PlanTarget } from "./notion.js";
import type { StoreProduct } from "./stores/types.js";

/**
 * Product-matching engine, ported and adapted from the sibling "Inventory Price
 * upkeeper" project's `src/match.js`. Replaces the old boolean form-word filter
 * with:
 *   - a multilingual (EN + Danish) tokenizer (diacritics folding + light
 *     stemming) so the matcher is ready for future Danish grocery stores,
 *   - an editable `synonyms.json` applied to both sides,
 *   - a confidence `score()` with an accept / review / miss verdict,
 *   - context-gated form penalties (oil, drinks, plant/flavoured milk) and a
 *     pack-size plausibility guard (the grocery-appropriate stand-in for the
 *     inventory project's ml-vs-g dimension guard — here ml ≈ g, so instead we
 *     catch a candidate whose pack is wildly larger than the item's own).
 *
 * Kept deliberately conservative: only fully-confident matches auto-accept;
 * anything softer lands in the review band for visibility, never on the page.
 */

// ---------------------------------------------------------------------------
// Tokenization (multilingual)
// ---------------------------------------------------------------------------

// EN + DA stopwords and bare unit words (units never carry product meaning).
const STOP = new Set([
	"the", "and", "of", "for", "with", "per", "pack", "new", "product", "a", "an", "to", "in",
	"med", "og", "til", "stk", "pcs", "pk", "pkt",
	"ml", "cl", "dl", "l", "lt", "ltr", "litre", "liter", "kg", "kgs", "g", "gm", "gms", "gram", "grams",
]);

// Built-in phrase synonyms, collapsed on BOTH query and candidate so equivalent
// terms unify. Danish↔English staples are included so the matcher already works
// for Danish product names before any Danish store is added. User/AI additions
// live in synonyms.json at the repo root (loaded below).
const BUILTIN_SYNONYMS: [RegExp, string][] = [
	[/\bskimmed\b/gi, "skim"],
	[/\bwholemeal\b/gi, "wholegrain"],
	[/\bwhole\s+meal\b/gi, "wholegrain"],
	[/\bwhole\s+grain\b/gi, "wholegrain"],
];

function loadUserSynonyms(): [RegExp, string][] {
	try {
		const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "synonyms.json");
		const arr = JSON.parse(readFileSync(file, "utf8"));
		return (Array.isArray(arr) ? arr : [])
			.filter((s: any) => s && s.from && s.to)
			.map((s: any): [RegExp, string] => [
				new RegExp(`\\b${String(s.from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
				String(s.to),
			]);
	} catch {
		return [];
	}
}

const SYNONYMS: [RegExp, string][] = [...BUILTIN_SYNONYMS, ...loadUserSynonyms()];

export function normSynonyms(s: string): string {
	let t = String(s || "");
	for (const [re, to] of SYNONYMS) t = t.replace(re, to);
	return t;
}

/**
 * Light suffix fold so simple variants match. Conservative and English-safe,
 * applied to every token so query and candidate always fold identically.
 *   • plural "-s" (len ≥ 4, not "ss") — carrot ~ carrots, oat ~ oats.
 *   • adjectival "-ed" (len ≥ 5) — mix ~ mixed, roast ~ roasted.
 * NOTE: Danish "-er"/"-e" folding is intentionally NOT applied — it mangles
 * common English words (pepper→pepp, butter→butt, ginger→ging). Danish product
 * names are instead handled by synonyms.json (mælk→milk, gulerødder→carrots,
 * …). When Danish grocery stores are added, enable a Danish stem per-locale here.
 */
export function stem(t: string): string {
	if (t.length >= 4 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
	if (t.length >= 5 && t.endsWith("ed")) t = t.slice(0, -2);
	return t;
}

export function tokens(s: string): string[] {
	return normSynonyms(s)
		.toLowerCase()
		.normalize("NFKD")
		// fold combining diacritics onto their base letter (ä→a, å→a) rather than
		// letting the next replace shatter the word; æ/ø have no decomposition.
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9æøå\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t && !STOP.has(t) && !/^\d/.test(t)) // drop stopwords and size/number tokens
		.map(stem);
}

function sharedPrefix(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

// Weighted the same way as the sibling inventory project's `score()`: mostly
// coverage, with a real precision term. An earlier revision here dropped precision,
// claiming it sank long titles like "Laobanniang Dried Sze Chuan Peppercorn" — that
// was wrong: at these weights that title scores 0.81, well clear of ACCEPT (0.7).
// Precision is what stops a bare item name matching a title that piles on extra
// product words ("Banana" vs "…Cereal - Banana Nut Crunch").
const COVERAGE_WEIGHT = 0.7;
const PRECISION_WEIGHT = 0.3;

/**
 * Match strength of the candidate title against the item name, in [0,1]:
 *   0.7 × coverage  — how many of the ITEM's words are present, plus
 *   0.3 × precision — how focused the candidate is (few extra words).
 * Partial credit (0.75) when the query token is a full ≥4-char prefix of a
 * candidate token (pepper ~ peppercorn, æble ~ æblejuice). Wrong-form / wrong-
 * product noise is handled by the penalties below as well.
 */
export function score(query: string, candidate: string): number {
	const q = tokens(query);
	const c = tokens(candidate);
	if (q.length === 0 || c.length === 0) return 0;
	const cset = new Set(c);
	let inter = 0;
	for (const qt of new Set(q)) {
		if (cset.has(qt)) {
			inter += 1;
			continue;
		}
		for (const ct of cset) {
			const p = sharedPrefix(qt, ct);
			if (p >= 4 && (p === qt.length || p === ct.length)) {
				inter += 0.75; // one token is a full prefix of the other (compound)
				break;
			}
		}
	}
	const coverage = inter / new Set(q).size; // how much of the item name is present
	const precision = inter / cset.size; // how FOCUSED the candidate is
	return COVERAGE_WEIGHT * coverage + PRECISION_WEIGHT * precision;
}

// Calibrated for SG grocery titles: ACCEPT requires ~all of a 1–2 word item's
// tokens present (or strong coverage of a longer name); REVIEW surfaces the rest.
export const ACCEPT_THRESHOLD = 0.7;
export const REVIEW_THRESHOLD = 0.45;

// ---------------------------------------------------------------------------
// Form / plausibility penalties (context-gated multipliers, ≤ 1)
// ---------------------------------------------------------------------------

// Oil is its own product form — only valid for an oil item. EN + DA/DE/other.
const OIL_RE = /\b(oils?|olie|olje|olja|huile|olio|aceite)\b|\wöl\b|\woel\b/i;
// Prepared drink / syrup form — a plain fruit/food is not a juice/soda/cordial.
// EN + DA (saft, sirup, sodavand, saftevand).
// Alcoholic forms are included: a spice/food item must not match a WINE that merely
// names the spice ("Sze Chuan pepper" vs "Feral No 1 - Beet Hop Szechuan Pepper 0.0
// White Wine"). A genuinely beverage item (Rice Wine (Cooking)) is exempt via
// BEVERAGE_ITEM_RE below, which also lists these words.
const PREPARED_RE =
	/\w*saft\b|\w*sirup\b|\b(juice|soda|sodavand|saftevand|lemonade|limonade|sparkling|cordial|squash|kombucha|drink|beverages?|ade|wine|beer|ale|lager|cider|spirits?|liqueurs?|vodka|whisky|whiskey|rum|gin|sake|brandy)\b/i;
// Plant / flavoured / processed MILK qualifiers — block only for a plain milk item.
const MILK_VARIANT_RE =
	/\b(soy|soya|almond|oat|goat|coconut|rice|cashew|hazelnut|lactose|powder|powdered|condensed|evaporated|malt|malted|chocolate|vanilla|strawberry|cultured|buttermilk)\b/i;
// A plain fruit/food turned into a processed form (block when the item lacks it).
const PROCESSED_RE = /\b(jam|puree|sauce|cider|vinegar|sorbet|concentrate|essence|flavou?red)\b/i;
// General "right word, wrong PRODUCT" forms — a candidate naming one of these,
// when the item does not, is a different product (Butter→"Peanut Butter",
// Cinnamon→"Fruit Spread … Cinnamon", Ginger→"Dishwashing Liquid - Ginger Tea",
// White Pepper→"White Pepper Chicken Vermicelli"). Covers snacks/bakery, nut
// modifiers, prepared dishes, and non-food (cleaning/toiletry) products.
// Checked ONE WORD AT A TIME, never as a single alternation. A shared regex would
// let any item whose own name contains one of these words (a "Milk" item, a
// "Peanut Butter" item) switch off the guard for ALL the others — which is how
// "Milk (Low Fat)" once accepted "Low Fat High Protein Milk - Green Tea".
const GENERIC_FORM_PATTERNS = [
	"spread", "seasoning", "marinade", "tea", "cake", "biscuits?", "crackers?",
	"milk", "milkshake", "yogh?urt", "smoothie", "cereal", "sandwich", "chips?",
	"snack", "pudding", "jelly", "candy", "ice\\s*cream", "vermicelli", "noodles?",
	"oatmeal", "porridge", "granola", "muesli", "oats",
	"peanut", "almond", "cashew", "hazelnut", "cocoa", "dishwashing", "detergent",
	"cleaner", "soap", "shampoo", "sanitiz\\w*", "bleach",
];
const GENERIC_FORM_RES = GENERIC_FORM_PATTERNS.map((p) => new RegExp(`\\b${p}\\b`, "i"));

// "Adjusted" product markers — a version of the basic product altered along some
// dietary axis. Asking for the basic range excludes all of these. Deliberately a
// conservative list: only modifiers that are always a deviation from the plain
// product (so "powder" is absent — whey protein is legitimately a powder).
const ADJUSTED_RE =
	/\b(low[\s-]?fat|lowfat|reduced[\s-]?fat|fat[\s-]?free|non[\s-]?fat|skim|skimmed|full[\s-]?cream|sugar[\s-]?free|no[\s-]?added[\s-]?sugar|reduced[\s-]?sugar|unsweetened|diet|zero|lactose[\s-]?free|decaf\w*|lite)\b/i;

// PLANT-PART groups, ported from the sibling inventory project. An item declaring
// a category names one part of the plant; a candidate naming ONLY a different part
// is a different product — "Banana (Fruit)" vs "Banana Leaves".
const PART_GROUPS: Record<string, RegExp> = {
	fruit: /\bfruits?\b|\bberr(?:y|ies)\b/i,
	leaf: /\bleaf\b|\bleaves\b/i,
	root: /\broots?\b|\btubers?\b/i,
	seed: /\bseeds?\b|\bkernels?\b|\bnuts?\b/i,
	flower: /\bflowers?\b|\bblossoms?\b|\bbuds?\b/i,
	stem: /\bstems?\b|\bstalks?\b|\bshoots?\b|\bsprouts?\b/i,
};
const partGroupsIn = (text: string): Set<string> => {
	const s = new Set<string>();
	for (const [g, re] of Object.entries(PART_GROUPS)) if (re.test(text)) s.add(g);
	return s;
};
// Which part group does a declared category belong to? "(Fruit)" → fruit.
const CATEGORY_PART: Record<string, string> = {
	fruit: "fruit", fruits: "fruit", berry: "fruit",
	leaf: "leaf", leaves: "leaf",
	root: "root", roots: "root",
	seed: "seed", seeds: "seed",
	flower: "flower", flowers: "flower",
};

// A DIFFERENT produce item named in the title. Fresh produce is sold under its own
// name, so a title naming another vegetable/plant part is a different product even
// when it borrows the item's word: "Banana Shallots" is a shallot, "Banana Leaves"
// is a leaf. Only applied when the item declared a produce category.
const DISTINCT_PRODUCE_PATTERNS = [
	"shallots?", "onions?", "garlic", "leeks?", "scallions?", "chives?", "ginger",
	// spring/green onion is a different vegetable from a bulb onion; listed
	// separately so a plain "Onion" item doesn't match it via the word "onion".
	"spring\\s+onions?", "green\\s+onions?",
	"potatoes?", "potato", "carrots?", "cabbages?", "lettuce", "spinach", "tomato(?:es)?",
	"cucumbers?", "mushrooms?", "peel", "skin", "bark", "sprouts?",
	// …food from an entirely different aisle that merely borrows the word
	// ("Banana Prawns" is a prawn; "Baby Puffs - Banana" is a snack)…
	"prawns?", "shrimps?", "fish", "seafood", "chicken", "beef", "pork", "mutton",
	"lamb", "meat", "puffs?",
	// …and OTHER fruit. A single-ingredient produce item should not match a
	// multi-fruit product ("Apple with Strawberries", "Strawberry & Banana").
	// Listing every fruit is safe because each guard exempts words the ITEM itself
	// uses — a Banana item is never penalised for the word "banana".
	"strawberr(?:y|ies)", "blueberr(?:y|ies)", "raspberr(?:y|ies)", "blackberr(?:y|ies)",
	"cranberr(?:y|ies)", "cherr(?:y|ies)", "apples?", "bananas?", "mangoe?s?", "oranges?",
	"grapes?", "pears?", "peach(?:es)?", "plums?", "kiwis?", "melons?", "watermelons?",
	"pineapples?", "papayas?", "guavas?", "lychees?", "longans?", "durians?", "avocados?",
	"lemons?", "limes?", "apricots?", "figs?", "dates?", "coconuts?", "raisins?", "prunes?",
];
const DISTINCT_PRODUCE_RES = DISTINCT_PRODUCE_PATTERNS.map((p) => new RegExp(`\\b${p}\\b`, "i"));

// The Notion `Catagory` select already records what KIND of thing an item is, so
// the produce guards switch themselves on for every "[3] Fruits/Vegetables" row —
// no per-row "(Fruit)" needed. Declaring one in the name still adds the stricter
// plant-part guard on top.
const PRODUCE_CATEGORY_RE = /fruits?|vegetables?|\bveg\b|produce/i;

// Fermented/preserved BY DEFINITION — Kimchi and lacto ferments are pickled food,
// so the "keeping form" guard below must not fire on them.
const FERMENTED_ITEM_RE = /\b(kimchi|ferment\w*|sauerkraut|pickle[ds]?|preserved?)\b/i;

// Fresh produce turned into a keeping/processed form — a "(Fruit)" item wants the
// actual fruit, never a dried / freeze-dried / pureed / canned version of it.
const PRODUCE_PROCESSED_RE =
	/\b(dried|drying|freeze|freeze[\s-]?dried|dehydrated|puree|pureed|canned|tinned|pickled|preserved|candied|crystalli[sz]ed|compote|marmalade|nectar|paste)\b/i;

// Beverage-like item? (its own name says it's a drink → drink candidates are fine)
const BEVERAGE_ITEM_RE =
	/\b(wine|juice|coffee|tea|drink|soda|kombucha|beer|ale|lager|cider|cordial|spirits?|liqueurs?|vodka|whisky|whiskey|rum|gin|sake|brandy)\b/i;

const has = (re: RegExp, s: string) => re.test(s || "");

// Mutually-exclusive VARIETY groups. If the item names one member of a group and
// the candidate names a DIFFERENT member of the same group, it's the wrong
// variety — "Onion (white)" must not match "Red Onion", "Chicken Breast" must not
// match "Chicken Thigh/Wing", "White Pepper" not "Black Pepper", etc. The item's
// variety comes from its FULL Notion name (e.g. "Onion (white)"), because the
// bracketed part is stripped from the search term. Negation is supported in the
// name: "Onion (not red)" means "any onion except red".
// Each entry is ONE member and may list equivalent spellings as an alternation —
// singular/plural, or names for the same cut. Keeping them as separate members was
// a bug: "Chicken thigh" read "Chicken Thighs" as a DIFFERENT cut and penalised it.
//
// "mince|minced|ground" belongs here rather than in synonyms.json because the
// equivalence is context-dependent: for meat "ground" means minced, but for a spice
// it means powdered ("White Pepper - Ground"). Scoping it to this group makes it
// safe — the check only fires when the ITEM itself names a cut, so a spice item is
// never affected.
const ATTRIBUTE_GROUPS: string[][] = [
	// colour / variety
	["white", "red", "yellow", "brown", "green", "purple", "black", "orange", "pink", "golden"],
	// meat cut / part
	[
		"breasts?", "thighs?", "wings?", "drumsticks?", "whole", "mince|minced|ground",
		"fillets?|filets?", "tenderloins?", "cutlets?", "chops?", "belly", "shoulders?",
		"loin", "rump", "sirloin", "brisket", "shanks?", "livers?", "gizzards?", "carcass",
		"wingettes?", "midjoints?", "keel",
	],
];
const GROUPS = ATTRIBUTE_GROUPS.map((members) =>
	members.map((m) => ({
		m,
		re: new RegExp(`\\b(?:${m})\\b`, "i"),
		notRe: new RegExp(`\\b(?:not|no|non[- ]?)\\s+(?:${m})\\b`, "i"),
	})),
);

/**
 * Penalty for a wrong-variety candidate. `itemName` is the full Notion name (so
 * a bracketed "(white)" / "(not red)" is seen); `title` is the product name+brand.
 */
function varietyPenalty(itemName: string, title: string): number {
	let mult = 1;
	for (const group of GROUPS) {
		const negated = new Set<string>();
		const itemHas = new Set<string>();
		for (const { m, re, notRe } of group) {
			if (notRe.test(itemName)) negated.add(m); // "not red" → red is forbidden, not required
			else if (re.test(itemName)) itemHas.add(m);
		}
		const candHas = new Set<string>();
		for (const { m, re } of group) if (re.test(title)) candHas.add(m);
		if ([...negated].some((m) => candHas.has(m))) {
			mult *= 0.2; // candidate is a forbidden variety
			continue;
		}
		if (itemHas.size && [...candHas].some((m) => !itemHas.has(m))) {
			mult *= 0.2; // candidate names a different variety than the item asked for
		}
	}
	return mult;
}

/**
 * Multiplier in (0,1]. 1 = no concern. Mirrors the inventory project's
 * `matchPenalty`, adapted to grocery targets.
 */
export function matchPenalty(target: PlanTarget, product: StoreProduct): number {
	const title = `${product.name} ${product.brand ?? ""}`;
	// NB: built from the parsed parts, never the raw name — so a {private note}
	// can't leak into a matching decision.
	const s = target.search;
	const itemText = `${s.searchTerm} ${s.mustMatch.join(" ")} ${s.properties.join(" ")}`;
	let mult = 1;

	// "Basic range" (bare name, or "(Normal)") — reject adjusted variants. This is
	// the general form of the plain-milk rule: plain "Milk" must not match low-fat,
	// skimmed, lactose-free or sugar-free versions. Only applies when the item
	// itself named no such variant.
	if (s.basicRange && !has(ADJUSTED_RE, itemText) && has(ADJUSTED_RE, title)) mult *= 0.2;

	// Fresh produce, either declared in the name ("Banana (Fruit)") or — for every
	// row — inferred from the Notion `Catagory` select, so the guards work without
	// each row needing a hand-written category.
	const declaredParts = new Set(
		s.categories.map((c) => CATEGORY_PART[c]).filter((p): p is string => !!p),
	);
	const isProduce = s.categories.length > 0 || PRODUCE_CATEGORY_RE.test(target.category);
	if (isProduce) {
		// Wrong plant part — ONLY when the name declared a specific part. The Notion
		// category says "Fruits/Vegetables" without saying which, and assuming "fruit"
		// would make "Lotus Root" reject every title containing "root".
		if (declaredParts.size) {
			const titleParts = partGroupsIn(title);
			if (titleParts.size && ![...titleParts].some((g) => declaredParts.has(g))) mult *= 0.2;
		}
		// A different vegetable/fruit borrowing the item's word ("Banana Shallots",
		// "Apple with Strawberries"). Safe for every produce row because each pattern
		// is skipped when the item's OWN name uses it (so "Lotus Root" keeps "root").
		for (const re of DISTINCT_PRODUCE_RES) {
			if (has(re, title) && !has(re, itemText)) {
				mult *= 0.2;
				break;
			}
		}
		// Dried / pureed / canned — a keeping form, not the fresh item. Fermented
		// items (Kimchi, Lacto ferment) ARE preserved by definition, so they're exempt.
		if (
			has(PRODUCE_PROCESSED_RE, title) &&
			!has(PRODUCE_PROCESSED_RE, itemText) &&
			!has(FERMENTED_ITEM_RE, itemText)
		) {
			mult *= 0.2;
		}
	}

	// DIMENSION GUARD: a "By Gram" item is a SOLID, sold by weight. A candidate
	// packed in ml/L is a liquid, i.e. a different product — an apple DRINK for a
	// "Red Apple" item, a white WINE for a "Sze Chuan pepper" item. Measured across
	// the whole inventory: of 260 candidates accepted for By-Gram targets, only 2
	// were volumetric and BOTH were wrong matches.
	//
	// Deliberately NOT symmetric. By-ml items legitimately match gram-packed goods
	// (FairPrice labels "Double A 100% Sesame Oil" and "Zarotti Anchovies Fish
	// Sauce" by weight), so a reverse guard would drop real products — measured too.
	if (target.unitType === "By Gram" && product.volumetric) mult *= 0.15;

	// Wrong variety (colour / cut) — "Onion (white)" ≠ red onion, breast ≠ thigh.
	// Both sides are synonym-normalized first, so the register can fold equivalent
	// cut names: "minced" and "ground" are separate members of the meat-cut group,
	// so without this an item saying "minced" read as a DIFFERENT cut from a title
	// saying "ground" and was penalised as the wrong variety.
	mult *= varietyPenalty(normSynonyms(target.name), normSynonyms(title));

	// Oil product is only valid for an oil item.
	if (has(OIL_RE, title) && !has(OIL_RE, itemText)) mult *= 0.2;

	// Prepared drink/syrup — only valid for a beverage-like item.
	if (has(PREPARED_RE, title) && !has(BEVERAGE_ITEM_RE, itemText) && !has(PREPARED_RE, itemText))
		mult *= 0.2;

	// Plain "milk" item must be cow's milk — block plant/flavoured/powdered milk.
	const itemIsMilk = /\bmilk\b|\bmælk\b/i.test(itemText);
	const itemIsPlainMilk = itemIsMilk && !has(MILK_VARIANT_RE, itemText);
	if (itemIsPlainMilk && has(MILK_VARIANT_RE, title)) mult *= 0.2;

	// Plain food vs a processed form the item didn't ask for.
	if (has(PROCESSED_RE, title) && !has(PROCESSED_RE, itemText)) mult *= 0.35;

	// General "right word, wrong product" form (snack/bakery/nut-modifier/prepared
	// dish / non-food) the item didn't ask for. One penalty is enough — a title
	// naming several of these is already firmly rejected.
	for (const re of GENERIC_FORM_RES) {
		if (has(re, title) && !has(re, itemText)) {
			mult *= 0.2;
			break;
		}
	}

	// NB: no pack-size guard — bulk/oversized packs are kept on purpose (a big
	// cheap pack may still be worth it). Correct-product oversized listings (e.g.
	// a 25 kg cinnamon) are allowed to win on price. Wrong-form products (a 6 L
	// "sparkling apple") are already handled by the drink/form penalties above.

	return mult;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type Verdict = "accept" | "review" | "miss";

export interface MatchResult {
	score: number; // raw name score
	adjusted: number; // score × penalty
	penalty: number;
	verdict: Verdict;
	/** Defining properties / keywords the candidate failed to satisfy. */
	missing: string[];
	/** True when the row is Brand Specific and this product is the wrong brand. */
	wrongBrand: boolean;
}

/** Are all meaningful tokens of `needle` present in the candidate's tokens? */
function tokensPresent(needle: string, hayTokens: Set<string>): boolean {
	const nt = tokens(needle);
	if (!nt.length) return true; // nothing checkable (e.g. a bare number)
	for (const t of nt) {
		if (hayTokens.has(t)) continue;
		let ok = false;
		for (const h of hayTokens) {
			const p = sharedPrefix(t, h);
			if (p >= 4 && (p === t.length || p === h.length)) {
				ok = true;
				break;
			}
		}
		if (!ok) return false;
	}
	return true;
}

/**
 * A `Quality item` rejects candidates whose NORMAL price is below this share of
 * what the user pays at full price — a product that is permanently far cheaper is
 * a lower grade, not a saving.
 */
export const QUALITY_FLOOR = 0.75;

/**
 * Does the product clear the quality floor? Compares undiscounted price per 100
 * against the item's own baseline. A sale price is deliberately ignored: the whole
 * point is that a quality product may be discounted as deeply as it likes.
 * Returns true when it can't be judged (no baseline or no pack weight) — never
 * reject for missing data.
 */
function passesQualityFloor(target: PlanTarget, product: StoreProduct): boolean {
	const baseline = target.baselinePer100g;
	if (baseline == null || baseline <= 0) return true;
	if (!product.packWeightG || product.packWeightG <= 0) return true;
	const normalPrice = product.onSale && product.listPriceSgd ? product.listPriceSgd : product.priceSgd;
	if (!normalPrice || normalPrice <= 0) return true;
	const normalPer100 = (normalPrice / product.packWeightG) * 100;
	return normalPer100 >= baseline * QUALITY_FLOOR;
}

// Rearing/production methods that count as animal welfare. These DO appear in
// titles, unlike organic certification which we take from structured data.
const WELFARE_RE =
	/\b(free[\s-]?range|cage[\s-]?free|grass[\s-]?fed|pasture[\s-]?(?:raised|fed)|barn[\s-]?laid|rspca|animal welfare|humanely[\s-]?(?:raised|reared))\b/i;

/** Store-certified organic, or a welfare rearing method named in the title. */
function isOrganicOrWelfare(product: StoreProduct): boolean {
	if (product.dietaryAttributes.some((a) => /^organic$/i.test(a.trim()))) return true;
	return WELFARE_RE.test(`${product.name} ${product.brand ?? ""}`);
}

/** Demotion applied when a defining property is unmet: enough to bar the deal, */
/** while leaving a strong name match inside the review band as a recommendation. */
const REQUIREMENT_FAIL_MULT = 0.6;

/**
 * Score a product against a target.
 *
 * Order matters:
 *  1. Brand Specific — a wrong-brand product is a hard MISS, never recommended.
 *  2. Defining properties (from "( )") and must-match keywords — a candidate that
 *     fails one is barred from ACCEPT, so it can never be published as a deal, but
 *     a strong name match still lands in REVIEW and is offered as a recommendation
 *     ("close, but not what you asked for").
 *  3. Name score × form/variety penalties → accept / review / miss.
 */
export function evaluate(target: PlanTarget, product: StoreProduct): MatchResult {
	const s = target.search;
	const hay = `${product.name} ${product.brand ?? ""}`.toLowerCase();
	const hayTokens = new Set(tokens(`${product.name} ${product.brand ?? ""}`));

	// 1. Brand Specific: only the named brand is allowed at all.
	if (target.brandSpecific && s.brand && !hay.includes(s.brand)) {
		return { score: 0, adjusted: 0, penalty: 1, verdict: "miss", missing: [], wrongBrand: true };
	}

	// 1b. Quality item: reject a cheaper GRADE of product. Judged on the normal
	// (undiscounted) price only — a quality product on deep discount is exactly what
	// we want, but one whose everyday price is far under yours is a budget line.
	if (target.qualityItem && !passesQualityFloor(target, product)) {
		return { score: 0, adjusted: 0, penalty: 1, verdict: "miss", missing: [], wrongBrand: false };
	}

	// 1c. Organic / animal welfare: the store must SAY SO in structured data, or the
	// title must name a welfare rearing method. Never inferred from the word
	// "organic" in a name alone — "Chew's Fresh Eggs - Organic Selenium" is a
	// mineral additive, not an organic egg.
	if (target.organicWelfare && !isOrganicOrWelfare(product)) {
		return { score: 0, adjusted: 0, penalty: 1, verdict: "miss", missing: ["organic/welfare"], wrongBrand: false };
	}

	// 2. Requirements: defining properties + must-match keywords. A keyword drawn
	// from a property ("(Low Fat)" → "low fat") would otherwise be reported twice.
	const missingSet = new Set<string>();
	for (const prop of s.properties) if (!tokensPresent(prop, hayTokens)) missingSet.add(prop);
	for (const kw of s.mustMatch) if (!hay.includes(kw)) missingSet.add(kw);
	const missing = [...missingSet];

	// Score the bare noun AND the noun+properties, taking the best — the sibling
	// project's `bestScore`. Some products are sold ONLY under the qualifier:
	// "Tofu (Tau Kwa)" must still reach "Fortune Tau Kwa - Original", whose title
	// never says "tofu" (bare-noun coverage 0).
	const titleText = product.name + " " + (product.brand ?? "");
	let raw = score(s.searchTerm, titleText);
	if (s.properties.length) {
		raw = Math.max(raw, score(`${s.searchTerm} ${s.properties.join(" ")}`, titleText));
	}
	let penalty = matchPenalty(target, product);

	// An explicitly excluded property — "(not red)" — is a hard exclusion.
	for (const neg of s.negatedProperties) if (tokensPresent(neg, hayTokens)) penalty *= 0.2;

	if (missing.length) penalty *= REQUIREMENT_FAIL_MULT;

	const adjusted = raw * penalty;
	let verdict: Verdict =
		adjusted >= ACCEPT_THRESHOLD ? "accept" : adjusted >= REVIEW_THRESHOLD ? "review" : "miss";
	// Belt and braces: an unmet requirement must never reach ACCEPT, whatever the score.
	if (missing.length && verdict === "accept") verdict = "review";

	return { score: raw, adjusted, penalty, verdict, missing, wrongBrand: false };
}
