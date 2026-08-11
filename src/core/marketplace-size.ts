/**
 * Read a pack size out of a MARKETPLACE listing title.
 *
 * Separate from `stores/weight.ts` on purpose. That parser reads a size a supermarket
 * *published as a field* — a clean "450 gm" from FairPrice's `DisplayUnit`. This one reads
 * a size out of free text a stranger typed, where the failure modes are different and all
 * of them err in the FLATTERING direction: they make a bad deal look good, which is the
 * error this project keeps having to design against.
 *
 * Measured on one page of Carousell whey results (47 distinct listings, 2026-08-04):
 * 100% carried a price, **62% stated a size in the title**. The other 38% return null here
 * and are dropped — no size is not a cheap price, it is no data.
 *
 * Four hazards, all seen in that single page:
 *
 *  1. **`lbs` dominates.** "5 lbs", "5LBS", "5Lb", "2lb", "1.58LBS", "4.00 LBS". `weight.ts`
 *     knows g/kg/ml/L only, so without lb/oz every supplement listing reads as sizeless.
 *  2. **Multi-size titles.** "Critical Whey Protein 450g/825g",
 *     "Gold Standard 100% Isolate [1.58LBS / 5.2LBS]" — one listing, several sizes, one
 *     price. A first-match regex takes the SMALL size and pairs it with the BIG tub's
 *     price. Rejected outright: which one the price refers to is unknowable from the title.
 *  3. **Multipacks.** "2 X MuscleBlaze … - 2lb" is 4 lb, not 2. Multiplied, not ignored.
 *  4. **Serving/scoop counts.** "60 servings", "30 scoops" is not a pack weight. Never read
 *     as one.
 *
 * Everything here is a pure function over a string, so it is cheap to test offline — which
 * matters because every one of these bugs is invisible in the output. A wrong size does not
 * look like an error; it looks like a bargain.
 */

export interface MarketplaceSize {
	grams: number;
	/** True when parsed from a volume unit — display per litre, as elsewhere in this project. */
	volumetric: boolean;
	/** What matched, for the probe output and for explaining a rejection. */
	basis: string;
}

/** Why a title yielded no size. Reported rather than swallowed — a silent drop teaches nothing. */
export type SizeRejection =
	| { ok: false; reason: "none" }
	| { ok: false; reason: "multi-size"; found: string[] }
	| { ok: false; reason: "range"; found: string[] };

export type SizeResult = ({ ok: true } & MarketplaceSize) | SizeRejection;

const UNIT_RE = "(kgs?|kg|gms?|grams?|g|mls?|ml|litres?|liters?|ltrs?|ltr|l|lbs?|pounds?|ozs?|oz)";

function toGrams(n: number, rawUnit: string): { grams: number; volumetric: boolean } | null {
	const u = rawUnit.toLowerCase().replace(/s$/, "");
	if (u === "kg") return { grams: n * 1000, volumetric: false };
	if (u === "g" || u === "gm" || u === "gram") return { grams: n, volumetric: false };
	if (u === "l" || u === "ltr" || u === "litre" || u === "liter") return { grams: n * 1000, volumetric: true };
	if (u === "ml") return { grams: n, volumetric: true };
	// Imperial — the whole reason this module exists.
	if (u === "lb" || u === "pound") return { grams: n * 453.59237, volumetric: false };
	if (u === "oz") return { grams: n * 28.349523125, volumetric: false };
	return null;
}

/**
 * A number+unit is only a PACK SIZE if it isn't something else wearing the same shape.
 * "100% Whey" and "50K enzymes" are not sizes; nor is a price ("S$40"). The unit regex
 * already excludes `%` and `K`, so this guards the remaining lookalikes.
 */
const SERVING_RE = /\b\d+\s*(servings?|scoops?|sachets?|caps?|capsules?|tablets?|pills?)\b/i;

/**
 * A number that may carry a comma, read the way the title meant it.
 *
 * ⚠️ **A comma is a thousands separator far more often than a decimal point, and this
 * used to assume the opposite.** `Number(x.replace(",", "."))` turned **"1,500 g" into
 * 1.5 g** — a thousandfold error, in a shape that looks like a perfectly ordinary number.
 *
 * Caught on 2026-08-11 against real iHerb titles: `"5 lb (2,268 g)"` parsed as 5 lb AND
 * 2.27 g, which disagreed, so the multi-size guard refused the listing — a correct refusal
 * hiding a wrong parse, and the product was silently dropped. A title stating **only**
 * "1,500 g" had nothing to disagree with and would have been believed.
 *
 * ⚠️ The danger is not only a bad comparison. `vendor-scan` writes this number into
 * `Size[Vendor n]`, so a misread here puts 1.5 where 1500 belongs in the price book and
 * every per-kilo figure derived from it is wrong afterwards.
 *
 * The rule: a comma followed by exactly three digits is a separator ("1,500" → 1500);
 * anything else is the European decimal comma this was written for ("1,5" → 1.5).
 */
export function looseNumber(raw: string): number {
	const s = /,\d{3}(?!\d)/.test(raw) ? raw.replace(/,/g, "") : raw.replace(",", ".");
	return Number(s);
}

