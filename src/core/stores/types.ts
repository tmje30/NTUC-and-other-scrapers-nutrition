/**
 * The standard shape every store module returns. Adding a store later = a new
 * module that implements StoreModule and maps its data into StoreProduct.
 */

export interface StoreProduct {
	store: string;
	name: string;
	brand?: string;
	/** Current selling price for the whole pack, SGD. */
	priceSgd: number;
	/** Total pack weight in grams, if known (null for pure by-unit items). */
	packWeightG: number | null;
	/** True when the pack size was a volume (ml/L) → show price per litre. */
	volumetric: boolean;
	/** Number of units in the pack, if known (e.g. eggs). */
	unitCount: number | null;
	/** Computed SGD per 100 g (null when weight unknown). */
	pricePer100g: number | null;
	/**
	 * Store-declared dietary/certification labels ("Organic", "Halal", "Vegetarian",
	 * "Healthier Choice", …). Structured data, so it's trustworthy in a way the
	 * product name is not — "Chew's Fresh Eggs - Organic Selenium" is NOT an organic
	 * product. Empty when the store publishes none.
	 */
	dietaryAttributes: string[];
	/** True when the store flags this below its own list price. */
	onSale: boolean;
	/** List/normal price when on sale, SGD. */
	listPriceSgd: number | null;
	/** ISO date the promo ends, if the store provides it (many don't). */
	saleEndsAt: string | null;
	/** Product page URL. */
	url: string;
	/**
	 * The shop's own nutrition panel as an HTML table, when it publishes one.
	 *
	 * This is what decides the `has macro` / `no macro` tag on the deals page, and
	 * more usefully it lets a page-side "Add" write the four per-100g columns for
	 * **free** — `nutrition-panel.ts` parses it deterministically, so no model and
	 * no API call are involved. Undefined means "this shop can't tell us", which is
	 * deliberately the same as "there is no panel": the tag must never claim macros
	 * are free when nobody has checked.
	 *
	 * ⚠️ Every panel is PER SERVING, never per 100g. Do not read numbers out of this
	 * string directly — `parseNutritionPanel` does the scaling and refuses a panel
	 * whose serving size isn't stated.
	 *
	 * Measured 2026-08-04: FairPrice's SEARCH payload carries it on **34 of 72**
	 * products, so the daily scan gets it at zero extra cost — no page fetch, no
	 * slowdown. Sheng Siong publishes nothing readable and always leaves it unset.
	 */
	nutritionHtml?: string | null;
	/** Original store payload, for debugging. */
	raw?: unknown;
}

export interface StoreModule {
	readonly name: string;
	/** Search the store for a keyword; return normalized products. */
	search(term: string): Promise<StoreProduct[]>;
}
