import type { PlanTarget } from "./notion.js";
import type { StoreProduct } from "./stores/types.js";
import { evaluate } from "./match.js";
import { cooldownKey } from "./cooldown.js";
import { EMPTY_EXCLUSIONS, exclusionReason, type ExclusionFile } from "./exclusions.js";

/**
 * Match store products to a plan target and find genuine savings.
 *
 * Match quality is delegated to `match.ts` (a scored, multilingual engine ported
 * from the sibling inventory-scraper project): a candidate must clear every
 * must-match keyword and reach the ACCEPT confidence band after form/pack-size
 * penalties. A deal is then flagged only where the candidate beats the baseline
 * by MIN_SAVING_PCT (or is explicitly on sale below it).
 *
 * ## Two dimensions
 *
 * Most items are compared **per 100g/ml**. Items counted in pieces (`By Unit` —
 * eggs, slices, tea bags) are compared **per piece**, because that's the way they
 * are bought, planned and used: the plan says "140 eggs a month", so what decides
 * the monthly bill is the price of an egg.
 *
 * Which dimension applies is decided per candidate, by what the shop published:
 *
 *  • counted item, shop gives a count  → per piece. FairPrice lists eggs as
 *    30s and 10s, and its cheapest carton per egg carries no weight at all, so a
 *    weight-only comparison cannot see it.
 *  • counted item, shop gives only weight → per 100g, against a weight written
 *    into the item's own name ("Bread, Wholemeal (600g)"). Every bread FairPrice
 *    returns is weight-only, which is exactly why that name convention exists.
 *  • everything else → per 100g, as before.
 *
 * So `baseline` and `productPrice` are "per 100g" or "per piece" according to
 * `dimension`, and nothing may read them without checking which.
 */

/** Whether a comparison was made by weight (per 100g/ml) or by the piece. */
export type DealDimension = "weight" | "unit";

export interface Deal {
	target: PlanTarget;
	product: StoreProduct;
	/** Which dimension the two prices below are in. Always check it before display. */
	dimension: DealDimension;
	/** What the user pays: per 100g/ml, or per piece. */
	baseline: number;
	/** What the store product costs, in the same dimension. */
	productPrice: number;
	/** baseline − productPrice, same dimension. */
	saving: number;
	savingPct: number;
	monthlySavingSgd: number;
}

const MIN_SAVING_PCT = 5; // ignore sub-5% noise

/** The two baselines a target can offer, or null where it has none. */
function baselines(target: PlanTarget): { unit: number | null; weight: number | null } {
	return {
		// Per-piece only for counted items: a By-Gram row's `baselinePerUnit` is null,
		// and a "unit" of loose rice is not a thing anyone buys.
		unit:
			target.unitType === "By Unit" && target.baselinePerUnit && target.baselinePerUnit > 0
				? target.baselinePerUnit
				: null,
		weight: target.baselinePer100g && target.baselinePer100g > 0 ? target.baselinePer100g : null,
	};
}

/** Weight of one piece, where both the pack weight and the count are known. */
function gramsPerPiece(weight: number | null, count: number | null): number | null {
	return weight && weight > 0 && count && count > 0 ? weight / count : null;
}

/**
 * How far apart two piece sizes may be and still be the same kind of thing.
 *
 * Counting does not normalise size the way weight does — a quail egg, a hen's egg
 * and a jumbo egg are all "1" — so a per-piece price flatters whatever is
 * smallest. Where both sides state a weight per piece, this is the sanity check.
 * 2.5× is deliberately loose: it passes small-vs-large hen eggs (53g vs 68g) and
 * fails a quail egg against a hen's (9g vs 55g, a factor of six).
 */
const MAX_PIECE_RATIO = 2.5;

/**
 * Compare one candidate in whichever dimension both sides can actually express,
 * preferring the piece for a counted item. Null when neither side lines up — a
 * counted product with no count and no weight can't be priced at all.
 */
function priceCandidate(
	target: PlanTarget,
	product: StoreProduct,
): { dimension: DealDimension; baseline: number; productPrice: number } | null {
	const b = baselines(target);
	if (b.unit && product.unitCount && product.unitCount > 0) {
		// Only when the pieces are plausibly the same size. Unknown on either side
		// means no opinion — never reject for missing data, same rule as elsewhere.
		const mine = gramsPerPiece(target.packWeightG, target.packSize);
		const theirs = gramsPerPiece(product.packWeightG, product.unitCount);
		const comparable =
			!mine || !theirs || (mine / theirs <= MAX_PIECE_RATIO && theirs / mine <= MAX_PIECE_RATIO);
		if (comparable) {
			return {
				dimension: "unit",
				baseline: b.unit,
				productPrice: product.priceSgd / product.unitCount,
			};
		}
		// Pieces too different to count against each other — fall through to weight.
	}
	if (b.weight && product.pricePer100g && product.pricePer100g > 0) {
		return { dimension: "weight", baseline: b.weight, productPrice: product.pricePer100g };
	}
	return null;
}