/** All distinct size mentions in a string, in order of appearance. */
function allSizes(s: string): { text: string; grams: number; volumetric: boolean }[] {
	const out: { text: string; grams: number; volumetric: boolean }[] = [];
	const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${UNIT_RE}\\b`, "gi");
	for (const m of s.matchAll(re)) {
		// Skip a match that is really a percentage or a currency amount just before it.
		const before = s.slice(Math.max(0, m.index! - 2), m.index!);
		if (/[%$]/.test(before)) continue;
		const g = toGrams(looseNumber(m[1]), m[2]);
		if (!g) continue;
		out.push({ text: m[0].trim(), grams: g.grams, volumetric: g.volumetric });
	}
	return out;
}

/** Distinct to within 1% — "2.27kg" and "5lbs" on the same listing are the SAME size stated twice. */
function distinct(sizes: { grams: number }[]): number {
	const kept: number[] = [];
	for (const s of sizes) {
		if (!kept.some((k) => Math.abs(k - s.grams) / Math.max(k, s.grams) < 0.01)) kept.push(s.grams);
	}
	return kept.length;
}

/**
 * The pack size a marketplace listing title states, or a reason it doesn't.
 *
 * ⚠️ Returns a REJECTION, not a guess, when the title names more than one real size. That is
 * the single most valuable behaviour in this file: "450g/825g" at one price is not a 450 g
 * bargain, and the version of this function that returned 450 would have been wrong in a way
 * nobody would have questioned.
 */
export function marketplaceSize(title: string | null | undefined): SizeResult {
	const s = String(title ?? "").replace(/\s+/g, " ").trim();
	if (!s) return { ok: false, reason: "none" };

	// ⚠️ A RANGE sharing one unit — "1.6-5 LBS", "450–825 g" — names two sizes but only the
	// second carries the unit, so the ordinary multi-size check below cannot see the first.
	// Caught live on 2026-08-05: "Mutant Hardcore ISO Whey Isolate Protein 1.6-5 LBS" was read
	// as a flat 5 LBS, making the seller's cheapest tier look like their largest tub.
	const range = s.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*[-–—]\\s*(\\d+(?:[.,]\\d+)?)\\s*${UNIT_RE}\\b`, "i"));
	if (range) return { ok: false, reason: "range", found: [range[0].trim()] };

	// Multipack — "2 x 2lb", "3X 1kg", and the real-world "2 X <long product name> - 2lb".
	// ⚠️ The gap was 40 chars and missed exactly that case (46 chars of product name), so an
	// 82-dollar twin-pack priced itself against a single tub. Widened to 80 and bounded by the
	// separators that would mean a new clause.
	const multi = s.match(new RegExp(`(\\d+)\\s*[x×]\\s*(?:[^,;(]{0,80}?)(\\d+(?:[.,]\\d+)?)\\s*${UNIT_RE}\\b`, "i"));
	if (multi) {
		const each = toGrams(looseNumber(multi[2]), multi[3]);
		const count = Number(multi[1]);
		if (each && count > 0 && count <= 24) {
			return {
				ok: true,
				grams: Math.round(each.grams * count * 100) / 100,
				volumetric: each.volumetric,
				basis: `${count} × ${multi[2]}${multi[3]}`,
			};
		}
	}

	const sizes = allSizes(s);
	if (!sizes.length) return { ok: false, reason: "none" };

	// More than one DISTINCT size in the title → which one does the price belong to? Unknowable.
	if (distinct(sizes) > 1) return { ok: false, reason: "multi-size", found: sizes.map((x) => x.text) };

	// A serving count is not a pack size; if that is all we matched, we have nothing.
	if (SERVING_RE.test(s) && sizes.length === 0) return { ok: false, reason: "none" };

	const first = sizes[0];
	return { ok: true, grams: Math.round(first.grams * 100) / 100, volumetric: first.volumetric, basis: first.text };
}

/**
 * The cheapest listing that is not an outlier, from candidates already priced per 100 g.
 *
 * ⚠️ **Never take the minimum on a marketplace — the minimum is usually the scam.** Measured
 * on Carousell 2026-08-04: Optimum Nutrition Gold Standard **5 lbs** was listed at S$37, S$38
 * and S$110 in a single search, against a retail of roughly S$120. "Cheapest wins" surfaces
 * the S$37 every time, and it is not a 5 lb tub of ON.
 *
 * So the median is the signal and the minimum is noise. Anything below `floorRatio` of the
 * median is dropped as implausible. The floor is deliberately a parameter and deliberately
 * generous — it is there to catch the obviously-impossible, not to second-guess a real find.
 */
export function cheapestPlausible<T extends { pricePer100g: number }>(
	candidates: T[],
	floorRatio = 0.55,
): { pick: T | null; median: number | null; rejected: T[] } {
	const priced = candidates.filter((c) => Number.isFinite(c.pricePer100g) && c.pricePer100g > 0);
	if (!priced.length) return { pick: null, median: null, rejected: [] };

	const sorted = [...priced].sort((a, b) => a.pricePer100g - b.pricePer100g);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 ? sorted[mid].pricePer100g : (sorted[mid - 1].pricePer100g + sorted[mid].pricePer100g) / 2;

	const floor = median * floorRatio;
	const rejected = sorted.filter((c) => c.pricePer100g < floor);
	const pick = sorted.find((c) => c.pricePer100g >= floor) ?? null;
	return { pick, median, rejected };
}
