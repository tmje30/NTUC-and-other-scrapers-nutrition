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
	/** Original store payload, for debugging. */
	raw?: unknown;
}

export interface StoreModule {
	readonly name: string;
	/** Search the store for a keyword; return normalized products. */
	search(term: string): Promise<StoreProduct[]>;
}