/** The monthly saving, using the usage figure that matches the dimension. */
function monthlySaving(target: PlanTarget, dimension: DealDimension, saving: number): number {
	// Per piece: pieces a month, straight multiply. Per 100g: grams a month ÷ 100.
	return dimension === "unit"
		? saving * target.monthlyAmount
		: (saving * target.monthlyAmountG) / 100;
}

/**
 * The best confidently-matching deal for a target among store products. Returns
 * null if the target isn't comparable or nothing beats the baseline. Only
 * ACCEPT-band matches are eligible — review-band near-misses are surfaced
 * separately via `findReview`, never auto-published.
 *
 * Ranked by % saved rather than by lowest price, because candidates may have been
 * priced in different dimensions (see the module note): the cheapest *number* is
 * meaningless across a per-egg and a per-100g figure, while "how much cheaper than
 * what you pay" is the same question either way.
 */
export function findDeal(
	target: PlanTarget,
	products: StoreProduct[],
	exclusions: ExclusionFile = EMPTY_EXCLUSIONS,
): Deal | null {
	let best: Deal | null = null;
	const key = cooldownKey(target.search.searchTerm);

	for (const product of products) {
		// User corrections come first: a product the user has told us is wrong for
		// this item is not a deal however well it scores. See `exclusions.ts`.
		if (exclusionReason(exclusions, key, product)) continue;
		if (evaluate(target, product).verdict !== "accept") continue;
		const priced = priceCandidate(target, product);
		if (!priced) continue;

		const saving = priced.baseline - priced.productPrice;
		const savingPct = (saving / priced.baseline) * 100;
		if (!(savingPct >= MIN_SAVING_PCT || (product.onSale && saving > 0))) continue;

		if (!best || savingPct > best.savingPct) {
			best = {
				target,
				product,
				...priced,
				saving,
				savingPct,
				monthlySavingSgd: monthlySaving(target, priced.dimension, saving),
			};
		}
	}

	return best;
}

/** A review-band near-miss — a plausible-but-unconfirmed match, for visibility. */
export interface ReviewMiss {
	target: PlanTarget;
	product: StoreProduct;
	/** Adjusted (score × penalty) confidence, in [REVIEW, ACCEPT). */
	score: number;
	/** Defining properties the product failed — why it's only a recommendation. */
	missing: string[];
	/**
	 * How the two prices below compare — the same rules as a `Deal` (see the module
	 * note). Null when neither dimension lines up, in which case the near-miss can't
	 * be priced at all and the page won't show it.
	 */
	dimension: DealDimension | null;
	/** What the store product costs, in `dimension`. Null when unpriceable. */
	productPrice: number | null;
	/** The item's own price in the same dimension, for context. */
	baseline: number | null;
}

/**
 * The strongest review-band candidate for a target (used only for logging when
 * no confident deal was found — so borderline matches are visible, not silently
 * dropped). Returns null if nothing reached the review band.
 */
export function findReview(
	target: PlanTarget,
	products: StoreProduct[],
	exclusions: ExclusionFile = EMPTY_EXCLUSIONS,
): ReviewMiss | null {
	let best: ReviewMiss | null = null;
	const key = cooldownKey(target.search.searchTerm);
	for (const p of products) {
		// Excluded here too, and for the stronger reason: this is the list the
		// "Mismatch"/"Almost, but no" buttons live on, so a correction that left the
		// product sitting on tomorrow's page would look like the button did nothing.
		if (exclusionReason(exclusions, key, p)) continue;
		const m = evaluate(target, p);
		if (m.verdict === "review" && (!best || m.adjusted > best.score)) {
			const priced = priceCandidate(target, p);
			best = {
				target,
				product: p,
				score: m.adjusted,
				missing: m.missing,
				dimension: priced?.dimension ?? null,
				productPrice: priced?.productPrice ?? null,
				baseline: priced?.baseline ?? null,
			};
		}
	}
	return best;
}
