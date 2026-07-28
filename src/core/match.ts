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

/**
 * Coverage of the item's tokens by the candidate title, in [0,1]. Grocery shop
 * titles are long and full of brand/marketing noise, so — unlike the inventory
 * project — we do NOT use a precision term (it wrongly sank long-title matches
 * like "Laobanniang Dried Sze Chuan Peppercorn"). Instead: how many of the ITEM's
 * words are present. Partial credit (0.75) when the query token is a full ≥4-char
 * prefix of a candidate token (pepper ~ peppercorn, æble ~ æblejuice). Wrong-form
 * / wrong-product noise is handled by the penalties below, not by precision.
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
	return inter / new Set(q).size;
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
const PREPARED_RE =
	/\w*saft\b|\w*sirup\b|\b(juice|soda|sodavand|saftevand|lemonade|limonade|sparkling|cordial|squash|kombucha|drink|ade)\b/i;
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
const GENERIC_FORM_RE =
	/\b(spread|seasoning|marinade|tea|cake|biscuits?|crackers?|yogh?urt|smoothie|cereal|sandwich|chips?|snack|pudding|jelly|candy|ice\s*cream|vermicelli|noodles?|peanut|almond|cashew|hazelnut|cocoa|dishwashing|detergent|cleaner|soap|shampoo|sanitiz\w*|bleach)\b/i;

// Beverage-like item? (its own name says it's a drink → drink candidates are fine)
const BEVERAGE_ITEM_RE = /\b(wine|juice|coffee|tea|drink|soda|kombucha|beer|cider|cordial)\b/i;

const has = (re: RegExp, s: string) => re.test(s || "");

/**
 * Multiplier in (0,1]. 1 = no concern. Mirrors the inventory project's
 * `matchPenalty`, adapted to grocery targets.
 */
export function matchPenalty(target: PlanTarget, product: StoreProduct): number {
	const title = `${product.name} ${product.brand ?? ""}`;
	const itemText = `${target.search.searchTerm} ${target.search.mustMatch.join(" ")} ${target.name}`;
	let mult = 1;

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
	// dish / non-food) the item didn't ask for.
	if (has(GENERIC_FORM_RE, title) && !has(GENERIC_FORM_RE, itemText)) mult *= 0.2;

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
}

/**
 * Score a product against a target. Hard gate first: every must-match keyword
 * (organic / low fat / frozen / …) MUST be present — these are non-negotiable
 * product distinctions, not soft evidence. Then name score × form penalty →
 * accept / review / miss.
 */
export function evaluate(target: PlanTarget, product: StoreProduct): MatchResult {
	const hay = `${product.name} ${product.brand ?? ""}`.toLowerCase();
	for (const kw of target.search.mustMatch) {
		if (!hay.includes(kw.toLowerCase())) {
			return { score: 0, adjusted: 0, penalty: 1, verdict: "miss" };
		}
	}
	const raw = score(target.search.searchTerm, product.name + " " + (product.brand ?? ""));
	const penalty = matchPenalty(target, product);
	const adjusted = raw * penalty;
	const verdict: Verdict =
		adjusted >= ACCEPT_THRESHOLD ? "accept" : adjusted >= REVIEW_THRESHOLD ? "review" : "miss";
	return { score: raw, adjusted, penalty, verdict };
}
