import type { UnitType } from "./notion.js";
import { normTag } from "./notion.js";
import type { StoreProduct } from "./stores/types.js";
import type { DiscountCapture } from "./discount.js";
import { ROUTES, sizeFor } from "./vendor-scan.js";

/**
 * **Today's deals page, turned into discount-column writes** (user, 2026-10-06).
 *
 * The vendor sweep already fills `Price (Discount)` and its four siblings — 12 rows on the
 * day this was written. What it could not fill is anything it did not see, and the daily
 * deals scan sees a different set of prices to the sweep's directed searches.
 *
 * ⚠️⚠️ **The two scans disagree about the same pack, and only one of them knows about the
 * promo.** Measured 2026-10-06, Peanut butter at Sheng Siong:
 *
 * ```
 *   sweep  04:01  ✔ written — Price [Vendor 2] = 5.6      (no promo seen, nothing recorded)
 *   scan   00:17  Sheng Siong · Peanut Butter - Creamy [800g] $5.05  🔻 on sale (−15%)
 * ```
 *
 * Same shop, same product name, and the sweep had no offer to record. Milk's UHT 12 L promo
 * was missed for a second reason — it is over that row's 2000 ml size ceiling, so the sweep
 * refuses it while the page shows it because it compares per litre. Neither gap is fixable
 * inside the sweep, and both are already solved on the deals page. So the page's own figures
 * are the source here, exactly as the user proposed.
 *
 * ⚠️ **Every item on the page, not only the ones the shop tags as on sale** (user's explicit
 * choice when asked, 2026-10-06, with the consequences shown). So a product that is simply
 * cheaper somewhere else — Szechuan pepper at $7.94 against a recorded $17.20 — lands in the
 * discount columns too, and the column means "the best price we can see today" rather than
 * strictly "a promo". The trade the user accepted: a non-promo has no expiry, so it will sit
 * there until a sweep of that same shop finds nothing and clears it.
 *
 * ⚠️ **Nothing here decides whether the write WINS.** `recordDiscount` applies
 * `discountBeats`, so a dearer find never displaces a cheaper one already recorded, whoever
 * wrote it. That is what stops this and the sweep fighting over the same five cells.
 */

/** A `Deal` or a `ReviewMiss` — both carry the row and the product, which is all this needs. */
export interface DealLike {
	target: { name: string; unitType: UnitType; ingredientId: string };
	product: StoreProduct;
}

/**
 * The Notion `Vendor n` option for a shop, by the shop's own name.
 *
 * ⚠️ **The two are not the same string**, and this is the one place that knows it: the
 * module called `fairprice` reports `store: "FairPrice"` and the database spells that shop
 * **`NTUC`**. Derived from `ROUTES` rather than written out again, so a route added there
 * is routed here without a second edit — see `dealDiscountRoutesAgree` in the tests.
 *
 * Returns null for a shop with no route (nothing in `ROUTES` reports one today, but a store
 * module can be used by the deals scan without being a sweep route). A null is skipped
 * rather than guessed: `Location (Discount)` naming a shop the price book has never heard
 * of would be unmatchable against the Vendor slots the grocery page reads.
 */
export function vendorOptionForStore(store: string): string | null {
	const want = normTag(store);
	if (!want) return null;
	for (const r of ROUTES) if (normTag(r.module.name) === want) return r.option;
	return null;
}

/**
 * One deal as the five discount cells would record it, or null where it cannot be.
 *
 * ⚠️⚠️ **`promoPriceSgd ?? priceSgd` — today's price either way, and the fallback is the
 * point.** On a flagged promo `atShelfPrice` has already moved the pre-promo figure into
 * `priceSgd` and left today's in `promoPriceSgd`; on everything else `priceSgd` IS today's.
 * Reading only `promoPriceSgd` is what the sweep does, and it is why six of today's eleven
 * deals had nowhere to go. Both branches yield the figure the deals page prints.
 *
 * ⚠️ Size comes from `sizeFor`, the same choke point the price book uses, so the per-kg rate
 * in `Price per kg/L (discount)` is computed off the same divisor `Size[Vendor n]` holds.
 * Null is allowed — `formatDiscount` simply writes no rate — but a null PRICE is not, since
 * that is the one cell the grocery page prices from.
 */
export function dealCapture(d: DealLike): DiscountCapture | null {
	const vendor = vendorOptionForStore(d.product.store);
	if (!vendor) return null;
	const today = d.product.promoPriceSgd ?? d.product.priceSgd;
	if (!Number.isFinite(today) || today <= 0) return null;
	if (!d.target.ingredientId || !d.product.name) return null;
	return {
		vendor,
		unitType: d.target.unitType,
		promoSgd: today,
		size: sizeFor(d.target.unitType, d.product),
		rowName: d.target.name,
		itemName: d.product.name,
		url: d.product.url,
	};
}

/**
 * The deals worth recording, best price per row first, one per ingredient.
 *
 * ⚠️ **One per row, and the cheapest wins.** A row can appear in more than one input list
 * (a plan deal at NTUC and a near-miss at Sheng Siong), and `recordDiscount` would be asked
 * twice for the same five cells. `discountBeats` would sort it out, but only after two round
 * trips per row — and the losing write would still be reported as a write. Deciding here
 * costs one comparison and makes the run's own log honest about what it did.
 *
 * ⚠️ Compared on the **per-pack** price because that is what the cells hold and what the
 * grocery page's `−%` is computed from. Not per-kg: two packs of different size at one shop
 * is not a case this has to rank, and the figure a row quotes should be the one you pay.
 */
export function pickDealsToRecord(lists: readonly DealLike[][]): Map<string, DiscountCapture> {
	const best = new Map<string, DiscountCapture>();
	for (const list of lists) {
		for (const d of list) {
			const capture = dealCapture(d);
			if (!capture) continue;
			const id = d.target.ingredientId;
			const held = best.get(id);
			if (held && held.promoSgd <= capture.promoSgd) continue;
			best.set(id, capture);
		}
	}
	return best;
}
