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
	/**
	 * The shop's own pack-shot URLs, in the order it publishes them — front first.
	 *
	 * Passed WHOLE, front included: `packShotsFor` in `macro-prompt.ts` is the one
	 * place allowed to decide what a lookup may see, and it drops the front. Filtering
	 * here would put that rule in two places, and the front-shot exclusion is the
	 * entire gate that stops a pack with no panel being read as marketing copy.
	 *
	 * FairPrice fills this from its search payload (10/10 products carry an `images`
	 * array — free, no extra request). Sheng Siong cannot yet: its search results give
	 * `imgKey` but not `totalImg`, and without the count an index past the end returns
	 * 403 and fails the whole lookup. See `shengsiong-images.ts` and Remaining work 20.
	 */
	images?: string[];
	/**
	 * An opaque handle from which pack-shot URLs must be CONSTRUCTED, for a store
	 * that publishes a key rather than a list — Sheng Siong's `imgKey`.
	 *
	 * ⚠️ It is a first-class field and not left in `raw` on purpose: the runner
	 * strips `raw` before committing `data/shengsiong-latest.json` (see
	 * `push-shengsiong.ts`), so anything the cloud needs has to survive that. Putting
	 * it here is the difference between the deals page being able to build these URLs
	 * and not.
	 *
	 * Says nothing about how MANY images exist — see `resolveShengSiongPackShots`.
	 */
	imageKey?: string | null;
	/** Original store payload, for debugging. */
	raw?: unknown;
}

export interface StoreModule {
	readonly name: string;
	/** Search the store for a keyword; return normalized products. */
	search(term: string): Promise<StoreProduct[]>;
}
