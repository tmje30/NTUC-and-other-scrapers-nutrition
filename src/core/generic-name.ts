/**
 * Full shop name → the generic `Name` the Ingredients DB wants.
 *
 *   "Malaysia Round Cabbage"   → "Round Cabbage"
 *   "Pasar Romaine Lettuce"    → "Romaine Lettuce"
 *   "China Purple Cabbage"     → "Purple Cabbage"
 *   "Seng Choon Carrot Eggs (10s)" → "Carrot Eggs"
 *
 * The full string is kept verbatim in `Items Exact Name`; this only produces the
 * stripped-down title. Deterministic on purpose — `parse.ts` sets the house rule
 * ("Deterministic parsers — no LLM"), and every field stays editable in the
 * extension before it is written, so a miss here is a box the human fixes, never
 * a silent wrong write.
 *
 * Deliberately CONSERVATIVE. Keeping a word costs the user one edit; deleting a
 * meaningful one loses information silently, and they would have to notice it to
 * fix it. So only three classes of word are removed: a known brand, a country of
 * origin, and a pack size.
 */

/**
 * Countries as they appear in SG produce titles. NOUNS ONLY — and that is what
 * makes the list safe. `\bchina\b` cannot match "Chinese", `\bjapan\b` cannot
 * match "Japanese", so the variety adjectives that carry real meaning survive:
 * "China Chinese Cabbage" → "Chinese Cabbage", not "Cabbage".
 *
 * Words left OUT on purpose, because in SG they name a variety at least as often
 * as an origin: `Thai` (Thai Red Rice), `Holland` (Holland Potatoes), `English`
 * (English Cabbage), `Chinese`, `Japanese`, `Korean`.
 */
export const ORIGIN_WORDS = [
	"china", "malaysia", "australia", "usa", "u.s.a", "america", "thailand",
	"vietnam", "indonesia", "india", "japan", "korea", "taiwan", "philippines",
	"myanmar", "pakistan", "bangladesh", "netherlands", "new zealand", "nz",
	"egypt", "peru", "chile", "spain", "italy", "france", "brazil", "israel",
	"turkey", "iran", "sri lanka", "cameron highlands", "singapore", "local",
	"imported",
];

/**
 * Retailer house brands, stripped even when the page exposes no structured
 * brand. `Pasar` is NTUC's produce label — the user's own worked example.
 * Only unambiguous retail labels belong here: a word that could also be part of
 * a product name ("Gold", "Fresh", "Choice") must not be added.
 */
export const HOUSE_BRANDS = [
	"pasar", "fairprice", "fair price", "ntuc", "sheng siong", "house brand",
	"meadows", "zenxin", "giant", "cold storage", "happy family", "harvest",
];

/** Pack sizes: "500g", "1 kg", "2 x 1L", "(10s)", "(6 pcs)", "12's". */
const SIZE_RES: RegExp[] = [
	/\(\s*\d+(?:\.\d+)?\s*(?:s|pc|pcs|piece|pieces|ct|count)?\s*\)/gi, // (10s) (6 pcs) (12)
	/\b\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?\s*(?:g|gm|gms|gram|grams|kg|kgs|ml|cl|l|ltr|litre|liter)\b/gi,
	/\b\d+(?:[.,]\d+)?\s*(?:g|gm|gms|gram|grams|kg|kgs|ml|cl|l|ltr|litre|liter)\b/gi,
	/\b\d+\s*'?s\b/gi, // 12's, 10s
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drop every whole-word occurrence of `words` from `s`. */
function dropWords(s: string, words: string[]): string {
	let out = s;
	for (const w of words) {
		out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, "giu"), "$1 ");
	}
	return out;
}

/**
 * Tidy what the deletions left behind: doubled separators, a leading or trailing
 * "-"/","/"&", and runs of whitespace. Without this "Pasar Romaine Lettuce" with
 * the brand removed reads " Romaine Lettuce" and "A - B" can collapse to "- B".
 */
function tidy(s: string): string {
	return s
		.replace(/\s+/g, " ")
		.replace(/\s*([-–—,&/])\s*\1+/g, " $1 ")
		.replace(/^[\s\-–—,&/|]+/, "")
		.replace(/[\s\-–—,&/|]+$/, "")
		.replace(/\(\s*\)/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Derive the generic name. `brand` is the shop's own structured brand field when
 * it has one (JSON-LD `brand.name`, or a store module's `brand`) — passing it
 * strips exactly that label rather than guessing.
 *
 * Falls back to the tidied original whenever stripping would leave nothing
 * usable: for "Pasar" on its own, or a title that is ALL origin words, an empty
 * Name is worse than an unstripped one.
 */
export function deriveGenericName(fullName: string, brand?: string | null): string {
	const original = tidy(String(fullName || ""));
	if (!original) return "";

	let s = original;
	if (brand && String(brand).trim()) s = dropWords(s, [String(brand).trim()]);
	s = dropWords(s, HOUSE_BRANDS);
	s = dropWords(s, ORIGIN_WORDS);
	for (const re of SIZE_RES) s = s.replace(re, " ");
	s = tidy(s);

	// A stripped name must still say what the thing IS. Two letters is the floor
	// ("Ox", "Pu"); below that the deletions have eaten the product.
	if (s.length < 2) return original;
	return s;
}
