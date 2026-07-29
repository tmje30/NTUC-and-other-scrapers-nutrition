import type { PlanTarget } from "./notion.js";
import type { StoreProduct } from "./stores/types.js";
import { evaluate } from "./match.js";

/**
 * Match store products to a plan target and find genuine per-100g savings.
 *
 * v1 compares By-Gram targets only (By-Unit comparison is future — see PRD).
 * Match quality is delegated to `match.ts` (a scored, multilingual engine ported
 * from the sibling inventory-scraper project): a candidate must clear every
 * must-match keyword and reach the ACCEPT confidence band after form/pack-size
 * penalties. We then take the cheapest ACCEPTED candidate and flag a deal only if
 * it beats the baseline by MIN_SAVING_PCT (or is explicitly on sale below it).
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

/** Back-compat boolean: does the product confidently (ACCEPT-band) match the target? */
export function matchesTarget(product: StoreProduct, target: PlanTarget): boolean {
	return evaluate(target, product).verdict === "accept";
}

/**
 * Find the best (cheapest confidently-matching) deal for a target among store
 * products. Returns null if the target isn't comparable or nothing beats the
 * baseline. Only ACCEPT-band matches are eligible — review-band near-misses are
 * surfaced separately via `findReview`, never auto-published.
 */
export function findDeal(target: PlanTarget, products: StoreProduct[]): Deal | null {
	const baseline = target.baselinePer100g;
	if (baseline == null || baseline <= 0) return null; // By-Unit or no baseline → skip in v1

	const candidates = products
		.filter((p) => evaluate(target, p).verdict === "accept")
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

/** A review-band near-miss — a plausible-but-unconfirmed match, for visibility. */
export interface ReviewMiss {
	target: PlanTarget;
	product: StoreProduct;
	/** Adjusted (score × penalty) confidence, in [REVIEW, ACCEPT). */
	score: number;
	/** Defining properties the product failed — why it's only a recommendation. */
	missing: string[];
	/** Per-100 price, when known (so the page can show whether it's even cheaper). */
	productPer100g: number | null;
	/** The item's own per-100 baseline, for context. */
	baselinePer100g: number | null;
}

/**
 * The strongest review-band candidate for a target (used only for logging when
 * no confident deal was found — so borderline matches are visible, not silently
 * dropped). Returns null if nothing reached the review band.
 */
export function findReview(target: PlanTarget, products: StoreProduct[]): ReviewMiss | null {
	let best: ReviewMiss | null = null;
	for (const p of products) {
		const m = evaluate(target, p);
		if (m.verdict === "review" && (!best || m.adjusted > best.score)) {
			best = {
				target,
				product: p,
				score: m.adjusted,
				missing: m.missing,
				productPer100g: p.pricePer100g ?? null,
				baselinePer100g: target.baselinePer100g,
			};
		}
	}
	return best;
}
