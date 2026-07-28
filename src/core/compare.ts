import type { PlanTarget } from "./notion.js";
import type { StoreProduct } from "./stores/types.js";

/**
 * Match store products to a plan target and find genuine per-100g savings.
 *
 * v1 compares By-Gram targets only (By-Unit comparison is future — see PRD).
 * Match quality (the PRD's open tuning question): a candidate must contain every
 * significant token of the search term AND every must-match keyword. We then
 * take the cheapest qualifying candidate and flag a deal only if it beats the
 * baseline by at least MIN_SAVING_PCT (or is explicitly on sale below baseline).
 */

export interface Deal {
	target: PlanTarget;
	product: StoreProduct;
	baselinePer100g: number;
	productPer100g: number;
	savingPer100g: number;
	savingPct: number;
	monthlySavingSgd: number;
}

const MIN_SAVING_PCT = 5; // ignore sub-5% noise
const STOPWORDS = new Set(["and", "the", "with", "per", "pack", "new", "product", "of"]);

/**
 * Product-FORM words. A candidate is rejected if its name contains one of these
 * but the target (its own name/keywords) does not — i.e. "right word, wrong
 * form": Ginger→"Ginger Ade" (drink), Banana→"...Soymilk - Banana", Butter→
 * "Buttercup ... Spread". Tuned against live FairPrice results (2026-07-27).
 */
const FORM_WORDS = [
	"drink",
	"ade",
	"juice",
	"soda",
	"cordial",
	"soymilk",
	"soy milk",
	"flavoured",
	"flavored",
	"flavour",
	"flavor",
	"essence",
	"spread",
	"seasoning",
	"marinade",
	// Sheng Siong's broader catalog surfaces many processed/flavoured variants:
	"milk",
	"tea",
	"cake",
	"biscuit",
	"biscuits",
	"cracker",
	"yoghurt",
	"yogurt",
	"smoothie",
	"cereal",
	"sandwich",
	"chip",
	"chips",
	"snack",
	"pudding",
	"jelly",
	"candy",
	"ice cream",
	// Modifiers that turn a word into a different product (peanut/cocoa butter,
	// almond milk already covered by "milk"): block when the target lacks them.
	"peanut",
	"almond",
	"cashew",
	"hazelnut",
	"cocoa",
	// Milk: a plain "Milk" target means cow's milk. Every other milk names its
	// kind (soy/almond/goat/oat/…) or its form (powder/flavour) — block those so
	// they don't undercut plain milk.
	"soya",
	"goat",
	"oat milk",
	"coconut milk",
	"rice milk",
	"lactose",
	"milk powder",
	"condensed",
	"evaporated",
	"concentrate",
	"malt",
	"chocolate",
	"vanilla",
	"strawberry",
	// Fruit: a plain fruit name means the fruit itself. A juice/soda/etc. always
	// says so in its name — block those forms so drinks don't match a fruit.
	"sparkling",
	"cider",
	"vinegar",
	"puree",
	"sauce",
	"jam",
	"sorbet",
	"squash",
];

function tokens(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Does a product satisfy a target's search tokens + must-match keywords? */
export function matchesTarget(product: StoreProduct, target: PlanTarget): boolean {
	const name = product.name.toLowerCase();
	const hay = `${product.name} ${product.brand ?? ""}`.toLowerCase();
	const targetText = `${target.search.searchTerm} ${target.search.mustMatch.join(" ")}`.toLowerCase();

	// Reject "right word, wrong form" (drink/spread/…) unless the target has it too.
	for (const fw of FORM_WORDS) if (name.includes(fw) && !targetText.includes(fw)) return false;

	const need = tokens(target.search.searchTerm);
	if (need.length && !need.every((t) => hay.includes(t))) return false;
	for (const kw of target.search.mustMatch) if (!hay.includes(kw.toLowerCase())) return false;
	return true;
}

/**
 * Find the best (cheapest qualifying) deal for a target among store products.
 * Returns null if the target isn't comparable or nothing beats the baseline.
 */
export function findDeal(target: PlanTarget, products: StoreProduct[]): Deal | null {
	const baseline = target.baselinePer100g;
	if (baseline == null || baseline <= 0) return null; // By-Unit or no baseline → skip in v1

	const candidates = products
		.filter((p) => matchesTarget(p, target))
		.filter((p) => p.pricePer100g != null && p.pricePer100g > 0);
	if (!candidates.length) return null;

	const best = candidates.reduce((a, b) => (a.pricePer100g! <= b.pricePer100g! ? a : b));
	const productPer100g = best.pricePer100g!;
	const savingPer100g = baseline - productPer100g;
	const savingPct = (savingPer100g / baseline) * 100;

	const qualifies = savingPct >= MIN_SAVING_PCT || (best.onSale && savingPer100g > 0);
	if (!qualifies) return null;

	return {
		target,
		product: best,
		baselinePer100g: baseline,
		productPer100g,
		savingPer100g,
		savingPct,
		// monthlyAmount is grams for By-Gram targets.
		monthlySavingSgd: (savingPer100g * target.monthlyAmount) / 100,
	};
}
