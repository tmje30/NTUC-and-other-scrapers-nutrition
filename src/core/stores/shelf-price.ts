import type { StoreProduct } from "./types.js";

/**
 * **The price book records the SHELF price, never the promo price.**
 *
 * A discount belongs on the deals page — saying *this is cheaper than usual today* is
 * that page's entire job. The price book answers a different question, *what does this
 * ingredient normally cost at this shop?*, and a promo answers it wrongly in a way that
 * is very hard to undo:
 *
 * 1. A promo is CHEAPER, so it sails past `dearerThanRecorded` and writes silently.
 * 2. When the promo ends, the shop's own price is now DEARER than the record, so the
 *    correction is refused by that same rule and queued as a question instead.
 *
 * The cheaper-only rule exists so a scan can never make a price worse. Against a promo it
 * does the opposite — it locks the wrong price in, and asks about it every morning
 * forever.
 *
 * Measured 2026-09-01 across the 52 picks of the first cloud sweep: **14 were promo
 * prices**, and six of those were already IN the price book from earlier runs. Guardian's
 * Sensodyne Repair & Protect was the clearest case — recorded at $8.65, while the shop's
 * live price was $10.20 with `onSale=false`, and the scan's attempt to correct it had
 * already been refused as "dearer".
 *
 * ⚠️ **Applied to a module's results BEFORE anything else reads them**, so the pre-promo
 * price is what the pick is RANKED on as well as what gets written. Ranking on the promo
 * price would choose a $10 pack at 50% off over a $6 one and then record $10 — the dearer
 * of the two, picked because it looked cheaper.
 *
 * ⚠️ `onSale` and `listPriceSgd` are left exactly as the shop set them, and the price
 * being replaced is kept as `promoPriceSgd`. Nothing downstream prices off any of the
 * three — they are there so the report can say out loud that a pick was on offer.
 *
 * ⚠️ A shop that publishes no list price is returned UNTOUCHED — Carousell, and My
 * Protein's JSON-LD, both hardcode `listPriceSgd: null`. Their selling price is the only
 * price they state, and inventing a pre-promo figure would be worse than recording the
 * one they publish.
 */
export function atShelfPrice(p: StoreProduct): StoreProduct {
	if (!p.onSale || p.listPriceSgd == null || !(p.listPriceSgd > p.priceSgd)) return p;
	const shelf = p.listPriceSgd;
	return {
		...p,
		priceSgd: shelf,
		// Not lost — the report quotes it, so a shelf price the shop isn't charging
		// today can explain itself. See `promoPriceSgd`.
		promoPriceSgd: p.priceSgd,
		// Recomputed from the pack weight rather than scaled from the old figure, so a
		// module that left `pricePer100g` null keeps it null.
		pricePer100g: p.packWeightG && p.packWeightG > 0 ? (shelf / p.packWeightG) * 100 : null,
	};
}
