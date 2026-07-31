import { parseWeight, type ParsedWeight } from "./stores/weight.js";
import { normSynonyms } from "./match.js";

/**
 * Deterministic parsers — no LLM. Two jobs:
 *  1. Ingredient Name  → search term + must-match keyword constraints.
 *  2. "Used 'N' Plan" formula string → monthly usage (amount, packs, cost).
 *
 * Formats verified against live Notion data (see LEARNINGS 2026-07-27).
 */

/**
 * Words that, if present in the Name, become a hard constraint a candidate
 * store product must also satisfy. Multi-word entries are matched as phrases.
 * Tune against real store results (PRD: false matches fixed by editing Names).
 */
export const MUST_MATCH_KEYWORDS = [
	"organic",
	"fresh",
	"frozen",
	"enriched",
	"wholegrain",
	"whole grain",
	"wholemeal",
	"whole meal",
	"skinless",
	"skimmed",
	"skim", // synonym form of "skimmed" — the hay is synonym-normalised below
	"low fat",
	"low gi",
	"raw",
	"unbreaded",
	"peeled",
	"light",
	"brown",
] as const;

/**
 * Bracket conventions in an Ingredient `Name` (the user's naming standard):
 *   [ ]  brand              — "Chicken Breast [Betagro]". Never part of the search
 *                             text. Becomes a hard brand filter only when the row
 *                             is tagged `Brand Specific` in the `Select` property.
 *   { }  ignored            — "Egg Whites, {cheap}". A private note: excluded from
 *                             the search term AND from every matching decision.
 *   ( )  defining property  — "Onion (White)", "egg (Omega 3 Enriched)". The thing
 *                             that makes this item the item. A candidate failing it
 *                             is never published as a deal, but a close one is
 *                             surfaced as a recommendation.
 *
 * Two special property forms:
 *   • Negation — "(not red)" means "any onion EXCEPT red" (a hard exclusion).
 *   • Basic range — "(Normal)"/"(Regular)"/"(Plain)" means the unadjusted product,
 *     identical in meaning to writing no property at all. It is NOT a required
 *     word; instead it switches on variant exclusion, so "Milk (Normal)" and plain
 *     "Milk" both reject low-fat / skimmed / lactose-free / flavoured / plant milk.
 */

/** Property words meaning "the basic, unadjusted product" (≡ no property). */
const BASIC_MARKERS = new Set(["normal", "regular", "plain", "basic", "standard", "original"]);

/**
 * A parenthetical that is NOTHING BUT a pack size — "(600g)", "(550g)", "(1.5kg)",
 * "(6 x 250ml)" — states how much is in the pack, not what makes the item the
 * item. It has to be kept out of `properties`, because a property is a hard
 * requirement on the product's title and no shop writes your pack size in its
 * name: "Bread, Wholemeal, [FairPrice] (600g)" would demand the word "600g" and
 * so match nothing at all.
 *
 * This is how a By-Unit item (counted in slices or eggs) gets a weight the price
 * comparison can use — see `readGroceryTargets`.
 */
const SIZE_ONLY_RE =
	/^\d+(?:\.\d+)?\s*(?:kg|kgs|gm|gms|grams?|g|ml|ltr|litre|liter|lt|l)$|^\d+\s*[x×]\s*\d+(?:\.\d+)?\s*(?:kg|kgs|gm|gms|grams?|g|ml|ltr|litre|liter|lt|l)$/i;

/**
 * CATEGORY properties say what KIND of thing the product is, rather than naming a
 * word that appears on its label. "Banana (Fruit)" means "the actual fruit" — no
 * banana is ever labelled "fruit", while a *freeze-dried fruit snack* is. Matching
 * these literally inverts the intent, so they're kept apart from `properties` and
 * drive a form guard instead (see `NON_PRODUCE_RES` in match.ts).
 */
const PRODUCE_CATEGORIES = new Set([
	"fruit", "fruits", "vegetable", "vegetables", "veg", "veggie", "veggies", "produce",
	"leaf", "leaves", "root", "roots", "seed", "seeds", "herb", "herbs", "flower", "flowers",
]);

export interface ParsedName {
	/** Cleaned keyword to search the store for (base noun only — broad on purpose). */
	searchTerm: string;
	/** Lower-cased keywords the candidate product must also contain. */
	mustMatch: string[];
	/** Defining properties from ( ) that a candidate must satisfy. */
	properties: string[];
	/** Category declarations from ( ) — e.g. "produce" for "(Fruit)"/"(Vegetable)". */
	categories: string[];
	/** Properties from "(not X)" that a candidate must NOT have. */
	negatedProperties: string[];
	/**
	 * Pack size stated in the name — "(600g)" on an item counted in slices. Null
	 * when the name says nothing about weight. Never a matching constraint.
	 */
	size: ParsedWeight | null;
	/** Brand from [ ], if any (lower-cased). */
	brand: string | null;
	/** True when the name asks for the basic range (bare name, or "(Normal)"). */
	basicRange: boolean;
	/** Contents of { } — deliberately excluded from search and matching. */
	ignored: string[];
	/** The original name, untouched. */
	original: string;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseName(raw: string): ParsedName {
	const original = raw;

	// { } is a private note — remove it before anything else looks at the name.
	const ignored: string[] = [];
	let work = raw.replace(/\{([^}]*)\}/g, (_m, inner) => {
		const v = collapse(inner);
		if (v) ignored.push(v.toLowerCase());
		return " ";
	});

