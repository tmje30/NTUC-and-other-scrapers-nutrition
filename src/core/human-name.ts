/**
 * A product name that arrived as a URL slug, turned back into words.
 *
 *   "cerave-pm-facial-moisturizing-lotion-52ml-630062.html"
 *       → "Cerave PM Facial Moisturizing Lotion 52ml"
 *
 * ## Why this exists
 *
 * Most shops hand over a real title, and this function never touches those. But an
 * app-rendered storefront can leave the last-resort readers holding the URL instead
 * — a Magento PWA sets `document.title` from the route before it hydrates, so a
 * content script that arrives early reads the slug, and the extension's `titleName()`
 * fallback writes it into `Items Exact Name` looking perfectly confident. That is how
 * the CeraVe row above ended up named after its own address bar.
 *
 * The slug is not wrong, just unreadable, and it is the string the user sees in Notion
 * for the rest of that row's life. So it is repaired at the point it is read rather
 * than left for a human to retype.
 *
 * ⚠️ **This is a last-resort tidy, not a name parser.** It is only ever reached by a
 * string that already failed every structured reader. It must not "improve" a title a
 * shop actually published — see the guard in `looksLikeSlug`.
 *
 * Deterministic, no model — the same house rule as `generic-name.ts`, and the reason
 * this can run inside the extension's content script.
 */

/**
 * Words a title-case pass would otherwise mangle. Small and closed on purpose:
 * every entry is a token that is *always* an initialism in a product name, never an
 * ordinary word. "PM" is the case that started this — `Cerave Pm Facial…` reads as a
 * typo, and it is the difference between a repaired name and a nearly-repaired one.
 *
 * ⚠️ Do not add a token that could also be a word ("in", "no", "one"). A wrongly
 * shouted word is a new disfigurement, not a fix.
 */
const INITIALISMS = new Set(["pm", "am", "spf", "uv", "bb", "cc", "hd", "led", "ph", "xl", "xxl", "usb"]);

/** `52ml`, `100g`, `1l`, `2x100g` — a size glued to its unit, as slugs write them. */
const SIZE_TOKEN = /^\d+(?:[.,]\d+)?(?:x\d+(?:[.,]\d+)?)?(?:g|gm|kg|ml|cl|l|ltr|mg|oz|pcs?|s)$/i;

/** Page extensions a storefront puts on a product URL. */
const PAGE_EXT = /\.(?:html?|php|aspx?|jsp)$/i;

/**
 * Is this string a URL slug rather than something a human wrote?
 *
 * Deliberately strict, because the cost is lopsided: leaving a slug alone is a name
 * the user can still read and fix, while rewriting a real title silently changes a
 * field nobody will re-check.
 *
 *   - Any whitespace at all ⇒ a human wrote it. Every published title has a space in
 *     it; no slug ever does.
 *   - Otherwise it needs a page extension or a path, or **three or more** hyphenated
 *     parts. ⚠️ Three, not two: "Coca-Cola", "7-Eleven" and "Vitamin-C" are real
 *     names with a real hyphen in them, and two parts cannot tell those apart from a
 *     slug. A product slug that short does not occur.
 *   - A one-word name ("Cabbage") is left exactly as it is.
 */
export function looksLikeSlug(raw: string): boolean {
	const s = String(raw || "").trim();
	if (!s || /\s/.test(s)) return false;
	if (PAGE_EXT.test(s) || s.includes("/")) return true;
	return s.split(/[-_]+/).filter(Boolean).length >= 3;
}

/** One slug token → how it should be spelled in a name. */
function spellToken(token: string): string {
	const lower = token.toLowerCase();
	if (INITIALISMS.has(lower)) return lower.toUpperCase();
	// A size keeps its digits and a lowercase unit — except a bare litre, where `1l` is
	// one character away from being read as eleven. ⚠️ The digit in the pattern is what
	// keeps it off "52ml" and "30cl", whose `l` belongs to the unit before it.
	if (SIZE_TOKEN.test(lower)) return lower.replace(/(\d)l$/, "$1L");
	return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * The slug's trailing catalogue id — Guardian's `630062`, FairPrice's 8-digit item
 * number. Dropped because it names nothing a shopper would recognise.
 *
 * ⚠️ **Five digits, not four.** `generic-name.ts` sets the house rule that deleting a
 * meaningful word loses information silently while keeping a useless one costs one
 * edit, so the threshold sits above the numbers that carry meaning: `vitamin-c-1000`
 * and `sunblock-2024` keep their last token, and only something long enough to be an
 * id is taken.
 */
const CATALOGUE_ID = /^\d{5,}$/;

/**
 * Turn a URL slug into a readable product name. Anything that is not a slug — which
 * is nearly everything — comes back untouched.
 *
 * Falls back to the original whenever the repair would leave too little to name a
 * product, on the same reasoning as `deriveGenericName`: a blank field is worse than
 * an ugly one.
 */
export function humanizeProductName(raw: string): string {
	const original = String(raw || "").trim();
	if (!looksLikeSlug(original)) return original;

	// A full URL, or a path — the product is named by the last segment.
	let s = original.split(/[?#]/)[0];
	const segments = s.split("/").filter(Boolean);
	s = (segments[segments.length - 1] || "").replace(PAGE_EXT, "");

	const tokens = s.split(/[-_]+/).filter(Boolean);
	// One token is a bare host ("www.guardian.com.sg") or a bare page name — neither
	// names a product, and inventing one from them would be worse than saying nothing.
	if (tokens.length < 2) return original;

	while (tokens.length > 1 && CATALOGUE_ID.test(tokens[tokens.length - 1])) tokens.pop();

	const name = tokens.map(spellToken).join(" ").trim();
	// Two letters is the floor, as in `deriveGenericName` — below that the repair has
	// eaten the product.
	return name.length >= 2 ? name : original;
}