	// [ ] is the brand. Last one wins (names carry at most one).
	let brand: string | null = null;
	work = work.replace(/\[([^\]]*)\]/g, (_m, inner) => {
		const v = collapse(inner);
		if (v) brand = v.toLowerCase();
		return " ";
	});

	// ( ) holds the defining properties.
	const properties: string[] = [];
	const categories: string[] = [];
	const negatedProperties: string[] = [];
	let size: ParsedWeight | null = null;
	let sawBasicMarker = false;
	work = work.replace(/\(([^)]*)\)/g, (_m, inner) => {
		// "(peeled/Frozen)" and "(a,b)" describe several properties at once.
		for (const part of String(inner).split(/[/,]/)) {
			const v = collapse(part).toLowerCase();
			if (!v) continue;
			// Tested per part, so "(600g, organic)" yields a size AND a property.
			if (SIZE_ONLY_RE.test(v)) {
				size = parseWeight(v) ?? size;
				continue;
			}
			const neg = v.match(/^(?:not|no|non[- ]?)\s+(.*)$/);
			// "un-" is a negation too: "(unbreaded)" means NOT breaded, "(Unpasteurized)"
			// means NOT pasteurized. No store prints these words, so requiring them
			// literally matched nothing — Squid Ring found 18 products and accepted 0.
			// Requiring the ABSENCE of the root works: word-boundary matching means
			// "Unsalted Butter" does not contain "salted", so it passes, while
			// "Salted Butter" is correctly rejected. Root must be ≥5 chars so ordinary
			// words starting with "un" ("union") aren't torn apart.
			const un = v.match(/^un([a-z]{5,})$/);
			if (neg?.[1]) {
				negatedProperties.push(collapse(neg[1]));
			} else if (un?.[1]) {
				negatedProperties.push(un[1]);
			} else if (BASIC_MARKERS.has(v)) {
				sawBasicMarker = true; // "(Normal)" ⇒ basic range, not a required word
			} else if (PRODUCE_CATEGORIES.has(v)) {
				categories.push(v); // "(Fruit)" ⇒ a KIND of product, not a word to find
			} else {
				properties.push(v);
			}
		}
		return " ";
	});

	// Must-match keywords are read from what's LEFT (brand and {notes} removed) plus
	// the declared properties — never from an ignored note.
	//
	// Run through the synonym register FIRST, so a phrase rule can retire a keyword
	// that no shop actually prints. "Omega 3 Enriched" folds to "omega3", which drops
	// `enriched` — a word FairPrice uses on BREAD and on one unrelated vitamin egg,
	// never on the omega-3 eggs the item is asking for. Without this the three egg
	// items demanded a word no candidate could ever satisfy, so they matched nothing.
	// Keywords whose synonym form differs (skimmed→skim, wholemeal→wholegrain) are
	// listed in MUST_MATCH_KEYWORDS in BOTH forms, so nothing else changes.
	const keywordHay = normSynonyms(`${work} ${properties.join(" ")}`).toLowerCase();
	const mustMatch = MUST_MATCH_KEYWORDS.filter((kw) => {
		const re = new RegExp(`(^|[^a-z])${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([^a-z]|$)`, "i");
		return re.test(keywordHay);
	}).map((k) => k.toLowerCase());

	// Take the part before the first comma as the base noun
	// ("Bread, Wholemeal, Sunshine" → "Bread"; keywords recovered separately).
	const searchTerm = collapse(
		work.split(",")[0].replace(/[^\p{L}\p{N}\s'-]/gu, " "),
	);

	// No stated property (or an explicit "(Normal)") ⇒ the basic, unadjusted range.
	const basicRange = sawBasicMarker || properties.length === 0;

	return {
		searchTerm,
		mustMatch,
		properties,
		categories,
		negatedProperties,
		size,
		brand,
		basicRange,
		ignored,
		original,
	};
}

export type UsageUnit = "g" | "ml" | "x";

export interface MonthlyUsage {
	/** Monthly quantity in grams (unit "g") or units (unit "x"). */
	amount: number;
	unit: UsageUnit;
	/** Packs per month, as the DB computed it. */
	packs: number;
	/** Monthly cost in SGD, per the DB. */
	costSgd: number;
}

/**
 * The unit is OPTIONAL. By-Gram and By-Unit rows render it ("40 x / 0.4Pk"),
 * but By-ml rows omit it entirely ("300 / 0.5Pk") — the formula doesn't emit a
 * unit for that type. Requiring it silently dropped 7 of 27 plan ingredients
 * (every liquid: soy sauce, fish sauce, milk, oils, vinegar): they showed up
 * under "Other items on offer" with no monthly usage, and their cooldowns fell
 * back to the flat no-usage default. See LEARNINGS 2026-07-29.
 */
const MONTHLY_RE =
	/([\d.]+)\s*(ml|g|x)?\s*\/\s*([\d.]+)\s*Pk\s*\|\s*Monthly[^|]*\|\s*([\d.]+)\s*SGD/i;

/**
 * Parse the monthly line of a "Used 'N' Plan" value. Returns null if the string
 * is empty (ingredient not in this plan) or doesn't match the expected shape.
 *
 * `fallbackUnit` supplies the unit when the formula omitted it — pass the one
 * implied by the row's `Unit type `, since that's the authority on what the
 * number means.
 */
export function parseMonthlyUsage(
	usedPlan: string | null | undefined,
	fallbackUnit: UsageUnit = "g",
): MonthlyUsage | null {
	if (!usedPlan) return null;
	const m = usedPlan.match(MONTHLY_RE);
	if (!m) return null;
	return {
		amount: Number(m[1]),
		unit: (m[2]?.toLowerCase() as UsageUnit) ?? fallbackUnit,
		packs: Number(m[3]),
		costSgd: Number(m[4]),
	};
}
